import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Events } from '../../src/core/Events';
import { VoicePool, type PoolVoice } from '../../src/systems/audio/voicePool';
import { AudioSystem } from '../../src/systems/audio';
import { AudioConfig } from '../../src/systems/audio/config';
import { FakeParam, installFakeAudio, type FakeAudioContext } from './fakeAudio';

const V = AudioConfig.voices;

/** Minimal game stand-in: the audio system only reads these few members. */
function makeGame(events: Events): never {
  const game = {
    perf: { set: (): void => {}, increment: (): void => {} },
    events,
    state: { interior: null, playerPos: { x: 0, y: 0, z: 0 }, prompts: [] },
    systems: { has: (): boolean => false, get: (): undefined => undefined },
    time: { realElapsed: 0 },
  };
  return game as never;
}

/** AudioParam writes recorded so far — "did this call touch the graph?". */
function paramWrites(ctx: FakeAudioContext): number {
  let n = 0;
  for (const node of ctx.nodes) {
    for (const value of Object.values(node)) {
      if (value instanceof FakeParam) n += value.calls.length;
    }
  }
  return n;
}

class FakeVoice implements PoolVoice {
  killed = 0;
  onStolen: (() => void) | null = null;
  constructor(
    readonly loop: boolean,
    readonly startedAt: number,
    public volume: number,
  ) {}

  kill(): void {
    this.killed++;
  }
}

describe('VoicePool stealing', () => {
  it('uses onStolen (the stop path) instead of kill() for a stolen loop', () => {
    const pool = new VoicePool<FakeVoice>(4, 1);
    const first = new FakeVoice(true, 0, 0.2);
    let stolen = 0;
    first.onStolen = () => {
      stolen++;
    };
    pool.add(first);
    pool.add(new FakeVoice(true, 1, 0.9));
    expect(stolen).toBe(1);
    expect(first.killed).toBe(0);
    expect(pool.loops).toHaveLength(1);
  });

  it('falls back to kill() when a voice has no onStolen hook', () => {
    const pool = new VoicePool<FakeVoice>(1, 1);
    const first = new FakeVoice(false, 0, 0.1);
    pool.add(first);
    pool.add(new FakeVoice(false, 1, 0.5));
    expect(first.killed).toBe(1);
  });
});

describe('AudioSystem loop handles', () => {
  let ctx: FakeAudioContext;
  let restore: () => void;
  let events: Events;
  let audio: AudioSystem;

  beforeEach(() => {
    const fake = installFakeAudio();
    ctx = fake.ctx;
    restore = fake.restore;
    events = new Events();
    audio = new AudioSystem(makeGame(events));
    audio.init();
  });

  afterEach(() => {
    audio.dispose();
    restore();
  });

  it('invalidates the stolen handle and ignores later calls on it', () => {
    const handles = [];
    for (let i = 0; i < V.maxLoops; i++) {
      handles.push(audio.loop('vehicle.engine.loop', { volume: 0.5 + i * 0.01 }));
    }
    expect(audio.voiceStats()).toMatchObject({ loops: V.maxLoops, stolen: 0 });

    const victim = handles[0];
    // The voice behind the quietest loop before it is stolen.
    const voice = (audio as unknown as { loopVoices: Map<number, { input: { gain: FakeParam } }> }).loopVoices.get(victim.id);
    expect(voice).toBeDefined();
    const gainCallsBefore = voice!.input.gain.calls.length;

    // One more loop steals the quietest (the first).
    const extra = audio.loop('vehicle.siren.loop');
    expect(audio.voiceStats()).toMatchObject({ loops: V.maxLoops, stolen: 1 });
    expect(victim.alive).toBe(false);
    expect(extra.alive).toBe(true);

    // The steal went through `stop()`'s teardown: a fade-out was scheduled on the
    // voice (not an abrupt kill), and the handle left the live map.
    expect(voice!.input.gain.calls.length).toBeGreaterThan(gainCallsBefore);
    expect(voice!.input.gain.calls.some((c) => c.startsWith('setTargetAtTime:0.0001'))).toBe(true);
    expect((audio as unknown as { loopVoices: Map<number, unknown> }).loopVoices.has(victim.id)).toBe(false);

    // Calls on the dead handle must not reach the graph.
    const before = paramWrites(ctx);
    audio.setLoopParams(victim, { pitch: 2, volume: 0.05, position: { x: 9, y: 0, z: 9 } });
    audio.engine(victim, 1, 1, 30);
    audio.siren(victim, true);
    expect(paramWrites(ctx)).toBe(before);

    // The survivors still work.
    const survivorBefore = paramWrites(ctx);
    audio.engine(handles[1], 0.7, 0.5, 12);
    expect(paramWrites(ctx)).toBeGreaterThan(survivorBefore);
  });

  it('stops a loop idempotently and leaves no bookkeeping behind', () => {
    const handle = audio.loop('vehicle.engine.loop');
    audio.engine(handle, 0.4, 0.5, 10);
    expect(audio.voiceStats().loops).toBe(1);

    audio.stop(handle);
    expect(handle.alive).toBe(false);
    // Slot freed immediately: no residue in the pool or the handle map.
    expect(audio.voiceStats().loops).toBe(0);

    // Repeated stops are no-ops, not errors.
    expect(() => {
      audio.stop(handle);
      audio.stop(handle);
    }).not.toThrow();
    const before = paramWrites(ctx);
    audio.setLoopParams(handle, { pitch: 3 });
    audio.engine(handle, 1, 1, 40);
    audio.siren(handle, true);
    expect(paramWrites(ctx)).toBe(before);
    expect(audio.voiceStats().loops).toBe(0);
  });

  it('frees the stolen slot and kills the fading voice once its window elapses', () => {
    for (let i = 0; i < V.maxLoops; i++) audio.loop('vehicle.engine.loop', { volume: 0.5 });
    expect(audio.voiceStats()).toMatchObject({ loops: V.maxLoops, stolen: 0 });

    // The 17th loop replaces the stolen one: the cap still holds.
    const extra = audio.loop('vehicle.siren.loop');
    expect(audio.voiceStats()).toMatchObject({ loops: V.maxLoops, stolen: 1 });
    const retiring = (audio as unknown as { retiring: unknown[] }).retiring;
    expect(retiring.length).toBe(1);

    // Stopping rather than stealing also frees the slot right away.
    audio.stop(extra);
    expect(audio.voiceStats().loops).toBe(V.maxLoops - 1);
    expect(retiring.length).toBe(2);

    ctx.advance(V.stopFade + 0.2);
    audio.update(0.016);
    expect(retiring.length).toBe(0);
    expect(audio.voiceStats().loops).toBe(V.maxLoops - 1);
  });
});

describe('AudioSystem pause/resume', () => {
  let ctx: FakeAudioContext;
  let restore: () => void;
  let events: Events;
  let audio: AudioSystem;

  beforeEach(() => {
    const fake = installFakeAudio();
    ctx = fake.ctx;
    restore = fake.restore;
    events = new Events();
    audio = new AudioSystem(makeGame(events));
    audio.init();
  });

  afterEach(() => {
    audio.dispose();
    restore();
  });

  it('suspends the context when the pause menu opens and resumes it when it closes', () => {
    audio.loop('vehicle.engine.loop');
    expect(ctx.state).toBe('running');

    events.emit('ui:paused', {});
    expect(ctx.state).toBe('suspended');
    expect(ctx.suspendCalls).toBe(1);

    events.emit('ui:resumed', {});
    expect(ctx.state).toBe('running');
    expect(ctx.resumeCalls).toBe(1);
  });

  it('keeps a live loop adjustable after the resume', () => {
    const engine = audio.loop('vehicle.engine.loop');
    audio.engine(engine, 0.3, 0.2, 6);

    events.emit('ui:paused', {});
    // Calls while frozen are still routed (they take effect when the clock runs).
    audio.engine(engine, 0.6, 0.5, 15);
    events.emit('ui:resumed', {});

    const before = paramWrites(ctx);
    audio.engine(engine, 0.9, 1, 30);
    audio.setLoopParams(engine, { pitch: 1.2, volume: 0.7 });
    expect(paramWrites(ctx)).toBeGreaterThan(before);
    expect(engine.alive).toBe(true);
    expect(audio.voiceStats().loops).toBe(1);
  });

  it('does not revive a loop stopped while paused', () => {
    const engine = audio.loop('vehicle.engine.loop');
    events.emit('ui:paused', {});
    audio.stop(engine);
    expect(engine.alive).toBe(false);

    events.emit('ui:resumed', {});
    expect(engine.alive).toBe(false);
    expect(audio.voiceStats().loops).toBe(0);

    const before = paramWrites(ctx);
    audio.engine(engine, 1, 1, 30);
    audio.setLoopParams(engine, { pitch: 2 });
    expect(paramWrites(ctx)).toBe(before);
  });

  it('keeps a stopped loop dead through repeated pause cycles', () => {
    const engine = audio.loop('vehicle.engine.loop');
    audio.stop(engine);
    for (let i = 0; i < 3; i++) {
      events.emit('ui:paused', {});
      events.emit('ui:resumed', {});
    }
    expect(engine.alive).toBe(false);
    expect(audio.voiceStats().loops).toBe(0);
  });

  it('a gesture during the pause menu does not unfreeze the context', () => {
    audio.loop('vehicle.engine.loop'); // creates the graph
    events.emit('ui:paused', {});
    expect(ctx.state).toBe('suspended');
    audio.resume();
    expect(ctx.state).toBe('suspended');
    events.emit('ui:resumed', {});
    expect(ctx.state).toBe('running');
  });

  it('does not create a context that ignores the pause freeze', () => {
    // No loop/play before the pause: the graph does not exist yet.
    events.emit('ui:paused', {});
    audio.play('ui.pause');
    expect(ctx.state).toBe('suspended');
    events.emit('ui:resumed', {});
    expect(ctx.state).toBe('running');
  });
});
