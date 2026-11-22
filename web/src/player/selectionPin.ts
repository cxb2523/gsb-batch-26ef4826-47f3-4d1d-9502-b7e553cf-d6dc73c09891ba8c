import type { Cue } from '../types';

export interface SelectionSnapshot {
  cues: Cue[];
  time: number;
}

export interface SelectionUpdate {
  selected: number | null;
  /** 本次渲染后仍需钉住的选中句；null 表示交还给正常的“暂停跟随当前句”逻辑。 */
  pin: SelectionSnapshot | null;
}

function clamp(index: number | null, length: number): number | null {
  return index == null ? null : Math.min(index, length - 1);
}

/**
 * 解析面板选中句的计算。
 *
 * 偏移调整会用新时间轴替换字幕，此时“当前句”可能变成另一句；但用户原本停在的
 * 那一句已经在 `realignCueIndex` 里映射到新索引，不应该被暂停跟随逻辑改回去。
 * 用「字幕数组换了、播放时间没动」识别偏移刷新，并一直钉住到播放时间变化为止；
 * StrictMode 的双次调用也因此保持幂等。
 */
export function nextAnalysisSelection(params: {
  cues: Cue[];
  time: number;
  cueIdx: number;
  paused: boolean;
  selected: number | null;
  /** 上一次渲染时的字幕与时间。 */
  previous: SelectionSnapshot | null;
  /** 当前仍钉住的字幕与时间。 */
  pin: SelectionSnapshot | null;
  followPaused: (selected: number | null, cueIdx: number, paused: boolean) => number | null;
}): SelectionUpdate {
  const { cues, time, cueIdx, paused, selected, previous, pin, followPaused } = params;

  const pinnedHere = pin != null && pin.cues === cues && pin.time === time;
  const timelineSwapped = previous != null && previous.cues !== cues && previous.time === time;

  if (timelineSwapped) {
    return { selected: clamp(selected, cues.length), pin: { cues, time } };
  }
  if (pinnedHere) {
    return { selected: clamp(selected, cues.length), pin };
  }
  return { selected: followPaused(selected, cueIdx, paused), pin: null };
}
