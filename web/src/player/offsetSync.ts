import type { SubtitleData } from '../types';

export interface OffsetSyncResult {
  mediaId: number;
  offsetMs: number;
  data: SubtitleData;
}

export interface OffsetSyncOptions {
  setOffset(mediaId: number, offsetMs: number): Promise<unknown>;
  loadSubtitles(mediaId: number): Promise<SubtitleData>;
  apply(result: OffsetSyncResult): void;
  onError?(error: unknown): void;
}

export interface OffsetSync {
  /** 切集/卸载：作废在途请求，并暂停接受新的调整，直到新一集字幕载入。 */
  invalidate(): void;
  /** 新字幕载入（初次载入或切集后）：以服务端偏移作为后续调整的基准。 */
  reset(mediaId: number, offsetMs: number): void;
  /** 微调偏移；快速连按时按累计目标串行发送，只有最后一次结果会落到界面。 */
  adjust(deltaMs: number): Promise<void>;
}

/**
 * 字幕偏移的请求协调器。
 *
 * - PUT 与随后的 GET 串行执行，避免连按时后发的请求先到、被先发的响应覆盖；
 * - 每次调整带代次（generation），只有最新代次的结果允许写回界面；
 * - 切集调用 invalidate 后，旧一集的在途响应一律丢弃，不会把旧字幕写回新页面。
 */
export function createOffsetSync(options: OffsetSyncOptions): OffsetSync {
  let generation = 0;
  let activeMediaId: number | null = null;
  let confirmedOffsetMs: number | null = null;
  let targetOffsetMs: number | null = null;
  let chain: Promise<void> = Promise.resolve();

  function invalidate(): void {
    generation += 1;
    activeMediaId = null;
    confirmedOffsetMs = null;
    targetOffsetMs = null;
  }

  function reset(mediaId: number, offsetMs: number): void {
    generation += 1;
    activeMediaId = mediaId;
    confirmedOffsetMs = offsetMs;
    targetOffsetMs = offsetMs;
  }

  function adjust(deltaMs: number): Promise<void> {
    const mediaId = activeMediaId;
    const base = targetOffsetMs;
    if (mediaId == null || base == null) return Promise.resolve();

    const myGeneration = ++generation;
    targetOffsetMs = base + deltaMs;
    const target = targetOffsetMs;

    const run = chain.then(() => execute(mediaId, myGeneration, target));
    chain = run.catch(() => undefined);
    return run;
  }

  async function execute(mediaId: number, myGeneration: number, target: number): Promise<void> {
    if (myGeneration !== generation) return;
    try {
      await options.setOffset(mediaId, target);
      if (myGeneration !== generation) return;
      const data = await options.loadSubtitles(mediaId);
      if (myGeneration !== generation) return;
      confirmedOffsetMs = data.offsetMs;
      targetOffsetMs = data.offsetMs;
      options.apply({ mediaId, offsetMs: data.offsetMs, data });
    } catch (error) {
      if (myGeneration !== generation) return;
      // 失败后回退到服务端确认过的偏移，避免下次连按从没写成功的值继续累加。
      targetOffsetMs = confirmedOffsetMs;
      options.onError?.(error);
    }
  }

  return { invalidate, reset, adjust };
}
