import { describe, expect, it } from 'bun:test';
import { TouchInputController } from '../src/lib/touchInput';
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

/** Zone rectangles: 0..7 across the top, 8 the bottom strip. */
function zoneAt(x: number, y: number): number {
  if (y > 400) return 8;
  if (y < 0 || y > 500) return -1;
  const zone = Math.floor(x / 100);
  if (zone < 0 || zone > 7) return -1;
  return zone;
}

function harness() {
  const audio = new FakeAudio();
  let now = 1000;
  const session = new GameSession(audio, () => now);
  let startCalls = 0;

  const controller = new TouchInputController({
    press: (code, source) => {
      session.press(code, source);
    },
    release: (code, source) => {
      session.release(code, source);
    },
    startAudio: () => {
      startCalls += 1;
    },
    getZoneAt: zoneAt,
  });

  return {
    controller,
    session,
    audio,
    get startCalls() {
      return startCalls;
    },
    begin: () => session.begin(LEVEL),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('TouchInputController', () => {
  it('presses the mapped key for a touched zone and releases on touchend', () => {
    const h = harness();
    h.session.begin(LEVEL);

    h.controller.touchStart([{ identifier: 1, x: 10, y: 10 }]); // zone 0 => A
    expect(h.session.getSnapshot().playerState[0]).toBe(1);
    expect(h.audio.attacks).toEqual(['a']);

    h.controller.touchEnd([{ identifier: 1, x: 10, y: 10 }]);
    expect(h.session.getSnapshot().playerState[0]).toBe(0);
    expect(h.audio.releases).toEqual(['a']);
  });

  it('dedupes two fingers on the same zone', () => {
    const h = harness();
    h.session.begin(LEVEL);

    h.controller.touchStart([{ identifier: 1, x: 10, y: 10 }]);
    h.controller.touchStart([{ identifier: 2, x: 20, y: 10 }]);
    expect(h.audio.attacks).toEqual(['a']);

    h.controller.touchEnd([{ identifier: 1, x: 10, y: 10 }]);
    expect(h.session.getSnapshot().playerState[0]).toBe(1); // finger 2 still holds

    h.controller.touchEnd([{ identifier: 2, x: 20, y: 10 }]);
    expect(h.session.getSnapshot().playerState[0]).toBe(0);
    expect(h.audio.releases).toEqual(['a']);
  });

  it('releases the old note and presses the new one when sliding between zones', () => {
    const h = harness();
    h.session.begin(LEVEL);

    h.controller.touchStart([{ identifier: 1, x: 10, y: 10 }]); // A
    h.controller.touchMove([{ identifier: 1, x: 210, y: 10 }]); // zone 2 => D

    expect(h.audio.attacks).toEqual(['a', 'd']);
    expect(h.audio.releases).toEqual(['a']);
    expect(h.session.getSnapshot().playerState[0]).toBe(0);
    expect(h.session.getSnapshot().playerState[2]).toBe(1);
  });

  it('releases the note when a finger slides out of the board', () => {
    const h = harness();
    h.session.begin(LEVEL);

    h.controller.touchStart([{ identifier: 1, x: 10, y: 10 }]); // A
    h.controller.touchMove([{ identifier: 1, x: -50, y: 10 }]); // outside

    expect(h.audio.releases).toEqual(['a']);
    expect(h.session.getSnapshot().pressedCodes).toEqual([]);
    expect(h.controller.activeTouchIds).toEqual([]);
  });

  it('touchcancel releases the note (no hanging note)', () => {
    const h = harness();
    h.session.begin(LEVEL);

    h.controller.touchStart([{ identifier: 1, x: 10, y: 10 }]); // A
    h.controller.touchEnd([{ identifier: 1, x: 10, y: 10 }]); // shared handler

    expect(h.audio.releases).toEqual(['a']);
    expect(h.session.getSnapshot().playerState.every((v) => v === 0)).toBe(true);
  });

  it('a level switch while a finger is down does not leave a ghost key', () => {
    const h = harness();
    h.session.begin(LEVEL);
    h.controller.touchStart([{ identifier: 1, x: 10, y: 10 }]); // A held

    // Level generation changes: the overlay effect calls releaseAll().
    h.session.begin(LEVEL);
    h.controller.releaseAll();

    const snapshot = h.session.getSnapshot();
    expect(snapshot.pressedCodes).toEqual([]);
    expect(snapshot.startTime).toBe(0);
    // The new session ignores the stale release; no release event is emitted.
    expect(h.audio.releases).toEqual([]);
  });

  it('a finger held across a level switch cannot start the new level until lifted and re-pressed', () => {
    const h = harness();
    h.session.begin(LEVEL);
    h.controller.touchStart([{ identifier: 1, x: 10, y: 10 }]); // zone 0 => A

    h.session.begin(LEVEL);
    h.controller.releaseAll(); // overlay reacts to the generation change

    // The browser keeps sending touchmove for the same finger; it is ignored.
    h.controller.touchMove([{ identifier: 1, x: 110, y: 10 }]); // zone 1
    expect(h.session.getSnapshot().startTime).toBe(0);
    expect(h.session.getSnapshot().pressedCodes).toEqual([]);

    // Lifting the finger clears suppression; a fresh touch starts the level.
    h.controller.touchEnd([{ identifier: 1, x: 110, y: 10 }]);
    h.controller.touchStart([{ identifier: 2, x: 10, y: 10 }]);
    expect(h.session.getSnapshot().startTime).not.toBe(0);
    expect(h.session.getSnapshot().pressedCodes).toEqual(['KeyA']);
  });

  it('a finger already on the glass when the new level mounts is not a press', () => {
    const h = harness();
    h.session.begin(LEVEL);

    // The overlay for a *fresh* level receives touchmove (not touchstart) for
    // a finger that was already down when the previous level ended.
    h.controller.touchMove([{ identifier: 9, x: 10, y: 10 }]); // slides onto zone 0
    expect(h.session.getSnapshot().startTime).toBe(0);
    expect(h.session.getSnapshot().pressedCodes).toEqual([]);

    // It stays ignored until it lifts, then a fresh touch works normally.
    h.controller.touchMove([{ identifier: 9, x: 110, y: 10 }]);
    expect(h.session.getSnapshot().pressedCodes).toEqual([]);
    h.controller.touchEnd([{ identifier: 9, x: 110, y: 10 }]);
    h.controller.touchStart([{ identifier: 10, x: 10, y: 10 }]);
    expect(h.session.getSnapshot().startTime).not.toBe(0);
  });

  it('exposes a stable zone snapshot used for highlighting', () => {
    const h = harness();
    h.session.begin(LEVEL);

    const empty = h.controller.zonesSnapshot;
    expect(empty.some(Boolean)).toBe(false);

    h.controller.touchStart([{ identifier: 1, x: 10, y: 450 }]); // zone 8 (space)
    expect(h.controller.zonesSnapshot[8]).toBe(true);
    expect(h.controller.zonesSnapshot).not.toBe(empty);
  });

  it('starts audio on first touch', () => {
    const h = harness();
    h.session.begin(LEVEL);
    h.controller.touchStart([{ identifier: 1, x: 10, y: 10 }]);
    expect(h.startCalls).toBe(1);
  });
});
