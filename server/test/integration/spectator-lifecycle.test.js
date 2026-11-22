/**
 * spectator-lifecycle.test.js
 *
 * Integration tests for the spectator seat lifecycle.  Seats are runtime-only
 * (they live in socket-handler, not in the persisted GameState), so their
 * correctness depends entirely on connection and game-lifecycle bookkeeping:
 *
 *   • reconnect race — a user opens a new socket BEFORE the old one drops; the
 *     old socket's disconnect must not evict the still-connected user.
 *   • cross-room switches — joining another room releases the old seat,
 *     including a seat left behind by the reconnect window.
 *   • game deletion and game end — seats go away and lobby counts drop to zero.
 *   • reloading a saved game — no phantom seats come back.
 *   • spectator action gating survives reconnects.
 *
 * The socket handler singleton is required directly (it is the same instance
 * the test server uses) so tests can assert on the authoritative seat count
 * even when a REST endpoint can no longer report it (deleted game).
 */

'use strict';

const { startServer, stopServer } = require('./helpers/server');
const { connectSocket, disconnectSocket, waitFor, emitAck } = require('./helpers/socket');

let server;

beforeAll(async () => {
  server = await startServer();
}, 15_000);
afterAll(async () => {
  await stopServer(server);
}, 10_000);

beforeEach(() => {
  const db = require('../../src/database');
  db.db.exec('DELETE FROM game_players; DELETE FROM games; DELETE FROM users;');
});

let _openSockets = [];
afterEach(async () => {
  await Promise.all(_openSockets.map(disconnectSocket));
  _openSockets = [];
});

const gameManager = require('../../src/game-manager');
const socketHandler = require('../../src/socket-handler');

// ── helpers ──────────────────────────────────────────────────────────────────

async function register(username, password = 'pass1234') {
  const res = await server.api.post('/api/auth/register').send({ username, password }).expect(201);
  return res.body;
}

async function connect(token) {
  const s = await connectSocket(server.url, token);
  _openSockets.push(s);
  return s;
}

function dropSocket(socket) {
  _openSockets = _openSockets.filter((s) => s !== socket);
  return disconnectSocket(socket);
}

const authed = (token) => ({ Authorization: `Bearer ${token}` });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Emit a game:action and resolve once the emitter sees its own game:update. */
async function action(socket, payload) {
  const upd = waitFor(socket, 'game:update');
  socket.emit('game:action', payload);
  return upd;
}

/**
 * Resolve with the first game:update whose state.status matches `status`.
 * Unlike waitFor(), this keeps listening past updates for earlier moves that
 * may still be in flight to a socket that wasn't being awaited move-by-move.
 */
function waitForStatus(socket, status, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for game status '${status}'`)),
      timeoutMs,
    );
    const onUpdate = ({ state }) => {
      if (state?.status !== status) return;
      clearTimeout(timer);
      socket.off('game:update', onUpdate);
      resolve({ state });
    };
    socket.on('game:update', onUpdate);
  });
}

/**
 * Create a two-player tic-tac-toe game, seat both players on their sockets and
 * start it.  Returns everything a test needs, including the started gameId.
 */
async function setupTicTacToe(p1Name = 'alice', p2Name = 'bob', gameName = 'ttt') {
  const p1 = await register(p1Name);
  const p2 = await register(p2Name);

  const createRes = await server.api
    .post('/api/games')
    .set(authed(p1.token))
    .send({ name: gameName, gameType: 'tic-tac-toe' })
    .expect(201);
  const gameId = createRes.body.gameId;

  await server.api.post(`/api/games/${gameId}/join`).set(authed(p1.token)).expect(200);
  await server.api.post(`/api/games/${gameId}/join`).set(authed(p2.token)).expect(200);

  const p1Sock = await connect(p1.token);
  const p2Sock = await connect(p2.token);
  await emitAck(p1Sock, 'join_game', gameId);
  await emitAck(p2Sock, 'join_game', gameId);

  const p1Start = waitFor(p1Sock, 'game:update');
  const p2Start = waitFor(p2Sock, 'game:update');
  p1Sock.emit('game:start');
  await p1Start;
  await p2Start;

  return { gameId, p1, p2, p1Sock, p2Sock };
}

/** Fetch a game's spectator list over REST (as `token`'s user). */
async function spectatorsOf(gameId, token) {
  const res = await server.api
    .get(`/api/games/${gameId}/spectators`)
    .set(authed(token))
    .expect(200);
  return res.body.spectators;
}

// Play a fixed winning line for p1 against p2: p1 takes the top row.
const WINNING_LINE = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
  [0, 2],
];

// ─────────────────────────────────────────────────────────────────────────────
//  Reconnect race
// ─────────────────────────────────────────────────────────────────────────────

describe('reconnect race', () => {
  test('a new socket taking over the seat survives the old socket disconnecting', async () => {
    const { gameId } = await setupTicTacToe();
    const charlie = await register('charlie');

    const sock1 = await connect(charlie.token);
    await emitAck(sock1, 'spectate', gameId);
    expect(socketHandler.spectatorCount(gameId)).toBe(1);

    // Reconnect flow: new socket comes up and re-seats the user BEFORE the old
    // socket's disconnect is processed.
    const sock2 = await connect(charlie.token);
    await emitAck(sock2, 'spectate', gameId);

    await dropSocket(sock1);
    await sleep(100);

    // The user is still watching — the seat must survive the stale disconnect.
    expect(socketHandler.spectatorCount(gameId)).toBe(1);
    const seats = await spectatorsOf(gameId, charlie.token);
    expect(seats).toHaveLength(1);
    expect(seats[0].username).toBe('charlie');
  });

  test('the old socket disconnect does not clear a reconnected player connected flag', async () => {
    const { gameId, p1 } = await setupTicTacToe();

    // p1 reconnects: a second socket for the same user joins the same room.
    const p1Sock2 = await connect(p1.token);
    await emitAck(p1Sock2, 'join_game', gameId);

    const p1Original = _openSockets[0]; // the socket created by setupTicTacToe
    await dropSocket(p1Original);
    await sleep(100);

    const player = gameManager.peekGame(gameId).players.find((p) => p.userId === p1.user.id);
    expect(player.connected).toBe(true);
  });

  test('a reconnect via join_game keeps the spectator seat', async () => {
    const { gameId } = await setupTicTacToe();
    const charlie = await register('charlie');

    const sock1 = await connect(charlie.token);
    await emitAck(sock1, 'spectate', gameId);

    // The client's reconnect handler re-joins the room with join_game.
    const sock2 = await connect(charlie.token);
    await emitAck(sock2, 'join_game', gameId);
    await dropSocket(sock1);
    await sleep(100);

    expect(socketHandler.spectatorCount(gameId)).toBe(1);
    // Still a spectator, so still no actions allowed from the new socket.
    const errPromise = waitFor(sock2, 'game:error');
    sock2.emit('game:action', { action: 'markCell', row: 2, col: 2 });
    const err = await errPromise;
    expect(err.message).toMatch(/spectators cannot take actions/i);
  });

  test('the seat is released when the user’s last socket disconnects', async () => {
    const { gameId } = await setupTicTacToe();
    const charlie = await register('charlie');

    const sock1 = await connect(charlie.token);
    await emitAck(sock1, 'spectate', gameId);
    expect(socketHandler.spectatorCount(gameId)).toBe(1);

    await dropSocket(sock1);
    await sleep(100);

    expect(socketHandler.spectatorCount(gameId)).toBe(0);
  });

  test('a second tab in another room does not keep a stale seat alive', async () => {
    const gameA = await setupTicTacToe('alice', 'bob', 'game-a');
    const gameB = await setupTicTacToe('dave', 'eve', 'game-b');
    const charlie = await register('charlie');

    const watcher = await connect(charlie.token);
    await emitAck(watcher, 'spectate', gameA.gameId);
    expect(socketHandler.spectatorCount(gameA.gameId)).toBe(1);

    // A second socket for the same user sits in a DIFFERENT room, then the
    // watching socket drops.  The user is still online, but nobody is left
    // watching game A — the seat must not survive on the strength of an
    // unrelated connected socket.
    const otherTab = await connect(charlie.token);
    await emitAck(otherTab, 'join_game', gameB.gameId);

    await dropSocket(watcher);
    await sleep(100);

    expect(socketHandler.spectatorCount(gameA.gameId)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Cross-room switching
// ─────────────────────────────────────────────────────────────────────────────

describe('cross-room switching', () => {
  test('spectating a second game releases the seat in the first', async () => {
    const gameA = await setupTicTacToe('alice', 'bob', 'game-a');
    const gameB = await setupTicTacToe('dave', 'eve', 'game-b');
    const charlie = await register('charlie');
    const charlieSock = await connect(charlie.token);

    await emitAck(charlieSock, 'spectate', gameA.gameId);
    expect(socketHandler.spectatorCount(gameA.gameId)).toBe(1);

    await emitAck(charlieSock, 'spectate', gameB.gameId);

    expect(socketHandler.spectatorCount(gameA.gameId)).toBe(0);
    expect(socketHandler.spectatorCount(gameB.gameId)).toBe(1);
    expect(await spectatorsOf(gameA.gameId, gameA.p1.token)).toEqual([]);
    const seatsB = await spectatorsOf(gameB.gameId, gameB.p1.token);
    expect(seatsB).toHaveLength(1);
    expect(seatsB[0].username).toBe('charlie');
  });

  test('joining another room as a player releases a spectator seat from a prior room', async () => {
    const gameA = await setupTicTacToe('alice', 'bob', 'game-a');
    const gameB = await setupTicTacToe('dave', 'eve', 'game-b');
    const charlie = await register('charlie');
    const charlieSock = await connect(charlie.token);

    await emitAck(charlieSock, 'join_game', gameA.gameId);
    await emitAck(charlieSock, 'spectate', gameA.gameId); // watching A

    // Switch to game B via join_game.  B is in progress, so charlie is not
    // added as a player — but the old seat in A must still be released.
    await emitAck(charlieSock, 'join_game', gameB.gameId);
    await sleep(100);

    expect(socketHandler.spectatorCount(gameA.gameId)).toBe(0);
    expect(await spectatorsOf(gameA.gameId, gameA.p1.token)).toEqual([]);
  });

  test('leave_game releases a spectator seat', async () => {
    const { gameId } = await setupTicTacToe();
    const charlie = await register('charlie');
    const charlieSock = await connect(charlie.token);
    await emitAck(charlieSock, 'spectate', gameId);
    expect(socketHandler.spectatorCount(gameId)).toBe(1);

    charlieSock.emit('leave_game');
    await sleep(100);

    expect(socketHandler.spectatorCount(gameId)).toBe(0);
    expect(await spectatorsOf(gameId, charlie.token)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Game deletion / game end
// ─────────────────────────────────────────────────────────────────────────────

describe('cleanup when the game ends', () => {
  test('deleteGame clears seats, drops the REST listing, and removes the game', async () => {
    const { gameId, p1 } = await setupTicTacToe();
    const charlie = await register('charlie');
    const charlieSock = await connect(charlie.token);
    await emitAck(charlieSock, 'spectate', gameId);
    expect(socketHandler.spectatorCount(gameId)).toBe(1);

    // The lobby list advertises the watcher while the game is alive.
    const before = await server.api.get('/api/games').set(authed(charlie.token)).expect(200);
    const listed = before.body.games.find((g) => g.id === gameId);
    expect(listed.spectator_count).toBe(1);

    await server.api.delete(`/api/games/${gameId}`).set(authed(p1.token)).expect(200);

    // Seat and count are gone; the game itself no longer exists.
    expect(socketHandler.spectatorCount(gameId)).toBe(0);
    await server.api.get(`/api/games/${gameId}/spectators`).set(authed(p1.token)).expect(404);
    await server.api.get(`/api/games/${gameId}`).set(authed(p1.token)).expect(404);

    const after = await server.api.get('/api/games').set(authed(charlie.token)).expect(200);
    expect(after.body.games.some((g) => g.id === gameId)).toBe(false);
  });

  test('a game moving to finished clears seats and lobby counts to zero', async () => {
    const { gameId, p1Sock, p2Sock } = await setupTicTacToe();
    const charlie = await register('charlie');
    const charlieSock = await connect(charlie.token);
    await emitAck(charlieSock, 'spectate', gameId);
    expect(socketHandler.spectatorCount(gameId)).toBe(1);

    // The SPECTATOR_JOINED broadcast queues an extra game:update on both
    // player sockets; let it drain so the move-by-move assertions below are
    // matched to the right moves.
    await sleep(100);

    // Play the first four marks normally.
    await action(p1Sock, { action: 'markCell', row: WINNING_LINE[0][0], col: WINNING_LINE[0][1] });
    await action(p2Sock, { action: 'markCell', row: WINNING_LINE[1][0], col: WINNING_LINE[1][1] });
    await action(p1Sock, { action: 'markCell', row: WINNING_LINE[2][0], col: WINNING_LINE[2][1] });
    await action(p2Sock, { action: 'markCell', row: WINNING_LINE[3][0], col: WINNING_LINE[3][1] });

    // The winning move: capture the player's and the spectator's final update.
    const playerFinal = waitForStatus(p1Sock, 'finished');
    const spectatorFinal = waitForStatus(charlieSock, 'finished');
    p1Sock.emit('game:action', {
      action: 'markCell',
      row: WINNING_LINE[4][0],
      col: WINNING_LINE[4][1],
    });
    const playerUpdate = await playerFinal;
    const spectatorUpdate = await spectatorFinal;

    // Seats are cleared the moment the game ends.
    expect(gameManager.peekGame(gameId).status).toBe('finished');
    expect(socketHandler.spectatorCount(gameId)).toBe(0);
    expect(await spectatorsOf(gameId, charlie.token)).toEqual([]);

    // …and the lobby list no longer advertises a watcher for the finished game.
    // Finished games drop out of the open list entirely, so assert both that
    // the card is gone and that no remaining card reports a stale count.
    const lobby = await server.api.get('/api/games').set(authed(charlie.token)).expect(200);
    expect(lobby.body.games.some((g) => g.id === gameId)).toBe(false);
    expect(lobby.body.games.every((g) => (g.spectator_count || 0) === 0)).toBe(true);

    // The final state reaches both roles, but with the visibility difference
    // intact: the player gets action decorations; the spectator gets none.
    expect(spectatorUpdate.state.status).toBe('finished');
    expect(spectatorUpdate.state.spectators).toEqual([]);
    expect(spectatorUpdate.state.validActions).toBeUndefined();
    expect(spectatorUpdate.state.actionDescriptors).toBeUndefined();

    expect(playerUpdate.state.status).toBe('finished');
    expect(Array.isArray(playerUpdate.state.validActions)).toBe(true);
    expect(playerUpdate.state.spectators).toEqual([]);
  });

  test('reloading a saved game does not resurrect old seats', async () => {
    const { gameId, p1Sock } = await setupTicTacToe();
    const charlie = await register('charlie');
    const charlieSock = await connect(charlie.token);
    await emitAck(charlieSock, 'spectate', gameId);
    expect(socketHandler.spectatorCount(gameId)).toBe(1);

    // Save (pause) the game, then drop it from memory and load it back — the
    // exact path a resume-from-lobby takes.  Seats must not survive.
    p1Sock.emit('game:save');
    await sleep(100);
    expect(gameManager.peekGame(gameId).status).toBe('paused');

    gameManager.evictGame(gameId);
    expect(socketHandler.spectatorCount(gameId)).toBe(0);

    const loaded = gameManager.loadGame(gameId);
    expect(loaded).not.toBeNull();
    expect(socketHandler.spectatorCount(gameId)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Action gating survives the lifecycle changes
// ─────────────────────────────────────────────────────────────────────────────

describe('spectator action gating', () => {
  test('a spectator still cannot execute game:action', async () => {
    const { gameId } = await setupTicTacToe();
    const charlie = await register('charlie');
    const charlieSock = await connect(charlie.token);
    await emitAck(charlieSock, 'spectate', gameId);

    const errPromise = waitFor(charlieSock, 'game:error');
    charlieSock.emit('game:action', { action: 'markCell', row: 0, col: 0 });
    const err = await errPromise;
    expect(err.message).toMatch(/spectators cannot take actions/i);

    // The board did not change — the action never reached game logic.
    expect(
      gameManager
        .peekGame(gameId)
        .board.flat()
        .every((c) => c === null),
    ).toBe(true);
  });

  test('a player of a game cannot spectate the same game', async () => {
    const { gameId, p1Sock } = await setupTicTacToe();
    await new Promise((resolve, reject) => {
      p1Sock.emit('spectate', gameId, (ack) => {
        try {
          expect(ack?.error).toMatch(/already a player/i);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
    expect(socketHandler.spectatorCount(gameId)).toBe(0);
  });
});
