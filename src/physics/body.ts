/**
 * The bunny-hop physics step. Pure and DOM-free: given a body, one tick of
 * input, the world and a config, it returns the next body plus a small event
 * record. No timers, no `performance.now()`, no mutation of its inputs.
 *
 * Model (Source-flavoured):
 *   1. Edge-triggered jump if grounded.
 *   2. Grounded: friction, then ground acceleration (gain clamped to wish speed).
 *      Airborne: gravity, then air acceleration whose *wish speed* is capped at
 *      30 u/s but whose per-tick gain is NOT clamped to the remaining headroom.
 *      That unclamped tick gain is what mouse-sweeping turns into speed.
 *   3. Move the AABB one axis at a time (Y, X, Z) and resolve contacts.
 *   4. Landing detection; auto-hop (if enabled) re-jumps on the landing tick.
 *
 * The order matters: friction before acceleration means the ground can never
 * be used to build speed; air acceleration is additive-per-tick so a sideways
 * wish direction keeps adding perpendicular velocity that friction never sees.
 */

import type { Vec3 } from '../math.ts';
import { horizontalLength } from '../math.ts';
import {
  boxOverlaps,
  findSupport,
  moveAxis,
  type BodyShape,
  type Brush,
} from './collision.ts';

export interface PhysicsConfig {
  stepSeconds: number;
  gravity: number;
  jumpVelocity: number;
  maxGroundSpeed: number;
  groundAccel: number;
  airAccel: number;
  airWishCap: number;
  friction: number;
  stopSpeed: number;
  halfWidth: number;
  height: number;
  supportEpsilon: number;
}

export interface PhysBody {
  /** Centre of the feet. */
  pos: Vec3;
  /** Velocity in units/second. */
  vel: Vec3;
  /** Current heading, radians, unwrapped. Physics uses it for the wish basis. */
  yaw: number;
  onGround: boolean;
}

/** One tick of player intent, already split out of a render frame. */
export interface TickCommand {
  /** -1..1 forward/back intent. */
  forward: number;
  /** -1..1 right/left intent. */
  right: number;
  /** Jump was pressed on this tick (edge). */
  jumpPressed: boolean;
  /** Jump is held on this tick (for auto-hop). */
  jumpHeld: boolean;
  /** Yaw change for this tick, radians. */
  yawDelta: number;
}

export interface StepEvents {
  /** True when a jump was launched this tick (manual or auto-hop). */
  jumped: boolean;
  /** True when the body touched down this tick, even if auto-hop re-launched it. */
  landed: boolean;
  /** Speed added to the horizontal velocity this tick (0 if no gain). */
  airGain: number;
  /** Horizontal speed after the step. */
  speed: number;
  /** 1 if onGround after the step, else 0. */
  grounded: number;
}

export const IDLE_COMMAND: TickCommand = {
  forward: 0,
  right: 0,
  jumpPressed: false,
  jumpHeld: false,
  yawDelta: 0,
};

export function createBody(pos: Vec3, yaw = 0, onGround = true): PhysBody {
  return {
    pos: { ...pos },
    vel: { x: 0, y: 0, z: 0 },
    yaw,
    onGround,
  };
}

export function cloneBody(body: PhysBody): PhysBody {
  return {
    pos: { ...body.pos },
    vel: { ...body.vel },
    yaw: body.yaw,
    onGround: body.onGround,
  };
}

/** Wish direction in world XZ from yaw + forward/right intents. */
export function wishDirection(yaw: number, forward: number, right: number): { x: number; z: number; length: number } {
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  let x = fx * forward + rx * right;
  let z = fz * forward + rz * right;
  const length = Math.hypot(x, z);
  // Commands are clamped so diagonals are not faster than cardinals.
  if (length > 1) {
    x /= length;
    z /= length;
  }
  return { x, z, length: Math.min(length, 1) };
}

function applyFriction(vel: Vec3, cfg: PhysicsConfig): void {
  const speed = horizontalLength(vel.x, vel.z);
  if (speed < 1e-6) {
    vel.x = 0;
    vel.z = 0;
    return;
  }
  const control = Math.max(speed, cfg.stopSpeed);
  const drop = control * cfg.friction * cfg.stepSeconds;
  const newSpeed = Math.max(0, speed - drop);
  const scale = newSpeed / speed;
  vel.x *= scale;
  vel.z *= scale;
}

/** Ground acceleration: gain is clamped to the wish-speed headroom. */
function accelerateGround(vel: Vec3, wish: { x: number; z: number; length: number }, cfg: PhysicsConfig): void {
  if (wish.length <= 0) return;
  const current = vel.x * wish.x + vel.z * wish.z;
  const addSpeed = cfg.maxGroundSpeed - current;
  if (addSpeed <= 0) return;
  const gain = Math.min(cfg.groundAccel * cfg.maxGroundSpeed * cfg.stepSeconds, addSpeed);
  vel.x += wish.x * gain;
  vel.z += wish.z * gain;
}

/**
 * Air acceleration: the wish speed is capped at `airWishCap`, but the gain
 * itself is deliberately not clamped to `addSpeed`. This is the honest Source
 * rule that lets a sideways strafe build speed tick by tick.
 */
function accelerateAir(vel: Vec3, wish: { x: number; z: number; length: number }, cfg: PhysicsConfig): number {
  if (wish.length <= 0) return 0;
  const current = vel.x * wish.x + vel.z * wish.z;
  const addSpeed = cfg.airWishCap - current;
  if (addSpeed <= 0) return 0;
  const gain = cfg.airAccel * cfg.airWishCap * cfg.stepSeconds;
  vel.x += wish.x * gain;
  vel.z += wish.z * gain;
  return gain;
}

function shapeOf(cfg: PhysicsConfig): BodyShape {
  return { halfWidth: cfg.halfWidth, height: cfg.height };
}

/**
 * Advance one body by exactly one tick. The return value is a fresh body; the
 * input body is never mutated.
 */
export function stepBody(
  body: PhysBody,
  command: TickCommand,
  brushes: readonly Brush[],
  cfg: PhysicsConfig,
  autoHop: boolean,
): { body: PhysBody; events: StepEvents } {
  const next = cloneBody(body);
  const shape = shapeOf(cfg);
  const dt = cfg.stepSeconds;

  next.yaw += command.yawDelta;

  // 1. Edge-triggered jump. `jumpPressed` is a one-tick latch produced by the
  //    input layer (key down / wheel notch), so holding space never bunny-hops
  //    by itself when auto-hop is off.
  let jumped = false;
  if (next.onGround && command.jumpPressed) {
    next.vel.y = cfg.jumpVelocity;
    next.onGround = false;
    jumped = true;
  }

  const wish = wishDirection(next.yaw, command.forward, command.right);
  const wasGrounded = next.onGround;

  // 2. Accelerate.
  let airGain = 0;
  if (next.onGround) {
    applyFriction(next.vel, cfg);
    accelerateGround(next.vel, wish, cfg);
  } else {
    next.vel.y -= cfg.gravity * dt;
    airGain = accelerateAir(next.vel, wish, cfg);
  }

  // 3. Integrate & resolve, one axis at a time.
  const yMove = moveAxis(next.pos, next.vel.y * dt, 'y', shape, brushes);
  if (yMove.hit) {
    if (yMove.floor) next.vel.y = 0;
    if (yMove.ceiling) next.vel.y = Math.min(next.vel.y, 0);
  }
  const xMove = moveAxis(next.pos, next.vel.x * dt, 'x', shape, brushes);
  if (xMove.hit) next.vel.x = 0;
  const zMove = moveAxis(next.pos, next.vel.z * dt, 'z', shape, brushes);
  if (zMove.hit) next.vel.z = 0;

  // 4. Ground state. If we were grounded but walked off an edge, we become
  //    airborne immediately rather than floating for a tick.
  let landed = false;
  if (next.onGround) {
    if (!findSupport(next.pos, shape, brushes, cfg.supportEpsilon)) {
      next.onGround = false;
    }
  } else if (next.vel.y <= 0) {
    if (findSupport(next.pos, shape, brushes, cfg.supportEpsilon)) {
      next.onGround = true;
    }
  }

  if (!wasGrounded && next.onGround) {
    landed = true;
    // Auto-hop re-jumps on exactly the landing tick, and only if the jump is
    // still held. It never adds speed or changes direction.
    if (autoHop && command.jumpHeld) {
      next.vel.y = cfg.jumpVelocity;
      next.onGround = false;
      jumped = true;
    }
  }

  return {
    body: next,
    events: {
      jumped,
      landed,
      airGain,
      speed: horizontalLength(next.vel.x, next.vel.z),
      grounded: next.onGround ? 1 : 0,
    },
  };
}

/**
 * Diagnostic used by tests and the bot: would this body overlap any brush?
 * A correctly-stepped body should never do so.
 */
export function overlapsWorld(body: PhysBody, brushes: readonly Brush[], cfg: PhysicsConfig): boolean {
  const shape = shapeOf(cfg);
  for (const brush of brushes) {
    if (boxOverlaps(body.pos, shape, brush)) return true;
  }
  return false;
}
