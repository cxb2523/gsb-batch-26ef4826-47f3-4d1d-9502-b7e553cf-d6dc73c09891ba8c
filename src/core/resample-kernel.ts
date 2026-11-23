// Shared windowed-sinc kernel used by the batch resampler and by
// StreamingAnalyzer. Keeping the arithmetic in one place guarantees
// that incremental conversion produces the same samples as a whole
// buffer conversion with resample(..., 'sinc').
//
// The helpers here assume the caller has already validated rates,
// lengths and options. They are internal: the public resampling API
// remains resample/resampleMono.

const TWO_PI = Math.PI * 2;

export const DEFAULT_SINC_HALF_WIDTH = 8;
export const MAX_SINC_KERNEL_RADIUS = 512;

function hannWindow(n: number, N: number): number {
  if (N <= 1) return 1;
  return 0.5 * (1 - Math.cos((TWO_PI * n) / (N - 1)));
}

function sinc(x: number): number {
  if (x === 0) return 1;
  return Math.sin(Math.PI * x) / (Math.PI * x);
}

export interface SincKernelPlan {
  readonly sourceRate: number;
  readonly targetRate: number;
  readonly ratio: number;
  readonly cutoff: number;
  readonly radius: number;
}

/** Geometry of a sinc conversion, including the kernel budget check. */
export function planSincKernel(
  sourceRate: number,
  targetRate: number,
  halfWidth: number = DEFAULT_SINC_HALF_WIDTH,
): SincKernelPlan {
  const ratio = targetRate / sourceRate;
  const cutoff = Math.min(1, ratio);
  const radius = Math.ceil(halfWidth / cutoff);
  if (radius > MAX_SINC_KERNEL_RADIUS)
    throw new RangeError('Sinc conversion ratio exceeds kernel budget');
  return { sourceRate, targetRate, ratio, cutoff, radius };
}

/** Fractional source position of output sample `index`, as in the batch path. */
export function sincPosition(index: number, plan: SincKernelPlan): number {
  return (index * plan.sourceRate) / plan.targetRate;
}

/** Number of output samples produced by a batch conversion. */
export function resampledLength(numSamples: number, ratio: number): number {
  return Math.max(1, Math.round(numSamples * ratio));
}

/**
 * Weight of source tap `k` for an output position `frac` samples past
 * its centre. Matches the sinc branch of resample().
 */
export function sincKernel(k: number, frac: number, radius: number, cutoff: number): number {
  const x = k - frac;
  const w = hannWindow(k + radius, 2 * radius + 1);
  return cutoff * sinc(x * cutoff) * w;
}
