export class LookaheadLimiter {
  constructor(sampleRate: number, channels?: number, options?: {lookaheadMs?: number; attackMs?: number; releaseMs?: number; ceilingDb?: number});
  readonly delaySamples: number;
  readonly ceiling: number;
  /** Drop all lookahead and gain-reduction state; equivalent to a freshly constructed limiter. */
  reset(): void;
  process(input: Float32Array[], output: Float32Array[]): void;
}
