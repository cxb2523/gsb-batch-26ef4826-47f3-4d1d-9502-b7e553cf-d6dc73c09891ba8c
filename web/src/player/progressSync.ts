export interface ProgressSave {
  mediaId: number;
  positionSec: number;
}

/**
 * 观看进度只能写回“当前真正载入了视频流的那个 media”：没有载入元数据、
 * 请求不属于已载入的视频、或时间非法时都返回 null。否则切集后新一集尚未
 * 载入期间，上一集的 currentTime 会被误写到新 mediaId 上。
 */
export function progressSaveFor(
  loadedMediaId: number | null,
  mediaId: number,
  positionSec: number,
): ProgressSave | null {
  if (loadedMediaId == null || loadedMediaId !== mediaId) return null;
  if (!Number.isFinite(positionSec) || positionSec <= 0) return null;
  return { mediaId: loadedMediaId, positionSec };
}

export interface ProgressSaver {
  /** 视频的时间已推进：记住最新位置，供暂停/切集补存。 */
  record(mediaId: number, positionSec: number): void;
  /** 立即保存某个视频的当前位置；不属于已载入视频或时间非法时丢弃。 */
  save(mediaId: number, positionSec: number): void;
  /** 只补存“已记住的最后位置”。切集清理与离页时用，不读取新视频的 currentTime。 */
  flush(): void;
  /** 切换集数：先把旧 mediaId 的最后位置补存，再解绑，直到新视频载入元数据。 */
  mediaChanged(): void;
  /** 视频流（对应 mediaId）的元数据已载入，之后的保存才归属于它。 */
  mediaLoaded(mediaId: number): void;
  readonly loadedMediaId: number | null;
}

export function createProgressSaver(
  write: (mediaId: number, positionSec: number) => void,
): ProgressSaver {
  let loadedMediaId: number | null = null;
  let lastPositionSec = 0;
  let lastWrite: ProgressSave | null = null;

  function writeOnce(payload: ProgressSave): void {
    if (lastWrite && lastWrite.mediaId === payload.mediaId && lastWrite.positionSec === payload.positionSec) return;
    lastWrite = payload;
    write(payload.mediaId, payload.positionSec);
  }

  function flush(): void {
    const payload = loadedMediaId == null ? null : progressSaveFor(loadedMediaId, loadedMediaId, lastPositionSec);
    if (payload) writeOnce(payload);
  }

  return {
    record(mediaId, positionSec) {
      const payload = progressSaveFor(loadedMediaId, mediaId, positionSec);
      if (payload) lastPositionSec = payload.positionSec;
    },
    save(mediaId, positionSec) {
      const payload = progressSaveFor(loadedMediaId, mediaId, positionSec);
      if (!payload) return;
      lastPositionSec = payload.positionSec;
      writeOnce(payload);
    },
    flush,
    mediaChanged() {
      flush();
      loadedMediaId = null;
      lastPositionSec = 0;
      lastWrite = null;
    },
    mediaLoaded(mediaId) {
      loadedMediaId = mediaId;
      lastPositionSec = 0;
      lastWrite = null;
    },
    get loadedMediaId() {
      return loadedMediaId;
    },
  };
}
