import { describe, it, expect, vi } from 'vitest';
import { createProgressSaver, progressSaveFor } from '../src/player/progressSync';

describe('progressSaveFor', () => {
  it('binds a save to the media whose video stream is loaded', () => {
    expect(progressSaveFor(7, 7, 42.5)).toEqual({ mediaId: 7, positionSec: 42.5 });
  });

  it('refuses to save before any video metadata is loaded', () => {
    expect(progressSaveFor(null, 7, 42.5)).toBeNull();
  });

  it('refuses to write another episode’s time onto the loaded one', () => {
    expect(progressSaveFor(2, 1, 42.5)).toBeNull();
    expect(progressSaveFor(1, 2, 42.5)).toBeNull();
  });

  it('ignores missing or non-positive positions', () => {
    expect(progressSaveFor(7, 7, 0)).toBeNull();
    expect(progressSaveFor(7, 7, -1)).toBeNull();
    expect(progressSaveFor(7, 7, NaN)).toBeNull();
    expect(progressSaveFor(7, 7, Infinity)).toBeNull();
  });
});

describe('createProgressSaver', () => {
  it('does nothing until the media metadata is loaded', () => {
    const write = vi.fn();
    const saver = createProgressSaver(write);
    saver.record(1, 30);
    saver.save(1, 30);
    saver.flush();
    expect(write).not.toHaveBeenCalled();
  });

  it('saves the loaded video position under its own mediaId', () => {
    const write = vi.fn();
    const saver = createProgressSaver(write);
    saver.mediaLoaded(11);
    saver.record(11, 64);
    saver.flush();
    saver.save(11, 65);
    expect(write.mock.calls).toEqual([[11, 64], [11, 65]]);
    expect(saver.loadedMediaId).toBe(11);
  });

  it('flushes the previous episode with its last recorded time, never the new episode id', () => {
    const write = vi.fn();
    const saver = createProgressSaver(write);
    saver.mediaLoaded(1);
    saver.record(1, 120);
    saver.record(1, 121.5);

    // 切集：此时 <video> 可能已经指向新 src，currentTime 不可信
    saver.mediaChanged();
    // 新视频还没载入元数据：这段时间的保存必须被丢弃
    saver.save(2, 3);
    saver.flush();
    saver.record(2, 4);

    expect(write.mock.calls).toEqual([[1, 121.5]]);
    expect(saver.loadedMediaId).toBeNull();

    // 新一集元数据载入后，保存归属新 mediaId
    saver.mediaLoaded(2);
    expect(saver.loadedMediaId).toBe(2);
    saver.save(2, 5);
    expect(write.mock.calls).toEqual([[1, 121.5], [2, 5]]);
  });

  it('drops a stale pause/timeupdate from the previous episode after the new one loaded', () => {
    const write = vi.fn();
    const saver = createProgressSaver(write);
    saver.mediaLoaded(1);
    saver.mediaChanged();
    saver.mediaLoaded(2);

    // 旧 <video> 的事件晚到：mediaId 不匹配，不能写到第 2 集
    saver.save(1, 300);
    saver.record(1, 300);

    expect(write).not.toHaveBeenCalled();
    saver.save(2, 7);
    expect(write.mock.calls).toEqual([[2, 7]]);
  });

  it('does not save a zero position when the new video resets currentTime', () => {
    const write = vi.fn();
    const saver = createProgressSaver(write);
    saver.mediaLoaded(2);
    saver.record(2, 0);
    saver.save(2, 0);
    saver.flush();
    expect(write).not.toHaveBeenCalled();
  });

  it('does not repeat the same write when flush runs twice', () => {
    const write = vi.fn();
    const saver = createProgressSaver(write);
    saver.mediaLoaded(3);
    saver.record(3, 10);
    saver.flush();
    saver.flush();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls).toEqual([[3, 10]]);
  });
});
