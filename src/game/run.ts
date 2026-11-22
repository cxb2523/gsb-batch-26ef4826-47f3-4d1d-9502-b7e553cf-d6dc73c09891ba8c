/**
 * One player run: timer, checkpoint progress, falls, splits.
 *
 * Two rules from the design live here:
 *
 *   - **A fall does not stop the run clock.** It keeps ticking through the
 *     respawn; falling costs you the time you lost plus the climb back.
 *   - **The clock only runs after the player starts moving.** It is created in
 *     the `ready` phase and `startRun` flips it to `running`.
 *
 * This module owns no DOM and no physics. The host loop feeds it tick-level
 * events; it feeds the HUD.
 */

import { GAME, STEP_SECONDS } from '../config.ts';
import type { Course, PadSpec } from './course.ts';
import type { PhysBody } from '../physics/body.ts';

export type RunPhase = 'ready' | 'running' | 'finished';

export interface RunState {
  phase: RunPhase;
  /** Simulated seconds, advanced one tick at a time. */
  elapsed: number;
  /** Ticks simulated since the run started (ready phase is 0). */
  ticks: number;
  /** Highest pad index reached so far. */
  reachedPad: number;
  /** Last checkpoint pad index touched, or -1 for the start pad. */
  checkpointIndex: number;
  falls: number;
  /** Per-stage split times in seconds, indexed by stage. */
  splits: number[];
  /** Ticks since the last respawn; suppresses instant re-fall checks. */
  sinceRespawn: number;
}

export function createRun(): RunState {
  return {
    phase: 'ready',
    elapsed: 0,
    ticks: 0,
    reachedPad: 0,
    checkpointIndex: -1,
    falls: 0,
    splits: [],
    sinceRespawn: 0,
  };
}

export interface RunTickResult {
  /** True on the tick a new checkpoint was banked. */
  checkpoint: PadSpec | null;
  /** True on the tick the finish pad was reached. */
  finished: boolean;
  /** True on the tick the player fell and must be respawned. */
  fell: boolean;
}

const NOTHING: RunTickResult = { checkpoint: null, finished: false, fell: false };

/** Start the clock. Returns false if the run is not in the ready phase. */
export function startRun(run: RunState): boolean {
  if (run.phase !== 'ready') return false;
  run.phase = 'running';
  return true;
}

/** Advance the run clock by exactly one physics tick. */
export function tickRun(run: RunState, course: Course, body: PhysBody): RunTickResult {
  if (run.phase !== 'running') return NOTHING;

  run.elapsed += STEP_SECONDS;
  run.ticks += 1;
  run.sinceRespawn += 1;

  // Fall detection. There are two triggers:
  //   - landing on the out-of-bounds ground plane, or
  //   - dropping below the kill plane (should not happen with a solid ground,
  //     but keeps the handler safe if the world is edited).
  // Both respect the post-respawn grace period so an awkward respawn cannot
  // chain into an immediate second fall.
  if (run.sinceRespawn > GAME.respawnGraceTicks) {
    const onGroundPlane = body.onGround && body.pos.y <= course.groundTop + 2;
    if (onGroundPlane || body.pos.y < GAME.killPlaneY) {
      run.falls += 1;
      return { checkpoint: null, finished: false, fell: true };
    }
  }

  const touch = padTouched(course, body);
  if (!touch) return NOTHING;

  if (touch.kind === 'finish') {
    if (touch.index > run.reachedPad) run.reachedPad = touch.index;
    run.phase = 'finished';
    return { checkpoint: null, finished: true, fell: false };
  }

  if (touch.index > run.reachedPad) run.reachedPad = touch.index;

  if (touch.kind === 'checkpoint' && touch.index > run.checkpointIndex) {
    run.checkpointIndex = touch.index;
    // Bank a per-stage split the first time its final pad is touched.
    if (touch.stage >= 0) {
      while (run.splits.length < touch.stage) run.splits.push(Number.NaN);
      run.splits[touch.stage] = run.elapsed;
    }
    return { checkpoint: touch, finished: false, fell: false };
  }

  return NOTHING;
}

/** The pad the body is standing on, if any (within a small tolerance). */
export function padTouched(course: Course, body: PhysBody): PadSpec | null {
  if (!body.onGround) return null;
  for (const pad of course.pads) {
    const half = pad.size / 2;
    if (
      Math.abs(body.pos.y - pad.center.y) < 2 &&
      Math.abs(body.pos.x - pad.center.x) <= half &&
      Math.abs(body.pos.z - pad.center.z) <= half
    ) {
      return pad;
    }
  }
  return null;
}

/** Where to respawn: the last checkpoint (or the start pad). */
export function respawnPad(course: Course, run: RunState): PadSpec {
  if (run.checkpointIndex >= 0) {
    for (const pad of course.pads) {
      if (pad.index === run.checkpointIndex) return pad;
    }
  }
  return course.startPad;
}

/** Called by the host after teleporting the body back to a checkpoint. */
export function markRespawned(run: RunState): void {
  run.sinceRespawn = 0;
}

/** Format seconds as `m:ss.mmm` for the HUD. */
export function formatTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const minutes = Math.floor(total / 60);
  const secs = Math.floor(total % 60);
  const millis = Math.floor((total * 1000) % 1000);
  return `${minutes}:${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}
