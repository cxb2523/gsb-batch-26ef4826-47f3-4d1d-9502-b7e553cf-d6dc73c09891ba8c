/**
 * Every tunable number lives here so the physics stays free of magic values
 * and modders can retune the game in one place.
 *
 * Units are Source-flavoured "units": 1 unit ~ 1 inch. Time is seconds.
 */

import type { PhysicsConfig } from './physics/body.ts';

/** Simulation rate. The accumulator never runs physics at any other rate. */
export const TICK_RATE = 128;
export const STEP_SECONDS = 1 / TICK_RATE;

/**
 * The physics body. This is intentionally the only place the simulation reads
 * numbers from; tests build their own configs from this object.
 */
export const PHYSICS: PhysicsConfig = {
  stepSeconds: STEP_SECONDS,

  gravity: 800,

  /**
   * 268 u/s launch speed gives a ~0.67 s hop and a ~44.9 u apex, comfortably
   * clearing the course's 22 u vertical steps.
   */
  jumpVelocity: 268,

  /** Ground movement cap. */
  maxGroundSpeed: 250,
  groundAccel: 10,

  /**
   * Air acceleration. The wish speed in the air is capped at 30 u/s, but the
   * per-tick gain is NOT clamped to the remaining headroom. That is the whole
   * trick: sweep the mouse so your strafe wish direction stays sideways to
   * your velocity and each tick adds a little perpendicular speed.
   */
  airAccel: 60,
  airWishCap: 30,

  /** Source-style friction, applied only while grounded. */
  friction: 5.2,
  stopSpeed: 75,

  /**
   * The player is an axis-aligned box, 32 u wide and 72 u tall. Position is
   * the centre of the feet.
   */
  halfWidth: 16,
  height: 72,

  /** How far below the feet a surface still counts as "standing on it". */
  supportEpsilon: 1.5,
};

/** Mouse look. View only: pitch never enters the physics state. */
export const VIEW = {
  fovDegrees: 78,
  mouseSensitivity: 0.055, // deg per pixel at sensitivity 1.0
  maxPitchRadians: (85 * Math.PI) / 180,
  eyeHeight: 54,
  /** Clamp absurd per-event deltas (e.g. after regaining pointer lock). */
  maxMouseEventPixels: 400,
};

/** Fixed-step driver. */
export const SIM = {
  /** Never integrate more than this much real time in one frame (spiral guard). */
  maxFrameDeltaSeconds: 0.25,
  /** Carried mouse movement is dropped if it grows past this (tab was away). */
  maxCarriedMousePixels: 2000,
};

export const GAME = {
  /** Hard safety net: anything below this is treated as a fall. */
  killPlaneY: -400,
  /** A run starts once the player gives movement input for this many ticks. */
  startDelayTicks: 1,
  /** Grace ticks after a respawn before fall detection can trigger again. */
  respawnGraceTicks: 8,
  /** Personal-best storage key. Bump the suffix on incompatible changes. */
  storageKey: 'bhop-chronicles.pb.v1',
  settingsKey: 'bhop-chronicles.settings.v1',
};

export interface Settings {
  autoHop: boolean;
  sensitivity: number;
}

export const DEFAULT_SETTINGS: Settings = {
  autoHop: true,
  sensitivity: 1.0,
};
