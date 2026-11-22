/**
 * socket-handler.js
 *
 * Wires all Socket.io real-time events for game play.
 * Game-agnostic: all game-specific behaviour is delegated to the game-logic
 * module selected by game-registry based on the game's gameType field.
 *
 * Connection lifecycle
 * ────────────────────
 *   connect        → client authenticates via socket.handshake.auth.token
 *   join_game      → client joins a Socket.io room for a specific game
 *   leave_game     → client leaves the room (but stays in DB)
 *   disconnect     → mark player as disconnected; game continues
 *
 * In-game events (client → server)
 * ──────────────────────────────────
 *   game:start              host starts the game
 *   game:action  { action, ...payload }  any player action (roll, buy, trade, …)
 *   game:save
 *   chat:message { text }
 *
 * Server → client broadcasts (to the game room)
 * ───────────────────────────────────────────────
 *   game:state         full GameState (on join)
 *   game:update        { state, events[] }  after every action
 *   game:error         { message }  (to the acting socket only)
 *   trade:incoming     { from, payload }  targeted to the trade recipient
 *   chat:message       { username, text, timestamp }
 */

'use strict';

const { authenticateSocket } = require('./auth');
const gameManager = require('./game-manager');
const gameRegistry = require('./game-registry');
const { filterStateForUser } = require('./state-filter');

// Track which socket is in which game room: Map<socketId, gameId>
const socketGameMap = new Map();
// Track each user's active socket for targeted emissions: Map<userId, socketId>
const userSocketMap = new Map();
// Track every live socket a user owns: Map<userId, Set<socketId>>.
//
// A reconnect is "new socket connects, then old socket disconnects".  Runtime
// state that belongs to the USER (spectator seats, player connected flags)
// must only be torn down when the user's LAST socket goes away — otherwise the
// dying socket's disconnect handler races the new connection and evicts a user
// who is demonstrably still online.  See handleSocketDisconnect below.
const userSockets = new Map();

function addUserSocket(userId, socketId) {
  let sockets = userSockets.get(userId);
  if (!sockets) {
    sockets = new Set();
    userSockets.set(userId, sockets);
  }
  sockets.add(socketId);
}

/**
 * Forget one of a user's sockets.
 * @returns {number} how many live sockets the user still has
 */
function removeUserSocket(userId, socketId) {
  const sockets = userSockets.get(userId);
  if (!sockets) return 0;
  sockets.delete(socketId);
  if (sockets.size === 0) {
    userSockets.delete(userId);
    return 0;
  }
  return sockets.size;
}

/** True if the user owns at least one live socket in the given game room. */
function userHasSocketInRoom(io, userId, gameId) {
  const sockets = userSockets.get(userId);
  const room = io.sockets.adapter.rooms.get(gameId);
  if (!sockets || !room) return false;
  for (const socketId of sockets) {
    if (room.has(socketId)) return true;
  }
  return false;
}

// ── spectators ───────────────────────────────────────────────────────────────
//
// Spectators are runtime-only — they live in this map, not in the persisted
// game state.  A user is a spectator of game X if they appear in
// `gameSpectators.get(X)`.  Spectators receive UNFILTERED game state (see
// the bypass in filteredFor) and CANNOT take game actions (see the gate in
// the game:action handler).  Joining as a player and joining as a spectator
// are mutually exclusive — the spectate handler rejects a player of the
// same game, and addPlayerToLobby/startGame don't add spectators to the
// player list.
//
// Map<gameId, Map<userId, { username, joinedAt, socketId }>>
const gameSpectators = new Map();

function isSpectator(gameId, userId) {
  const spectators = gameSpectators.get(gameId);
  return !!(spectators && spectators.has(userId));
}

function addSpectator(gameId, userId, username, socketId) {
  let spectators = gameSpectators.get(gameId);
  if (!spectators) {
    spectators = new Map();
    gameSpectators.set(gameId, spectators);
  }
  // A reconnecting spectator is the SAME spectator: keep the original
  // joinedAt so the lobby doesn't look like a fresh join, but point the seat
  // at the live socket so room bookkeeping stays accurate.
  const existing = spectators.get(userId);
  spectators.set(userId, {
    username,
    joinedAt: existing ? existing.joinedAt : Date.now(),
    socketId,
  });
}

function removeSpectator(gameId, userId) {
  const spectators = gameSpectators.get(gameId);
  if (!spectators) return false;
  const removed = spectators.delete(userId);
  if (spectators.size === 0) gameSpectators.delete(gameId);
  return removed;
}

/**
 * Drop every spectator seat for a game.  Called when the game disappears
 * (deleted, evicted) or stops being watchable (finished).
 *
 * Runtime-only by design: seats are never persisted, so nothing has to happen
 * in the database — but every place that can end a game's life has to call
 * this, otherwise the lobby keeps advertising spectators for a dead game.
 */
function clearSpectators(gameId) {
  return gameSpectators.delete(gameId);
}

/**
 * Remove a user's spectator seat from every game except `keepGameId`.
 *
 * The client model is one game view at a time, so a user who joins another
 * room is no longer watching the old one.  Runs on every room join to catch
 * seats left behind by a reconnect (new socket joins before the old socket's
 * disconnect is processed — that disconnect deliberately keeps the seat, see
 * handleSocketDisconnect).
 *
 * @returns {boolean} true if any seat was removed
 */
function removeSpectatorElsewhere(userId, keepGameId = null) {
  let removedAny = false;
  for (const [gameId, spectators] of gameSpectators) {
    if (gameId === keepGameId) continue;
    if (spectators.delete(userId)) {
      removedAny = true;
      if (spectators.size === 0) gameSpectators.delete(gameId);
    }
  }
  return removedAny;
}

/** Number of spectator seats currently registered for a game. */
function spectatorCount(gameId) {
  const spectators = gameSpectators.get(gameId);
  return spectators ? spectators.size : 0;
}

/**
 * Snapshot the userIds seated as spectators for a game.
 * Used to carry spectator visibility through a broadcast that happens after
 * the seats have already been cleared (the final game:update of a game that
 * just ended).  Returns null when nobody was watching.
 */
function spectatorSnapshotFor(gameId) {
  const spectators = gameSpectators.get(gameId);
  if (!spectators || spectators.size === 0) return null;
  return new Set(spectators.keys());
}

/** Emit a lobby refresh if the socket layer has been wired up yet. */
function notifyLobbyUpdate() {
  if (_io) _io.emit('lobby:update');
}

// Games transition to 'finished' / disappear inside game-manager, which can't
// import this module (cycle).  It emits lifecycle events instead; wire them to
// runtime-state cleanup here.  Listeners are synchronous, so applyAction() and
// deleteGame() return only after the stale seats are gone.
gameManager.events.on('game:finished', (gameId) => {
  clearSpectators(gameId);
  notifyLobbyUpdate();
});
gameManager.events.on('game:removed', (gameId) => {
  clearSpectators(gameId);
  notifyLobbyUpdate();
});
gameManager.events.on('game:loaded', (gameId) => {
  // A game loaded from the DB must not inherit seats from an earlier
  // incarnation of the same id (e.g. delete → recreate with a fixed id).
  clearSpectators(gameId);
});

/**
 * Snapshot of a game's spectator list in the shape the wire format expects:
 *   [{ userId, username, joinedAt }, ...]
 * Always returns a fresh array (never the internal Map).  Empty array is
 * returned for games with no spectators — renderers should treat that as
 * "no spectators present" rather than "feature unavailable."
 */
function spectatorsForWire(gameId) {
  const spectators = gameSpectators.get(gameId);
  if (!spectators) return [];
  return Array.from(spectators.entries(), ([userId, info]) => ({
    userId,
    username: info.username,
    joinedAt: info.joinedAt,
  }));
}

// ── per-socket state filtering ─────────────────────────────────────────────────
//
// Hidden-information games (Risk, future card games) implement
// getStateForPlayer(state, userId) which masks fields the recipient is not
// allowed to see (other players' hands, the deck, etc.).  Every state-bearing
// emit MUST go through these helpers so each socket receives the version
// tailored to its user.

/**
 * Build the per-recipient view of state for the wire.  Two flavours:
 *
 *   Player path  — runs the recipient's userId through getStateForPlayer
 *     so hidden information (Battleship ships, Risk hands, Life tiles)
 *     stays masked; attaches the recipient's validActions and
 *     actionDescriptors decorations.
 *   Spectator path — SKIPS the hidden-information filter (spectators
 *     watch with full visibility per the locked design decision) AND
 *     skips the action decorations (spectators have no actions).
 *
 * The spectator branch is the ONLY legitimate way for a connected user
 * to receive unfiltered state for a game they're not playing in.  The
 * gate is `isSpectator(gameId, userId)` — registration goes through
 * the `spectate` socket handler, which validates the game exists and
 * the user isn't already a player.  No client-side flag can claim
 * spectator status.
 *
 * Every state-bearing emit attaches `state.spectators` (a list of
 * { userId, username, joinedAt }) so renderers can render a spectator
 * count without an extra round-trip.  The list comes from gameSpectators,
 * not from persisted state — see the spectators block above.
 *
 * `spectatorSnapshot` (optional) is the set of userIds that were seated when
 * the action was dispatched.  It exists for exactly one situation: the final
 * game:update of a game that just finished.  Seats are cleared the moment the
 * game ends (lobby counts must drop to zero), but the spectators who were
 * watching still deserve the unfiltered view of the ending state.  Passing
 * the pre-clear snapshot preserves that visibility without keeping the seats
 * alive in the lobby.
 */
function filteredFor(state, userId, gameId = null, spectatorSnapshot = null) {
  if (!state) return state;
  const gid = gameId || state.id;

  const spectatorList = gid ? spectatorsForWire(gid) : [];

  const watching = spectatorSnapshot
    ? !!(userId && spectatorSnapshot.has(userId))
    : !!(gid && userId && isSpectator(gid, userId));

  if (watching) {
    // Spectator path — full state, no descriptors, no validActions.
    return { ...state, spectators: spectatorList };
  }

  // Player path — filter for hidden information then attach decorations.
  const view = filterStateForUser(state, userId, gameRegistry);
  const logic = gameRegistry.getGameLogic(state.gameType);
  let out = view;
  if (userId && typeof logic.getValidActions === 'function') {
    out = { ...out, validActions: logic.getValidActions(out, userId) };
  }
  if (userId && typeof logic.getActionDescriptors === 'function') {
    out = { ...out, actionDescriptors: logic.getActionDescriptors(out, userId) };
  }
  out = { ...out, spectators: spectatorList };
  return out;
}

/**
 * Emit a state-bearing event to one socket, with the state filtered for that
 * socket's user.  `extra` is merged into the payload unchanged (events array,
 * etc. — never private to a particular user).
 *
 * The gameId argument is the recipient's current game room; passed through to
 * filteredFor so it can apply the spectator-bypass when applicable.  When
 * omitted, falls back to socketGameMap (the socket's current room).
 */
function emitToSocket(
  socket,
  eventName,
  state,
  extra = {},
  gameId = null,
  spectatorSnapshot = null,
) {
  const userId = socket.data?.userId;
  const gid = gameId || socketGameMap.get(socket.id) || null;
  socket.emit(eventName, {
    state: filteredFor(state, userId, gid, spectatorSnapshot),
    ...extra,
  });
}

/**
 * Emit a state-bearing event to every socket in a game room, each receiving
 * its user's filtered view.  `exceptSocket` skips one socket (used when the
 * acting socket already received a different event for the same action).
 * `spectatorSnapshot` is forwarded to filteredFor — see its doc comment.
 */
function emitToRoom(
  io,
  gameId,
  eventName,
  state,
  extra = {},
  exceptSocket = null,
  spectatorSnapshot = null,
) {
  const room = io.sockets.adapter.rooms.get(gameId);
  if (!room) return;
  for (const socketId of room) {
    if (exceptSocket && socketId === exceptSocket.id) continue;
    const sock = io.sockets.sockets.get(socketId);
    if (!sock) continue;
    emitToSocket(sock, eventName, state, extra, gameId, spectatorSnapshot);
  }
}

// ── turn timeout ──────────────────────────────────────────────────────────────
// When a player disconnects mid-turn, auto-skip after TURN_TIMEOUT_MS.

const TURN_TIMEOUT_MS = 30_000;
const turnTimers = new Map(); // key: `${gameId}:${userId}` → timer handle

function scheduleTurnTimeout(io, gameId, userId, username) {
  const key = `${gameId}:${userId}`;
  clearTurnTimeout(key);
  // Send an absolute deadline so the client can run a local countdown that
  // stays accurate regardless of network jitter or message-delivery delay.
  io.to(gameId).emit('game:turn_warning', {
    username,
    deadlineTimestamp: Date.now() + TURN_TIMEOUT_MS,
  });
  turnTimers.set(
    key,
    setTimeout(async () => {
      turnTimers.delete(key);
      // Snapshot — we hand `state` to game-logic functions below.
      const state = gameManager.getGameSnapshot(gameId);
      if (!state || state.status !== 'playing') return;
      const logic = gameRegistry.getGameLogic(state.gameType);
      const cur = logic.getCurrentPlayer(state);
      // Only fire if it's still this player's turn and they're still disconnected
      if (!cur || cur.userId !== userId) return;
      const player = state.players.find((p) => p.userId === userId);
      if (player?.connected) return;
      if (logic.isTurnTimerBlocked(state)) return;
      const spectatorSnapshot = spectatorSnapshotFor(gameId);
      const result = await gameManager.applyAction(gameId, userId, 'skipTurn', {});
      if (!result.error) {
        emitToRoom(
          io,
          gameId,
          'game:update',
          result.state,
          { events: result.events },
          null,
          spectatorSnapshot,
        );
      }
    }, TURN_TIMEOUT_MS),
  );
}

function clearTurnTimeout(key) {
  if (turnTimers.has(key)) {
    clearTimeout(turnTimers.get(key));
    turnTimers.delete(key);
  }
}

// Stored io reference so REST routes can trigger lobby broadcasts
let _io = null;

/**
 * Emit 'lobby:update' to all connected sockets so every client on the lobby
 * screen refreshes its game list automatically.
 */
function broadcastLobbyUpdate() {
  if (!_io) throw new Error('broadcastLobbyUpdate called before registerHandlers');
  _io.emit('lobby:update');
}

// ── per-socket room membership ───────────────────────────────────────────────
//
// Room membership is tracked per SOCKET (socketGameMap) because a socket is in
// at most one game room.  Seat ownership is tracked per USER (gameSpectators),
// and player connection flags are per USER too.  That split is what makes a
// reconnect race safe: the new socket claims the user's seat/connection state,
// and the old socket's disconnect must only undo *that socket's* membership.

/**
 * Detach a socket from whatever game room it is in and release any spectator
 * seat the user held there — used when a socket explicitly switches rooms.
 *
 * Seat release is guarded: if another live socket of the same user is still
 * sitting in the room, the seat belongs to that socket and stays.  In the
 * reconnect case the new socket has already re-seated the user, so the old
 * socket's cleanup must not evict them.  Seats held in OTHER games are cleared
 * separately by removeSpectatorElsewhere() at the new room's join site.
 *
 * @returns {{ gameId: string, wasSpectator: boolean } | null}
 *   The game the socket left, or null if it wasn't in one.
 */
function releaseSocketRoom(socket, currentUser, io) {
  const gameId = socketGameMap.get(socket.id);
  if (!gameId) return null;

  socketGameMap.delete(socket.id);
  socket.leave(gameId);

  if (isSpectator(gameId, currentUser.sub) && !userHasSocketInRoom(io, currentUser.sub, gameId)) {
    removeSpectator(gameId, currentUser.sub);
    return { gameId, wasSpectator: true };
  }

  return { gameId, wasSpectator: false };
}

/**
 * Handle a socket disconnect without conflating it with the user leaving.
 *
 * The ordering guarantee that matters: a reconnecting client opens its new
 * socket BEFORE the old one fully drops.  If any other live socket for the
 * same user remains, the user is still "here" — so:
 *   • the spectator seat stays (the new socket owns it now),
 *   • the player is NOT marked disconnected (that would start a turn timer and
 *     broadcast PLAYER_DISCONNECTED for someone actively reconnected).
 * Only the last socket to go performs the full teardown.
 */
async function handleSocketDisconnect(io, socket, currentUser) {
  console.log(`[socket] ${currentUser.username} disconnected (${socket.id})`);

  if (userSocketMap.get(currentUser.sub) === socket.id) {
    userSocketMap.delete(currentUser.sub);
  }

  const gameId = socketGameMap.get(socket.id);
  const remaining = removeUserSocket(currentUser.sub, socket.id);

  // Still connected under another socket?  The user never left the server, so
  // this is a reconnect race (new socket up, old socket dropping) or a second
  // tab closing.  Keep the player's connected flag untouched.  A spectator
  // seat is keyed by user, but it represents a view held by THIS socket — if no
  // surviving socket is still in this room, the seat has no watcher and is
  // dropped.  In the reconnect case the new socket has already (re)joined the
  // room, so userHasSocketInRoom is true and the seat survives.
  if (remaining > 0) {
    if (gameId) {
      socketGameMap.delete(socket.id);
      socket.leave(gameId);
      if (
        !userHasSocketInRoom(io, currentUser.sub, gameId) &&
        isSpectator(gameId, currentUser.sub)
      ) {
        removeSpectator(gameId, currentUser.sub);
        broadcastLobbyUpdate();
      }
    }
    return;
  }

  // Last socket gone: this user is really offline.  Any seat they held for
  // ANY game goes with them, including seats left behind by an earlier
  // cross-room switch.
  const droppedSeats = removeSpectatorElsewhere(currentUser.sub);
  if (droppedSeats) broadcastLobbyUpdate();

  if (!gameId) {
    socketGameMap.delete(socket.id);
    return;
  }

  socketGameMap.delete(socket.id);
  socket.leave(gameId);

  // Spectators have no persisted connection state — the seat cleanup above is
  // the whole story.  (No spectator:left broadcast: leaves are silent.)
  if (!gameManager.peekGame(gameId)?.players?.some((p) => p.userId === currentUser.sub)) {
    return;
  }

  // A real departure by a player.
  await gameManager.setPlayerConnected(gameId, currentUser.sub, false);

  // Snapshot — sent over the wire and also passed to game-logic
  // (getCurrentPlayer / isTurnTimerBlocked) below.
  const state = gameManager.getGameSnapshot(gameId);
  emitToRoom(io, gameId, 'game:update', state, {
    events: [
      {
        type: 'PLAYER_DISCONNECTED',
        data: { username: currentUser.username },
        timestamp: Date.now(),
      },
    ],
  });

  // If it was this player's turn, start the auto-skip countdown
  if (state && state.status === 'playing') {
    const logic = gameRegistry.getGameLogic(state.gameType);
    const cur = logic.getCurrentPlayer(state);
    if (cur?.userId === currentUser.sub && !logic.isTurnTimerBlocked(state)) {
      scheduleTurnTimeout(io, gameId, currentUser.sub, currentUser.username);
    }
  }
}

/**
 * Register all Socket.io event handlers.
 * @param {import('socket.io').Server} io
 */
function registerHandlers(io) {
  _io = io;

  io.on('connection', (socket) => {
    // ── authenticate ────────────────────────────────────────────────────────

    let currentUser = null;
    try {
      currentUser = authenticateSocket(socket);
    } catch {
      socket.emit('auth:error', { message: 'Invalid or missing token. Please log in again.' });
      socket.disconnect(true);
      return;
    }

    console.log(`[socket] ${currentUser.username} connected (${socket.id})`);
    userSocketMap.set(currentUser.sub, socket.id);
    addUserSocket(currentUser.sub, socket.id);
    // Cache userId on the socket so per-socket state filtering can look it
    // up directly without a userSocketMap reverse-scan.
    socket.data.userId = currentUser.sub;

    // ── join game room ───────────────────────────────────────────────────────

    socket.on('join_game', async (gameId, ack) => {
      // peek is fine — we only read status here; the wire-bound read happens
      // after the mutations below via getGameSnapshot.
      const state = gameManager.peekGame(gameId);
      if (!state) {
        return ack?.({ error: 'Game not found' });
      }

      // Leave any previously joined game room.  If that room was being
      // watched as a spectator, release the seat — a spectator switching to
      // another game must not linger in the old game's list.
      const prevGame = socketGameMap.get(socket.id);
      if (prevGame && prevGame !== gameId) {
        releaseSocketRoom(socket, currentUser, io);
      }

      socket.join(gameId);
      socketGameMap.set(socket.id, gameId);

      // One game view at a time: joining this room retires seats the user
      // holds in any OTHER game (reconnect leftovers in particular).
      const droppedElsewhere = removeSpectatorElsewhere(currentUser.sub, gameId);

      // Spectator bookkeeping on (re)join:
      //   • a player of this game can never also hold a seat (locked rule),
      //   • a spectator reconnecting into the same game stays the SAME
      //     spectator — keep their spot and point it at the new socket.
      const isPlayer = state.players?.some((p) => p.userId === currentUser.sub);
      if (isSpectator(gameId, currentUser.sub)) {
        if (isPlayer) {
          removeSpectator(gameId, currentUser.sub);
        } else {
          addSpectator(gameId, currentUser.sub, currentUser.username, socket.id);
        }
        broadcastLobbyUpdate();
      } else if (droppedElsewhere) {
        broadcastLobbyUpdate();
      }

      // For games still in the lobby, add the player idempotently so that
      // joining via REST + socket (the normal flow) always results in a
      // consistent player list broadcast to everyone already in the room.
      if (state.status === 'waiting') {
        await gameManager.addPlayerToLobby(gameId, {
          id: currentUser.sub,
          username: currentUser.username,
        });
      }

      await gameManager.setPlayerConnected(gameId, currentUser.sub, true);
      // Cancel any pending turn-skip timer now that this player is back
      clearTurnTimeout(`${gameId}:${currentUser.sub}`);

      // Auto-resume paused (saved) games when a player rejoins
      if (state.status === 'paused') {
        await gameManager.resumeGame(gameId);
      }

      // Snapshot for wire emission — the state is about to be filtered and
      // serialized to multiple sockets and one ack callback.
      const latestState = gameManager.getGameSnapshot(gameId);

      // Send full state to the joining client
      emitToSocket(socket, 'game:state', latestState);

      // Notify everyone else in the room with the updated player list
      emitToRoom(
        io,
        gameId,
        'game:update',
        latestState,
        {
          events: [
            {
              type: 'PLAYER_JOINED_LOBBY',
              data: { username: currentUser.username },
              timestamp: Date.now(),
            },
          ],
        },
        socket,
      );

      // Update lobby lists on all connected clients (player count changed)
      broadcastLobbyUpdate();

      ack?.({ success: true });
    });

    // ── spectate game (read-only join) ───────────────────────────────────────

    socket.on('spectate', async (gameId, ack) => {
      const state = gameManager.peekGame(gameId);
      if (!state) return ack?.({ error: 'Game not found' });
      if (state.status !== 'playing') {
        return ack?.({
          error: 'You can only spectate a game in progress',
        });
      }
      // A player of this game can't also spectate it.  The lobby UI
      // doesn't show the Spectate button for the user's own active
      // games — this is the server-side enforcement of that decision.
      if (state.players?.some((p) => p.userId === currentUser.sub)) {
        return ack?.({ error: 'You are already a player in this game' });
      }

      // Leave any previously joined game room (spectator or player).  Leaving
      // a room we were watching releases that game's seat.
      const prevGame = socketGameMap.get(socket.id);
      if (prevGame && prevGame !== gameId) {
        releaseSocketRoom(socket, currentUser, io);
      }

      socket.join(gameId);
      socketGameMap.set(socket.id, gameId);
      addSpectator(gameId, currentUser.sub, currentUser.username, socket.id);
      // A spectator watches one game at a time; clear seats in other games
      // that a reconnect may have left behind.
      removeSpectatorElsewhere(currentUser.sub, gameId);

      const latestState = gameManager.getGameSnapshot(gameId);

      // Send the full state to the joining spectator (filteredFor's
      // spectator branch returns unfiltered state because we just
      // registered them above).
      emitToSocket(socket, 'game:state', latestState, {}, gameId);

      // Notify everyone else in the room — players want to know who's watching.
      emitToRoom(
        io,
        gameId,
        'game:update',
        latestState,
        {
          events: [
            {
              type: 'SPECTATOR_JOINED',
              data: { username: currentUser.username, joinedAt: Date.now() },
              timestamp: Date.now(),
            },
          ],
        },
        socket,
      );

      // The targeted broadcast above also emits the spectator:joined event
      // separately so renderers that don't read the events array still see
      // the join.
      io.to(gameId).emit('spectator:joined', {
        username: currentUser.username,
        joinedAt: Date.now(),
      });

      // Lobby spectator counts changed.
      broadcastLobbyUpdate();

      ack?.({ success: true });
    });

    socket.on('unspectate', () => {
      const gameId = socketGameMap.get(socket.id);
      if (!gameId) return;
      if (!isSpectator(gameId, currentUser.sub)) return;

      socketGameMap.delete(socket.id);
      socket.leave(gameId);
      // Only drop the seat if no other socket of this user is still watching
      // (e.g. two tabs, one closes the spectator view).
      if (!userHasSocketInRoom(io, currentUser.sub, gameId)) {
        removeSpectator(gameId, currentUser.sub);
      }

      // No spectator:left broadcast — locked design decision (joins are
      // events, leaves are silent).  Lobby refresh keeps counts in sync.
      broadcastLobbyUpdate();
    });

    // ── leave game room ──────────────────────────────────────────────────────

    socket.on('leave_game', async () => {
      const gameId = socketGameMap.get(socket.id);
      if (!gameId) return;

      socketGameMap.delete(socket.id);
      socket.leave(gameId);

      // A spectator who leaves through leave_game releases the seat too —
      // otherwise the lobby would keep counting a viewer who is gone.
      if (isSpectator(gameId, currentUser.sub)) {
        if (!userHasSocketInRoom(io, currentUser.sub, gameId)) {
          removeSpectator(gameId, currentUser.sub);
        }
        broadcastLobbyUpdate();
        return;
      }

      // Not a player in this game (e.g. a spectator of a different game, or
      // the game's spectator seat was already gone) — nothing else to do.
      if (!gameManager.peekGame(gameId)?.players?.some((p) => p.userId === currentUser.sub)) {
        return;
      }

      // A player who still owns another socket in the room hasn't really left
      // — don't mark them disconnected or start a turn timer.
      if (userHasSocketInRoom(io, currentUser.sub, gameId)) return;

      clearTurnTimeout(`${gameId}:${currentUser.sub}`);
      await gameManager.setPlayerConnected(gameId, currentUser.sub, false);

      emitToRoom(io, gameId, 'game:update', gameManager.getGameSnapshot(gameId), {
        events: [
          {
            type: 'PLAYER_DISCONNECTED',
            data: { username: currentUser.username },
            timestamp: Date.now(),
          },
        ],
      });
    });

    // ── disconnect ───────────────────────────────────────────────────────────

    socket.on('disconnect', async () => {
      await handleSocketDisconnect(io, socket, currentUser);
    });

    // ── game start ───────────────────────────────────────────────────────────

    socket.on('game:start', () => {
      const gameId = socketGameMap.get(socket.id);
      if (!gameId) return socket.emit('game:error', { message: 'Not in a game' });

      const result = gameManager.startGame(gameId, currentUser.sub);
      if (result.error) return socket.emit('game:error', { message: result.error });

      emitToRoom(io, gameId, 'game:update', result.state, { events: result.events });

      // Game status changed to 'playing' — update lobby lists everywhere
      broadcastLobbyUpdate();
    });

    // ── join lobby ───────────────────────────────────────────────────────────

    socket.on('lobby:join', async (gameId, ack) => {
      const result = await gameManager.addPlayerToLobby(gameId, {
        id: currentUser.sub,
        username: currentUser.username,
      });
      if (result.error) return ack?.({ error: result.error });

      // Switching rooms releases any seat held in the previous one.
      const prevGame = socketGameMap.get(socket.id);
      if (prevGame && prevGame !== gameId) {
        releaseSocketRoom(socket, currentUser, io);
      }

      socket.join(gameId);
      socketGameMap.set(socket.id, gameId);

      // Joining as a player means the user stops watching anything else.  (The
      // spectate handler rejects players of the same game, but a player may
      // have an old seat in a different game.)
      if (removeSpectatorElsewhere(currentUser.sub, gameId)) broadcastLobbyUpdate();

      emitToRoom(io, gameId, 'game:update', result.state, {
        events: [
          {
            type: 'PLAYER_JOINED_LOBBY',
            data: { username: currentUser.username },
            timestamp: Date.now(),
          },
        ],
      });

      // ack is delivered to the joining socket; filter the state for them too
      ack?.({ success: true, state: filteredFor(result.state, currentUser.sub, gameId) });
    });

    // ── game action (single generic handler for all player actions) ──────────

    socket.on('game:action', async (payload) => {
      const { action, ...data } = payload || {};
      if (!action) {
        socket.emit('game:error', { message: 'Missing action type' });
        return;
      }

      const gameId = socketGameMap.get(socket.id);
      if (!gameId) {
        socket.emit('game:error', { message: 'Not in a game' });
        return;
      }

      // Spectators are watch-only.  A normal-UI client never reaches here
      // (the spectator banner replaces the action panel), but a buggy
      // or malicious client trying to slip an action through is rejected
      // server-side.  Logged because if this fires in normal play we
      // want to know.
      if (isSpectator(gameId, currentUser.sub)) {
        console.warn(
          `[socket] spectator ${currentUser.username} attempted action "${action}" ` +
            `in game ${gameId} — rejected`,
        );
        socket.emit('game:error', { message: 'Spectators cannot take actions' });
        return;
      }

      // Snapshot the seated spectators BEFORE the action runs.  If this action
      // finishes the game, the lifecycle hook clears the seats immediately (so
      // lobby counts drop), but the people who were watching still get the
      // unfiltered view of the ending state.  See filteredFor().
      const spectatorSnapshot = spectatorSnapshotFor(gameId);

      const result = await gameManager.applyAction(gameId, currentUser.sub, action, data);

      if (result.error) {
        socket.emit('game:error', { message: result.error });
        return;
      }

      emitToRoom(
        io,
        gameId,
        'game:update',
        result.state,
        { events: result.events },
        null,
        spectatorSnapshot,
      );

      // If the action resulted in a trade offer, notify the recipient directly
      const tradeEvent = result.events?.find((e) => e.type === 'TRADE_OFFERED');
      if (tradeEvent && data.toUserId) {
        const recipientSid = userSocketMap.get(data.toUserId);
        if (recipientSid) {
          io.to(recipientSid).emit('trade:incoming', { from: currentUser.username, payload: data });
        }
      }
    });

    // ── save game ────────────────────────────────────────────────────────────

    socket.on('game:save', async (ack) => {
      const gameId = socketGameMap.get(socket.id);
      if (!gameId) return ack?.({ error: 'Not in a game' });

      const result = await gameManager.saveGame(gameId, currentUser.sub);
      if (result.error) {
        socket.emit('game:error', { message: result.error });
        return ack?.({ error: result.error });
      }

      io.to(gameId).emit('game:saved', { savedBy: currentUser.username });
      ack?.({ success: true });
    });

    // ── chat ─────────────────────────────────────────────────────────────────

    socket.on('chat:message', ({ text }) => {
      if (!text || typeof text !== 'string') return;
      const trimmed = text.trim().slice(0, 300); // max 300 chars
      if (!trimmed) return;

      const gameId = socketGameMap.get(socket.id);
      if (!gameId) return;

      // senderRole lets the client render spectator messages with a
      // distinguishing prefix.  The server is the only place that
      // knows authoritatively whether the sender is a player or a
      // spectator — a client-supplied role tag would be forgeable.
      const senderRole = isSpectator(gameId, currentUser.sub) ? 'spectator' : 'player';

      io.to(gameId).emit('chat:message', {
        username: currentUser.username,
        text: trimmed,
        timestamp: Date.now(),
        senderRole,
      });
    });
  }); // end io.on('connection')
}

module.exports = {
  registerHandlers,
  broadcastLobbyUpdate,
  // Exported for REST routes that want to render a spectator count.
  spectatorsForWire,
  spectatorCount,
};
