import type { Cue, SubtitleData } from '../types';

/**
 * 服务端返回的 cue 已经加过整体偏移，这里还原成字幕文件自身的源时间轴。
 * 偏移只平移时间、不改变句子顺序，因此同一句在调整前后的源时间应完全一致。
 */
export function sourceStart(cue: Cue, offsetMs: number): number {
  return cue.start - offsetMs / 1000;
}

/** 浮点换算（毫秒→秒）与解析取整带来的误差容忍；超过它就不再认为是同一句。 */
const SAME_CUE_TOLERANCE_SEC = 0.05;

function clampIndex(index: number, length: number): number {
  return Math.min(Math.max(index, 0), length - 1);
}

/**
 * 偏移调整后重新拉取字幕时，把已选句映射到新字幕上：
 * 优先按源时间轴找同一句（offset 变化不影响它），找不到时退回原索引（夹在新列表范围内）。
 * 这样暂停时不会因为时间没变、索引重算而跳到别的句子上。
 */
export function realignCueIndex(
  previous: Pick<SubtitleData, 'offsetMs' | 'cues'> | null,
  next: Pick<SubtitleData, 'offsetMs' | 'cues'>,
  index: number | null,
): number | null {
  if (index == null || index < 0) return null;
  if (next.cues.length === 0) return null;
  if (!previous || previous.cues.length === 0 || index >= previous.cues.length) {
    return clampIndex(index, next.cues.length);
  }

  const target = sourceStart(previous.cues[index], previous.offsetMs);
  let bestIndex = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < next.cues.length; i++) {
    const delta = Math.abs(sourceStart(next.cues[i], next.offsetMs) - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIndex = i;
    }
  }
  return bestDelta <= SAME_CUE_TOLERANCE_SEC ? bestIndex : clampIndex(index, next.cues.length);
}
