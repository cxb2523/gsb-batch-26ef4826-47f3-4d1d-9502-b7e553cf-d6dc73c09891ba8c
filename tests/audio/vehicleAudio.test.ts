import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Events } from '../../src/core/Events';
import type { Game } from '../../src/core/Game';
import type { LoopHandle } from '../../src/systems/audio/api';
import { AudioSystem } from '../../src/systems/audio';
import { VehicleAudio } from '../../src/systems/vehicles/VehicleAudio';
import { installFakeAudio, type FakeAudioContext } from './fakeAudio';

/** The slice of `Vehicle` that `VehicleAudio` reads. */
class FakeVehicle {
  isAlive = true;
  hasController = true;
  readonly position = { x: 0, y: 0, z: 0 };
  readonly controls = { throttle: 0 };
  readonly state = { wrecked: false, rpm01: 0.4, speedMs: 0, lateralSpeed: 0, grounded: true, onFire: false, sirenOn: false };
  sirenOn = false;
}

interface Harness {
  game: Game;
  events: Events;
  audio: AudioSystem;
  vehicleAudio: VehicleAudio;
}

function makeHarness(): Harness {
  const events = new Events();
  const game = {
    perf: { set: (): void => {}, increment: (): void => {} },
    events,
    state: { interior: null, playerPos: { x: 0, y: 0, z: 0 }, prompts: [] },
    systems: { has: (): boolean => false, get: (): undefined => undefined },
    time: { realElapsed: 0 },
  } as unknown as Game;
  const audio = new AudioSystem(game);
  (game as unknown as { audio: AudioSystem }).audio = audio;
  audio.init();
  const vehicleAudio = new VehicleAudio(game);
  return { game, events, audio, vehicleAudio };
}

describe('VehicleAudio lifecycle', () => {
  let ctx: FakeAudioContext;
  let restore: () => void;
  let h: Harness;

  beforeEach(() => {
    const fake = installFakeAudio();
    ctx = fake.ctx;
    restore = fake.restore;
    h = makeHarness();
  });

  afterEach(() => {
    h.vehicleAudio.dispose();
    h.audio.dispose();
    restore();
  });

  it('runs an engine loop while a driven car is close by', () => {
    const v = new FakeVehicle();
    h.vehicleAudio.update([v as never], { x: 0, y: 0, z: 0 });
    expect(h.audio.voiceStats().loops).toBe(1);
    expect(ctx.state).toBe('running');
  });

  it('stops engine and siren when the player leaves, and repeated stops are safe', () => {
    const v = new FakeVehicle();
    v.state.sirenOn = true;
    h.vehicleAudio.update([v as never], { x: 0, y: 0, z: 0 });
    expect(h.audio.voiceStats().loops).toBe(2); // engine + siren

    // The player gets out: the entity clears its controller before emitting.
    v.hasController = false;
    h.events.emit('vehicle:exited', { vehicle: v as never, who: { kind: 'player' } as never });
    expect(h.audio.voiceStats().loops).toBe(0);

    // A despawn right after (the normal flow) must not throw or resurrect anything.
    expect(() => {
      h.vehicleAudio.remove(v as never);
      h.vehicleAudio.remove(v as never);
    }).not.toThrow();
    expect(h.audio.voiceStats().loops).toBe(0);
  });

  it('keeps the engine running when only a passenger leaves', () => {
    const v = new FakeVehicle();
    h.vehicleAudio.update([v as never], { x: 0, y: 0, z: 0 });
    expect(h.audio.voiceStats().loops).toBe(1);

    // Still driven after the passenger stepped out.
    h.events.emit('vehicle:exited', { vehicle: v as never, who: { kind: 'ped' } as never });
    expect(h.audio.voiceStats().loops).toBe(1);
  });

  it('stops every loop on destruction', () => {
    const v = new FakeVehicle();
    v.state.onFire = true;
    v.state.sirenOn = true;
    h.vehicleAudio.update([v as never], { x: 0, y: 0, z: 0 });
    expect(h.audio.voiceStats().loops).toBe(3); // engine + fire + siren

    h.events.emit('vehicle:exploded', { vehicle: v as never, position: { x: 0, y: 0, z: 0 } });
    expect(h.audio.voiceStats().loops).toBe(0);
  });

  it('restarts a loop whose voice was stolen and then stopped via remove()', () => {
    const handle: LoopHandle = { id: 999_999, sound: 'vehicle.engine.loop', alive: false };
    const v = new FakeVehicle();
    // Prime the internal map with a dead handle, as a steal would leave it.
    const map = (h.vehicleAudio as unknown as { loops: { engine: Map<unknown, LoopHandle> } }).loops.engine;
    map.set(v, handle);

    h.vehicleAudio.update([v as never], { x: 0, y: 0, z: 0 });
    const current = map.get(v);
    expect(current).toBeDefined();
    expect(current).not.toBe(handle);
    expect(current?.alive).toBe(true);
    expect(h.audio.voiceStats().loops).toBe(1);
  });
});
