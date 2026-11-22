import { describe, expect, it } from 'vitest'
import {
  createFrameBufferContext,
  FrameBufferReader,
  FrameBufferWriter,
  type FrameBufferContext,
} from '@ain1084/audio-frame-buffer'
import { OutputStreamProcessorEngine } from '../src/output-stream-processor-engine'
import type { MessageToAudioNode } from '../src/output-message'

/**
 * The AudioWorklet render quantum size used in the tests.
 */
const BLOCK_FRAME_COUNT = 128

/**
 * Test harness that wires an OutputStreamProcessorEngine to a real shared frame buffer.
 */
class ProcessorHarness {
  public readonly context: FrameBufferContext
  public readonly writer: FrameBufferWriter
  public readonly engine: OutputStreamProcessorEngine
  public readonly messages: MessageToAudioNode[] = []

  constructor(channelCount: number = 1, frameCount: number = 4096) {
    this.context = createFrameBufferContext({ channelCount, frameCount })
    this.writer = new FrameBufferWriter(this.context)
    const reader = new FrameBufferReader(this.context)
    this.engine = new OutputStreamProcessorEngine(reader, {
      postMessage: (message: MessageToAudioNode): void => {
        this.messages.push(message)
      },
    })
  }

  /**
   * Writes the given number of frames, each holding a constant sample value.
   */
  public writeFrames(frameCount: number, value: number = 0.5): void {
    this.writer.write((segment) => {
      const count = Math.min(segment.frameCount, frameCount)
      for (let frame = 0; frame < count; ++frame) {
        for (let channel = 0; channel < segment.channels; ++channel) {
          segment.set(frame, channel, value)
        }
      }
      return count
    })
  }

  /**
   * Invokes one process() call with freshly zeroed output arrays and returns the outputs.
   */
  public processOnce(channelCount: number = 1): { outputs: Float32Array[][], keepRunning: boolean } {
    const outputs = [Array.from({ length: channelCount }, () => new Float32Array(BLOCK_FRAME_COUNT))]
    const keepRunning = this.engine.process(outputs)
    return { outputs, keepRunning }
  }

  public get readFrames(): bigint {
    return this.context.totalReadFrames[0]
  }

  public underrunMessages(): Array<{ type: 'underrun', underrunFrameCount: number }> {
    return this.messages.filter(
      (message): message is { type: 'underrun', underrunFrameCount: number } => message.type === 'underrun')
  }

  public stopMessages(): Array<{ type: 'stop', totalProcessedFrames: bigint }> {
    return this.messages.filter(
      (message): message is { type: 'stop', totalProcessedFrames: bigint } => message.type === 'stop')
  }
}

describe('OutputStreamProcessorEngine underrun handling', () => {
  it('reports accumulated silence frames once on recovery and resets the counter', () => {
    const harness = new ProcessorHarness()
    harness.writeFrames(BLOCK_FRAME_COUNT * 2)

    // Drain the two written blocks.
    expect(harness.processOnce().keepRunning).toBe(true)
    expect(harness.processOnce().keepRunning).toBe(true)
    expect(harness.readFrames).toBe(BigInt(BLOCK_FRAME_COUNT * 2))
    expect(harness.underrunMessages()).toHaveLength(0)

    // Buffer is empty: two blocks of silence are accumulated without events.
    expect(harness.processOnce().keepRunning).toBe(true)
    expect(harness.processOnce().keepRunning).toBe(true)
    expect(harness.underrunMessages()).toHaveLength(0)

    // Supply data again. The first recovered block reports the full accumulated duration.
    harness.writeFrames(BLOCK_FRAME_COUNT * 2)
    expect(harness.processOnce().keepRunning).toBe(true)
    const underrunEvents = harness.underrunMessages()
    expect(underrunEvents).toHaveLength(1)
    expect(underrunEvents[0].underrunFrameCount).toBe(BLOCK_FRAME_COUNT * 2)

    // Following healthy blocks do not emit further underrun events.
    expect(harness.processOnce().keepRunning).toBe(true)
    expect(harness.underrunMessages()).toHaveLength(1)
    expect(harness.stopMessages()).toHaveLength(0)
  })

  it('flushes the previous silence duration when recovery only supplies a partial block', () => {
    const harness = new ProcessorHarness()
    harness.writeFrames(BLOCK_FRAME_COUNT)
    harness.processOnce()

    // One full block of silence.
    harness.processOnce()
    expect(harness.underrunMessages()).toHaveLength(0)

    // Only a partial block is supplied: the old underrun is reported immediately and the
    // remaining silence of this block starts a fresh accumulation.
    const partialFrames = 30
    harness.writeFrames(partialFrames)
    harness.processOnce()
    const firstEvents = harness.underrunMessages()
    expect(firstEvents).toHaveLength(1)
    expect(firstEvents[0].underrunFrameCount).toBe(BLOCK_FRAME_COUNT)

    // Recover again: only the silence after the partial block is reported.
    harness.writeFrames(BLOCK_FRAME_COUNT)
    harness.processOnce()
    const allEvents = harness.underrunMessages()
    expect(allEvents).toHaveLength(2)
    expect(allEvents[1].underrunFrameCount).toBe(BLOCK_FRAME_COUNT - partialFrames)
  })

  it('reports each underrun/recovery cycle with its own accumulated duration', () => {
    const harness = new ProcessorHarness()
    harness.writeFrames(BLOCK_FRAME_COUNT)
    harness.processOnce()

    // First underrun: one silent block, then recovery.
    harness.processOnce()
    harness.writeFrames(BLOCK_FRAME_COUNT)
    harness.processOnce()
    // Second underrun: three silent blocks, then recovery.
    harness.processOnce()
    harness.processOnce()
    harness.processOnce()
    harness.writeFrames(BLOCK_FRAME_COUNT)
    harness.processOnce()

    const events = harness.underrunMessages()
    expect(events).toHaveLength(2)
    expect(events[0].underrunFrameCount).toBe(BLOCK_FRAME_COUNT)
    expect(events[1].underrunFrameCount).toBe(BLOCK_FRAME_COUNT * 3)
  })

  it('does not count silence before the first frame is read as an underrun', () => {
    const harness = new ProcessorHarness()
    // No data written at all: process() may run before connect.
    harness.processOnce()
    harness.processOnce()
    expect(harness.underrunMessages()).toHaveLength(0)

    // Once real frames flow, no stale underrun must be reported.
    harness.writeFrames(BLOCK_FRAME_COUNT)
    harness.processOnce()
    expect(harness.underrunMessages()).toHaveLength(0)
    expect(harness.readFrames).toBe(BigInt(BLOCK_FRAME_COUNT))
  })
})

describe('OutputStreamProcessorEngine stop handling', () => {
  it('flushes accumulated silence frames when stopped during an unrecovered underrun', () => {
    const harness = new ProcessorHarness()
    harness.writeFrames(BLOCK_FRAME_COUNT)
    harness.processOnce()

    // Two silent blocks while the buffer is empty.
    harness.processOnce()
    harness.processOnce()
    expect(harness.underrunMessages()).toHaveLength(0)

    // Stop arrives before the supply recovers.
    harness.engine.handleMessage({ type: 'stop', framePosition: BigInt(0) })
    const keepRunning = harness.processOnce().keepRunning
    expect(keepRunning).toBe(false)

    const underrunEvents = harness.underrunMessages()
    expect(underrunEvents).toHaveLength(1)
    expect(underrunEvents[0].underrunFrameCount).toBe(BLOCK_FRAME_COUNT * 2)

    const stopEvents = harness.stopMessages()
    expect(stopEvents).toHaveLength(1)
    // The underrun event must be emitted before the stop event.
    expect(harness.messages[0].type).toBe('underrun')
    expect(harness.messages[1].type).toBe('stop')
    expect(stopEvents[0].totalProcessedFrames).toBe(BigInt(BLOCK_FRAME_COUNT))
  })

  it('stops immediately when the stop frame position has already been read', () => {
    const harness = new ProcessorHarness()
    harness.writeFrames(BLOCK_FRAME_COUNT * 4)
    harness.processOnce()
    harness.processOnce()
    expect(harness.readFrames).toBe(BigInt(BLOCK_FRAME_COUNT * 2))

    // Request a stop at a position already passed: the very next process() must stop
    // without reading or outputting another block.
    harness.engine.handleMessage({ type: 'stop', framePosition: BigInt(BLOCK_FRAME_COUNT) })
    const { keepRunning } = harness.processOnce()
    expect(keepRunning).toBe(false)
    expect(harness.readFrames).toBe(BigInt(BLOCK_FRAME_COUNT * 2))

    const stopEvents = harness.stopMessages()
    expect(stopEvents).toHaveLength(1)
    expect(stopEvents[0].totalProcessedFrames).toBe(BigInt(BLOCK_FRAME_COUNT * 2))
    expect(harness.underrunMessages()).toHaveLength(0)
  })

  it('stops exactly at a future frame position without overshooting', () => {
    const harness = new ProcessorHarness()
    harness.writeFrames(BLOCK_FRAME_COUNT * 4)
    harness.processOnce()
    expect(harness.readFrames).toBe(BigInt(BLOCK_FRAME_COUNT))

    // The stop position lies inside the next 128-frame block.
    const stopAt = BigInt(BLOCK_FRAME_COUNT + 37)
    harness.engine.handleMessage({ type: 'stop', framePosition: stopAt })

    const { outputs, keepRunning } = harness.processOnce()
    expect(keepRunning).toBe(false)
    expect(harness.readFrames).toBe(stopAt)
    // Only the frames up to the stop position carry data; the rest stays silent.
    expect(outputs[0][0][0]).not.toBe(0)
    expect(outputs[0][0][36]).toBe(0.5)
    expect(outputs[0][0][37]).toBe(0)
    expect(outputs[0][0][BLOCK_FRAME_COUNT - 1]).toBe(0)

    const stopEvents = harness.stopMessages()
    expect(stopEvents).toHaveLength(1)
    expect(stopEvents[0].totalProcessedFrames).toBe(stopAt)
    expect(harness.underrunMessages()).toHaveLength(0)
  })

  it('emits no underrun event when stopping at a block-aligned future position', () => {
    const harness = new ProcessorHarness()
    harness.writeFrames(BLOCK_FRAME_COUNT * 3)
    harness.processOnce()

    const stopAt = BigInt(BLOCK_FRAME_COUNT * 3)
    harness.engine.handleMessage({ type: 'stop', framePosition: stopAt })
    expect(harness.processOnce().keepRunning).toBe(true)
    expect(harness.processOnce().keepRunning).toBe(false)
    expect(harness.readFrames).toBe(stopAt)
    expect(harness.underrunMessages()).toHaveLength(0)
    expect(harness.stopMessages()).toHaveLength(1)
  })

  it('emits no further underrun events after stopping', () => {
    const harness = new ProcessorHarness()
    harness.writeFrames(BLOCK_FRAME_COUNT)
    harness.processOnce()

    harness.engine.handleMessage({ type: 'stop', framePosition: BigInt(0) })
    expect(harness.processOnce().keepRunning).toBe(false)
    // Even if process() were invoked again, it must not emit anything new.
    expect(harness.processOnce().keepRunning).toBe(false)
    expect(harness.messages).toHaveLength(1)
    expect(harness.messages[0].type).toBe('stop')
  })

  it('handles multi-channel underrun and stop with per-frame accounting', () => {
    const channelCount = 2
    const harness = new ProcessorHarness(channelCount)
    harness.writeFrames(BLOCK_FRAME_COUNT)

    const first = harness.processOnce(channelCount)
    expect(first.keepRunning).toBe(true)
    expect(first.outputs[0]).toHaveLength(channelCount)
    expect(first.outputs[0][0][0]).toBe(0.5)
    expect(first.outputs[0][1][0]).toBe(0.5)

    // One silent stereo block, then recovery reports a single frame-based duration.
    harness.processOnce(channelCount)
    harness.writeFrames(BLOCK_FRAME_COUNT)
    harness.processOnce(channelCount)
    const underrunEvents = harness.underrunMessages()
    expect(underrunEvents).toHaveLength(1)
    expect(underrunEvents[0].underrunFrameCount).toBe(BLOCK_FRAME_COUNT)

    // Stopping mid-block clamps both channels at the same frame position.
    harness.writeFrames(BLOCK_FRAME_COUNT)
    const stopAt = harness.readFrames + BigInt(10)
    harness.engine.handleMessage({ type: 'stop', framePosition: stopAt })
    const clamped = harness.processOnce(channelCount)
    expect(clamped.keepRunning).toBe(false)
    expect(harness.readFrames).toBe(stopAt)
    expect(clamped.outputs[0][0][9]).toBe(0.5)
    expect(clamped.outputs[0][1][9]).toBe(0.5)
    expect(clamped.outputs[0][0][10]).toBe(0)
    expect(clamped.outputs[0][1][10]).toBe(0)
  })
})
