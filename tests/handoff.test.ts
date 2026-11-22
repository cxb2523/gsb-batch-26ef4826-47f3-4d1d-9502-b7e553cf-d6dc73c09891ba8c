import { describe, expect, it } from 'bun:test';
import { AudioEngine, type AudioBackend } from '../src/lib/audioEngine';
import { GameSession } from '../src/lib/gameSession';
import { KeyboardInputController } from '../src/lib/keyboardInput';
import { TouchInputController } from '../src/lib/touchInput';
import type { Level } from '../src/lib/level';

/**
 * End-to-end "hand-off" scenarios: the real AudioEngine plus the real input
 * controllers wired to a GameSession, exactly like the app wires them, with a
 * fake Tone backend whose start is resolved on demand.
 */
class TestBackend implements AudioBackend {
  startCalls = 0;
  attacks: string[] = [];
  releases: string[] = [];
  releaseAllCalls = 0;
  private resolveStart: (() => void) | null = null;

  start(): Promise<void> {
    this.startCalls += 1;
    return new Promise<void>((resolve) => {
      this.resolveStart = resolve;
    });
  }
  resolve(): void {
    const resolve = this.resolveStart;
    this.resolveStart = null;
    resolve?.();
  }
  triggerAttack(note: string): void {
    this.attacks.push(note);
  }
  triggerRelease(note: string): void {
    this.releases.push(note);
  }
  releaseAll(): void {
    this.releaseAllCalls += 1;
  }
}

const NOTES: Record<string, string> = {
  a: 'C2', s: 'D2', d: 'E2', f: 'F2', ' ': 'G2', j: 'A2', k: 'B2', l: 'C3', ';': 'D3',
};

const LEVEL_1: Level = {
  name: 'level 1',
  patterns: [
    [1, 0, 0, 0, 0, 0, 0, 0, 0], // A
    [0, 1, 0, 0, 0, 0, 0, 0, 0], // S
  ],
  ranks: [1, 2, 3],
};

const LEVEL_2: Level = {
  name: 'level 2',
  patterns: [
    [0, 0, 0, 0, 0, 0, 0, 0, 1], // ;
  ],
  ranks: [1, 2, 3],
};

function zoneAt(x: number, y: number): number {
  if (y > 400) return 8;
  const zone = Math.floor(x / 100);
  return zone >= 0 && zone <= 7 ? zone : -1;
}

function wire() {
  const backend = new TestBackend();
  const engine = new AudioEngine(backend, (key) => NOTES[key]);
  let now = 10_000;
  const session = new GameSession(
    {
      playNote: (key) => engine.playNote(key),
      releaseNote: (key) => engine.releaseNote(key),
      releaseAll: () => engine.releaseAll(),
      beginLevelSession: () => engine.beginLevelSession(),
      endLevelSession: () => engine.endLevelSession(),
    },
    () => now,
  );

  const startAudio = () => {
    if (!engine.isInitialized()) void engine.ensureStarted().catch(() => {});
  };

  let menu = false;
  const keyboard = new KeyboardInputController({
    isLevelActive: () => session.getSnapshot().active,
    isMenu: () => menu,
    press: (code) => session.press(code, 'keyboard'),
    release: (code) => session.release(code, 'keyboard'),
    startAudio,
    playMenuNote: () => {},
    releaseMenuNote: () => {},
    releaseAllHeld: () => session.releaseSource('keyboard'),
  });

  const touch = new TouchInputController({
    press: (code, source) => session.press(code, source),
    release: (code, source) => session.release(code, source),
    startAudio,
    getZoneAt: zoneAt,
  });

  const kd = (code: string) => keyboard.handleKeyDown({ code, preventDefault() {} });
  const ku = (code: string) => keyboard.handleKeyUp({ code, preventDefault() {} });

  return {
    backend,
    engine,
    session,
    keyboard,
    touch,
    kd,
    ku,
    /** Resolve Tone.start() and wait for the engine to be usable. */
    ready: async () => {
      const starting = engine.ensureStarted();
      backend.resolve();
      await starting;
      await Promise.resolve();
    },
    setMenu: (on: boolean) => {
      menu = on;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('cross-level hand-off', () => {
  it('normal level 1 -> result -> level 2 hand-off starts clean', async () => {
    const h = wire();
    await h.ready();
    h.session.begin(LEVEL_1);
    h.advance(200);
    h.kd('KeyA');
    expect(h.session.getSnapshot().startTime).toBe(10_200);
    h.ku('KeyA');
    expect(h.session.getSnapshot().currentStep).toBe(1);

    h.advance(300);
    h.kd('KeyS');
    expect(h.session.getSnapshot().completed).toBe(true); // result screen
    expect(h.session.getSnapshot().finalTime).toBe(300);
    h.ku('KeyS');

    // Next level begins (fresh session).
    h.advance(1000);
    h.session.begin(LEVEL_2);

    const clean = h.session.getSnapshot();
    expect(clean.currentStep).toBe(0);
    expect(clean.startTime).toBe(0);
    expect(clean.pressedCodes).toEqual([]);
    expect(clean.playerState.every((v) => v === 0)).toBe(true);

    // The first press of the new level starts its timer, from now (not 0).
    h.kd('KeyA'); // not the target, but a real press
    expect(h.session.getSnapshot().startTime).toBe(11_500);
    expect(h.session.getSnapshot().pressedCodes).toEqual(['KeyA']);
  });

  it('the "any key" that finished level 1 cannot start or advance level 2', () => {
    const h = wire();
    h.session.begin(LEVEL_2); // single-pattern level
    h.kd('Semicolon');
    expect(h.session.getSnapshot().completed).toBe(true);

    // Key is still physically held when the player advances to the next level.
    h.session.begin(LEVEL_2);

    // Auto-repeat while held must be ignored.
    h.keyboard.handleKeyDown({ code: 'Semicolon', repeat: true, preventDefault() {} });
    expect(h.session.getSnapshot().startTime).toBe(0);
    expect(h.session.getSnapshot().completed).toBe(false);

    // Release + fresh press starts the new level.
    h.ku('Semicolon');
    h.kd('Semicolon');
    expect(h.session.getSnapshot().startTime).not.toBe(0);
  });

  it('rapid double key press does not double-advance or double-attack', async () => {
    const h = wire();
    await h.ready();
    h.session.begin(LEVEL_1);

    h.kd('KeyA');
    h.kd('KeyA'); // duplicate keydown without keyup
    expect(h.backend.attacks).toEqual(['C2']);
    expect(h.session.getSnapshot().currentStep).toBe(1); // advanced once
  });

  it('audio initialised mid-level flushes only the current level note, never an old one', async () => {
    const h = wire();
    h.session.begin(LEVEL_1);

    // Press before AudioContext is ready (start is deferred).
    h.kd('KeyA');
    expect(h.backend.startCalls).toBe(1);
    expect(h.backend.attacks).toEqual([]); // not played yet

    // Resolve initialisation: the queued press for the *current* session plays.
    h.backend.resolve();
    await h.engine.ensureStarted();
    await Promise.resolve();
    expect(h.backend.attacks).toEqual(['C2']);
  });

  it('a note queued for level 1 is dropped if the player switches before init completes', async () => {
    const h = wire();
    h.session.begin(LEVEL_1);
    h.kd('KeyA'); // queued
    h.ku('KeyA');

    // Rapid switch before Tone.start() resolves.
    h.session.begin(LEVEL_2);
    h.backend.resolve();
    await h.engine.ensureStarted();
    await Promise.resolve();

    // Level 1's queued C2 must not sound in level 2.
    expect(h.backend.attacks).toEqual([]);

    // A fresh press in level 2 plays normally now that audio is ready.
    h.kd('Semicolon');
    expect(h.backend.attacks).toEqual(['D3']);
  });

  it('touching through a level switch leaves no hanging notes', () => {
    const h = wire();
    h.session.begin(LEVEL_1);
    h.touch.touchStart([{ identifier: 1, x: 10, y: 10 }]); // A down
    expect(h.session.getSnapshot().pressedCodes).toEqual(['KeyA']);

    // Player leaves the level mid-touch.
    h.session.stop();
    h.touch.releaseAll();

    expect(h.session.getSnapshot().pressedCodes).toEqual([]);
    expect(h.session.getSnapshot().playerState.every((v) => v === 0)).toBe(true);
    // Session stop released all notes; the stale touch release is a no-op.
    expect(h.backend.releases).toEqual([]);
    expect(h.engine.isInitialized()).toBe(false); // never initialised in this test
  });

  it('keyboard and touch holding the same key release the note exactly once', async () => {
    const h = wire();
    await h.ready();
    h.session.begin(LEVEL_1);

    h.kd('KeyA');
    h.touch.touchStart([{ identifier: 1, x: 10, y: 10 }]); // same zone => A
    expect(h.backend.attacks).toEqual(['C2']);

    h.ku('KeyA');
    expect(h.backend.releases).toEqual([]); // touch still holds
    h.touch.touchEnd([{ identifier: 1, x: 10, y: 10 }]);
    expect(h.backend.releases).toEqual(['C2']);
  });
});
