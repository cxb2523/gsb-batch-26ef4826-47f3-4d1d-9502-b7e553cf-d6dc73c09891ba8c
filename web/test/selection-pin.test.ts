import { describe, it, expect } from 'vitest';
import { nextAnalysisSelection, type SelectionSnapshot } from '../src/player/selectionPin';
import { analysisCueIndex } from '../src/player/learningMode';
import type { Cue } from '../src/types';

const cuesA: Cue[] = [
  { start: 1, end: 3, text: '一' },
  { start: 5, end: 8, text: '二' },
];
const cuesB: Cue[] = [
  { start: 2, end: 4, text: '一' },
  { start: 6, end: 9, text: '二' },
];

function run(params: {
  cues: Cue[]; time: number; cueIdx: number; paused: boolean; selected: number | null;
  previous: SelectionSnapshot | null; pin: SelectionSnapshot | null;
}) {
  return nextAnalysisSelection({ ...params, followPaused: analysisCueIndex });
}

describe('nextAnalysisSelection', () => {
  it('follows the paused cue during normal playback changes', () => {
    const r = run({ cues: cuesA, time: 6, cueIdx: 1, paused: true, selected: 0, previous: null, pin: null });
    expect(r).toEqual({ selected: 1, pin: null });
  });

  it('keeps a manual selection while playing', () => {
    const r = run({ cues: cuesA, time: 6, cueIdx: 1, paused: false, selected: 0, previous: null, pin: null });
    expect(r).toEqual({ selected: 0, pin: null });
  });

  it('pins the realigned selection when the timeline is swapped at the same time', () => {
    const previous = { cues: cuesA, time: 6 };
    // 偏移调整后 realignCueIndex 已把选中句映射到索引 1
    const r = run({ cues: cuesB, time: 6, cueIdx: 0, paused: true, selected: 1, previous, pin: null });
    expect(r.selected).toBe(1);
    expect(r.pin).toEqual({ cues: cuesB, time: 6 });
  });

  it('stays pinned across repeated renders at the same time (StrictMode-safe)', () => {
    const pin = { cues: cuesB, time: 6 };
    const r = run({ cues: cuesB, time: 6, cueIdx: 0, paused: true, selected: 1, previous: { cues: cuesB, time: 6 }, pin });
    expect(r.selected).toBe(1);
    expect(r.pin).toBe(pin);
  });

  it('releases the pin once playback time changes', () => {
    const pin = { cues: cuesB, time: 6 };
    const r = run({ cues: cuesB, time: 7, cueIdx: 0, paused: true, selected: 1, previous: { cues: cuesB, time: 7 }, pin });
    expect(r.selected).toBe(0); // 暂停跟随到当前句
    expect(r.pin).toBeNull();
  });

  it('clamps a pinned selection that no longer fits the new cue list', () => {
    const previous = { cues: cuesA, time: 2 };
    const r = run({ cues: [cuesB[0]], time: 2, cueIdx: 0, paused: true, selected: 5, previous, pin: null });
    expect(r.selected).toBe(0);
  });

  it('keeps null selection null (nothing was selected)', () => {
    const previous = { cues: cuesA, time: 2 };
    const r = run({ cues: cuesB, time: 2, cueIdx: 0, paused: true, selected: null, previous, pin: null });
    expect(r.selected).toBeNull();
  });
});
