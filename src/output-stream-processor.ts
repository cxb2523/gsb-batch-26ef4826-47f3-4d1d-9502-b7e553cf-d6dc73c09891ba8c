import { FrameBufferReader, type FrameBufferContext } from '@ain1084/audio-frame-buffer'
import { PROCESSOR_NAME } from './constants'
import type { MessageToAudioNode, MessageToProcessor } from './output-message'
import { OutputStreamProcessorEngine } from './output-stream-processor-engine'

/**
 * OutputStreamProcessor class
 * This class extends AudioWorkletProcessor to process audio data.
 * It uses a FrameBufferReader instance to read from a shared buffer and delegates
 * underrun accounting and stop handling to OutputStreamProcessorEngine.
 */
class OutputStreamProcessor extends AudioWorkletProcessor {
  private readonly _engine: OutputStreamProcessorEngine

  /**
   * Creates an instance of OutputStreamProcessor.
   * @param options - The options for the processor, including shared buffers.
   */
  constructor(options: AudioWorkletNodeOptions) {
    super()
    const frameReader = new FrameBufferReader(options.processorOptions as FrameBufferContext)
    this._engine = new OutputStreamProcessorEngine(frameReader, {
      postMessage: (message: MessageToAudioNode): void => {
        this.port.postMessage(message)
      },
    })
    this.port.onmessage = (event: MessageEvent<MessageToProcessor>): void => {
      this._engine.handleMessage(event.data)
    }
  }

  /**
   * Processes the audio data.
   * @param _inputs - The input audio data.
   * @param outputs - The output audio data.
   * @returns A boolean indicating whether to continue processing.
   */
  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const keepRunning = this._engine.process(outputs)
    if (!keepRunning) {
      // Pending messages are still delivered before the port is closed.
      this.port.close()
    }
    return keepRunning
  }
}

registerProcessor(PROCESSOR_NAME, OutputStreamProcessor)
