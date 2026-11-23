// Streaming feature analyzer. A fixed-size analysis window is slid
// over an incoming sample stream; each new frame produces the
// requested feature vector. The output is equivalent to a batched
// framing of the same data.
//
// Input may arrive at a different rate than the analysis rate. When
// sourceSampleRate differs from sampleRate the analyzer runs a
// windowed-sinc conversion (the same kernel as resample(..., 'sinc'))
// while samples arrive and frames the converted stream. Emitted
// frames then match "resample the whole input, then frame it" with
// the same arithmetic, and a chunk boundary never changes the frame
// sequence.
//
// Exactness and the tail: an output sample depends on nearby source
// samples in both directions, so a frame is emitted only once every
// source sample its kernel needs has arrived. Output positions whose
// kernel reaches past the last pushed sample are completed by
// flush(), which marks the end of the current source stream. Call it
// once after the final push when the input rate differs from the
// analysis rate; a same-rate analyzer needs no flush.
//
// The analyzer retains only the source samples unfinished output
// positions still need, so memory stays bounded however much audio
// passes through.

import { assertFiniteSamples, assertInteger } from './validation.js';
import { assertSampleRate, assertSampleCount } from './sample-rate.js';
import { isPow2 } from './pow2.js';
import { RingBuffer } from './ring.js';
import { rms, zeroCrossingRate } from './features-time.js';
import { spectralCentroid, spectralFlatness, spectralRolloff } from './features-spectral.js';
import { fft, MAX_FFT_SIZE } from './fft.js';
import { magnitude, halfSpectrum } from './spectrum.js';
import {
  planSincKernel,
  resampledLength,
  sincKernel,
  sincPosition,
  type SincKernelPlan,
} from './resample-kernel.js';

export interface StreamingFrame {
  rms: number;
  zcr: number;
  centroid: number;
  rolloff: number;
  flatness: number;
}

export interface StreamingOptions {
  /** Analysis sample rate. Frames and features use this rate. */
  sampleRate: number;
  /** Rate of the samples passed to push(). Defaults to sampleRate. */
  sourceSampleRate?: number;
  frameSize: number;
  hopSize: number;
  retainFrames?: number;
}

/**
 * Sliding source window used by the sinc conversion. `base` is the
 * absolute index of the oldest retained sample, so source indices stay
 * meaningful across trims without helper bookkeeping.
 */
class SourceWindow {
  private data: Float32Array;
  private base = 0;
  private count = 0;

  constructor(capacity: number) {
    this.data = new Float32Array(capacity);
  }

  get received(): number {
    return this.base + this.count;
  }

  /** Absolute source index of the oldest retained sample. */
  get first(): number {
    return this.base;
  }

  push(value: number): void {
    if (this.count === this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data.subarray(0, this.count));
      this.data = grown;
    }
    this.data[this.count++] = value;
  }

  at(index: number): number | undefined {
    const offset = index - this.base;
    if (offset < 0 || offset >= this.count) return undefined;
    return this.data[offset];
  }

  /** Drop samples older than `index`; indices below zero are never kept. */
  trimBefore(index: number): void {
    const keepFrom = Math.max(0, index);
    if (keepFrom <= this.base) return;
    const drop = Math.min(this.count, keepFrom - this.base);
    if (drop <= 0) return;
    this.data.copyWithin(0, drop, this.count);
    this.count -= drop;
    this.base += drop;
  }

  clear(): void {
    this.base = 0;
    this.count = 0;
  }
}

/**
 * Incremental windowed-sinc conversion. Output position `j` sits at
 * source time j * sourceRate / targetRate, exactly as the batch path,
 * and mixes the source taps within `radius` of that position that
 * have arrived. Missing leading taps are skipped, reproducing the
 * batch boundary rule at the start of the stream.
 */
class SincConverter {
  private readonly plan: SincKernelPlan;
  private readonly window: SourceWindow;
  private nextOutput = 0;

  constructor(plan: SincKernelPlan) {
    this.plan = plan;
    this.window = new SourceWindow(Math.max(64, 4 * plan.radius + 8));
  }

  accept(value: number): void {
    this.window.push(value);
  }

  /** True when the next output position only touches received samples. */
  ready(): boolean {
    if (this.window.received === 0) return false;
    const center = Math.floor(sincPosition(this.nextOutput, this.plan));
    return center + this.plan.radius <= this.window.received - 1;
  }

  /** Emit the next output sample; callers check ready() first. */
  take(): number {
    const value = this.valueAt(this.nextOutput);
    this.nextOutput++;
    this.trim();
    return value;
  }

  /**
   * Emit every output position for the input received so far,
   * including positions whose kernel reaches past the last sample.
   * Those follow the batch rule too (missing taps are skipped), so
   * the completed stream equals a whole-buffer conversion.
   */
  drain(): number[] {
    const pending: number[] = [];
    const total =
      this.window.received === 0 ? 0 : resampledLength(this.window.received, this.plan.ratio);
    while (this.nextOutput < total) {
      pending.push(this.valueAt(this.nextOutput));
      this.nextOutput++;
    }
    this.trim();
    return pending;
  }

  clear(): void {
    this.window.clear();
    this.nextOutput = 0;
  }

  private valueAt(index: number): number {
    const { radius, cutoff } = this.plan;
    const position = sincPosition(index, this.plan);
    const center = Math.floor(position);
    const frac = position - center;
    let acc = 0;
    let weightSum = 0;
    for (let k = -radius; k <= radius; k++) {
      const sample = this.window.at(center + k);
      if (sample === undefined) continue;
      const h = sincKernel(k, frac, radius, cutoff);
      acc += sample * h;
      weightSum += h;
    }
    return weightSum === 0 ? 0 : acc / weightSum;
  }

  private trim(): void {
    // Keep a little slack so trimming stays amortized instead of
    // copying the window on every emitted sample. Retained memory is
    // still O(radius), independent of stream length.
    const center = Math.floor(sincPosition(this.nextOutput, this.plan));
    const keepFrom = center - this.plan.radius;
    if (keepFrom - this.window.first < this.plan.radius) return;
    this.window.trimBefore(keepFrom);
  }
}

export class StreamingAnalyzer {
  readonly frameSize: number;
  readonly hopSize: number;
  private readonly retainFrames: number;
  private rate: number;
  private source: number;
  private sourcePinned: boolean;
  private converter: SincConverter | null;
  private buffer: RingBuffer;
  private received = 0;
  private nextFrameEnd: number;
  private readonly frames: StreamingFrame[] = [];

  /** Analysis sample rate of the current session. */
  get sampleRate(): number {
    return this.rate;
  }

  /** Input sample rate of the current session. */
  get sourceSampleRate(): number {
    return this.source;
  }

  constructor(options: StreamingOptions) {
    assertSampleRate(options.sampleRate);
    const sourceSampleRate = options.sourceSampleRate ?? options.sampleRate;
    assertSampleRate(sourceSampleRate);
    assertSampleCount(options.hopSize);
    assertInteger(options.frameSize, 'frameSize');
    if (options.hopSize < 1) throw new RangeError('hopSize must be positive');
    if (!isPow2(options.frameSize) || options.frameSize > MAX_FFT_SIZE)
      throw new RangeError('unsupported FFT frameSize');
    const retainFrames = options.retainFrames ?? 1024;
    assertInteger(retainFrames, 'retainFrames');
    if (retainFrames < 0 || retainFrames > 100_000)
      throw new RangeError('retainFrames must be in [0,100000]');
    const plan =
      sourceSampleRate === options.sampleRate
        ? null
        : planSincKernel(sourceSampleRate, options.sampleRate);
    this.retainFrames = retainFrames;
    this.rate = options.sampleRate;
    this.source = sourceSampleRate;
    // Remember whether the caller pinned an input rate. A session that
    // never declared one keeps following the analysis rate on a switch.
    this.sourcePinned = options.sourceSampleRate !== undefined;
    this.frameSize = options.frameSize;
    this.hopSize = options.hopSize;
    this.converter = plan ? new SincConverter(plan) : null;
    this.buffer = new RingBuffer(this.frameSize);
    this.nextFrameEnd = this.frameSize;
  }

  push(samples: ArrayLike<number>): StreamingFrame[] {
    assertFiniteSamples(samples);
    for (let i = 0; i < samples.length; i++) {
      if (!Number.isFinite(Math.fround(samples[i]!)))
        throw new RangeError('sample exceeds Float32 range');
    }
    const out: StreamingFrame[] = [];
    const converter = this.converter;
    if (!converter) {
      for (let i = 0; i < samples.length; i++) this.acceptAnalysed(samples[i] ?? 0, out);
      return out;
    }
    for (let i = 0; i < samples.length; i++) {
      converter.accept(samples[i] ?? 0);
      while (converter.ready()) this.acceptAnalysed(converter.take(), out);
    }
    return out;
  }

  /**
   * Complete the current source stream: emit any frames whose
   * conversion kernel reached past the last pushed sample, exactly as
   * a whole-buffer conversion of everything received would. Only
   * needed when the input rate differs from the analysis rate, and
   * only once after the final push. Push after flush continues the
   * same session with the completed positions fixed.
   */
  flush(): StreamingFrame[] {
    const converter = this.converter;
    if (!converter) return [];
    const out: StreamingFrame[] = [];
    for (const value of converter.drain()) this.acceptAnalysed(value, out);
    return out;
  }

  /**
   * Start a new session at `sampleRate`.
   *
   * If this analyzer was constructed with an explicit sourceSampleRate
   * (the input device rate), the input rate stays pinned unless a new
   * one is given here: an analysis-rate change should not silently
   * reinterpret the incoming samples. When no source rate was ever
   * declared, the input keeps matching the analysis rate.
   *
   * Calling this with both rates already in effect is a no-op and
   * keeps the current session. Otherwise the ring buffer, received
   * count, retained history and the unfinished tail of the previous
   * session are dropped, so the next frame starts from the new
   * session's first complete frame.
   *
   * Rates and the sinc kernel budget are validated before any state
   * changes: an invalid switch throws and leaves the current session
   * usable.
   */
  setSampleRate(sampleRate: number, sourceSampleRate?: number): void {
    assertSampleRate(sampleRate);
    const pinned = sourceSampleRate !== undefined || this.sourcePinned;
    const nextSource = sourceSampleRate ?? (this.sourcePinned ? this.source : sampleRate);
    assertSampleRate(nextSource);
    if (sampleRate === this.rate && nextSource === this.source) return;
    const plan = sampleRate === nextSource ? null : planSincKernel(nextSource, sampleRate);
    this.rate = sampleRate;
    this.source = nextSource;
    this.sourcePinned = pinned;
    this.converter = plan ? new SincConverter(plan) : null;
    this.buffer = new RingBuffer(this.frameSize);
    this.received = 0;
    this.nextFrameEnd = this.frameSize;
    this.frames.length = 0;
  }

  framesOut(): readonly StreamingFrame[] {
    return this.frames.slice();
  }

  reset(): void {
    this.buffer.clear();
    if (this.converter) this.converter.clear();
    this.received = 0;
    this.nextFrameEnd = this.frameSize;
    this.frames.length = 0;
  }

  private acceptAnalysed(sample: number, out: StreamingFrame[]): void {
    this.buffer.push(sample);
    this.received++;
    if (this.received === this.nextFrameEnd) {
      const frame = Object.freeze(this.analyse(this.buffer.toArray()));
      out.push(frame);
      this.frames.push(frame);
      if (this.frames.length > this.retainFrames)
        this.frames.splice(0, this.frames.length - this.retainFrames);
      this.nextFrameEnd += this.hopSize;
    }
  }

  private analyse(window: Float32Array): StreamingFrame {
    const N = this.frameSize;
    const mag = halfSpectrum(magnitude(fft(window)));
    return {
      rms: rms(window),
      zcr: zeroCrossingRate(window, this.rate),
      centroid: spectralCentroid(mag, N, this.rate),
      rolloff: spectralRolloff(mag, N, this.rate, 0.85),
      flatness: spectralFlatness(mag),
    };
  }
}
