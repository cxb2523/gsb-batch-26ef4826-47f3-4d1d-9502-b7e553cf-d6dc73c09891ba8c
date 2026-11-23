// Sample-rate conversion. Three modes are exposed:
// - linear: fast two-tap interpolation, fine for control signals
// - nearest: zero-order hold, lowest CPU cost
// - sinc: windowed-sinc for high-quality resampling

import { AudioBuffer } from './buffer.js';
import { assertFiniteSamples, assertInteger, assertInRange } from './validation.js';
import { assertSampleRate } from './sample-rate.js';
import {
  DEFAULT_SINC_HALF_WIDTH,
  planSincKernel,
  resampledLength,
  sincKernel,
} from './resample-kernel.js';

export type ResampleMode = 'linear' | 'nearest' | 'sinc';

export function resample(
  buffer: AudioBuffer,
  targetSampleRate: number,
  mode: ResampleMode = 'linear',
  options?: { sincHalfWidth?: number },
): AudioBuffer {
  assertSampleRate(targetSampleRate);
  assertSampleRate(buffer.sampleRate);
  if (!['nearest', 'linear', 'sinc'].includes(mode))
    throw new RangeError('Unknown resampling mode');
  const halfWidth = options?.sincHalfWidth ?? DEFAULT_SINC_HALF_WIDTH;
  assertInteger(halfWidth, 'sincHalfWidth');
  assertInRange(halfWidth, 2, 64, 'sincHalfWidth');
  for (const channel of buffer.data) assertFiniteSamples(channel);
  if (targetSampleRate === buffer.sampleRate) return buffer;
  if (buffer.numSamples === 0) {
    return new AudioBuffer(targetSampleRate, buffer.numChannels, 0);
  }
  const ratio = targetSampleRate / buffer.sampleRate;
  const outSamples = resampledLength(buffer.numSamples, ratio);
  const plan =
    mode === 'sinc' ? planSincKernel(buffer.sampleRate, targetSampleRate, halfWidth) : null;
  const cutoff = plan ? plan.cutoff : Math.min(1, ratio),
    radius = plan ? plan.radius : Math.ceil(halfWidth / cutoff);
  const out = new AudioBuffer(targetSampleRate, buffer.numChannels, outSamples);
  for (let c = 0; c < buffer.numChannels; c++) {
    const src = buffer.getChannel(c);
    const dst = out.getChannel(c);
    for (let i = 0; i < outSamples; i++) {
      const t = (i * buffer.sampleRate) / targetSampleRate;
      if (mode === 'nearest') {
        const idx = Math.min(src.length - 1, Math.max(0, Math.round(t)));
        dst[i] = src[idx] ?? 0;
      } else if (mode === 'linear') {
        const lo = Math.floor(t);
        const frac = t - lo;
        const a = src[Math.min(src.length - 1, Math.max(0, lo))] ?? 0;
        const b = src[Math.min(src.length - 1, Math.max(0, lo + 1))] ?? 0;
        dst[i] = a + (b - a) * frac;
      } else {
        const center = Math.floor(t);
        const frac = t - center;
        let acc = 0;
        let wsum = 0;
        for (let k = -radius; k <= radius; k++) {
          const idx = center + k;
          if (idx < 0 || idx >= src.length) continue;
          const h = sincKernel(k, frac, radius, cutoff);
          acc += (src[idx] ?? 0) * h;
          wsum += h;
        }
        dst[i] = wsum === 0 ? 0 : acc / wsum;
      }
    }
  }
  return out;
}

export function resampleMono(
  samples: ArrayLike<number>,
  sourceRate: number,
  targetRate: number,
  mode: ResampleMode = 'linear',
): Float32Array {
  assertSampleRate(sourceRate);
  assertSampleRate(targetRate);
  assertFiniteSamples(samples);
  const input = new AudioBuffer(sourceRate, 1, samples.length, [Float32Array.from(samples)]);
  return new Float32Array(resample(input, targetRate, mode).getChannel(0));
}
