/**
 * Shared cross-module types that don't belong to a single implementation file.
 *
 * Most types live next to the module that owns them (e.g. `PhysBody` in
 * `physics/body.ts`, `RunState` in `game/run.ts`). This file is for small,
 * broadly used aliases only.
 */

/** Anything with an x/z position, used by collision-free helpers. */
export interface XZPosition {
  x: number;
  z: number;
}

/** Severity levels used by the HUD / overlays. */
export type Notice = 'info' | 'checkpoint' | 'fall' | 'finish';
