/**
 * The life of an export task run in a worker: start, progress, done / cancelled / failed. A fake Worker stands in for the real one, so every
 * step can be ordered by hand: a normal finish, a cancel, a message that arrives after the cancel, and buffers two frames share.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runEncodeTask, transferablesOf } from '../src/core/export/encodeTask';
import type { EncodeReply, EncodeTask } from '../src/core/export/encodeTask';
import { CANCELLED, encodeInWorker } from '../src/store/encodeInWorker';
import { encodeApng, frameDelay } from '../src/core/export/apng';
import { encodeGif } from '../src/core/export/gif';
import { createZip } from '../src/core/export/zip';
import { encodePng } from '../cli/png';

/** A Worker the test drives itself: it records what it was given, and the test posts replies back through `reply`. */
class FakeWorker {
  static made: FakeWorker[] = [];
  static failToStart = false;
  onmessage: ((e: MessageEvent<EncodeReply>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: ((e: MessageEvent) => void) | null = null;
  terminated = false;
  task: EncodeTask | null = null;
  transfer: Transferable[] = [];

  constructor(
    readonly url: URL,
    readonly options: WorkerOptions,
  ) {
    if (FakeWorker.failToStart) throw new Error('no workers here');
    FakeWorker.made.push(this);
  }

  postMessage(task: EncodeTask, transfer: Transferable[] = []) {
    if (this.terminated) throw new Error('This worker was terminated');
    this.task = task;
    this.transfer = transfer;
  }

  terminate() {
    this.terminated = true;
  }

  /** A reply from the worker while it runs. */
  reply(message: EncodeReply) {
    this.onmessage?.({ data: message } as MessageEvent<EncodeReply>);
  }

  /** A message that was already on its way when the job ended: it reaches the handler, but must not change anything. */
  late(message: EncodeReply) {
    this.onmessage?.({ data: message } as MessageEvent<EncodeReply>);
  }

  fail(message: string) {
    this.onerror?.({ message, preventDefault() {} } as unknown as ErrorEvent);
  }
}

const task: EncodeTask = {
  kind: 'zip',
  files: [
    { name: 'a.txt', data: new Uint8Array([1, 2, 3]) },
    { name: 'b.txt', data: new Uint8Array([4, 5, 6]) },
  ],
};

const doneReply = (): EncodeReply => ({ type: 'done', bytes: new Uint8Array([9, 8, 7]) });

const useFakeWorkers = () => {
  FakeWorker.made = [];
  FakeWorker.failToStart = false;
  vi.stubGlobal('Worker', FakeWorker);
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A promise state read without awaiting it (awaiting a rejection would end the test). */
async function stateOf<T>(p: Promise<T>): Promise<'pending' | 'resolved' | 'rejected'> {
  let state: 'pending' | 'resolved' | 'rejected' = 'pending';
  void p.then(
    () => (state = 'resolved'),
    () => (state = 'rejected'),
  );
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return state;
}

/** Takes the rejection of a job right away, so it is handled even before the test awaits it. */
function rejectionOf(job: { result: Promise<Uint8Array> }): Promise<Error> {
  return job.result.then(
    () => {
      throw new Error('the job resolved, but it should have been cancelled');
    },
    (e: Error) => e,
  );
}

describe('encodeInWorker: the lifecycle of an export task', () => {
  it('runs in a worker, reports progress, hands over its buffers and ends with the bytes, releasing the worker', async () => {
    useFakeWorkers();
    const progress: number[] = [];
    const job = encodeInWorker(task, (f) => progress.push(f));
    const worker = FakeWorker.made[0];
    expect(worker.terminated).toBe(false);
    expect(worker.transfer).toEqual(transferablesOf(task));
    expect(worker.transfer).toHaveLength(2);
    expect(worker.task).toBe(task);

    worker.reply({ type: 'progress', value: 0.25 });
    worker.reply({ type: 'progress', value: 0.75 });
    expect(progress).toEqual([0.25, 0.75]);

    worker.reply(doneReply());
    await expect(job.result).resolves.toEqual(new Uint8Array([9, 8, 7]));
    expect(worker.terminated).toBe(true);
    expect(worker.onmessage).toBeNull();

    // a message that still arrives after the end changes nothing: no progress, no second result
    worker.late({ type: 'progress', value: 1 });
    worker.late({ type: 'done', bytes: new Uint8Array([0]) });
    expect(progress).toEqual([0.25, 0.75]);
  });

  it('cancels: the result rejects with "Cancelled", the worker is ended at once, and nothing comes through afterwards', async () => {
    useFakeWorkers();
    const progress: number[] = [];
    const job = encodeInWorker(task, (f) => progress.push(f));
    const worker = FakeWorker.made[0];
    const outcome = rejectionOf(job);
    worker.reply({ type: 'progress', value: 0.5 });

    job.cancel();
    expect(worker.terminated).toBe(true);
    await expect(outcome).resolves.toHaveProperty('message', 'Cancelled');
    await expect(job.result).rejects.toThrow(CANCELLED);

    // cancel is idempotent: a second call neither throws nor changes the outcome
    expect(() => job.cancel()).not.toThrow();
    await expect(job.result).rejects.toThrow(CANCELLED);

    // a progress or done message that was on its way when the job was cancelled is dropped
    worker.late({ type: 'progress', value: 0.9 });
    worker.late(doneReply());
    await expect(job.result).rejects.toThrow(CANCELLED);
    expect(progress).toEqual([0.5]);
  });

  it('fails: an error from the worker rejects the result with its message and the worker is released', async () => {
    useFakeWorkers();
    const progress: number[] = [];
    const job = encodeInWorker(task, (f) => progress.push(f));
    const worker = FakeWorker.made[0];
    worker.reply({ type: 'error', message: 'the encoder broke' });
    await expect(job.result).rejects.toThrow('the encoder broke');
    expect(worker.terminated).toBe(true);
    expect(worker.onmessage).toBeNull();
    worker.late({ type: 'progress', value: 1 });
    expect(progress).toEqual([]);

    // a worker that crashes instead of answering fails the job too
    const second = encodeInWorker(task);
    FakeWorker.made[1].fail('the worker died');
    await expect(second.result).rejects.toThrow('the worker died');
    expect(FakeWorker.made[1].terminated).toBe(true);
  });

  it('fails when the task cannot be posted, without leaving a worker behind', async () => {
    useFakeWorkers();
    // a worker whose postMessage refuses the task, as the real one does with a buffer it cannot transfer
    class RefusingWorker extends FakeWorker {
      override postMessage() {
        throw new Error('DataCloneError');
      }
    }
    vi.stubGlobal('Worker', RefusingWorker);
    const job = encodeInWorker(task);
    const worker = FakeWorker.made[0];
    await expect(job.result).rejects.toThrow('DataCloneError');
    expect(worker.terminated).toBe(true);
    expect(worker.onmessage).toBeNull();
  });

  it('without a Worker, gives the bytes of the encoder; a job cancelled before it starts never resolves', async () => {
    vi.stubGlobal('Worker', undefined);
    const expected = runEncodeTask({
      kind: 'zip',
      files: [
        { name: 'a.txt', data: new Uint8Array([1, 2, 3]) },
        { name: 'b.txt', data: new Uint8Array([4, 5, 6]) },
      ],
    });
    // the fallback starts in a timer, so a cancel can still land before the encoder runs
    const cancelled = encodeInWorker(task);
    const outcome = rejectionOf(cancelled);
    cancelled.cancel();
    expect(await stateOf(cancelled.result)).toBe('rejected');
    await expect(outcome).resolves.toHaveProperty('message', CANCELLED);

    const plain = encodeInWorker({
      kind: 'zip',
      files: [
        { name: 'a.txt', data: new Uint8Array([1, 2, 3]) },
        { name: 'b.txt', data: new Uint8Array([4, 5, 6]) },
      ],
    });
    await expect(plain.result).resolves.toEqual(expected);
  });

  it('without a Worker, drops progress and the result of a run that was cancelled while it worked', async () => {
    vi.stubGlobal('Worker', undefined);
    vi.useFakeTimers();
    const progress: number[] = [];
    const job = encodeInWorker({ kind: 'gif', frames: [new Uint8ClampedArray(16)], options: { width: 2, height: 2, delayCs: 8 } }, (f) =>
      progress.push(f),
    );
    const outcome = rejectionOf(job);
    job.cancel();
    await vi.runAllTimersAsync();
    await expect(outcome).resolves.toHaveProperty('message', CANCELLED);
    expect(progress).toEqual([]);
  });

  it('does not detach a buffer two frames share: the caller still reads it after a real structured clone', async () => {
    useFakeWorkers();
    const shared = new Uint8ClampedArray(16);
    shared.fill(3);
    const own = new Uint8ClampedArray(4);
    const job = encodeInWorker({ kind: 'gif', frames: [shared, shared.subarray(0, 8), own], options: { width: 2, height: 2, delayCs: 8 } });
    const worker = FakeWorker.made[0];
    void rejectionOf(job);
    job.cancel();

    // the hand-over the real browser makes: the same message and transfer list, through the real structured clone
    const passed = structuredClone({ task: worker.task, transfer: worker.transfer }, { transfer: worker.transfer });
    expect(passed.transfer).toEqual([own.buffer]);
    // the shared buffer was copied, not transferred: it is not detached, and neither is a view of it
    expect(shared.buffer.byteLength).toBe(16);
    expect(Array.from(shared)).toEqual(Array(16).fill(3));
    expect(shared.subarray(0, 8).byteLength).toBe(8);
    // the buffer the task owned on its own went to the worker
    expect(own.buffer.byteLength).toBe(0);
  });

  it('a duplicated transfer would throw, so the list never has one: the hand-over of a shared buffer works', async () => {
    useFakeWorkers();
    const one = new Uint8Array(4);
    const job = encodeInWorker({
      kind: 'zip',
      files: [
        { name: 'a', data: one },
        { name: 'b', data: one.subarray(0, 2) },
      ],
    });
    const worker = FakeWorker.made[0];
    void rejectionOf(job);
    job.cancel();
    expect(worker.transfer).toEqual([]);
    expect(() => structuredClone({ task: worker.task }, { transfer: worker.transfer })).not.toThrow();
    expect(one.byteLength).toBe(4);
  });

  it('a frame that is a window into a bigger buffer is copied, so the rest of that buffer stays readable', async () => {
    useFakeWorkers();
    const big = new Uint8ClampedArray(64);
    big.fill(5);
    const job = encodeInWorker({ kind: 'gif', frames: [big.subarray(16, 32)], options: { width: 2, height: 2, delayCs: 8 } });
    const worker = FakeWorker.made[0];
    void rejectionOf(job);
    job.cancel();
    expect(worker.transfer).toEqual([]);
    expect(() => structuredClone({ task: worker.task }, { transfer: worker.transfer })).not.toThrow();
    expect(big.byteLength).toBe(64);
    expect(Array.from(big.subarray(16, 20))).toEqual([5, 5, 5, 5]);
  });

  it('produces what createZip produces: the worker hand-over does not change the bytes', () => {
    // the bytes never depend on the transfer list: the same task encoded here and there is the same file
    const files = [
      { name: 'one.txt', data: new TextEncoder().encode('hello') },
      { name: 'two.bin', data: new Uint8Array([0, 255, 7]) },
    ];
    const direct = createZip(files);
    const viaTask = runEncodeTask({ kind: 'zip', files });
    expect(Array.from(viaTask)).toEqual(Array.from(direct));
  });
});

describe('the hand-over to the worker keeps the bytes of every export', () => {
  /** What the browser does with the message and the transfer list: the real structured clone, with the real transfer. */
  const handOver = (message: EncodeTask) => structuredClone({ task: message }, { transfer: transferablesOf(message) }).task;

  const pixelFrame = (w: number, h: number, seed: number) => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) data.set([(i * 7 + seed * 31) % 256, (i * 3 + seed) % 256, seed * 40, 255], i * 4);
    return data;
  };

  it('a GIF task encoded after the hand-over is the same file as the direct encodeGif', () => {
    const frames = [pixelFrame(9, 7, 1), pixelFrame(9, 7, 2), pixelFrame(9, 7, 3)];
    const options = { width: 9, height: 7, delayCs: 8, transparent: true };
    const direct = encodeGif(frames, options);
    const stayed = frames.map((f) => Array.from(f)); // the direct call reads the same arrays: remember them
    const passed = handOver({ kind: 'gif', frames, options });
    expect(Array.from(runEncodeTask(passed))).toEqual(Array.from(direct));
    // every frame's buffer went over, so the caller's arrays are detached: a copy was kept above to compare with
    expect(frames.every((f) => f.buffer.byteLength === 0)).toBe(true);
    expect(stayed[0].slice(0, 4)).toEqual([31, 1, 40, 255]);
  });

  it('an APNG task encoded after the hand-over is the same file as the direct encodeApng', () => {
    const pngs = [1, 2].map((seed) => new Uint8Array(encodePng(6, 5, pixelFrame(6, 5, seed))));
    const options = { ...frameDelay(12), plays: 0 };
    const direct = encodeApng(pngs, options);
    const passed = handOver({ kind: 'apng', frames: pngs, options });
    expect(Array.from(runEncodeTask(passed))).toEqual(Array.from(direct));
  });

  it('a ZIP task after the hand-over is the same file as the direct createZip', () => {
    const files = [
      { name: 'one.txt', data: new TextEncoder().encode('hello') },
      { name: 'two.bin', data: new Uint8Array([0, 255, 7]) },
    ];
    const direct = createZip(files);
    const passed = handOver({ kind: 'zip', files });
    expect(Array.from(runEncodeTask(passed))).toEqual(Array.from(direct));
  });

  it('frames that share a buffer survive the hand-over, and the caller still has their pixels', () => {
    const shared = pixelFrame(8, 8, 4);
    // the second frame is a view of the same pixels: same buffer, so the hand-over must copy it
    const frames = [shared, new Uint8ClampedArray(shared.buffer)];
    const options = { width: 8, height: 8, delayCs: 8 };
    const direct = encodeGif(frames, options); // still readable before the hand-over
    const passed = handOver({ kind: 'gif', frames, options });
    expect(Array.from(runEncodeTask(passed))).toEqual(Array.from(direct));
    // nothing was transferred: the caller's view of the shared buffer is intact
    expect(shared.buffer.byteLength).toBe(8 * 8 * 4);
    expect(Array.from(shared.slice(0, 4))).toEqual([124, 4, 160, 255]);
  });
});
