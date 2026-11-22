import { StopEvent, StreamNodeFactory, UnderrunEvent,
  type OutputStreamNode,
} from '@ain1084/audio-worklet-stream'
import worker from './worker?worker'
import type { FillerParameters } from './sine-wave-frame-buffer-filler'
import { SineWaveFrameBufferFiller } from './sine-wave-frame-buffer-filler'
import { SineWaveGenerator } from './sine-wave-generator'

/**
 * Maximum number of log lines kept in the example log panel.
 */
const MAX_LOG_LINES = 20

class Main {
  private factory: StreamNodeFactory | null = null
  private streamNode: OutputStreamNode | null = null
  private readonly statusCell: HTMLElement
  private readonly stopPositionCell: HTMLElement
  private readonly underrunCountCell: HTMLElement
  private readonly underrunFramesCell: HTMLElement
  private readonly logDiv: HTMLElement
  private underrunEventCount = 0
  private totalUnderrunFrames = 0

  constructor() {
    this.statusCell = document.getElementById('status')!
    this.stopPositionCell = document.getElementById('stopPosition')!
    this.underrunCountCell = document.getElementById('underrunCount')!
    this.underrunFramesCell = document.getElementById('underrunFrames')!
    this.logDiv = document.getElementById('log')!

    this.addCommand('startManualButton', async (): Promise<OutputStreamNode> => {
      const frequencies = [440]
      const sampleRate = this.factory!.audioContext.sampleRate
      const generators = frequencies.map((frequency) => {
        return new SineWaveGenerator({ frequency, sampleRate })
      })
      const frameBufferSize = this.factory!.audioContext.sampleRate
      const [node, writer] = await this.factory!.createManualBufferNode({
        channelCount: frequencies.length, frameCount: frameBufferSize })
      writer.write((segment) => {
        for (let i = 0; i < segment.frameCount; ++i) {
          generators.forEach((generator, channelIndex) => {
            segment.set(i, channelIndex, generator.nextValue() * 0.3)
          })
        }
        return segment.frameCount
      })
      // The manual node receives only one second of data and nothing more, so playback
      // will underrun once the buffer has been drained.
      return node
    })

    this.addCommand('startTimerButton', async (): Promise<OutputStreamNode> => {
      const frequencies = [440]
      return this.factory!.createTimedBufferNode(
        new SineWaveFrameBufferFiller(
          { sampleRate: this.factory!.audioContext.sampleRate, frequencies },
        ),
        { channelCount: frequencies.length },
      )
    })

    this.addCommand('startWorkerButton', async (): Promise<OutputStreamNode> => {
      const frequencies = [440, 431]
      return this.factory!.createWorkerBufferNode<FillerParameters>(
        worker,
        { channelCount: frequencies.length,
          fillerParams: { sampleRate: this.factory!.audioContext.sampleRate, frequencies },
        },
      )
    })

    const stopButton = document.getElementById('stopButton')!
    stopButton.addEventListener('click', async (): Promise<void> => {
      await this.streamNode?.stop()
      this.streamNode = null
    })

    const stopAtPositionButton = document.getElementById('stopAtPositionButton')!
    stopAtPositionButton.addEventListener('click', async (): Promise<void> => {
      const node = this.streamNode
      if (!node) {
        this.appendLog('No active stream to stop')
        return
      }
      // Stop 256 frames after the position already played. This makes the exact stop
      // position observable in the table below.
      const stopAtFrame = node.totalReadFrames + BigInt(256)
      this.appendLog(`Requesting stop at frame ${stopAtFrame} (current read position: ${node.totalReadFrames})`)
      await node.stop(stopAtFrame)
      this.streamNode = null
    })
  }

  private addCommand(id: string, commandProc: () => Promise<OutputStreamNode>): void {
    document.getElementById(id)!.addEventListener('click', async (): Promise<void> => {
      await this.streamNode?.stop()
      this.streamNode = null
      await this.prepareStreamFactory()
      if (!this.factory) {
        throw new Error('Invalid factory state')
      }
      this.resetUnderrunCounters()
      this.stopPositionCell.textContent = '-'
      this.streamNode = await commandProc()
      this.startStreamNode()
    })
  }

  private async prepareStreamFactory(): Promise<StreamNodeFactory> {
    if (!this.factory) {
      this.factory = await StreamNodeFactory.create(new AudioContext())
    }
    return this.factory
  }

  private startStreamNode(): void {
    if (!this.streamNode) {
      throw new Error('Invalid streamNode state')
    }
    this.streamNode.addEventListener(UnderrunEvent.type, (event) => {
      const underrunEvent = event as UnderrunEvent
      this.underrunEventCount += 1
      this.totalUnderrunFrames += underrunEvent.frameCount
      this.underrunCountCell.textContent = String(this.underrunEventCount)
      this.underrunFramesCell.textContent = String(this.totalUnderrunFrames)
      this.appendLog(`UnderrunEvent: ${underrunEvent.frameCount} silent frames`)
    })
    this.streamNode.addEventListener(StopEvent.type, (event) => {
      const stopEvent = event as StopEvent
      this.statusCell.textContent = 'Stopped'
      this.stopPositionCell.textContent = String(stopEvent.stoppedAtFrame)
      this.appendLog(`StopEvent: stopped at frame ${stopEvent.stoppedAtFrame}`)
      this.streamNode = null
    }, { once: true })
    this.streamNode.connect(this.streamNode.context.destination)
    this.streamNode.start()
    this.statusCell.textContent = 'Started'
    this.appendLog('Stream started')
  }

  private resetUnderrunCounters(): void {
    this.underrunEventCount = 0
    this.totalUnderrunFrames = 0
    this.underrunCountCell.textContent = '0'
    this.underrunFramesCell.textContent = '0'
  }

  private appendLog(message: string): void {
    const lines = this.logDiv.textContent ? this.logDiv.textContent.split('\n') : []
    lines.push(message)
    while (lines.length > MAX_LOG_LINES) {
      lines.shift()
    }
    this.logDiv.textContent = lines.join('\n')
  }
}

export default new Main()
