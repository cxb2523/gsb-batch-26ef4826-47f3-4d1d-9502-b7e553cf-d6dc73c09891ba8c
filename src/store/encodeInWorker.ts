import { runEncodeTask, transferablesOf } from '@/core/export/encodeTask';
import type { EncodeReply, EncodeTask } from '@/core/export/encodeTask';

export interface EncodeJob {
  /**
   * The encoded file. Rejects with the message of the encoder when it fails, and with "Cancelled" after `cancel` (a cancel that comes
   * before the end always wins, even if the encoder was about to finish: nothing is handed over any more). A cancel after the job ended
   * changes nothing.
   */
  result: Promise<Uint8Array>;
  /** Stops the work at once (the worker is ended, nothing is left running). Calling it again, or after the job ended, does nothing. */
  cancel(): void;
}

export const CANCELLED = 'Cancelled';

/**
 * Runs a slow encoder (GIF, APNG, ZIP) in a Web Worker, so the editor stays alive while it works, and gives a way to stop it. The frames
 * and files of the task are handed over, not copied, except a buffer the task does not hold on its own (two frames share it, or one points
 * into a part of it): that one is copied, so the caller's views of it stay valid (see transferablesOf). Without Worker support the work is
 * done here, in a timer, as before (such a run cannot be interrupted, only its result thrown away).
 *
 * Lifecycle: the job ends exactly once, as done, cancelled or failed. Ending it releases the worker, and after that no `onProgress` call
 * is made: messages that were already on their way, or progress from a run that could not be stopped, are dropped.
 */
export function encodeInWorker(task: EncodeTask, onProgress?: (fraction: number) => void): EncodeJob {
  let worker: Worker | null = null;
  let settled = false;
  let resolve!: (bytes: Uint8Array) => void;
  let reject!: (reason: Error) => void;
  const result = new Promise<Uint8Array>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  /** Stops the worker (if it is still there) and lets its messages go nowhere. */
  const release = () => {
    const w = worker;
    worker = null;
    if (!w) return;
    w.onmessage = null;
    w.onerror = null;
    w.onmessageerror = null;
    w.terminate();
  };

  /** Ends the job once: whatever it was doing is released before the promise settles, so no worker is left hanging. */
  const settle = (finish: () => void) => {
    if (settled) return;
    settled = true;
    release();
    finish();
  };

  /** Progress is only news while the task runs: once the job ended it is dropped, even if it comes from a late message. */
  const report = (fraction: number) => {
    if (settled) return;
    onProgress?.(fraction);
  };

  const cancel = () => settle(() => reject(new Error(CANCELLED)));

  try {
    if (typeof Worker !== 'undefined') worker = new Worker(new URL('../core/export/encodeWorker.ts', import.meta.url), { type: 'module' });
  } catch {
    worker = null;
  }

  if (!worker) {
    // No Worker: the work runs here in a timer. It cannot be interrupted, so a cancel only throws its result away.
    setTimeout(() => {
      if (settled) return;
      try {
        const bytes = runEncodeTask(task, report);
        if (settled) return; // cancelled while the encoder was running: its bytes are not wanted any more
        settle(() => resolve(bytes));
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        settle(() => reject(error));
      }
    }, 0);
    return { result, cancel };
  }

  const w = worker;
  w.onmessage = (e: MessageEvent<EncodeReply>) => {
    if (settled) return; // a message that was already on its way when the job was cancelled or finished
    const m = e.data;
    if (m.type === 'progress') return report(m.value);
    if (m.type === 'done') settle(() => resolve(m.bytes));
    else settle(() => reject(new Error(m.message)));
  };
  w.onerror = (e) => {
    e.preventDefault(); // the job reports the failure through `result`: do not also log it as an uncaught worker error
    settle(() => reject(new Error(e.message || 'The encoder stopped unexpectedly')));
  };
  w.onmessageerror = () => settle(() => reject(new Error('The encoder reply could not be read')));
  const transfer = transferablesOf(task);
  try {
    w.postMessage(task, transfer);
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    settle(() => reject(error));
  }
  return { result, cancel };
}
