/**
 * FSKProcessor Cancellation Semantics Tests
 *
 * キャンセル（abortメッセージ）が変調・復調・状態查询に贯通することを検証する:
 * - 変調キャンセル後、出力が即座に無音になり、次の modulate が "Modulation already in progress" で詰まらない
 * - キャンセル後の再送信データが受信側で欠落なく復調できる（前の信号が混ざらない）
 * - 待機中の demodulate をキャンセルするとキャンセルエラーで終了し、
 *   後から届いたバイトがキャンセル済みリクエストに紐付かない
 * - reset が残留状態（未再生波形・受信バッファ・同期状態）をクリアし、status が実状態を反映する
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

// Mock AudioWorkletProcessor for Node.js testing
class MockAudioWorkletProcessor {
  port = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: vi.fn()
  };
}

// Mock registerProcessor and sampleRate
const mockRegisterProcessor = vi.fn();
vi.stubGlobal('AudioWorkletProcessor', MockAudioWorkletProcessor);
vi.stubGlobal('registerProcessor', mockRegisterProcessor);
vi.stubGlobal('sampleRate', 48000);

// Import the module under test (after stubbing globals)
const processorModule = await import('../../src/webaudio/processors/fsk-processor.js') as any;
const FSKProcessor = processorModule.FSKProcessor;
const { FSKCore, DEFAULT_FSK_CONFIG } = await import('../../src/modems/fsk.js');

const FRAME_SIZE = 128;

describe('FSKProcessor cancellation semantics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- helpers -----------------------------------------------------------

  const sendMessage = async (proc: any, message: any) => {
    const messageEvent = { data: message } as MessageEvent;
    await proc.port.onmessage(messageEvent);
  };

  const configure = async (proc: any, id = 'config') => {
    await sendMessage(proc, {
      id,
      type: 'configure',
      data: { config: { ...DEFAULT_FSK_CONFIG } }
    });
  };

  const flush = () => new Promise(resolve => setTimeout(resolve, 0));

  const postedMessages = (proc: any) =>
    proc.port.postMessage.mock.calls.map((call: any[]) => call[0]);

  const findPosted = (proc: any, id: string) =>
    postedMessages(proc).filter((m: any) => m.id === id);

  const findPostedOfType = (proc: any, id: string, type: string) =>
    findPosted(proc, id).filter((m: any) => m.type === type);

  /** Run process() frames on a processor, feeding the given input (or silence) */
  const pump = async (proc: any, frames: number, inputForFrame?: (i: number) => Float32Array) => {
    const outputs: Float32Array[] = [];
    for (let i = 0; i < frames; i++) {
      const input = inputForFrame ? inputForFrame(i) : new Float32Array(FRAME_SIZE);
      const output = new Float32Array(FRAME_SIZE);
      proc.process([[input]], [[output]]);
      outputs.push(output);
      await flush();
    }
    return outputs;
  };

  /** Pump frames: sender output -> receiver input. Returns sender outputs. */
  const pumpTransfer = async (sender: any, receiver: any, frames: number) => {
    const senderOutputs: Float32Array[] = [];
    for (let i = 0; i < frames; i++) {
      const out = new Float32Array(FRAME_SIZE);
      sender.process([[new Float32Array(FRAME_SIZE)]], [[out]]);
      senderOutputs.push(out);
      receiver.process([[out]], [[new Float32Array(FRAME_SIZE)]]);
      await flush();
    }
    return senderOutputs;
  };

  /** Generate a real FSK signal and feed it through the processor's input */
  const feedSignal = async (proc: any, data: Uint8Array) => {
    const generator = new FSKCore();
    generator.configure({ ...DEFAULT_FSK_CONFIG });
    const signal = await generator.modulateData(data);
    for (let off = 0; off < signal.length; off += FRAME_SIZE) {
      const chunk = new Float32Array(FRAME_SIZE);
      chunk.set(signal.slice(off, off + FRAME_SIZE));
      proc.process([[chunk]], [[new Float32Array(FRAME_SIZE)]]);
      await flush();
    }
    // Silence tail to trigger end-of-data flushing
    await pump(proc, 40);
  };

  const getStatus = async (proc: any, id = 'status-req') => {
    await sendMessage(proc, { id, type: 'status', data: {} });
    const statusMessages = findPostedOfType(proc, id, 'result');
    expect(statusMessages.length).toBe(1);
    return statusMessages[0].data;
  };

  // --- tests -------------------------------------------------------------

  test('cancelling modulation silences output immediately and retransmission is received intact', async () => {
    const sender = new FSKProcessor();
    const receiver = new FSKProcessor();
    await configure(sender, 'config-s');
    await configure(receiver, 'config-r');

    // 1. Start a long modulation (stays in progress while we pump only a few frames)
    const longData = Array.from({ length: 64 }, (_, i) => i & 0xff);
    const m1 = sendMessage(sender, { id: 'm1', type: 'modulate', data: { bytes: longData } });

    // Pump a few frames: not enough for the receiver to sync, but the
    // sender must be actively emitting signal
    const activeOutputs = await pumpTransfer(sender, receiver, 4);
    const emittedSignal = activeOutputs.some(frame => frame.some(s => s !== 0));
    expect(emittedSignal).toBe(true);

    // 2. Cancel the in-progress modulation
    await sendMessage(sender, { id: 'a1', type: 'abort', data: { id: 'm1' } });
    await m1;

    // The modulate request must end with a cancellation error
    const m1Errors = findPostedOfType(sender, 'm1', 'error');
    expect(m1Errors.length).toBe(1);
    expect(m1Errors[0].data.message).toMatch(/aborted/i);
    expect(findPostedOfType(sender, 'm1', 'result').length).toBe(0);

    // 3. Output must be silent immediately after cancellation
    const silentOutputs = await pumpTransfer(sender, receiver, 6);
    for (const frame of silentOutputs) {
      expect(Array.from(frame)).toEqual(new Array(FRAME_SIZE).fill(0));
    }

    // Status must reflect that nothing is pending and no residue remains
    const statusAfterAbort = await getStatus(sender, 's-after-abort');
    expect(statusAfterAbort.pendingModulation).toBe(false);
    expect(statusAfterAbort.demodulatedBufferLength).toBe(0);

    // 4. A new modulation must start without "Modulation already in progress"
    const newData = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
    const m2 = sendMessage(sender, { id: 'm2', type: 'modulate', data: { bytes: Array.from(newData) } });

    // Pump until the modulation completes (result posted) with a generous bound
    let frames = 0;
    while (findPosted(sender, 'm2').length === 0 && frames < 400) {
      await pumpTransfer(sender, receiver, 1);
      frames++;
    }
    await m2;

    const m2Results = findPostedOfType(sender, 'm2', 'result');
    expect(m2Results.length).toBe(1);
    expect(m2Results[0].data.success).toBe(true);
    expect(findPostedOfType(sender, 'm2', 'error').length).toBe(0);

    // Flush silence so the receiver emits the final bytes
    await pumpTransfer(sender, receiver, 40);

    // 5. The receiver must obtain exactly the new data - no residue of the
    //    cancelled first transmission
    await sendMessage(receiver, { id: 'd1', type: 'demodulate', data: {} });
    const d1Results = findPostedOfType(receiver, 'd1', 'result');
    expect(d1Results.length).toBe(1);
    expect(d1Results[0].data.bytes).toEqual(Array.from(newData));
  });

  test('cancelling a waiting demodulate ends it with a cancel error and later bytes go to the next request', async () => {
    const receiver = new FSKProcessor();
    await configure(receiver);

    // 1. demodulate with empty buffer -> waits
    const d1 = sendMessage(receiver, { id: 'd1', type: 'demodulate', data: {} });
    await flush();

    // status reflects the waiting request
    const waitingStatus = await getStatus(receiver, 's-waiting');
    expect(waitingStatus.awaitingDemodulation).toBe(true);

    // 2. Cancel the waiting request
    await sendMessage(receiver, { id: 'a1', type: 'abort', data: { id: 'd1' } });
    await d1;

    // The cancelled request ends with a cancel error, never with data
    const d1Errors = findPostedOfType(receiver, 'd1', 'error');
    expect(d1Errors.length).toBe(1);
    expect(d1Errors[0].data.message).toMatch(/abort/i);
    expect(findPostedOfType(receiver, 'd1', 'result').length).toBe(0);

    const statusAfterAbort = await getStatus(receiver, 's-after-abort');
    expect(statusAfterAbort.awaitingDemodulation).toBe(false);

    // 3. A new request issued after the cancellation must work normally
    const d2 = sendMessage(receiver, { id: 'd2', type: 'demodulate', data: {} });
    await flush();
    expect(findPostedOfType(receiver, 'd2', 'error').length).toBe(0);

    // 4. Bytes arriving after the cancellation must not be attributed to the
    //    cancelled request - they belong to the new one
    await feedSignal(receiver, new Uint8Array([0x41, 0x42]));
    await d2;

    // Collect everything the new request(s) receive
    const received: number[] = [];
    const d2Results = findPostedOfType(receiver, 'd2', 'result');
    expect(d2Results.length).toBe(1);
    received.push(...d2Results[0].data.bytes);

    // Drain whatever remains buffered (data may arrive in several chunks)
    await sendMessage(receiver, { id: 'd3', type: 'demodulate', data: {} });
    const d3Results = findPostedOfType(receiver, 'd3', 'result');
    expect(d3Results.length).toBe(1);
    received.push(...d3Results[0].data.bytes);

    expect(received).toEqual([0x41, 0x42]);
  });

  test('reset clears pending operations, buffers and sync state; status reflects it', async () => {
    const proc = new FSKProcessor();
    await configure(proc);

    // 1. Fill the receive buffer with a real signal
    await feedSignal(proc, new Uint8Array([0x41, 0x42]));
    const filledStatus = await getStatus(proc, 's-filled');
    expect(filledStatus.demodulatedBufferLength).toBeGreaterThan(0);
    expect(filledStatus.processDemodulationCallCount).toBeGreaterThan(0);

    // 2. Start a modulation (stays pending: output is never pumped)
    const longData = Array.from({ length: 64 }, (_, i) => i & 0xff);
    const m1 = sendMessage(proc, { id: 'm1', type: 'modulate', data: { bytes: longData } });
    await flush();

    // A demodulate request must NOT cancel the in-progress modulation
    // (modulate/demodulate have independent cancellation)
    await sendMessage(proc, { id: 'd1', type: 'demodulate', data: {} });
    expect(findPostedOfType(proc, 'd1', 'result').length).toBe(1); // returns buffered bytes
    expect(findPosted(proc, 'm1').length).toBe(0); // m1 still in progress

    // 3. A waiting demodulate request
    const d2 = sendMessage(proc, { id: 'd2', type: 'demodulate', data: {} });
    await flush();

    const busyStatus = await getStatus(proc, 's-busy');
    expect(busyStatus.pendingModulation).toBe(true);
    expect(busyStatus.awaitingDemodulation).toBe(true);

    // 4. Reset must terminate both pending operations with cancel errors
    await sendMessage(proc, { id: 'r1', type: 'reset', data: {} });
    await Promise.all([m1, d2]);

    const m1Errors = findPostedOfType(proc, 'm1', 'error');
    expect(m1Errors.length).toBe(1);
    expect(m1Errors[0].data.message).toMatch(/aborted/i);
    const d2Errors = findPostedOfType(proc, 'd2', 'error');
    expect(d2Errors.length).toBe(1);
    expect(d2Errors[0].data.message).toMatch(/abort/i);
    expect(findPostedOfType(proc, 'r1', 'result').length).toBe(1);

    // 5. Status and buffers are zeroed, FSK core stays configured
    const resetStatus = await getStatus(proc, 's-reset');
    expect(resetStatus.demodulatedBufferLength).toBe(0);
    expect(resetStatus.pendingModulation).toBe(false);
    expect(resetStatus.awaitingDemodulation).toBe(false);
    expect(resetStatus.processDemodulationCallCount).toBe(0);
    expect(resetStatus.fskCoreReady).toBe(true);
    // FSK core internal sync/debug state is reset as well
    expect(resetStatus.demodulationCalls).toBe(0);
    expect(resetStatus.frameStarted).toBe(false);
    expect(resetStatus.receivedBitsLength).toBe(0);

    // 6. Output is silent after reset
    const outputs = await pump(proc, 4);
    for (const frame of outputs) {
      expect(Array.from(frame)).toEqual(new Array(FRAME_SIZE).fill(0));
    }

    // 7. A new modulation works after reset (no "Modulation already in progress")
    const m2 = sendMessage(proc, { id: 'm2', type: 'modulate', data: { bytes: [0x48] } });
    let frames = 0;
    while (findPosted(proc, 'm2').length === 0 && frames < 400) {
      await pump(proc, 1);
      frames++;
    }
    await m2;
    const m2Results = findPostedOfType(proc, 'm2', 'result');
    expect(m2Results.length).toBe(1);
    expect(m2Results[0].data.success).toBe(true);
  });

  test('abort with an operation id cancels only that operation', async () => {
    const proc = new FSKProcessor();
    await configure(proc);

    // In-progress modulation and waiting demodulation at the same time
    const longData = Array.from({ length: 64 }, (_, i) => i & 0xff);
    const m1 = sendMessage(proc, { id: 'm1', type: 'modulate', data: { bytes: longData } });
    const d1 = sendMessage(proc, { id: 'd1', type: 'demodulate', data: {} });
    await flush();

    // Cancel only the demodulation
    await sendMessage(proc, { id: 'a1', type: 'abort', data: { id: 'd1' } });
    await d1;
    expect(findPostedOfType(proc, 'd1', 'error').length).toBe(1);
    // The modulation is untouched
    expect(findPosted(proc, 'm1').length).toBe(0);
    const stillModulating = await getStatus(proc, 's1');
    expect(stillModulating.pendingModulation).toBe(true);

    // Cancel only the modulation
    await sendMessage(proc, { id: 'a2', type: 'abort', data: { id: 'm1' } });
    await m1;
    expect(findPostedOfType(proc, 'm1', 'error').length).toBe(1);
    const idleStatus = await getStatus(proc, 's2');
    expect(idleStatus.pendingModulation).toBe(false);
    expect(idleStatus.awaitingDemodulation).toBe(false);

    // Abort for an unknown id is a no-op and still acknowledged
    await sendMessage(proc, { id: 'a3', type: 'abort', data: { id: 'no-such-op' } });
    expect(findPostedOfType(proc, 'a3', 'result').length).toBe(1);
  });

  test('broadcast abort (no id) cancels all in-progress operations', async () => {
    const proc = new FSKProcessor();
    await configure(proc);

    const longData = Array.from({ length: 64 }, (_, i) => i & 0xff);
    const m1 = sendMessage(proc, { id: 'm1', type: 'modulate', data: { bytes: longData } });
    const d1 = sendMessage(proc, { id: 'd1', type: 'demodulate', data: {} });
    await flush();

    await sendMessage(proc, { id: 'a1', type: 'abort', data: {} });
    await Promise.all([m1, d1]);

    expect(findPostedOfType(proc, 'm1', 'error').length).toBe(1);
    expect(findPostedOfType(proc, 'd1', 'error').length).toBe(1);

    const status = await getStatus(proc, 's1');
    expect(status.pendingModulation).toBe(false);
    expect(status.awaitingDemodulation).toBe(false);
  });
});
