/**
 * The slow encoders of the exports as one message-shaped function, so they can run in a Web Worker (encodeWorker.ts) and be tested here
 * without one: a GIF of a long animation takes seconds, and on the main thread that freezes the whole editor.
 */
import { encodeApng } from './apng';
import type { ApngOptions } from './apng';
import { encodeGif } from './gif';
import type { GifOptions } from './gif';
import { createZip } from './zip';
import type { ZipEntry } from './zip';

export type EncodeTask =
  | { kind: 'gif'; frames: Uint8ClampedArray[]; options: Omit<GifOptions, 'onProgress'> }
  | { kind: 'apng'; frames: Uint8Array[]; options: ApngOptions }
  | { kind: 'zip'; files: ZipEntry[] };

/** What the worker sends back. */
export type EncodeReply = { type: 'progress'; value: number } | { type: 'done'; bytes: Uint8Array } | { type: 'error'; message: string };

/** Runs a task; `onProgress` gets a number from 0 to 1 when the encoder can tell how far it is (only the GIF encoder can). */
export function runEncodeTask(task: EncodeTask, onProgress?: (fraction: number) => void): Uint8Array {
  switch (task.kind) {
    case 'gif':
      return encodeGif(task.frames, { ...task.options, onProgress: (done, total) => onProgress?.(done / total) });
    case 'apng':
      return encodeApng(task.frames, task.options);
    case 'zip':
      return createZip(task.files);
  }
}

/**
 * The buffers to hand to the worker instead of copying: only those the task has to itself. A buffer that two frames (or files) share is left
 * out, because transferring it would detach the other view as well, and the caller would then read empty data from it. The same goes for a
 * frame that is only a window into a larger buffer: the rest of that buffer may well be the caller's. Such buffers are copied by the
 * structured clone instead, which keeps every view of the caller valid. Each buffer appears once (a duplicate in the transfer list makes the
 * clone fail), and buffers of a SharedArrayBuffer are never listed (they cannot be transferred).
 */
export function transferablesOf(task: EncodeTask): ArrayBuffer[] {
  const views: ArrayBufferView[] = task.kind === 'zip' ? task.files.map((f) => f.data) : task.frames;
  const uses = new Map<ArrayBuffer, number>();
  for (const v of views) {
    const buffer = v.buffer;
    if (buffer instanceof ArrayBuffer) uses.set(buffer, (uses.get(buffer) ?? 0) + 1);
  }
  const owned: ArrayBuffer[] = [];
  for (const [buffer, count] of uses) {
    // referenced once, and by a view that covers it whole: nobody else can be holding it
    const whole = views.every((v) => v.buffer !== buffer || (v.byteOffset === 0 && v.byteLength === buffer.byteLength));
    if (count === 1 && whole) owned.push(buffer);
  }
  return owned;
}
