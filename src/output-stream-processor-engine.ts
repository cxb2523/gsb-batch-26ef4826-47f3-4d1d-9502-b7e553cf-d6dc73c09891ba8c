import type { FrameBufferReader } from '@ain1084/audio-frame-buffer'
import type { MessageToAudioNode, MessageToProcessor } from './output-message'

/**
 * A sink that receives the messages emitted by the {@link OutputStreamProcessorEngine}.
 * In the AudioWorklet these are forwarded through `MessagePort.postMessage`.
 */
export interface ProcessorMessageSink {
  postMessage(message: MessageToAudioNode): void
}

/**
 * OutputStreamProcessorEngine class
 *
 * Holds the stateful playback logic of the output stream processor independently of the
 * AudioWorklet environment, so that underrun accounting and stop handling can be tested
 * without a real AudioContext.
 *
 * State transitions driven by this engine:
 * - A `stop` message with a frame position at or below the frames already read stops the
 *   processor immediately, instead of waiting for the next process() checkpoint.
 * - While the buffer is empty, silence is output and the number of silent frames is
 *   accumulated. When data becomes available again, the accumulated duration is reported
 *   through a single UnderrunEvent and the counter is reset.
 * - If the processor is stopped while an underrun is still in progress, the accumulated
 *   silent frames are flushed as an UnderrunEvent before the StopEvent is emitted.
 * - Once stopped, no further underrun events are emitted.
 */
export class OutputStreamProcessorEngine {
  private readonly _frameReader: FrameBufferReader
  private readonly _messageSink: ProcessorMessageSink
  private _shouldStop = false
  private _stopped = false
  private _stopFramePosition: bigint | undefined
  private _underrunFrameCount = 0
  private _isUnderrun = false

  /**
   * Creates an instance of OutputStreamProcessorEngine.
   * @param frameReader - The reader used to consume frames from the shared frame buffer.
   * @param messageSink - The sink receiving `underrun` and `stop` messages.
   */
  constructor(frameReader: FrameBufferReader, messageSink: ProcessorMessageSink) {
    this._frameReader = frameReader
    this._messageSink = messageSink
  }

  /**
   * Handles a message sent from the audio node.
   * Only `stop` messages are supported.
   * @param message - The message sent to the processor.
   */
  public handleMessage(message: MessageToProcessor): void {
    if (message.type !== 'stop') {
      throw new Error(`Unexpected message type: ${message.type}`)
    }
    const framePosition = message.framePosition
    // A non-positive position, or a position that playback has already reached or passed,
    // must stop the processor immediately rather than wait for the next process() checkpoint.
    if (framePosition <= 0 || framePosition <= this._frameReader.totalFrames) {
      this._shouldStop = true
      return
    }
    this._stopFramePosition = framePosition
  }

  /**
   * Copies the given number of frames into the output by reading from the frame buffer.
   * Deinterleaves the interleaved frame samples into the per-channel output arrays.
   * @param output - The output channel arrays provided by process().
   * @param maxReadFrames - The maximum number of frames allowed to be read on this call.
   * @returns The number of frames actually read from the buffer.
   */
  private readOutput(output: Float32Array[], maxReadFrames: number): number {
    const samplesPerFrame = output.length
    return this._frameReader.read((segment, offset) => {
      const bufferFrameCount = segment.frameCount
      const frameCount = Math.min(bufferFrameCount, maxReadFrames - offset)
      // Deinterleaves interleaved audio frame data and writes it to the output.
      output.forEach((outputChannel, channelIndex) => {
        for (let i = channelIndex, j = 0; j < frameCount; i += samplesPerFrame, ++j) {
          outputChannel[offset + j] = segment.samples[i]
        }
      })
      return frameCount
    })
  }

  /**
   * Flushes the accumulated underrun frame count.
   * When an underrun has been resolved (or the processor is stopping), the total number of
   * silent frames accumulated since the underrun started is reported once and the counter
   * is reset. Nothing is emitted when no underrun has been accumulated.
   */
  private flushUnderrun(): void {
    if (this._underrunFrameCount === 0) {
      return
    }
    this._messageSink.postMessage({ type: 'underrun', underrunFrameCount: this._underrunFrameCount })
    this._underrunFrameCount = 0
    this._isUnderrun = false
  }

  /**
   * Stops the processor.
   * Any underrun still in progress is reported before the stop message so that accumulated
   * silent frames are never lost. After this call no further underrun events are emitted.
   * The stop sequence is emitted only once; subsequent calls return `false` without
   * posting any message.
   * @returns Always `false`, suitable as the return value of process().
   */
  private stopProcessing(): boolean {
    if (this._stopped) {
      return false
    }
    this._stopped = true
    this.flushUnderrun()
    this._messageSink.postMessage({ type: 'stop', totalProcessedFrames: this._frameReader.totalFrames })
    this._shouldStop = true
    return false
  }

  /**
   * Processes one render quantum.
   * Reads as many frames as are available (without crossing the requested stop position),
   * outputs silence for the remainder while underrun, and reports stop/underrun events.
   * @param outputs - The output audio data provided by the AudioWorklet.
   * @returns `true` while processing should continue, `false` once stopped.
   */
  public process(outputs: Float32Array[][]): boolean {
    const output = outputs[0]
    const blockFrameCount = output[0].length

    // A stop requested at a position already reached takes effect immediately:
    // do not read or output another block.
    if (this._shouldStop) {
      return this.stopProcessing()
    }

    // Never read beyond the requested stop position.
    let maxReadFrames = blockFrameCount
    if (this._stopFramePosition !== undefined) {
      const remainingFrames = this._stopFramePosition - this._frameReader.totalFrames
      if (remainingFrames <= BigInt(0)) {
        return this.stopProcessing()
      }
      const remainingFrameCount = Number(remainingFrames)
      if (remainingFrameCount < maxReadFrames) {
        maxReadFrames = remainingFrameCount
      }
    }

    const readFrames = this.readOutput(output, maxReadFrames)
    const totalFrames = this._frameReader.totalFrames

    if (this._stopFramePosition !== undefined && totalFrames >= this._stopFramePosition) {
      // Reached the requested stop position. Silence produced by clamping the read is not
      // part of an underrun, so only previously accumulated underrun frames are flushed.
      return this.stopProcessing()
    }

    // A short read means the buffer was exhausted: the rest of this block is silence.
    // process() may run before the node is connected; ignore silence before any frame has
    // ever been read.
    const underrunFrames = blockFrameCount - readFrames
    if (totalFrames === BigInt(0)) {
      return true
    }
    if (readFrames > 0 && this._isUnderrun) {
      // New data has been supplied while silence was being output: the underrun has
      // recovered, so report the accumulated silent duration before starting a new one.
      this.flushUnderrun()
    }
    if (underrunFrames > 0) {
      this._underrunFrameCount += underrunFrames
      this._isUnderrun = true
    }
    return true
  }
}
