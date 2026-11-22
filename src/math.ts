/**
 * Small, dependency-free vector / angle helpers shared by physics, simulation,
 * the bot and the renderer.
 *
 * All angles are radians. `yaw = 0` looks along +Z; increasing yaw turns
 * towards +X (i.e. clockwise when viewed from above), which keeps the
 * first-person camera basis simple:
 *
 *   forward = (sin(yaw), 0, cos(yaw))
 *   right   = (cos(yaw), 0, -sin(yaw))
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const EPS = 1e-6;
export const TAU = Math.PI * 2;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    z: lerp(a.z, b.z, t),
  };
}

/** Length of the horizontal (XZ) component of a velocity / offset. */
export function horizontalLength(x: number, z: number): number {
  return Math.hypot(x, z);
}

/** Normalise an XZ vector, returning the original length alongside it. */
export function normalizeXZ(x: number, z: number): { x: number; z: number; length: number } {
  const length = Math.hypot(x, z);
  if (length < EPS) return { x: 0, z: 0, length: 0 };
  return { x: x / length, z: z / length, length };
}

/** Normalise yaw to [-PI, PI). Used for HUD output only, never for state. */
export function wrapAngle(angle: number): number {
  let a = angle % TAU;
  if (a >= Math.PI) a -= TAU;
  if (a < -Math.PI) a += TAU;
  return a;
}

/**
 * Yaw is stored unwrapped in the physics state so linear interpolation never
 * takes the long way around. This helper is here for callers that need the
 * shortest signed difference between two headings.
 */
export function angleDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

/** Move `current` towards `target` by at most `maxDelta` radians. */
export function approachAngle(current: number, target: number, maxDelta: number): number {
  const delta = angleDelta(current, target);
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

/** Linear interpolation for an unwrapped angle. */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
