import test from 'node:test';
import assert from 'node:assert/strict';
import { AVEngine } from '../av-engine.js';
import { idleState } from '../shared.js';

// A session with observable resources and a viewer that acknowledges STOP on
// the next macrotask, so release order and single-release can be asserted.
function sessionFixture({ ack = true, ackDelay = 0, encoderDelay = 5, contextDelay = 5, closeThrows = false } = {}) {
  const log = [];
  const stopped = { tracks: 0, destination: 0, encoder: 0, context: 0, channel: 0 };
  const track = () => ({ stop() { stopped.tracks++; log.push('track:stop'); } });
  const session = {
    listeners: [], closing: false, releasePromise: null, viewerGone: false, timer: null,
    sequence: 0, unacknowledged: new Map(), inFlightBytes: 0,
    lastHeartbeat: performance.now(), reportedAt: performance.now(),
    budget: { pending: 1 << 30, playback: 1 << 30 },
    channel: {
      postMessage(message) {
        log.push(`post:${message.type}`);
        if (message.type === 'STOP' && ack) setTimeout(() => session.released?.(), ackDelay);
      },
      close() { stopped.channel++; log.push('channel:close'); },
    },
    encoder: {
      close() {
        stopped.encoder++;
        log.push('encoder:close');
        if (closeThrows) throw new Error('encoder already closed');
        return new Promise(resolve => setTimeout(resolve, encoderDelay));
      },
    },
    stream: { getTracks: () => [track(), track()] },
    context: {
      state: 'running',
      close() { stopped.context++; log.push('context:close'); return new Promise(resolve => setTimeout(resolve, contextDelay)); },
    },
    audioSource: { disconnect() { log.push('audio:disconnect'); } },
    audioDestination: { stream: { getTracks: () => [{ stop() { stopped.destination++; log.push('destination:stop'); } }] } },
  };
  return { session, log, stopped };
}
function activeEngine(session) {
  const engine = new AVEngine({ mediaDevices: {} });
  engine.session = session;
  engine.state = { ...idleState(), active: true, mode: 'av', sessionId: 'one', tabId: 8, tabTitle: 'test' };
  return engine;
}

test('stopping A/V during acquisition releases a late stream without starting an encoder', async () => {
  const originalChannel = globalThis.BroadcastChannel;
  globalThis.BroadcastChannel = class {
    postMessage(message) { if (message.type === 'STOP') queueMicrotask(() => this.onmessage({ data: { type: 'RELEASED' } })); }
    close() {}
  };
  try {
    let resolveStream, stopped = 0;
    const engine = new AVEngine({ mediaDevices: { getUserMedia: () => new Promise(resolve => { resolveStream = resolve; }) } });
    const pending = engine.start({ streamId: 'fresh', tabId: 8, tabTitle: 'test', sessionId: 'one', delay: 30, viewerTabId: 9, region: 'tab' });
    await engine.stop();
    resolveStream({ getTracks: () => [{ stop() { stopped++; } }] });
    await pending;
    assert.equal(stopped, 1);
    assert.equal(engine.snapshot().active, false);
    assert.equal(engine.session, null);
  } finally { globalThis.BroadcastChannel = originalChannel; }
});

test('Stop waits for cleanup already started by an error or viewer closure', async () => {
  const oldChannel = globalThis.BroadcastChannel;
  let channel;
  globalThis.BroadcastChannel = class { constructor() { channel = this; } postMessage() {} close() {} };
  try {
    const engine = new AVEngine({ mediaDevices: { getUserMedia: async () => { throw new DOMException('denied', 'NotAllowedError'); } } });
    const starting = engine.start({ streamId: 'fresh', sessionId: 'one', delay: 30, region: 'tab' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(engine.session, null);
    let finished = false;
    const stopping = engine.stop().then(() => { finished = true; });
    await Promise.resolve();
    assert.equal(finished, false);
    channel.onmessage({ data: { type: 'RELEASED' } });
    await starting; await stopping;
    assert.equal(finished, true);
    assert.equal(engine.snapshot().phase, 'idle');
  } finally { globalThis.BroadcastChannel = oldChannel; }
});

test('crop geometry updates only its session; losing the player releases capture instead of showing the page', async () => {
  let stopped = 0, closed = 0;
  const engine = new AVEngine({ mediaDevices: {} });
  const session = { listeners: [], stream: { getTracks: () => [{ stop() { stopped++; } }] },
    encoder: { async close() { closed++; } },
    channel: { postMessage() { queueMicrotask(() => session.released?.()); }, close() {} } };
  engine.session = session;
  engine.state = { ...idleState(), active: true, mode: 'av', sessionId: 'current' };
  const geometry = { rect: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, sourceWidth: 1920, sourceHeight: 1080 };
  await engine.setRegion({ sessionId: 'old', geometry });
  assert.equal(session.encoder.geometry, undefined);
  await engine.setRegion({ sessionId: 'current', geometry });
  assert.equal(session.encoder.geometry, geometry); assert.equal(engine.state.sourceWidth, 1920);
  await engine.setRegion({ sessionId: 'current', error: '播放器未完整显示' });
  assert.equal(engine.state.phase, 'interrupted'); assert.equal(engine.state.active, false);
  assert.equal(stopped, 1); assert.equal(closed, 1);
});

test('release silences output first, then stops tracks/encoder/audio, closes the channel last, and stop waits for it', async () => {
  const f = sessionFixture({ ackDelay: 5, encoderDelay: 5, contextDelay: 5 });
  const engine = activeEngine(f.session);
  const stopping = engine.stop('user');
  // The viewer has not acknowledged STOP yet: stop must not resolve early.
  await Promise.resolve();
  assert.deepEqual(f.log, ['post:STOP']);
  await stopping;
  assert.deepEqual(f.log, [
    'post:STOP',
    'track:stop', 'track:stop', 'encoder:close',
    'destination:stop', 'audio:disconnect', 'context:close', 'channel:close',
  ]);
  const order = name => f.log.indexOf(name);
  assert.ok(order('post:STOP') >= 0);
  assert.ok(order('post:STOP') < order('track:stop'));
  assert.ok(order('track:stop') < order('encoder:close'));
  assert.ok(order('encoder:close') < order('context:close'));
  assert.ok(order('context:close') < order('channel:close'));
  assert.deepEqual(f.stopped, { tracks: 2, destination: 1, encoder: 1, context: 1, channel: 1 });
  assert.equal(engine.session, null);
  assert.equal(engine.snapshot().phase, 'idle');
});

test('viewer CLOSED, track ended and user stop racing each other release exactly once', async () => {
  const f = sessionFixture({ ack: false });
  const engine = activeEngine(f.session);
  engine.attachChannel(f.session, () => ({ type: 'CONFIG' }), () => {});
  // The viewer closes first; the worker stop and the ended track arrive while
  // its release is still closing the encoder/context.
  const byViewer = f.session.channel.onmessage({ data: { type: 'CLOSED' } });
  const byTrack = engine.fail(f.session, 'interrupted', 'track ended');
  const byStop = engine.stop('user');
  await Promise.all([byViewer, byTrack, byStop, new Promise(resolve => setTimeout(resolve, 20))]);
  assert.equal(f.stopped.tracks, 2);
  assert.equal(f.stopped.encoder, 1);
  assert.equal(f.stopped.context, 1);
  assert.equal(f.stopped.channel, 1);
  // A closed viewer already silenced itself; no STOP message is needed.
  assert.equal(f.log.filter(line => line === 'post:STOP').length, 0);
  assert.equal(engine.session, null);
});

test('a STOP already awaiting acknowledgement completes once when the viewer closes mid-wait', async () => {
  const f = sessionFixture({ ack: false });
  const engine = activeEngine(f.session);
  engine.attachChannel(f.session, () => ({ type: 'CONFIG' }), () => {});
  const stopping = engine.stop('user');
  await Promise.resolve();
  assert.equal(f.log.filter(line => line === 'post:STOP').length, 1);
  // Viewer closes before acking; this unblocks the bounded wait immediately.
  f.session.channel.onmessage({ data: { type: 'CLOSED' } });
  await stopping;
  assert.equal(f.stopped.tracks, 2);
  assert.equal(f.stopped.encoder, 1);
  assert.equal(f.stopped.context, 1);
  assert.equal(f.stopped.channel, 1);
});

test('stop waits for release started by a viewer close even when the session was already cleared', async () => {
  const f = sessionFixture({ ack: false, encoderDelay: 10, contextDelay: 10 });
  const engine = activeEngine(f.session);
  engine.attachChannel(f.session, () => ({ type: 'CONFIG' }), () => {});
  const failing = f.session.channel.onmessage({ data: { type: 'CLOSED' } });
  await Promise.resolve();
  assert.equal(engine.session, null);
  let finished = false;
  const stopping = engine.stop().then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  await Promise.all([failing, stopping]);
  assert.equal(finished, true);
  assert.equal(f.stopped.tracks, 2);
  assert.equal(f.stopped.encoder, 1);
  assert.equal(f.stopped.context, 1);
  assert.equal(f.stopped.channel, 1);
  assert.equal(engine.snapshot().phase, 'idle');
});

test('a release that finishes after a new session started never overwrites its state', async () => {
  const f = sessionFixture({ ack: true, encoderDelay: 20, contextDelay: 20 });
  const engine = activeEngine(f.session);
  const old = engine.stop('old');
  // New capture begins while the old encoder/context are still closing.
  let resolveStream;
  const stream = new Promise(resolve => { resolveStream = resolve; });
  engine.mediaDevices = { getUserMedia: () => stream };
  const starting = engine.start({ streamId: 'next', tabId: 8, tabTitle: 'next', sessionId: 'two',
    delay: 25, viewerTabId: 10, region: 'tab' });
  await old;
  assert.equal(engine.state.active, true);
  assert.equal(engine.state.sessionId, 'two');
  assert.equal(engine.snapshot().phase, 'capturing');
  assert.ok(engine.session);
  await engine.stop();
  resolveStream({ getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] });
  await starting;
});

test('late messages from a released session cannot touch a new session', async () => {
  const oldChannel = { onmessage: null };
  const oldSession = { channel: oldChannel, unacknowledged: new Map(), inFlightBytes: 0, released: null };
  const engine = new AVEngine({ mediaDevices: {} });
  let configs = 0;
  engine.attachChannel(oldSession, () => { configs++; return { type: 'CONFIG' }; }, () => {});
  const newSession = { channel: { postMessage() { configs += 100; } }, sequence: 0 };
  engine.session = newSession;
  engine.state = { ...idleState(), active: true, mode: 'av', sessionId: 'new', phase: 'running' };
  oldSession.configReady = true;
  oldChannel.onmessage({ data: { type: 'HELLO' } });
  oldChannel.onmessage({ data: { type: 'STATUS', phase: 'error', blocked: true } });
  oldChannel.onmessage({ data: { type: 'ERROR', error: 'late' } });
  assert.equal(configs, 0);
  assert.equal(engine.session, newSession);
  assert.equal(engine.state.sessionId, 'new');
  assert.equal(engine.state.phase, 'running');
});

test('viewer closing while acquisition waits for it releases promptly instead of timing out', async () => {
  const originalChannel = globalThis.BroadcastChannel;
  let channel, stopMessages = 0;
  globalThis.BroadcastChannel = class {
    constructor() { channel = this; }
    postMessage(message) { if (message.type === 'STOP') stopMessages++; }
    close() {}
  };
  const track = kind => ({ kind, getSettings: () => ({ width: 1280, height: 720, frameRate: 30, sampleRate: 48000, channelCount: 2 }),
    addEventListener() {}, removeEventListener() {}, stop() {}, applyConstraints: async () => {} });
  const stream = { getTracks: () => [track('audio'), track('video')],
    getAudioTracks: () => [track('audio')], getVideoTracks: () => [track('video')] };
  try {
    const engine = new AVEngine({ mediaDevices: { getUserMedia: async () => stream } });
    const starting = engine.start({ streamId: 'fresh', tabId: 8, tabTitle: 'test', sessionId: 'one',
      delay: 30, viewerTabId: 9, region: 'tab' });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(channel, 'channel created');
    // The viewer never sends READY; it closes instead.
    channel.onmessage({ data: { type: 'CLOSED' } });
    const resolved = await Promise.race([
      starting.then(() => 'resolved'),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 2000)),
    ]);
    assert.equal(resolved, 'resolved');
    assert.equal(engine.snapshot().active, false);
    assert.equal(engine.session, null);
    // The closed viewer already silenced itself: no STOP was attempted.
    assert.equal(stopMessages, 0);
  } finally { globalThis.BroadcastChannel = originalChannel; }
});

test('an encoder that throws on close or a channel that throws still lets release complete', async () => {
  const f = sessionFixture({ ack: false, closeThrows: true });
  f.session.viewerGone = true; // No bounded viewer acknowledgement to wait for.
  f.session.channel.close = () => { f.stopped.channel++; throw new Error('already closed'); };
  const engine = activeEngine(f.session);
  await engine.stop();
  assert.equal(f.stopped.encoder, 1);
  assert.equal(f.stopped.context, 1);
  assert.equal(f.stopped.channel, 1);
  assert.equal(engine.snapshot().phase, 'idle');
});
