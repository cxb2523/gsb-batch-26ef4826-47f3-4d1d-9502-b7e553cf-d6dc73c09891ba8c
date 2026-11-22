import { describe, it, expect, vi } from 'vitest';
import { createOffsetSync, type OffsetSyncResult } from '../src/player/offsetSync';
import type { SubtitleData } from '../src/types';

function subtitles(offsetMs: number): SubtitleData {
  return { offsetMs, cues: [{ start: 10 + offsetMs / 1000, end: 12 + offsetMs / 1000, text: 'こんにちは' }] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** 允许测试手动决定每个 PUT/GET 何时返回，模拟网络乱序。 */
function controllable() {
  const puts: { mediaId: number; offsetMs: number; gate: ReturnType<typeof deferred<void>> }[] = [];
  const gets: { mediaId: number; gate: ReturnType<typeof deferred<SubtitleData>> }[] = [];
  const applied: OffsetSyncResult[] = [];
  const errors: unknown[] = [];
  const sync = createOffsetSync({
    setOffset: (mediaId, offsetMs) => {
      const gate = deferred<void>();
      puts.push({ mediaId, offsetMs, gate });
      return gate.promise;
    },
    loadSubtitles: (mediaId) => {
      const gate = deferred<SubtitleData>();
      gets.push({ mediaId, gate });
      return gate.promise;
    },
    apply: (result) => applied.push(result),
    onError: (error) => errors.push(error),
  });
  return { sync, puts, gets, applied, errors };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createOffsetSync', () => {
  it('sends the request and applies the freshly loaded subtitles', async () => {
    const { sync, puts, gets, applied } = controllable();
    sync.reset(3, 0);
    const run = sync.adjust(100);
    await flush();
    expect(puts.map((p) => p.offsetMs)).toEqual([100]);
    puts[0].gate.resolve();
    await flush();
    gets[0].gate.resolve(subtitles(100));
    await run;

    expect(applied).toHaveLength(1);
    expect(applied[0].mediaId).toBe(3);
    expect(applied[0].data.offsetMs).toBe(100);
    expect(applied[0].data.cues[0].start).toBeCloseTo(10.1);
  });

  it('serializes rapid presses and only applies the latest result', async () => {
    const { sync, puts, gets, applied } = controllable();
    sync.reset(3, 0);

    const first = sync.adjust(100);
    await flush();
    // 第一次请求还在途中时再次连按
    const second = sync.adjust(100);
    const third = sync.adjust(100);

    // 只有第一发已发出；后续请求排队等待
    expect(puts).toHaveLength(1);
    puts[0].gate.resolve();
    await flush();
    // 第一代已被新一代取代：既不拉取新字幕，也不写回界面
    expect(gets).toHaveLength(0);
    expect(applied).toHaveLength(0);

    // 连按被合并成目标累计值 300，中间代次不再发请求
    expect(puts.map((p) => p.offsetMs)).toEqual([100, 300]);
    puts[1].gate.resolve();
    await flush();
    gets[0].gate.resolve(subtitles(300));
    await Promise.all([first, second, third]);

    expect(applied).toHaveLength(1);
    expect(applied[0].data.offsetMs).toBe(300);
  });

  it('does not let a slow earlier response overwrite a newer one', async () => {
    const { sync, puts, gets, applied } = controllable();
    sync.reset(9, 0);

    const first = sync.adjust(100);
    await flush();
    puts[0].gate.resolve();
    await flush();
    const second = sync.adjust(-100);
    await flush();
    // 早先的 GET 现在才返回
    gets[0].gate.resolve(subtitles(100));
    await flush();
    expect(applied).toHaveLength(0);

    expect(puts.map((p) => p.offsetMs)).toEqual([100, 0]);
    puts[1].gate.resolve();
    await flush();
    gets[1].gate.resolve(subtitles(0));
    await Promise.all([first, second]);

    expect(applied.map((a) => a.data.offsetMs)).toEqual([0]);
  });

  it('starts each new adjustment from the server-confirmed offset', async () => {
    const { sync, puts, gets } = controllable();
    sync.reset(4, 500);

    const run = sync.adjust(100);
    await flush();
    puts[0].gate.resolve();
    await flush();
    // 服务端取整后的偏移成为下一次调整的基准
    gets[0].gate.resolve(subtitles(601));
    await run;

    const next = sync.adjust(100);
    await flush();
    expect(puts.map((p) => p.offsetMs)).toEqual([600, 701]);
    puts[1].gate.resolve();
    await flush();
    gets[1].gate.resolve(subtitles(701));
    await next;
  });

  it('drops in-flight responses after switching episodes', async () => {
    const { sync, puts, gets, applied } = controllable();
    sync.reset(1, 0);
    const run = sync.adjust(100);
    await flush();
    puts[0].gate.resolve();
    await flush();

    // 切集：新的字幕载入前，旧请求的响应不得写回
    sync.invalidate();
    gets[0].gate.resolve(subtitles(100));
    await run;
    expect(applied).toHaveLength(0);

    // 新一集载入后可以继续调整，且以新一集的偏移为基准
    sync.reset(2, 0);
    const next = sync.adjust(200);
    await flush();
    expect(puts[1]).toMatchObject({ mediaId: 2, offsetMs: 200 });
    puts[1].gate.resolve();
    await flush();
    gets[1].gate.resolve(subtitles(200));
    await next;
    expect(applied).toHaveLength(1);
    expect(applied[0].mediaId).toBe(2);
  });

  it('ignores adjustments before any subtitles are loaded', async () => {
    const { sync, puts } = controllable();
    await sync.adjust(100);
    expect(puts).toHaveLength(0);
  });

  it('reports errors for the current generation only', async () => {
    const { sync, puts, gets, applied, errors } = controllable();
    sync.reset(5, 0);
    const run = sync.adjust(100);
    await flush();
    puts[0].gate.reject(new Error('HTTP 500'));
    await run;
    expect(errors).toHaveLength(1);
    expect(applied).toHaveLength(0);
    expect(gets).toHaveLength(0);
  });

  it('continues from the last server-confirmed offset after a failed adjustment', async () => {
    const { sync, puts, gets, errors } = controllable();
    sync.reset(5, 400);

    const failed = sync.adjust(100);
    await flush();
    puts[0].gate.reject(new Error('HTTP 500'));
    await failed;
    expect(errors).toHaveLength(1);

    // 失败的那次不累加：下一次调整仍以服务端确认的 400 为基准
    const run = sync.adjust(100);
    await flush();
    expect(puts.map((p) => p.offsetMs)).toEqual([500, 500]);
    puts[1].gate.resolve();
    await flush();
    gets[0].gate.resolve(subtitles(500));
    await run;
  });
});
