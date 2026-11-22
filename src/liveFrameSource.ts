import type { LiveFrame } from './liveFrame.js';
import type { PosedFrame } from './posedFrame.js';

/** @internal Renderer association; contains no poser dependency. */
export const liveDrawings = new WeakMap<object, PosedFrame>();

/**
 * @internal Freshness probes for borrowed frames, keyed by the exact object a
 * player handed out. A probe throws `LIVE_FRAME_STALE` when that borrow is no
 * longer the player's current frame — after a pose mutation (a runtime advance,
 * an oracle step, a fallback that retires the runtime) or after disposal.
 *
 * The checked development lease already fails a stale read through its own
 * generation getter; this registry is what makes *production* frames refuse to
 * draw old data at the renderer boundary, where no proxy lease guards. The
 * borrowed object's own `generation`/`count` getters cover direct reads (see
 * `RuntimeFrames.retire` and `retireLiveFrame`).
 */
export const liveValidity = new WeakMap<object, () => void>();

/** @internal Make a borrowed frame throw through `renderFrameOf` once `probe` says it is spent. */
export function registerLiveValidity(frame: object, probe: () => void): void {
  liveValidity.set(frame, probe);
}

/** @internal Resolve a borrowed view to its preallocated renderer facade. */
export function renderFrameOf(frame: PosedFrame | LiveFrame): PosedFrame {
  if ('order' in frame) return frame;
  // A production borrow carries no proxy, so this registry is its stale gate;
  // a checked lease's proxy generation read below throws on its own.
  const validity = liveValidity.get(frame);
  if (validity) validity();
  // Reading the generation makes a checked stale lease fail before drawing.
  void frame.generation;
  const drawing = liveDrawings.get(frame);
  if (!drawing) throw new Error('LIVE_FRAME_SOURCE: renderer needs a liveFrame() borrowed from a player');
  return drawing;
}
