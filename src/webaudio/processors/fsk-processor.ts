/**
 * FSK AudioWorklet Processor - Thin wrapper for FSK operations
 */

/// <reference path="./types.d.ts" />

// AudioWorkletGlobalScope provides sampleRate as a global variable
declare const sampleRate: number;

import { IAudioProcessor, IDataChannel } from '../../core';
import { FSKCore } from '../../modems/fsk';
import { ChunkedModulator } from '../chunked-modulator';
import { RingBuffer } from '../../utils';

interface WorkletMessage {
  id: string;
  type: 'configure' | 'modulate' | 'demodulate' | 'status' | 'reset' | 'abort';
  data?: any
}

/**
 * Note:
 * AudioWorkletGlobalScope では標準の AbortController / AbortSignal が利用できません。
 * そのため、キャンセル制御には独自実装の MyAbortController / MyAbortSignal を使用しています。
 */
class MyAbortSignal {
  private _aborted = false;
  private listeners: (() => void)[] = [];
  onabort: (() => void) | null = null;

  get aborted() { return this._aborted; }

  addEventListener(type: 'abort', listener: () => void) {
    if (type === 'abort') this.listeners.push(listener);
  }

  removeEventListener(type: 'abort', listener: () => void) {
    if (type === 'abort') this.listeners = this.listeners.filter(l => l !== listener);
  }

  dispatchEvent() {
    this.onabort?.();
    this.listeners.forEach(l => l());
    this.listeners = [];
  }

  throwIfAborted() {
    if (this._aborted) throw new DOMException('Aborted', 'AbortError');
  }
}

class MyAbortController {
  signal = new MyAbortSignal();

  abort() {
    if (!this.signal.aborted) {
      (this.signal as any)._aborted = true;
      this.signal.dispatchEvent();
    }
  }
}

export class FSKProcessor extends AudioWorkletProcessor implements IAudioProcessor, IDataChannel {
  private fskCore: FSKCore;
  private demodulatedBuffer: RingBuffer<Uint8Array>;
  private pendingModulation: ChunkedModulator | null = null;
  private awaitingCallback: (() => void) | null = null;
  private modulationWaitCallback: () => void = () => {};
  private instanceName: string;
  // 変調と復調は独立したAbortControllerを持ち、相互にキャンセルしない。
  // （以前は単一controllerを共有していたため、demodulate開始が進行中の
  //   modulateをキャンセルするなどの副作用があった）
  private modulationAbortController: MyAbortController | null = null;
  private demodulationAbortController: MyAbortController | null = null;
  // 進行中操作のメッセージID。abortメッセージが data.id を持つ場合、
  // 対象の操作だけをキャンセルするために使用する。
  private currentModulationId: string | null = null;
  private currentDemodulationId: string | null = null;

  constructor(options?: AudioWorkletNodeOptions) {
    super();
    
    // Extract instance name from processorOptions
    this.instanceName = options?.processorOptions?.name || 'unnamed';
    
    console.log(`[FSKProcessor:${this.instanceName}] Initialized with sample rate:`, sampleRate);
    
    // Initialize FSK core (will be configured via message)
    this.fskCore = new FSKCore();
    
    // 復調されたデータを保持するリングバッファ
    this.demodulatedBuffer = new RingBuffer(Uint8Array, 1024);
    
    this.port.onmessage = this.handleMessage.bind(this);
  }

  async modulate(data: Uint8Array, options: {signal: AbortSignal }): Promise<void> {
    console.log(`[FSKProcessor:${this.instanceName}] modulate() called with ${data.length} bytes: [${Array.from(data).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);

    if (this.pendingModulation) {
      throw new Error('Modulation already in progress');
    }

    // 開始前にすでにキャンセルされていた場合は即座に終了
    if (options?.signal?.aborted) {
      throw new Error('FSK Processor Modulation aborted');
    }

    const modulator = new ChunkedModulator(this.fskCore);
    this.pendingModulation = modulator;

    try {
      await modulator.startModulation(data);

      await new Promise<void>((resolve, reject) => {
        // 自分自身の変調インスタンスである場合のみ状態をクリアする。
        // キャンセルと完了・後続操作が競合しても互いの状態を上書きしない。
        const cleanupOwnState = () => {
          if (this.pendingModulation === modulator) {
            modulator.cancel();
            this.pendingModulation = null;
          }
          if (this.modulationWaitCallback === onComplete) {
            this.modulationWaitCallback = () => {};
          }
          this.samplesGenerated = 0;
        };
        const handleAbort = () => {
          console.warn(`[FSKProcessor:${this.instanceName}] Modulation aborted`);
          cleanupOwnState();
          // 中断された波形の自己受信残渣（受信バッファ・復調器の同期状態）を除去し、
          // 次の送信/受信に持ち越さない
          this.demodulatedBuffer.clear();
          this.fskCore.reset();
          reject(new Error('FSK Processor Modulation aborted'));
        };
        const onComplete = () => {
          options?.signal.removeEventListener('abort', handleAbort);
          resolve();
        };
        this.modulationWaitCallback = onComplete;
        options?.signal.addEventListener('abort', handleAbort, { once: true });
        // startModulation() 待機中にabortが届いていた場合に備える
        if (options?.signal?.aborted) {
          handleAbort();
        }
      });
    } catch (error) {
      // 失敗・キャンセル時に自分の残留状態が残らないことを保証
      if (this.pendingModulation === modulator) {
        modulator.cancel();
        this.pendingModulation = null;
      }
      throw error;
    }
  }

  async demodulate(options: {signal: AbortSignal }): Promise<Uint8Array> {
      // Return currently buffered demodulated data
      const availableBytes = this.demodulatedBuffer.length;
      if (availableBytes === 0) {
        // 開始前にすでにキャンセルされていた場合は即座に終了
        if (options?.signal?.aborted) {
          throw new Error('Demodulation aborted');
        }
        await new Promise<void>((resolve, reject) => {
          // 自分自身の待機コールバックである場合のみクリアする。
          // キャンセル済みリクエストのリスナーが後続リクエストの
          // コールバックを上書きしないようにする。
          const onData = () => {
            options?.signal.removeEventListener('abort', onAbort);
            if (this.awaitingCallback === onData) {
              this.awaitingCallback = null;
            }
            resolve();
          };
          const onAbort = () => {
            if (this.awaitingCallback === onData) {
              this.awaitingCallback = null;
            }
            reject(new Error('Demodulation aborted'));
          };
          this.awaitingCallback = onData;
          options?.signal.addEventListener('abort', onAbort, { once: true });
          // リスナー登録前にabortが届いていた場合に備える
          if (options?.signal?.aborted) {
            onAbort();
          }
        });
      }

      const finalAvailableBytes = this.demodulatedBuffer.length;
      const demodulatedBytes = new Uint8Array(finalAvailableBytes);

      for (let i = 0; i < finalAvailableBytes; i++) {
        const byte = this.demodulatedBuffer.remove();
        demodulatedBytes[i] = byte;
      }

      return demodulatedBytes;
  }

  async reset(): Promise<void> {
      console.log(`[FSKProcessor:${this.instanceName}] Resetting FSKProcessor state`);

      // 進行中の操作をabortし、待機中のPromiseを確実に終了させる
      // （以前はPromiseが吊られたまま残り、応答が返らない可能性があった）
      if (this.modulationAbortController) {
        this.modulationAbortController.abort();
        this.modulationAbortController = null;
      }
      if (this.demodulationAbortController) {
        this.demodulationAbortController.abort();
        this.demodulationAbortController = null;
      }

      // 未再生の波形・受信バッファ・待機状態をクリア
      this.pendingModulation?.cancel();
      this.pendingModulation = null;
      this.demodulatedBuffer.clear();
      this.awaitingCallback = null;
      this.modulationWaitCallback = () => {};
      this.samplesGenerated = 0;
      this.processDemodulationCallCount = 0;

      // FSK復調器の同期状態・内部バッファもリセット（設定は維持される）
      this.fskCore.reset();
  }
  
  private resetModulationAbortController(): void {
    if (this.modulationAbortController) {
      this.modulationAbortController.abort();
    }
    this.modulationAbortController = new MyAbortController();
  }

  private resetDemodulationAbortController(): void {
    if (this.demodulationAbortController) {
      this.demodulationAbortController.abort();
    }
    this.demodulationAbortController = new MyAbortController();
  }
  
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const output = outputs[0];
    
    // Handle input for demodulation
    if (input?.[0]) {
      this.demodulateFrom(input[0]);
    }
    
    // Handle output for modulation
    if (output?.[0]) {
      this.modulateTo(output[0]);
    }
    
    return true;
  }

  private async handleMessage(event: MessageEvent<WorkletMessage>) {
    const { id, type, data } = event.data;

    try {
      switch (type) {
        case 'configure':
          try {
            this.fskCore.configure(data.config);
            console.log(`[FSKProcessor:${this.instanceName}] FSKCore configured successfully, ready:`, this.fskCore.isReady());
            this.port.postMessage({ id, type: 'result', data: { success: true } });
          } catch (configError) {
            console.error(`[FSKProcessor:${this.instanceName}] Configuration error:`, configError);
            throw configError;
          }
          break;
        case 'reset': {
          console.log(`[FSKProcessor:${this.instanceName}] Resetting FSKProcessor state`);
          await this.reset();
          this.port.postMessage({ id, type: 'result', data: { success: true } });
          break;
        }

        case 'abort': {
          // Handle abort signal
          // data.id が指定されていればその操作のみ、なければ進行中の全操作をキャンセルする。
          // （キャンセル要求と完了/データ到着の順序が入れ替わっても、
          //   別操作の状態を巻き込まないようにする）
          const targetId = data?.id as string | undefined;
          if (!targetId || targetId === this.currentModulationId) {
            if (this.modulationAbortController) {
              console.warn(`[FSKProcessor:${this.instanceName}] Received abort signal for modulation`);
              this.modulationAbortController.abort();
              this.modulationAbortController = null;
            }
          }
          if (!targetId || targetId === this.currentDemodulationId) {
            if (this.demodulationAbortController) {
              console.warn(`[FSKProcessor:${this.instanceName}] Received abort signal for demodulation`);
              this.demodulationAbortController.abort();
              this.demodulationAbortController = null;
            }
          }
          if (id) this.port.postMessage({ id, type: 'result', data: { success: true } });
          break;
        }

        case 'modulate': {
          this.resetModulationAbortController();
          this.currentModulationId = id;
          try {
            // console.log(`[FSKProcessor:${this.instanceName}] Modulating ${data.bytes.length} bytes: [${data.bytes.map((b: number) => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
            // @ts-expect-error
            await this.modulate(new Uint8Array(data.bytes), { signal: this.modulationAbortController!.signal });
            // Clear receive buffer after modulation to avoid self-reception
            this.demodulatedBuffer.clear();
            this.port.postMessage({ id, type: 'result', data: { success: true } });
          } finally {
            if (this.currentModulationId === id) this.currentModulationId = null;
          }
          break;
        }

        case 'demodulate': {
          this.resetDemodulationAbortController();
          this.currentDemodulationId = id;
          try {
            // console.log(`[FSKProcessor:${this.instanceName}] Demodulating data request received`);
            // @ts-expect-error
            const demodulatedBytes = await this.demodulate({ signal: this.demodulationAbortController!.signal });
            this.port.postMessage({ id, type: 'result', data: { bytes: Array.from(demodulatedBytes) } });
          } finally {
            if (this.currentDemodulationId === id) this.currentDemodulationId = null;
          }
          break;
        }

        case 'status': {
          // Send detailed status including debug info
          const fskStatus = this.fskCore.getStatus();
          this.port.postMessage({
            id,
            type: 'result',
            data: {
              demodulatedBufferLength: this.demodulatedBuffer.length,
              pendingModulation: !!this.pendingModulation,
              awaitingDemodulation: !!this.awaitingCallback,
              fskCoreReady: this.fskCore.isReady(),
              processDemodulationCallCount: this.processDemodulationCallCount,
              ...fskStatus
            }
          });
          break;
        }
          
        default:
          throw new Error(`Unknown message type: ${type}`);
      }
    } catch (error) {
      this.port.postMessage({ 
        id, 
        type: 'error', 
        data: { message: error instanceof Error ? error.message : String(error) } 
      });
    }
  }
  
  private samplesGenerated = 0;
  

  private hasLoggedAudioInput = false;
  
  private demodulateFrom(inputSamples: Float32Array): void {
    // Check if we're receiving audio data (log only once)
    const hasNonZero = inputSamples.some(sample => Math.abs(sample) > 0.001);
    if (hasNonZero && !this.hasLoggedAudioInput) {
      this.hasLoggedAudioInput = true;
    }
    
    // Direct processing: pass audio samples directly to FSKCore
    // FSKCore handles all buffering and stream processing internally
    this.processDemodulation(inputSamples);
  }
  
  private modulateTo(outputSamples: Float32Array): void {
    // Fill output with zeros first
    outputSamples.fill(0);
    
    // Generate modulated signal directly to output
    if (this.pendingModulation) {
      const result = this.pendingModulation.getNextSamples(outputSamples.length);
      
      if (result) {
        this.samplesGenerated += result.signal.length;
        
        // Copy signal directly to output buffer
        outputSamples.set(result.signal);
        
        // Check if modulation is complete
        if (result.isComplete) {
          this.pendingModulation = null;
          this.samplesGenerated = 0; // Reset for next modulation
          this.modulationWaitCallback();
        }
      }
    }
  }
  
  private processDemodulationCallCount = 0;
  
  private async processDemodulation(inputSamples: Float32Array): Promise<void> {
    // Check if FSKCore is ready before processing
    if (!this.fskCore.isReady()) {
      return; // Skip processing if not configured yet
    }
    
    this.processDemodulationCallCount++;
    
    try {
      // Direct processing: pass samples directly to FSKCore
      // FSKCore handles all internal buffering and stream processing
      const demodulated = await this.fskCore.demodulateData(inputSamples);
      
      // Always log when we get actual demodulation results
      if (demodulated && demodulated.length > 0) {
        // Store demodulated data
        for (const byte of demodulated) {
          this.demodulatedBuffer.put(byte);
          
          if (this.awaitingCallback) {
            this.awaitingCallback();
            this.awaitingCallback = null;
          }
        }
      }
    } catch (error) {
      console.error(`[FSKProcessor:${this.instanceName}] Demodulation error:`, error);
    }
  }

}

// Register the processor
registerProcessor('fsk-processor', FSKProcessor);
