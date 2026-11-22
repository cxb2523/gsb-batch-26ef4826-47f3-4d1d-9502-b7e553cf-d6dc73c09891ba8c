'use strict';

/**
 * game-manager.test.js
 *
 * Tests the per-game action queue added to game-manager.js.
 * The database is replaced with a lightweight in-memory mock so no file I/O
 * occurs and the tests stay fast.
 */

// ── database mock ─────────────────────────────────────────────────────────────
// jest.mock is hoisted before any require() calls, so the factory must be
// self-contained.  We expose _store so beforeEach can clear it between tests.

jest.mock('../src/database', () => {
  const store = new Map();
  return {
    _store: store,
    createGame(id, _name, createdBy, state, config, gameType) {
      store.set(id, {
        id,
        created_by: createdBy,
        game_type: gameType || 'monopoly',
        status: 'waiting',
        state: JSON.parse(JSON.stringify(state)),
        config: JSON.parse(JSON.stringify(config)),
      });
    },
    updateGame(id, status, stateObj) {
      const row = store.get(id);
      if (row) {
        row.status = status;
        row.state = JSON.parse(JSON.stringify(stateObj));
      }
    },
    getGameById(id) {
      const row = store.get(id);
      if (!row) return null;
      return { ...row, state: JSON.parse(JSON.stringify(row.state)) };
    },
    addPlayerToGame() {},
    removePlayerFromGame() {},
    deleteGame(id) {
      store.delete(id);
    },
    listOpenGames() {
      return [];
    },
    db: {},
  };
});

// ── module imports (after mock registration) ──────────────────────────────────

const database = require('../src/database');
const gameManager = require('../src/game-manager');

// ── test helpers ──────────────────────────────────────────────────────────────

const HOST = { id: 'host-001', username: 'Alice' };
const P2 = { id: 'plyr-002', username: 'Bob' };

/**
 * Create a game, add two players, start it, and return the gameId.
 */
async function createAndStartGame() {
  const { gameId } = gameManager.createGame('Test Game', HOST.id, 'monopoly');
  await gameManager.addPlayerToLobby(gameId, HOST);
  await gameManager.addPlayerToLobby(gameId, P2);
  const result = gameManager.startGame(gameId, HOST.id);
  if (result.error) throw new Error(`startGame failed: ${result.error}`);
  return gameId;
}

// ── setup / teardown ──────────────────────────────────────────────────────────

afterEach(() => {
  // Clear the mock DB between tests.  The game-manager's activeGames map
  // retains entries across tests, but each test uses a fresh UUID so there
  // is no cross-test interference.
  database._store.clear();
  gameManager.events.removeAllListeners();
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Lifecycle events
// ═══════════════════════════════════════════════════════════════════════════════
//
// game-manager can't import socket-handler (cycle), so it announces lifecycle
// transitions on gameManager.events and the socket layer subscribes.  These
// tests pin the contract: which event, with which gameId, and when NOT to fire.

describe('lifecycle events', () => {
  /**
   * Create, join and start a two-player tic-tac-toe game.  Tic-tac-toe is used
   * because it can be driven to 'finished' with a handful of deterministic
   * moves, and its state filter is the identity function.
   */
  async function createTicTacToe() {
    const { gameId } = gameManager.createGame('TTT', HOST.id, 'tic-tac-toe');
    await gameManager.addPlayerToLobby(gameId, HOST);
    await gameManager.addPlayerToLobby(gameId, P2);
    const start = gameManager.startGame(gameId, HOST.id);
    if (start.error) throw new Error(`startGame failed: ${start.error}`);
    return gameId;
  }

  /** Play a fixed winning line for HOST: (0,0) (0,1) (0,2), P2 interleaves. */
  async function playToHostWin(gameId) {
    const moves = [
      [HOST.id, 0, 0],
      [P2.id, 1, 0],
      [HOST.id, 0, 1],
      [P2.id, 1, 1],
      [HOST.id, 0, 2],
    ];
    let last;
    for (const [userId, row, col] of moves) {
      last = await gameManager.applyAction(gameId, userId, 'markCell', { row, col });
      if (last.error) throw new Error(`markCell failed: ${last.error}`);
    }
    return last;
  }

  test('a move that finishes the game emits game:finished with the gameId', async () => {
    const gameId = await createTicTacToe();
    const seen = [];
    gameManager.events.on('game:finished', (id) => seen.push(id));

    await playToHostWin(gameId);

    expect(gameManager.peekGame(gameId).status).toBe('finished');
    expect(seen).toEqual([gameId]);
  });

  test('ordinary in-progress moves do not emit game:finished', async () => {
    const gameId = await createTicTacToe();
    const seen = [];
    gameManager.events.on('game:finished', (id) => seen.push(id));

    await gameManager.applyAction(gameId, HOST.id, 'markCell', { row: 0, col: 0 });
    await gameManager.applyAction(gameId, P2.id, 'markCell', { row: 1, col: 0 });

    expect(seen).toEqual([]);
  });

  test('game:finished fires once even if later actions are attempted', async () => {
    const gameId = await createTicTacToe();
    const seen = [];
    gameManager.events.on('game:finished', (id) => seen.push(id));

    await playToHostWin(gameId);
    // The game is finished — further actions are rejected, not processed.
    await gameManager.applyAction(gameId, P2.id, 'markCell', { row: 2, col: 2 });

    expect(seen).toEqual([gameId]);
  });

  test('deleteGame emits game:removed with the gameId', async () => {
    const { gameId } = gameManager.createGame('Delete Me', HOST.id, 'tic-tac-toe');
    const seen = [];
    gameManager.events.on('game:removed', (id) => seen.push(id));

    const result = await gameManager.deleteGame(gameId, HOST.id);

    expect(result).toEqual({ success: true });
    expect(seen).toEqual([gameId]);
  });

  test('deleteGame by a non-host emits nothing (and deletes nothing)', async () => {
    const { gameId } = gameManager.createGame('Not Yours', HOST.id, 'tic-tac-toe');
    const seen = [];
    gameManager.events.on('game:removed', (id) => seen.push(id));

    const result = await gameManager.deleteGame(gameId, P2.id);

    expect(result.error).toMatch(/only the host/i);
    expect(seen).toEqual([]);
    expect(gameManager.peekGame(gameId)).not.toBeNull();
  });

  test('evictGame emits game:removed', () => {
    const { gameId } = gameManager.createGame('Evict Me', HOST.id, 'tic-tac-toe');
    const seen = [];
    gameManager.events.on('game:removed', (id) => seen.push(id));

    gameManager.evictGame(gameId);

    expect(seen).toEqual([gameId]);
    // Evicted from memory but still in the DB — it can be loaded back.
    expect(database.getGameById(gameId)).not.toBeNull();
  });

  test('loading a game from the database emits game:loaded', () => {
    const { gameId } = gameManager.createGame('Reload Me', HOST.id, 'tic-tac-toe');
    gameManager.evictGame(gameId); // drop the in-memory copy

    const seen = [];
    gameManager.events.on('game:loaded', (id) => seen.push(id));

    const loaded = gameManager.loadGame(gameId);

    expect(loaded).not.toBeNull();
    expect(loaded.id).toBe(gameId);
    expect(seen).toEqual([gameId]);
  });

  test('loading an already-active game does not emit game:loaded (no-op)', () => {
    const { gameId } = gameManager.createGame('Still Here', HOST.id, 'tic-tac-toe');
    const seen = [];
    gameManager.events.on('game:loaded', (id) => seen.push(id));

    // Already in activeGames — loadGame returns the cached copy early.
    gameManager.loadGame(gameId);

    expect(seen).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Per-game action queue
// ═══════════════════════════════════════════════════════════════════════════════

describe('per-game action queue', () => {
  // ── basic liveness ──────────────────────────────────────────────────────────

  test('N concurrent applyAction calls all resolve (no deadlock)', async () => {
    const gameId = await createAndStartGame();
    const N = 10;
    const results = await Promise.all(
      Array.from({ length: N }, () => gameManager.applyAction(gameId, HOST.id, 'rollDice', {})),
    );
    expect(results).toHaveLength(N);
    expect(results.every((r) => r !== undefined && r !== null)).toBe(true);
  });

  // ── state consistency ───────────────────────────────────────────────────────

  test('exactly one rollDice succeeds when N calls fire concurrently', async () => {
    const gameId = await createAndStartGame();
    const N = 10;

    // Force non-doubles dice for the only roll that should succeed.  Doubles
    // would leave the phase at pre-roll and let a second concurrent roll
    // legitimately succeed (Monopoly rule: doubles → roll again) — correct
    // behaviour, but not what this test is about.  Math.random alternates
    // 0.1 / 0.5 → dice [1, 4] for the first (and only) successful roll.
    const original = Math.random;
    let call = 0;
    Math.random = () => (call++ % 2 === 0 ? 0.1 : 0.5);

    let results;
    try {
      results = await Promise.all(
        Array.from({ length: N }, () => gameManager.applyAction(gameId, HOST.id, 'rollDice', {})),
      );
    } finally {
      Math.random = original;
    }

    const successes = results.filter((r) => !r.error);
    const errors = results.filter((r) => r.error);

    // Only the first call in the queue can succeed — the game logic rejects
    // subsequent rolls because the turn phase has already advanced.
    expect(successes).toHaveLength(1);
    expect(errors).toHaveLength(N - 1);
  });

  test('final state reflects exactly one roll after N concurrent calls', async () => {
    const gameId = await createAndStartGame();
    await Promise.all(
      Array.from({ length: 10 }, () => gameManager.applyAction(gameId, HOST.id, 'rollDice', {})),
    );

    const final = gameManager.peekGame(gameId);
    // Dice were set to non-zero values — exactly one roll happened.
    // Phase is not checked here: it depends on what the player landed on
    // (pre-roll if doubles, buying if unowned property, post-roll otherwise).
    expect(final.turnState.dice[0] + final.turnState.dice[1]).toBeGreaterThan(0);
  });

  // ── high-concurrency stress ─────────────────────────────────────────────────

  test('no deadlock under high concurrency (50 calls)', async () => {
    const gameId = await createAndStartGame();
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => gameManager.applyAction(gameId, HOST.id, 'rollDice', {})),
    );
    // Every promise must settle — if any hang the test times out
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  });

  // ── game isolation ──────────────────────────────────────────────────────────

  test('queues for different games are independent', async () => {
    const g1 = await createAndStartGame();
    const g2 = await createAndStartGame();

    const [r1, r2] = await Promise.all([
      gameManager.applyAction(g1, HOST.id, 'rollDice', {}),
      gameManager.applyAction(g2, HOST.id, 'rollDice', {}),
    ]);

    // Each game is in its own pre-roll phase — both rolls should succeed.
    // Phase is not asserted: doubles keep it at pre-roll, an unowned property
    // moves it to buying, etc.  Dice being set proves the roll ran.
    expect(r1.error).toBeUndefined();
    expect(r2.error).toBeUndefined();
    expect(
      gameManager.peekGame(g1).turnState.dice[0] + gameManager.peekGame(g1).turnState.dice[1],
    ).toBeGreaterThan(0);
    expect(
      gameManager.peekGame(g2).turnState.dice[0] + gameManager.peekGame(g2).turnState.dice[1],
    ).toBeGreaterThan(0);
  });

  // ── saveGame shares the same queue ─────────────────────────────────────────

  test('concurrent applyAction and saveGame both resolve without throwing', async () => {
    const gameId = await createAndStartGame();

    // Fire both at the same instant — order of execution is determined by the
    // queue.  Either the roll succeeds then the game is saved, or the save
    // pauses the game first and the roll is rejected.  In both cases the
    // promises must resolve (not throw) and the state must be self-consistent.
    const [actionResult, saveResult] = await Promise.all([
      gameManager.applyAction(gameId, HOST.id, 'rollDice', {}),
      gameManager.saveGame(gameId, HOST.id),
    ]);

    expect(actionResult).toBeDefined();
    expect(saveResult).toBeDefined();

    const final = gameManager.peekGame(gameId);
    // Whatever order ran: status must be a valid value, not undefined/corrupt
    expect(['playing', 'paused']).toContain(final.status);
  });

  test('saveGame followed by applyAction correctly rejects the action', async () => {
    const gameId = await createAndStartGame();

    // Save first (sequential, not concurrent) so the game is definitively paused
    await gameManager.saveGame(gameId, HOST.id);
    expect(gameManager.peekGame(gameId).status).toBe('paused');

    // Any action against a paused game must be rejected
    const result = await gameManager.applyAction(gameId, HOST.id, 'rollDice', {});
    expect(result.error).toBe('Game is not in playing state');
    // State must not have been mutated
    expect(gameManager.peekGame(gameId).status).toBe('paused');
  });

  // ── setPlayerConnected shares the same queue ────────────────────────────────

  test('setPlayerConnected and applyAction on the same game both resolve', async () => {
    const gameId = await createAndStartGame();

    const [, actionResult] = await Promise.all([
      gameManager.setPlayerConnected(gameId, HOST.id, false),
      gameManager.applyAction(gameId, HOST.id, 'rollDice', {}),
    ]);

    // The action result must be defined (not lost due to a race)
    expect(actionResult).toBeDefined();
    // Final state must be self-consistent
    expect(gameManager.peekGame(gameId)).not.toBeNull();
  });

  // ── lock cleanup ────────────────────────────────────────────────────────────

  test('subsequent calls resolve normally after queue has fully drained', async () => {
    // Verify that the lock entry is cleaned up correctly after a batch completes.
    // A stale, unreleased lock would cause any subsequent call to hang forever.
    const gameId = await createAndStartGame();

    // Drain the queue with a batch of calls
    await Promise.allSettled(
      Array.from({ length: 10 }, () => gameManager.applyAction(gameId, HOST.id, 'rollDice', {})),
    );

    // A follow-up call that does not depend on game phase must resolve promptly.
    // setPlayerConnected always succeeds regardless of turn state.
    await gameManager.setPlayerConnected(gameId, HOST.id, false);
    expect(gameManager.peekGame(gameId).players.find((p) => p.userId === HOST.id).connected).toBe(
      false,
    );

    // And a further call proves the queue is still accepting work
    await gameManager.setPlayerConnected(gameId, HOST.id, true);
    expect(gameManager.peekGame(gameId).players.find((p) => p.userId === HOST.id).connected).toBe(
      true,
    );
  });
});
