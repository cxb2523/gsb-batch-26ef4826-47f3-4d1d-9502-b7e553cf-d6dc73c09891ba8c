/**
 * Scripted bunny-hop bot.
 *
 * The bot has exactly what a human has, nothing more:
 *
 *   - `W`/`A`/`D` strafe intent and a single jump press,
 *   - a bounded yaw rate (it cannot snap-turn; 360 deg/s by default),
 *   - knowledge of the physics it is standing in.
 *
 * Strategy, per pad:
 *   1. Run straight at the next pad to build ground speed (friction + ground
 *      accel cap at 250 u/s).
 *   2. Once at full speed, sample candidate (strafe, yaw rate) pairs against a
 *      *copy of the physics body*. Keep the first candidate whose simulated
 *      arc lands near the next pad's centre.
 *   3. Replay the winning candidate tick for tick. Planning and execution use
 *      the same command generator, so the verified arc is the arc that flies.
 *   4. If no candidate lands, don't run off the pad: brake/reset and retry.
 *
 * Because the bot only ever presses keys a human can press, a successful run
 * is a completability proof for the map. `tests/map.test.ts` asserts it.
 */

import { clamp, wrapAngle } from '../math.ts';
import { PHYSICS } from '../config.ts';
import { cloneBody, stepBody, type PhysBody, type TickCommand } from '../physics/body.ts';
import type { Brush } from '../physics/collision.ts';
import { checkpointForIndex, type Course, type PadSpec } from '../game/course.ts';

const DEG = Math.PI / 180;

export interface HopPlan {
  /** Strafe intent held for the whole air phase. */
  readonly strafe: number;
  /** Yaw rate in radians per second, applied every tick including takeoff. */
  readonly yawRate: number;
  /** Distance from the landing point to the pad centre. */
  readonly landingError: number;
  /** Horizontal speed at landing. */
  readonly landingSpeed: number;
}

export interface BotOptions {
  /** Hard cap on yaw rate, degrees/second. Human-ish. */
  maxYawRateDeg: number;
  /** Ground speed required before a hop is attempted. */
  launchSpeed: number;
  /** Landing points must be this far inside the pad edge (units). */
  landingInset: number;
  /** Candidate strafe intents, in priority order. */
  strafeCandidates: readonly number[];
  /** Candidate yaw rates, degrees/second. */
  rateCandidates: readonly number[];
  /** Safety cap on simulated ticks per hop. */
  maxAirTicks: number;
  /** Hard cap on total simulated ticks for a full run. */
  maxRunTicks: number;
  /** Give up after this many respawns. */
  maxRespawns: number;
}

export const DEFAULT_BOT: BotOptions = {
  maxYawRateDeg: 360,
  launchSpeed: 245,
  landingInset: 12,
  strafeCandidates: [1, -1, 0],
  rateCandidates: [-240, -210, -180, -150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150, 180, 210, 240],
  maxAirTicks: 220,
  maxRunTicks: 128 * 200,
  maxRespawns: 100,
};

function padContains(body: PhysBody, pad: PadSpec): boolean {
  return (
    body.onGround &&
    Math.abs(body.pos.y - pad.center.y) < 2 &&
    Math.abs(body.pos.x - pad.center.x) <= pad.size / 2 + PHYSICS.halfWidth &&
    Math.abs(body.pos.z - pad.center.z) <= pad.size / 2 + PHYSICS.halfWidth
  );
}

function padContainsInset(body: PhysBody, pad: PadSpec, inset: number): boolean {
  return (
    body.onGround &&
    Math.abs(body.pos.y - pad.center.y) < 2 &&
    Math.abs(body.pos.x - pad.center.x) <= pad.size / 2 - inset &&
    Math.abs(body.pos.z - pad.center.z) <= pad.size / 2 - inset
  );
}

/** The single command generator used for both planning and execution. */
function commandFor(strafe: number, yawRate: number, jumpPressed: boolean): TickCommand {
  return {
    forward: 1,
    right: strafe,
    jumpPressed,
    jumpHeld: true,
    yawDelta: yawRate * PHYSICS.stepSeconds,
  };
}

/**
 * Simulate one hop from `start` at the given strafe / yaw rate.
 * Returns the landing body, or null if it never leaves the ground, falls out
 * of the world, or is still airborne when the tick cap is hit.
 */
export function simulateHop(
  start: PhysBody,
  strafe: number,
  yawRateDeg: number,
  brushes: readonly Brush[],
  maxAirTicks: number,
  maxYawRateDeg: number,
): { body: PhysBody; airTicks: number } | null {
  const limit = maxYawRateDeg * DEG;
  const yawRate = clamp(yawRateDeg * DEG, -limit, limit);
  let body = cloneBody(start);
  let jumped = false;
  for (let tick = 0; tick < maxAirTicks; tick++) {
    const result = stepBody(body, commandFor(strafe, yawRate, !jumped), brushes, PHYSICS, false);
    body = result.body;
    if (result.events.jumped) jumped = true;
    if (body.pos.y < -200) return null;
    if (!jumped && !body.onGround) return null; // somehow walked off without jumping
    if (jumped && body.onGround) return { body, airTicks: tick + 1 };
  }
  return null;
}

/**
 * Sample (strafe, yaw rate) candidates and return the one whose simulated arc
 * lands closest to `target`'s centre, or null if nothing lands on it.
 */
export function planHop(
  start: PhysBody,
  target: PadSpec,
  brushes: readonly Brush[],
  options: BotOptions = DEFAULT_BOT,
): HopPlan | null {
  if (!start.onGround) return null;
  const speed = Math.hypot(start.vel.x, start.vel.z);
  if (speed < options.launchSpeed) return null;

  let best: HopPlan | null = null;
  for (const strafe of options.strafeCandidates) {
    for (const rateDeg of options.rateCandidates) {
      const result = simulateHop(start, strafe, rateDeg, brushes, options.maxAirTicks, options.maxYawRateDeg);
      if (!result) continue;
      if (!padContainsInset(result.body, target, options.landingInset)) continue;
      const landingError = Math.hypot(
        result.body.pos.x - target.center.x,
        result.body.pos.z - target.center.z,
      );
      const landingSpeed = Math.hypot(result.body.vel.x, result.body.vel.z);
      const plan: HopPlan = {
        strafe,
        yawRate: clamp(rateDeg * DEG, -(options.maxYawRateDeg * DEG), options.maxYawRateDeg * DEG),
        landingError,
        landingSpeed,
      };
      if (best === null || plan.landingError < best.landingError) best = plan;
    }
  }
  return best;
}

export interface BotRunResult {
  finished: boolean;
  padsCleared: number;
  totalPads: number;
  totalTicks: number;
  seconds: number;
  hops: number;
  respawns: number;
  furthestPad: number;
  failure: string | null;
  /** Peak horizontal speed observed, units/second. */
  peakSpeed: number;
}

/**
 * Drive a body through the whole course. Pure: takes a course, returns a
 * result, never touches the DOM or real time.
 */
export function runBot(course: Course, options: BotOptions = DEFAULT_BOT): BotRunResult {
  const brushes = course.brushes;
  const maxYawStep = options.maxYawRateDeg * DEG * PHYSICS.stepSeconds;

  const spawnAt = (pad: PadSpec, yaw = 0): PhysBody => ({
    pos: { x: pad.center.x, y: pad.center.y + 0.02, z: pad.center.z },
    vel: { x: 0, y: 0, z: 0 },
    yaw,
    onGround: true,
  });

  let body = spawnAt(course.startPad);
  let next = 1;
  let onPadIdx = 0;
  let ticks = 0;
  let hops = 0;
  let respawns = 0;
  let peakSpeed = 0;
  let failure: string | null = null;
  let air: { strafe: number; yawRate: number } | null = null;

  const respawn = (): void => {
    respawns++;
    const pad = checkpointForIndex(course, Math.max(0, next - 1));
    body = spawnAt(pad);
    next = pad.index + 1;
    onPadIdx = pad.index;
    air = null;
  };

  while (next < course.pads.length && ticks < options.maxRunTicks) {
    const target = course.pads[next];
    peakSpeed = Math.max(peakSpeed, Math.hypot(body.vel.x, body.vel.z));

    if (air) {
      const result = stepBody(
        body,
        commandFor(air.strafe, air.yawRate, false),
        brushes,
        PHYSICS,
        false,
      );
      body = result.body;
      ticks++;
      if (body.pos.y < -200) {
        respawn();
        if (respawns > options.maxRespawns) {
          failure = `too many respawns at pad ${next}`;
          break;
        }
        continue;
      }
      if (body.onGround) {
        const landed = padContains(body, target);
        air = null;
        if (landed) {
          onPadIdx = target.index;
          next++;
        } else {
          respawn();
          if (respawns > options.maxRespawns) {
            failure = `too many respawns at pad ${next}`;
            break;
          }
        }
      }
      continue;
    }

    const speed = Math.hypot(body.vel.x, body.vel.z);
    if (speed >= options.launchSpeed) {
      const plan = planHop(body, target, brushes, options);
      if (plan) {
        const result = stepBody(
          body,
          commandFor(plan.strafe, plan.yawRate, true),
          brushes,
          PHYSICS,
          false,
        );
        body = result.body;
        ticks++;
        if (result.events.jumped) {
          hops++;
          air = { strafe: plan.strafe, yawRate: plan.yawRate };
          continue;
        }
        // Could not take off for some reason; reset and retry.
        respawn();
        if (respawns > options.maxRespawns) {
          failure = `cannot take off at pad ${next}`;
          break;
        }
        continue;
      }
    }

    // Keep running straight at the target, but never step off the pad.
    const here = course.pads[onPadIdx];
    const bearing = Math.atan2(target.center.x - body.pos.x, target.center.z - body.pos.z);
    const turn = clamp(wrapAngle(bearing - body.yaw), -maxYawStep, maxYawStep);
    const stepX = body.vel.x * PHYSICS.stepSeconds;
    const stepZ = body.vel.z * PHYSICS.stepSeconds;
    const half = here.size / 2 + PHYSICS.halfWidth - 1;
    const staysOn =
      Math.abs(body.pos.x + stepX - here.center.x) <= half &&
      Math.abs(body.pos.z + stepZ - here.center.z) <= half;

    if (!staysOn) {
      // Reached the edge without a valid hop: re-run the approach.
      respawn();
      if (respawns > options.maxRespawns) {
        failure = `stuck before pad ${next}`;
        break;
      }
      continue;
    }

    const result = stepBody(
      body,
      { forward: 1, right: 0, jumpPressed: false, jumpHeld: true, yawDelta: turn },
      brushes,
      PHYSICS,
      false,
    );
    body = result.body;
    ticks++;
    if (!body.onGround) {
      respawn();
      if (respawns > options.maxRespawns) {
        failure = `walked off pad ${onPadIdx}`;
        break;
      }
    }
  }

  const finished = next >= course.pads.length;
  if (!finished && failure === null) {
    failure = ticks >= options.maxRunTicks ? `tick budget exhausted at pad ${next}` : `stopped at pad ${next}`;
  }

  return {
    finished,
    padsCleared: finished ? course.pads.length : next,
    totalPads: course.pads.length,
    totalTicks: ticks,
    seconds: ticks / 128,
    hops,
    respawns,
    furthestPad: finished ? course.pads.length - 1 : next - 1,
    failure,
    peakSpeed,
  };
}
