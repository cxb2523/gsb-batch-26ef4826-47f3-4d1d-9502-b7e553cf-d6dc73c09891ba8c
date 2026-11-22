/**
 * Fixed-step accumulator.
 *
 * The whole point: physics only ever advances in whole `stepSeconds` ticks,
 * no matter how long a render frame took. A 240 Hz monitor gets more renders
 * (and therefore more interpolated pictures), not more physics ticks.
 *
 * Rules enforced here:
 *   - Real time is clamped per call so a long stall (tab in background, GC
 *     pause, breakpoint) can never produce a burst of catch-up ticks.
 *   - While paused, time is simply dropped. Resuming does not "catch up".
 *   - `alpha` is the leftover fraction of a tick, used *only* for rendering
 *     interpolation. It is never fed back into the physics.
 */

export interface ClockOptions {
  stepSeconds: number;
  /** Longest real-time slice consumed in one call. */
  maxFrameSeconds?: number;
}

export class FixedStepClock {
  readonly stepSeconds: number;
  readonly maxFrameSeconds: number;

  private accumulator = 0;
  private paused = false;
  /** Ticks emitted since construction (diagnostics / tests). */
  private emitted = 0;

  constructor(options: ClockOptions) {
    if (!(options.stepSeconds > 0)) throw new Error('stepSeconds must be > 0');
    this.stepSeconds = options.stepSeconds;
    this.maxFrameSeconds = options.maxFrameSeconds ?? 0.25;
  }

  /** Feed one frame's real elapsed time; returns how many whole ticks to run. */
  advance(realSeconds: number): number {
    if (this.paused) return 0;
    if (!Number.isFinite(realSeconds) || realSeconds <= 0) return 0;
    const slice = Math.min(realSeconds, this.maxFrameSeconds);
    this.accumulator += slice;
    // +1e-9 keeps exact multiples (e.g. 1/128 fed 128 times) from flooring to
    // one step short due to floating point drift.
    const steps = Math.floor(this.accumulator / this.stepSeconds + 1e-9);
    if (steps > 0) {
      this.accumulator -= steps * this.stepSeconds;
      // Keep the fractional part in range even after many steps.
      if (this.accumulator < 0) this.accumulator = 0;
      this.emitted += steps;
    }
    return steps;
  }

  /** Leftover fraction of a tick in [0, 1), for render interpolation only. */
  get alpha(): number {
    return this.accumulator / this.stepSeconds;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get totalSteps(): number {
    return this.emitted;
  }

  /**
   * Pausing drops the accumulator: when play resumes the first frame starts
   * from a clean slate, so the player never teleports through a wall because
   * the tab was hidden for ten minutes.
   */
  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.accumulator = 0;
  }

  reset(): void {
    this.accumulator = 0;
    this.emitted = 0;
  }
}

/**
 * Split a whole-frame value across `steps` ticks.
 *
 * Uses running-total differencing so the parts always sum exactly to `total`
 * (important for yaw: dropped remainder would be a slow aim drift). When there
 * are no steps the whole value is returned as a single part, but callers should
 * usually carry it to the next frame instead.
 */
export function splitEvenly(total: number, steps: number): number[] {
  if (steps <= 0) return [];
  const parts: number[] = new Array(steps);
  let previous = 0;
  for (let i = 1; i <= steps; i++) {
    const cumulative = (total * i) / steps;
    parts[i - 1] = cumulative - previous;
    previous = cumulative;
  }
  return parts;
}
