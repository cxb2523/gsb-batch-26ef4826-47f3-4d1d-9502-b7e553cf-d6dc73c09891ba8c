import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MusicEngine } from '../../src/core/MusicEngine';
import { pulsePlugin } from '../../src/styles/pulse';
import { zenPlugin } from '../../src/styles/zen';
import type {
  InstrumentPlugin,
  MusicalEvent,
  StyleInstance,
  StylePlugin,
} from '../../src/core/types';
import { MockAudioContext } from '../helpers/MockAudioContext';

/**
 * Acceptance coverage for "latest request wins" across a crossfade transition:
 *  - the transition completes normally at the musical boundary
 *  - re-requests made mid-transition (style and seed) are merged and land
 *  - pause interrupts a transition, and resume applies the queued target
 *  - stop interrupts a transition, and an immediate start leaves no stale
 *    instance, timer or generation horizon behind
 *  - an unknown style requested mid-transition throws without derailing the
 *    in-flight transition
 *  - the style/seed/transition events the UI listens to always end on the
 *    final state (never the old style)
 *  - the seed/style/version determinism contract still holds
 */

function recordingInstrument(
  id: string,
  log: { id: string; event: MusicalEvent; at: number }[],
): InstrumentPlugin {
  return {
    id,
    name: id,
    create: () => ({
      trigger(event, at) {
        log.push({ id: event.id, event, at });
      },
      stopAll() {},
      setParameter() {},
    }),
  };
}

/** Counts live style instances: every create/stop is tracked per style id. */
type InstanceCounter = { started: number; stopped: number };

function trackedStyle(plugin: StylePlugin, counters: Map<string, InstanceCounter>): StylePlugin {
  const counterFor = (id: string): InstanceCounter => {
    let c = counters.get(id);
    if (!c) {
      c = { started: 0, stopped: 0 };
      counters.set(id, c);
    }
    return c;
  };
  return {
    ...plugin,
    create: (config) => {
      const inner: StyleInstance = plugin.create(config);
      const counter = counterFor(plugin.id);
      return {
        start(context) {
          counter.started++;
          inner.start(context);
        },
        stop() {
          counter.stopped++;
          inner.stop();
        },
        generateEvents: (ctx) => inner.generateEvents(ctx),
        setParameter: (name, value) => inner.setParameter(name, value),
        nextBoundary: inner.nextBoundary ? (pos) => inner.nextBoundary!(pos) : undefined,
      };
    },
  };
}

interface Harness {
  engine: MusicEngine;
  mock: MockAudioContext;
  log: { id: string; event: MusicalEvent; at: number }[];
  counters: Map<string, InstanceCounter>;
  fxResets: { count: number };
  liveInstances: (styleId: string) => number;
  events: string[];
}

function makeHarness(): Harness {
  const mock = new MockAudioContext();
  const log: { id: string; event: MusicalEvent; at: number }[] = [];
  const counters = new Map<string, InstanceCounter>();
  const fxResets = { count: 0 };
  const engine = new MusicEngine({
    audioContextFactory: () => mock as unknown as AudioContext,
    style: 'pulse',
    seed: '777',
    lookAhead: 0.16,
    generationHorizon: 45,
  });
  engine.registerInstrument(recordingInstrument('pluck', log));
  for (const id of ['drone', 'bell', 'bowl', 'noise-texture']) {
    engine.registerInstrument(recordingInstrument(id, log));
  }
  engine.registerFX({
    id: 'reverb',
    name: 'Reverb (stub)',
    create: () => {
      const g = mock.createGain() as unknown as AudioNode;
      return {
        input: g,
        output: g,
        setParameter() {},
        reset() {
          fxResets.count++;
        },
        dispose() {},
      };
    },
  });
  engine.registerStyle(trackedStyle(pulsePlugin, counters));
  engine.registerStyle(trackedStyle(zenPlugin, counters));

  const events: string[] = [];
  engine.eventBus.on('transition', ({ phase }) => events.push(`transition:${phase}`));
  engine.eventBus.on('style', ({ styleId }) => events.push(`style:${styleId}`));
  engine.eventBus.on('seed', ({ seed, pending }) =>
    events.push(`seed:${seed}${pending ? ':pending' : ''}`),
  );

  const liveInstances = (styleId: string) => {
    const c = counters.get(styleId);
    return c ? c.started - c.stopped : 0;
  };

  return { engine, mock, log, counters, fxResets, liveInstances, events };
}

/** Advance the mock audio clock and the fake wall clock together. */
async function advance(mock: MockAudioContext, ms: number): Promise<void> {
  mock.advance(ms / 1000);
  await vi.advanceTimersByTimeAsync(ms);
}

/** Drive the scheduler tick by hand over `seconds` of audio clock. */
function play(engine: MusicEngine, mock: MockAudioContext, seconds: number, step = 0.1): void {
  for (let t = 0; t < seconds; t += step) {
    mock.advance(step);
    (engine as any).scheduler.tick();
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('transition lifecycle — latest request wins', () => {
  it('completes a style switch at the musical boundary, cleanly', async () => {
    const h = makeHarness();
    await h.engine.start();
    play(h.engine, h.mock, 0.5);
    expect(h.liveInstances('pulse')).toBe(1);

    h.engine.useStyle('zen');
    expect((h.engine as any).transitioning).toBe(true);
    expect((h.engine as any).transitionTimer).not.toBeNull();

    // Cross the ≤4s boundary and let the transition timer fire.
    await advance(h.mock, 4000);
    play(h.engine, h.mock, 1.0);

    expect(h.engine.getState().styleId).toBe('zen');
    expect(h.engine.getState().status).toBe('playing');
    expect((h.engine as any).transitioning).toBe(false);
    expect((h.engine as any).transitionTimer).toBeNull();
    // Exactly one live instance, and the old one was torn down.
    expect(h.liveInstances('zen')).toBe(1);
    expect(h.liveInstances('pulse')).toBe(0);
    // teardownInstance resets the master FX on the way through.
    expect(h.fxResets.count).toBeGreaterThan(0);
    // Event order ends on the new style, matching the reported state.
    expect(h.events).toEqual(['transition:begin', 'style:zen', 'transition:end']);
    const lastStyle = [...h.events].reverse().find((e) => e.startsWith('style:'));
    expect(lastStyle).toBe(`style:${h.engine.getState().styleId}`);

    await h.engine.dispose();
  });

  it('a rapid style change followed by a seed change lands both at the boundary', async () => {
    const h = makeHarness();
    await h.engine.start();
    play(h.engine, h.mock, 0.5);

    h.engine.useStyle('zen'); // transition starts
    h.engine.useStyle('pulse'); // queued mid-transition
    h.engine.setSeed('4242'); // queued mid-transition
    expect((h.engine as any).pendingTarget).toMatchObject({ styleId: 'pulse', seed: '4242' });

    await advance(h.mock, 4000);
    play(h.engine, h.mock, 1.0);

    expect(h.engine.getState().styleId).toBe('pulse');
    expect(h.engine.getState().seed).toBe('4242');
    expect(h.engine.getState().status).toBe('playing');
    expect(h.liveInstances('pulse')).toBe(1);
    expect(h.liveInstances('zen')).toBe(0); // zen was never instantiated
    expect((h.engine as any).pendingTarget).toBeNull();
    // The last style event the UI sees is the final one.
    expect(h.events.filter((e) => e.startsWith('style:')).pop()).toBe('style:pulse');
    expect(h.events.filter((e) => e.startsWith('seed:')).pop()).toBe('seed:4242');

    await h.engine.dispose();
  });

  it('a transition interrupted by pause applies its target on resume', async () => {
    const h = makeHarness();
    await h.engine.start();
    play(h.engine, h.mock, 0.5);

    h.engine.useStyle('zen');
    h.engine.pause();
    await advance(h.mock, 200); // let pause's suspend wind-down settle
    expect((h.engine as any).pendingTarget).toMatchObject({ styleId: 'zen' });
    expect((h.engine as any).transitionTimer).toBeNull();
    // Interrupting the crossfade must re-enable the UI's play button.
    expect(h.events).toContain('transition:end');

    await h.engine.resume();
    expect(h.engine.getState().styleId).toBe('zen');
    expect(h.engine.getState().status).toBe('playing');
    expect((h.engine as any).pendingTarget).toBeNull();

    play(h.engine, h.mock, 0.6);
    expect(h.liveInstances('zen')).toBe(1);
    expect(h.liveInstances('pulse')).toBe(0);
    expect(h.log.length).toBeGreaterThan(0);
    await h.engine.dispose();
  });

  it('a request made while paused supersedes the interrupted transition target', async () => {
    const h = makeHarness();
    await h.engine.start();
    play(h.engine, h.mock, 0.5);

    h.engine.useStyle('zen'); // interrupted transition -> pending zen
    h.engine.pause();
    await advance(h.mock, 200);

    // User changes their mind while paused: newer values must win.
    h.engine.setSeed('9001');
    h.engine.useStyle('pulse');

    await h.engine.resume();
    expect(h.engine.getState().styleId).toBe('pulse');
    expect(h.engine.getState().seed).toBe('9001');
    expect(h.engine.getState().status).toBe('playing');
    expect((h.engine as any).pendingTarget).toBeNull();

    play(h.engine, h.mock, 0.6);
    expect(h.liveInstances('pulse')).toBe(1);
    expect(h.liveInstances('zen')).toBe(0);
    await h.engine.dispose();
  });

  it('stop mid-transition then an immediate start leaves no stale instance or timer', async () => {
    const h = makeHarness();
    await h.engine.start();
    play(h.engine, h.mock, 1.0);
    const pulseBefore = h.liveInstances('pulse');
    expect(pulseBefore).toBe(1);

    h.engine.useStyle('zen'); // transition in flight
    h.engine.stop();
    expect((h.engine as any).transitionTimer).toBeNull();
    expect((h.engine as any).stopTimer).not.toBeNull();
    expect(h.engine.getState().status).toBe('idle');

    await h.engine.start(); // ▶ pressed during the wind-down
    expect((h.engine as any).stopTimer).toBeNull();
    expect((h.engine as any).transitionTimer).toBeNull();
    expect(h.engine.getState().status).toBe('playing');
    // The queued intent survives: the latest requested style is now playing.
    expect(h.engine.getState().styleId).toBe('zen');
    expect(h.liveInstances('zen')).toBe(1);
    expect(h.liveInstances('pulse')).toBe(0);

    // A stale wind-down must not pull playback down or spawn duplicates.
    const before = h.log.length;
    await advance(h.mock, 500);
    play(h.engine, h.mock, 1.0);
    expect(h.engine.getState().status).toBe('playing');
    expect(h.liveInstances('zen')).toBe(1);
    expect(h.liveInstances('pulse')).toBe(0);
    expect(h.log.length).toBeGreaterThan(before);

    await h.engine.dispose();
  });

  it('an unknown style requested mid-transition throws but leaves playback intact', async () => {
    const h = makeHarness();
    await h.engine.start();
    play(h.engine, h.mock, 0.5);

    h.engine.useStyle('zen'); // valid transition starts
    expect(() => h.engine.useStyle('ghost-style')).toThrow(/Unknown style/);
    // The in-flight transition is untouched and still heading to zen.
    expect((h.engine as any).transitioning).toBe(true);
    expect((h.engine as any).pendingTarget).toBeNull();

    await advance(h.mock, 4000);
    play(h.engine, h.mock, 1.0);
    expect(h.engine.getState().styleId).toBe('zen');
    expect(h.engine.getState().status).toBe('playing');

    // Playback keeps generating for the new style (zen is sparse, so measure
    // the generation horizon rather than the note count).
    // Playback keeps generating for the new style: the horizon stays covered
    // and a real instance is running (zen is sparse, so notes alone are a
    // noisy signal).
    play(h.engine, h.mock, 3.0);
    const audio = (h.engine as any).audio;
    const transport = (h.engine as any).transport;
    const position = transport.positionAt(audio.ctx.currentTime);
    expect((h.engine as any).generatedUntil).toBeGreaterThanOrEqual(position);
    expect((h.engine as any).instance).not.toBeNull();
    expect(h.liveInstances('zen')).toBe(1);
    await h.engine.dispose();
  });
});

describe('determinism across a torn-down restart', () => {
  it('the same seed + style + version replays identically after a transition is interrupted', async () => {
    // Reference: a fresh zen run from a clean start.
    const ref = makeHarness();
    ref.engine.useStyle('zen'); // idle -> applies immediately
    expect(ref.engine.getState().styleId).toBe('zen');
    await ref.engine.start();
    play(ref.engine, ref.mock, 3.0, 0.05);
    const reference = ref.log
      .filter((l) => l.event.metadata?.sourcePlugin === 'zen')
      .map((l) => ({ id: l.id, rel: l.at }));
    expect(reference.length).toBeGreaterThan(0);

    // Same style/seed reached via an interrupted transition + restart.
    const h = makeHarness();
    await h.engine.start();
    play(h.engine, h.mock, 0.5);
    h.engine.useStyle('zen'); // transition in flight
    h.engine.stop(); // interrupted before the boundary
    await h.engine.start(); // fresh run, pending style applied
    expect(h.engine.getState().styleId).toBe('zen');
    const after = h.log.length;
    play(h.engine, h.mock, 3.0, 0.05);
    const replay = h.log
      .slice(after)
      .filter((l) => l.event.metadata?.sourcePlugin === 'zen')
      .map((l) => ({ id: l.id, rel: l.at }));

    expect(replay.length).toBe(reference.length);
    for (let i = 0; i < replay.length; i++) {
      expect(replay[i].id).toBe(reference[i].id);
      // Audio-clock anchors differ, so compare time relative to the first note.
      const refRel = reference[i].rel - reference[0].rel;
      const repRel = replay[i].rel - replay[0].rel;
      expect(repRel).toBeCloseTo(refRel, 6);
    }

    await h.engine.dispose();
    await ref.engine.dispose();
  });
});
