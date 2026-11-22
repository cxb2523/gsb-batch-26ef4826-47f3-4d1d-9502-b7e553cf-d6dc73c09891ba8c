/* Local, dependency-free tests for playback-session isolation and stream
 * buffer lifecycle.  No network or real audio hardware is used: fetch,
 * ReadableStream, Worker and AudioContext are mocked with small fakes.
 *
 * Run with: npm test   (or: node --test "test/*.test.mjs")
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AudioStreamPlayer } from '../src/js/modules/audio-stream-player.mjs';
import { BufferedStreamReader } from '../src/js/modules/buffered-stream-reader.mjs';
import { DecodedAudioPlaybackBuffer } from '../src/js/modules/decoded-audio-playback-buffer.mjs';

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

class MockAudioBufferSource {
  constructor() {
    this.onended = null;
    this.buffer = null;
    this.started = false;
    this.stopped = false;
    this.connected = false;
    this.disconnected = false;
    this.startAt = null;
  }
  connect() { this.connected = true; }
  disconnect() { this.disconnected = true; }
  start(at) { this.started = true; this.startAt = at; }
  stop() { this.stopped = true; }
}

class MockAudioContext {
  constructor() {
    this.currentTime = 0;
    this.destination = {};
    this.state = 'running';
    this.closed = false;
    this.nodes = [];
  }
  createBufferSource() {
    const node = new MockAudioBufferSource();
    this.nodes.push(node);
    return node;
  }
  createBuffer(numberOfChannels, length, sampleRate) {
    const data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
    return {
      numberOfChannels,
      length,
      sampleRate,
      duration: length / sampleRate,
      copyToChannel(src, ch) { data[ch].set(src.subarray(0, length)); },
      getChannelData(ch) { return data[ch]; }
    };
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  close() { this.closed = true; this.state = 'closed'; return Promise.resolve(); }
}

class MockWorker {
  constructor() {
    this.posted = [];
    this.onmessage = null;
    this.onerror = null;
  }
  postMessage(message) { this.posted.push(message); }
}

function createControlledStream() {
  const state = { controller: null, cancelled: false };
  const stream = new ReadableStream({
    start(controller) { state.controller = controller; },
    cancel() { state.cancelled = true; }
  });
  return { stream, state };
}

function installFetch(stream, state) {
  globalThis.fetch = (request, options = {}) => {
    const signal = options.signal;
    const abort = () => {
      try { state.controller.error(new DOMException('aborted', 'AbortError')); } catch (e) { /* closed */ }
    };
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort);
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: stream
    });
  };
}

function setupHarness() {
  globalThis.window = globalThis;
  globalThis.AudioContext = MockAudioContext;
  delete globalThis.webkitAudioContext;

  const worker = new MockWorker();
  globalThis.Worker = class { constructor() { return worker; } };

  const { stream, state } = createControlledStream();
  installFetch(stream, state);

  return { worker, stream, state };
}

function decoded(length, sampleRate = 48000) {
  return {
    channelData: [new Float32Array(length), new Float32Array(length)],
    length,
    numberOfChannels: 2,
    sampleRate
  };
}

function makePlayer() {
  const events = [];
  const player = new AudioStreamPlayer('http://localhost/audio.pcm', 4, 'PCM');
  player.onUpdateState = state => events.push(state);
  return { player, events };
}

test('start() begins a session and posts bytes tagged with the session id', async (t) => {
  const h = setupHarness();
  const { player, events } = makePlayer();
  t.after(() => player.close());

  player.start();
  const sessionId = player._sessionId;
  assert.equal(typeof sessionId, 'number');

  const resetMessage = h.worker.posted.find(m => m.reset);
  assert.ok(resetMessage, 'decoder is reset for the new session');
  assert.equal(resetMessage.sessionId, sessionId);

  await tick();
  h.state.controller.enqueue(new Uint8Array([1, 2, 3, 4]));
  await tick(5);

  assert.ok(events.some(s => s.bytesRead === 4), 'download progress is reported');

  const decodeMessage = h.worker.posted.find(m => m.decode);
  assert.ok(decodeMessage, 'a full read buffer is sent to the decoder');
  assert.equal(decodeMessage.sessionId, sessionId);

  player._onWorkerMessage({ data: { sessionId, decoded: decoded(4) } });
  assert.equal(player._abCreated, 1);
  assert.equal(player._abEnded, 0);
});

test('close() aborts the reader, stops scheduled audio, closes the AudioContext and clears counters', async (t) => {
  const h = setupHarness();
  const { player } = makePlayer();
  t.after(() => player.close());

  player.start();
  const sessionId = player._sessionId;
  await tick();
  player._onWorkerMessage({ data: { sessionId, decoded: decoded(4) } });

  const audioCtx = player._audioCtx;
  const node = audioCtx.nodes[0];
  assert.equal(node.started, true);

  player.close();

  assert.equal(player._sessionId, null);
  assert.equal(player._reader, null);
  assert.equal(player._audioCtx, null);
  assert.equal(player._abCreated, 0);
  assert.equal(player._abEnded, 0);
  assert.equal(player._skips, 0);
  assert.equal(node.stopped, true, 'scheduled node is stopped');
  assert.equal(node.disconnected, true, 'scheduled node is disconnected');
  assert.equal(node.onended, null, 'onended handler is removed');
  assert.equal(audioCtx.closed, true, 'AudioContext is closed');

  // close() is idempotent
  player.close();
});

test('late download progress from a retired session is ignored', async (t) => {
  const h = setupHarness();
  const { player, events } = makePlayer();
  t.after(() => player.close());

  player.start();
  const oldSessionId = player._sessionId;

  // new session replaces the first one
  player.start();
  const newSessionId = player._sessionId;
  assert.notEqual(oldSessionId, newSessionId);

  const eventCount = events.length;
  player._downloadProgress(oldSessionId, { totalRead: 999, totalBytes: 4096 });
  assert.equal(events.length, eventCount, 'no state update for an old session');

  player._downloadProgress(newSessionId, { totalRead: 8, totalBytes: 4096 });
  assert.ok(events.some(s => s.bytesRead === 8));
});

test('late decoder message from a retired session is not scheduled into the new session', async (t) => {
  const h = setupHarness();
  const { player } = makePlayer();
  t.after(() => player.close());

  player.start();
  const oldSessionId = player._sessionId;
  player.start();
  const newSessionId = player._sessionId;
  const newCtx = player._audioCtx;

  player._onWorkerMessage({ data: { sessionId: oldSessionId, decoded: decoded(4) } });
  assert.equal(player._abCreated, 0, 'old decode is dropped');
  assert.equal(newCtx.nodes.length, 0, 'nothing is scheduled on the new context');

  player._onWorkerMessage({ data: { sessionId: newSessionId, decoded: decoded(4) } });
  assert.equal(player._abCreated, 1, 'current decode is accepted');
  assert.equal(newCtx.nodes.length, 1);
});

test('late onended from a retired session cannot change counters', async (t) => {
  const h = setupHarness();
  const { player } = makePlayer();
  t.after(() => player.close());

  player.start();
  const sessionId = player._sessionId;
  player._onWorkerMessage({ data: { sessionId, decoded: decoded(4) } });
  const oldEnded = player._audioCtx.nodes[0].onended;
  assert.equal(typeof oldEnded, 'function');

  player.start(); // new session tears the old one down
  const newSessionId = player._sessionId;
  player._onWorkerMessage({ data: { sessionId: newSessionId, decoded: decoded(4) } });
  assert.equal(player._abCreated, 1);
  assert.equal(player._abEnded, 0);

  oldEnded(); // fired by the browser after teardown
  assert.equal(player._abEnded, 0, 'old onended does not increment the new session');
  assert.equal(player._abCreated - player._abEnded, 1);

  const newNode = player._audioCtx.nodes[0];
  newNode.onended();
  newNode.onended(); // double-fire must not double count
  assert.equal(player._abEnded, 1);
  assert.equal(player._abCreated - player._abEnded, 0);
});

test('repeated start/reset keeps AudioBuffer counters consistent and non-negative', async (t) => {
  const h = setupHarness();
  const { player } = makePlayer();
  t.after(() => player.close());

  for (let i = 0; i < 3; i++) {
    player.start();
    const sessionId = player._sessionId;
    player._onWorkerMessage({ data: { sessionId, decoded: decoded(4) } });
    player._onWorkerMessage({ data: { sessionId, decoded: decoded(4) } });

    assert.equal(player._abCreated, 2, `cycle ${i}: created resets per session`);
    assert.equal(player._abEnded, 0);
    assert.ok(player._abCreated - player._abEnded >= 0);

    // simulate the browser ending the first buffer
    player._audioCtx.nodes[0].onended();
    assert.equal(player._abEnded, 1);

    player.close();
    assert.equal(player._abCreated, 0, 'reset clears created');
    assert.equal(player._abEnded, 0, 'reset clears ended');
    assert.ok(player._abCreated - player._abEnded >= 0);
  }
});

test('zero-length decode results are ignored instead of creating invalid buffers', async (t) => {
  const h = setupHarness();
  const { player } = makePlayer();
  t.after(() => player.close());

  player.start();
  const sessionId = player._sessionId;
  player._onWorkerMessage({ data: { sessionId, decoded: decoded(0) } });
  assert.equal(player._abCreated, 0);
  assert.equal(player._audioCtx.nodes.length, 0);
});

test('a fresh start schedules from a clean timeline, not the previous session', async (t) => {
  const h = setupHarness();
  const { player } = makePlayer();
  t.after(() => player.close());

  player.start();
  let sessionId = player._sessionId;
  player._onWorkerMessage({ data: { sessionId, decoded: decoded(4800) } });
  const firstCtx = player._audioCtx;
  const firstNode = firstCtx.nodes[0];
  assert.equal(firstNode.startAt, 0.1);

  player.start(); // reset + new AudioContext with currentTime 0
  sessionId = player._sessionId;
  player._onWorkerMessage({ data: { sessionId, decoded: decoded(4800) } });

  const secondCtx = player._audioCtx;
  const secondNode = secondCtx.nodes[0];
  assert.notEqual(secondCtx, firstCtx);
  assert.equal(firstNode.stopped, true, 'old scheduled audio is stopped');
  assert.equal(secondNode.startAt, 0.1, 'fresh session starts at its own 0 + delay');
  assert.equal(player._totalTimeScheduled, 0.1, 'schedule time does not carry over');
});

test('aborted BufferedStreamReader stops reading, flushing and progress callbacks', async () => {
  const { stream, state } = createControlledStream();
  installFetch(stream, state);

  let readCalls = 0;
  let flushCalls = 0;
  const reader = new BufferedStreamReader(new Request('http://localhost/x.pcm'), 4);
  reader.onRead = () => readCalls++;
  reader.onBufferFull = () => flushCalls++;

  const reading = reader.read();
  await tick();
  reader.abort();

  // data arriving after abort must be ignored
  try { state.controller.enqueue(new Uint8Array([9, 9, 9, 9])); } catch (e) { /* stream aborted */ }
  await tick(10);

  assert.equal(flushCalls, 0);
  assert.equal(reader.bufferPos, 0);
  await reading;
});

test('BufferedStreamReader flushes a partial buffer on done and never flushes empty data', async () => {
  const { stream, state } = createControlledStream();
  installFetch(stream, state);

  const flushed = [];
  const reader = new BufferedStreamReader(new Request('http://localhost/x.pcm'), 8);
  reader.onBufferFull = ({ bytes }) => flushed.push(Array.from(bytes));

  const reading = reader.read();
  await tick();

  state.controller.enqueue(new Uint8Array([1, 2, 3]));
  await tick(10);
  assert.equal(flushed.length, 0, 'nothing flushed until the buffer is full or done');

  state.controller.close();
  await tick(10);
  await reading;

  assert.deepEqual(flushed, [[1, 2, 3]]);
  assert.equal(reader.bufferPos, 0, 'buffer position resets after the final flush');

  // a second, empty completion must not produce a zero-length chunk
  reader._flushBuffer({ end: 0, done: true, request: reader.request });
  assert.equal(flushed.length, 1);
});

test('DecodedAudioPlaybackBuffer.reset() clears position and empty flushes emit nothing', () => {
  const flushes = [];
  const buffer = new DecodedAudioPlaybackBuffer({ onFlush: f => flushes.push(f) });

  buffer.flush(); // nothing buffered
  assert.equal(flushes.length, 0);

  buffer.add({ left: new Float32Array(10), right: new Float32Array(10) });
  buffer.flush();
  assert.equal(flushes.length, 1);
  assert.equal(flushes[0].left.length, 10);

  buffer.reset();
  buffer.flush();
  assert.equal(flushes.length, 1, 'reset clears buffered samples');
});

test('each start creates a fresh reader with a clean buffer position', (t) => {
  setupHarness();
  const { player } = makePlayer();
  t.after(() => player.close());

  player.start();
  const firstReader = player._reader;
  assert.equal(firstReader.bufferPos, 0);

  player.start();
  assert.notEqual(player._reader, firstReader, 'a new reader is created per session');
  assert.equal(firstReader.isAborted, true, 'the old reader is aborted');
  assert.equal(player._reader.bufferPos, 0, 'new reader starts at position 0');
});

test('a start that fails synchronously reports its error and leaves no session behind', (t) => {
  setupHarness();
  globalThis.AudioContext = class {
    constructor() { throw new Error('AudioContext unavailable'); }
  };
  t.after(() => { globalThis.AudioContext = MockAudioContext; });

  const { player, events } = makePlayer();
  const started = player.start();

  assert.equal(started, false);
  assert.equal(player._sessionId, null);
  assert.equal(player._reader, null);
  assert.equal(player._audioCtx, null);
  assert.ok(events.some(s => typeof s.error === 'string' && s.error.includes('AudioContext unavailable')));
});

test('state updates are ignored once a session is closed', async (t) => {
  const h = setupHarness();
  const { player, events } = makePlayer();
  t.after(() => player.close());

  player.start();
  const sessionId = player._sessionId;
  player.close();

  const eventCount = events.length;
  player._updateState({ bytesRead: 123 });
  player._downloadProgress(sessionId, { totalRead: 456, totalBytes: 1000 });
  player._onWorkerMessage({ data: { sessionId, decoded: decoded(4) } });

  assert.equal(events.length, eventCount, 'no UI updates after close');
  assert.equal(player._abCreated, 0);
  assert.equal(player._abEnded, 0);
});
