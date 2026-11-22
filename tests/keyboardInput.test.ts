import { describe, expect, it } from 'bun:test';
import { KeyboardInputController } from '../src/lib/keyboardInput';
import { GameSession } from '../src/lib/gameSession';
import type { AudioPort } from '../src/lib/audioEngine';
import type { Level } from '../src/lib/level';

class FakeAudio implements AudioPort {
  attacks: string[] = [];
  releases: string[] = [];
  releaseAllCalls = 0;
  playNote(key: string) {
    this.attacks.push(key);
  }
  releaseNote(key: string) {
    this.releases.push(key);
  }
  releaseAll() {
    this.releaseAllCalls += 1;
  }
  beginLevelSession() {
    return 1;
  }
  endLevelSession() {
    return 2;
  }
}

const LEVEL: Level = {
  name: 'l',
  patterns: [
    [1, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 1],
  ],
  ranks: [1, 2, 3],
};

interface Harness {
  controller: KeyboardInputController;
  session: GameSession;
  audio: FakeAudio;
  menuNotes: { played: string[]; released: string[] };
  setMenu(on: boolean): void;
  startCalls: number;
}

function harness(): Harness {
  const audio = new FakeAudio();
  const now = 5000;
  const session = new GameSession(audio, () => now);
  let menu = true;
  const menuNotes = { played: [] as string[], released: [] as string[] };

  const controller = new KeyboardInputController({
    isLevelActive: () => session.getSnapshot().active,
    isMenu: () => menu,
    press: (code) => {
      session.press(code, 'keyboard');
    },
    release: (code) => {
      session.release(code, 'keyboard');
    },
    startAudio: () => {
      harnessResult.startCalls += 1;
    },
    playMenuNote: (key) => {
      menuNotes.played.push(key);
    },
    releaseMenuNote: (key) => {
      menuNotes.released.push(key);
    },
    releaseAllHeld: () => {
      session.releaseSource('keyboard');
      audio.releaseAll();
    },
  });

  const harnessResult: Harness = {
    controller,
    session,
    audio,
    menuNotes,
    setMenu: (on: boolean) => {
      menu = on;
    },
    startCalls: 0,
  };
  return harnessResult;
}

const key = (code: string, repeat = false) => ({
  code,
  repeat,
  preventDefault: () => {},
});

describe('KeyboardInputController', () => {
  it('filters auto-repeat and duplicate keydown', () => {
    const h = harness();
    h.session.begin(LEVEL);
    h.setMenu(false);

    h.controller.handleKeyDown(key('KeyA'));
    h.controller.handleKeyDown(key('KeyA'));
    h.controller.handleKeyDown(key('KeyA', true));

    expect(h.audio.attacks).toEqual(['a']);
    expect(h.session.getSnapshot().playerState[0]).toBe(1);
  });

  it('a key held across a level transition cannot start the new level timer', () => {
    const h = harness();
    h.session.begin(LEVEL);
    h.setMenu(false);
    h.controller.handleKeyDown(key('KeyA')); // still held

    // New level begins while A is held down (e.g. the key that finished the
    // previous level). The physical set still says A is down.
    h.session.begin(LEVEL);

    // Auto-repeat while held must be ignored...
    h.controller.handleKeyDown(key('KeyA', true));
    // ...and even a non-repeat duplicate (browser quirk) is deduped.
    h.controller.handleKeyDown(key('KeyA'));

    expect(h.session.getSnapshot().startTime).toBe(0);
    expect(h.session.getSnapshot().pressedCodes).toEqual([]);

    // Releasing (a no-op for the new session) then pressing starts the timer.
    h.controller.handleKeyUp(key('KeyA'));
    h.controller.handleKeyDown(key('KeyA'));
    expect(h.session.getSnapshot().startTime).not.toBe(0);
  });

  it('triggering audio start happens on the first press only', () => {
    const h = harness();
    h.session.begin(LEVEL);
    h.setMenu(false);

    h.controller.handleKeyDown(key('KeyA'));
    h.controller.handleKeyUp(key('KeyA'));
    h.controller.handleKeyDown(key('KeyA'));

    expect(h.startCalls).toBe(2); // one per physical press, not auto-repeat
  });

  it('plays and releases menu free-play notes on the level select screen', () => {
    const h = harness();
    h.setMenu(true);

    h.controller.handleKeyDown(key('KeyJ'));
    h.controller.handleKeyUp(key('KeyJ'));

    expect(h.menuNotes.played).toEqual(['j']);
    expect(h.menuNotes.released).toEqual(['j']);
    expect(h.session.getSnapshot().active).toBe(false);
  });

  it('does not play menu notes while a level is active', () => {
    const h = harness();
    h.session.begin(LEVEL);
    h.setMenu(false);

    h.controller.handleKeyDown(key('KeyJ'));
    expect(h.menuNotes.played).toEqual([]);
    expect(h.audio.attacks).toEqual(['j']);
  });

  it('blur releases held keys and clears the physical set', () => {
    const h = harness();
    h.session.begin(LEVEL);
    h.setMenu(false);

    h.controller.handleKeyDown(key('KeyA'));
    expect(h.controller.heldCodes).toEqual(['KeyA']);

    h.controller.handleBlur();
    expect(h.controller.heldCodes).toEqual([]);
    expect(h.session.getSnapshot().pressedCodes).toEqual([]);
    expect(h.audio.releaseAllCalls).toBe(1);

    // After blur, a fresh keydown is accepted again.
    h.controller.handleKeyDown(key('KeyA'));
    expect(h.session.getSnapshot().playerState[0]).toBe(1);
  });
});
