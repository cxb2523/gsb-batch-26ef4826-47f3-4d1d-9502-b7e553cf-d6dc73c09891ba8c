import { describe, it, expect } from 'vitest';
import { realignCueIndex, sourceStart } from '../src/player/subtitleTimeline';
import { currentCueIndex } from '../src/player/learningMode';
import type { Cue, SubtitleData } from '../src/types';

const baseCues: Cue[] = [
  { start: 1, end: 3, text: '一句目' },
  { start: 5, end: 8, text: '二句目' },
  { start: 10, end: 12, text: '三句目' },
];

function shifted(offsetMs: number, cues: Cue[] = baseCues): SubtitleData {
  const delta = offsetMs / 1000;
  return {
    offsetMs,
    cues: cues.map((c) => ({ ...c, start: c.start + delta, end: c.end + delta })),
  };
}

describe('sourceStart', () => {
  it('removes the applied offset to recover the subtitle file timeline', () => {
    expect(sourceStart({ start: 5.4, end: 8.4, text: 'x' }, 400)).toBeCloseTo(5);
    expect(sourceStart({ start: 4.6, end: 7.6, text: 'x' }, -400)).toBeCloseTo(5);
  });
});

describe('realignCueIndex', () => {
  it('keeps the same sentence selected after the offset changes', () => {
    const before = shifted(-300);
    const after = shifted(200);
    expect(realignCueIndex(before, after, 1)).toBe(1);
  });

  it('finds the same sentence even when cue order metadata changes shape', () => {
    const before = shifted(0);
    const after = shifted(500, [baseCues[0], { start: 4, end: 4.5, text: '挿入句' }, ...baseCues.slice(1)]);
    expect(realignCueIndex(before, after, 2)).toBe(3);
  });

  it('falls back to the original index (clamped) when no cue matches', () => {
    const before = shifted(0);
    const after = shifted(0, [baseCues[0], { start: 20, end: 22, text: '別の句' }]);
    expect(realignCueIndex(before, after, 8)).toBe(1);
    expect(realignCueIndex(before, after, 0)).toBe(0);
  });

  it('returns null for no selection or an empty subtitle list', () => {
    expect(realignCueIndex(shifted(0), shifted(100), null)).toBeNull();
    expect(realignCueIndex(shifted(0), shifted(100), -1)).toBeNull();
    expect(realignCueIndex(shifted(0), shifted(100, []), 1)).toBeNull();
  });
});

describe('cue index after offset realignment', () => {
  it('recomputes the active cue from the new timeline at the same playback time', () => {
    const time = 9;
    expect(currentCueIndex(shifted(0).cues, time)).toBe(1);
    // 字幕整体后移 1 秒后，同一时刻落在第二句的间隙里，仍按“直前の句”算第二句
    expect(currentCueIndex(shifted(1000).cues, time)).toBe(1);
    // 前移 1 秒后，9 秒落在第三句之外
    expect(currentCueIndex(shifted(-1000).cues, time)).toBe(2);
    // 同一时间点上的“当前句”随新字幕改变
    expect(currentCueIndex(shifted(-2000).cues, time)).toBe(2);
    expect(currentCueIndex(shifted(2000).cues, time)).toBe(1);
  });

  it('keeps the same sentence selected (not the stale index) when the time now falls on the next line', () => {
    const before = shifted(0);
    const after = shifted(-2000); // 整体提前 2 秒：9 秒处现在已在第三句前
    const selectedBefore = 1;      // 用户原本停在第二句
    const activeAfter = currentCueIndex(after.cues, 9);
    expect(activeAfter).toBe(2);
    expect(realignCueIndex(before, after, selectedBefore)).toBe(1);
  });
});
