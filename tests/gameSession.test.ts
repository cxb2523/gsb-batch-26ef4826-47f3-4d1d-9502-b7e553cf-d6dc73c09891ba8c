import { describe, expect, it } from 'bun:test';
import { GameSession } from '../src/lib/gameSession';
import type { AudioPort } from '../src/lib/audioEngine';
import type { Level } from '../src/lib/level';

class FakeAudio implements AudioPort {
  attacks: string[] = [];
  releases: string[] = [];
  releaseAllCalls = 0;
  sessions: string[] = [];

  playNote(key: string): void {
    this.attacks.push(key);
  }
  releaseNote(key: string): void {
    this.releases.push(key);
  }
  releaseAll(): void {
    this.releaseAllCalls += 1;
  }
  beginLevelSession(): number {
    this.sessions.push('begin');
    return this.sessions.length;
  }
  endLevelSession(): number {
    this.sessions.push('end');
    return this.sessions.length;
  }
}

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
    [0, 0, 1, 0, 0, 0, 0, 0, 0], // D
  ],
  ranks: [1, 2, 3],
};

function makeSession(audio = new FakeAudio()) {
  let now = 1000;
  const session = new GameSession(audio, () => now);
  return {
    session,
    audio,
    advance: (ms: number) => {
      now += ms;
    },
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe('GameSession', () => {
  it('does not start the timer until a real press', () => {
    const { session } = makeSession();
    session.begin(LEVEL_1);
    expect(session.getSnapshot().startTime).toBe(0);

    session.press('KeyA', 'keyboard');
    expect(session.getSnapshot().startTime).toBe(1000);
  });

  it('advances steps on match and completes exactly once, once the final pattern is matched', () => {
    const { session, advance, audio } = makeSession();
    session.begin(LEVEL_1);

    session.press('KeyA', 'keyboard');
    session.release('KeyA', 'keyboard');
    expect(session.getSnapshot().currentStep).toBe(1);

    advance(500);
    session.press('KeyS', 'keyboard');
    // Final match happens while S is still held.
    const snapshot = session.getSnapshot();
    expect(snapshot.completed).toBe(true);
    expect(snapshot.finalTime).toBe(500);
    expect(snapshot.active).toBe(false);
    expect(snapshot.playerState.every((v) => v === 0)).toBe(true);
    expect(audio.sessions).toEqual(['begin', 'end']);
  });

  it('ignores input before a level is begun and after completion', () => {
    const { session } = makeSession();
    expect(session.press('KeyA', 'keyboard')).toBe(false);

    session.begin(LEVEL_2);
    session.press('KeyD', 'keyboard');
    expect(session.getSnapshot().completed).toBe(true);

    expect(session.press('KeyD', 'keyboard')).toBe(false);
    expect(session.getSnapshot().playerState.every((v) => v === 0)).toBe(true);
  });

  it('dedupes the same key across keyboard and touch sources', () => {
    const { session, audio } = makeSession();
    session.begin(LEVEL_1);

    session.press('KeyA', 'keyboard');
    session.press('KeyA', 'touch:1');
    expect(audio.attacks).toEqual(['a']); // pressed once

    session.release('KeyA', 'keyboard');
    expect(audio.releases).toEqual([]); // touch still holds it
    expect(session.getSnapshot().playerState[0]).toBe(1);

    session.release('KeyA', 'touch:1');
    expect(audio.releases).toEqual(['a']);
    expect(session.getSnapshot().playerState[0]).toBe(0);
  });

  it('clears held keys, player state, step and timer when a new level begins', () => {
    const { session, audio } = makeSession();
    session.begin(LEVEL_1);
    session.press('KeyA', 'keyboard');
    expect(session.getSnapshot().startTime).toBe(1000);

    session.begin(LEVEL_2);

    const snapshot = session.getSnapshot();
    expect(snapshot.pressedCodes).toEqual([]);
    expect(snapshot.playerState.every((v) => v === 0)).toBe(true);
    expect(snapshot.currentStep).toBe(0);
    expect(snapshot.startTime).toBe(0);
    expect(snapshot.level).toBe(LEVEL_2);
    // Two session starts, each of which silences the previous session.
    expect(audio.sessions).toEqual(['begin', 'begin']);
  });

  it('a key held from the previous level cannot start or advance the new one until re-pressed', () => {
    const { session } = makeSession();
    session.begin(LEVEL_1);
    session.press('KeyA', 'keyboard'); // held at switch time

    session.begin(LEVEL_2);
    // The same physical press must be released and pressed again.
    expect(session.release('KeyA', 'keyboard')).toBe(false); // no owner in new session
    expect(session.press('KeyA', 'keyboard')).toBe(true);
    expect(session.getSnapshot().startTime).toBe(1000);
    // Level 2's first pattern is D, so A does not advance anything.
    expect(session.getSnapshot().currentStep).toBe(0);
  });

  it('releaseSource releases only the keys that source owns', () => {
    const { session, audio } = makeSession();
    session.begin(LEVEL_1);

    session.press('KeyD', 'keyboard');
    session.press('KeyD', 'touch:7');
    session.releaseSource('keyboard');

    expect(session.getSnapshot().playerState[2]).toBe(1); // touch still holds
    session.releaseSource('touch:7');
    expect(session.getSnapshot().playerState[2]).toBe(0);
    expect(audio.releases).toEqual(['d']);
  });

  it('stop releases notes and fully resets state', () => {
    const { session, audio } = makeSession();
    session.begin(LEVEL_1);
    session.press('KeyA', 'keyboard');

    session.stop();

    const snapshot = session.getSnapshot();
    expect(snapshot.active).toBe(false);
    expect(snapshot.pressedCodes).toEqual([]);
    expect(snapshot.playerState.every((v) => v === 0)).toBe(true);
    expect(snapshot.startTime).toBe(0);
    expect(audio.sessions).toEqual(['begin', 'end']);
  });

  it('emits notifications and exposes a stable snapshot between changes', () => {
    const { session } = makeSession();
    let notifications = 0;
    session.subscribe(() => {
      notifications += 1;
    });

    session.begin(LEVEL_1);
    const a = session.getSnapshot();
    expect(session.getSnapshot()).toBe(a); // cached identity

    session.press('KeyA', 'keyboard');
    expect(session.getSnapshot()).not.toBe(a);
    expect(notifications).toBe(2);
  });
});
