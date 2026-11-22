/**
 * Solid world geometry and the box-vs-box collision helpers used by the
 * physics step.
 *
 * The world is a flat array of axis-aligned boxes. The player is a vertical
 * AABB whose `pos` is the centre of its feet. Collision is resolved one axis
 * at a time (Y first so landings snap, then X, then Z), which is stable at
 * 128 Hz for the speeds this game reaches.
 */

import type { Vec3 } from '../math.ts';

export type BrushTag = 'ground' | 'start' | 'pad' | 'checkpoint' | 'finish' | 'wall';

export interface Brush {
  /** Inclusive-min corner. */
  min: Vec3;
  /** Exclusive-max corner. */
  max: Vec3;
  tag: BrushTag;
  /** A one-line label the HUD / bot can show. */
  label?: string;
}

export interface BodyShape {
  halfWidth: number;
  height: number;
}

export const COLLISION_EPS = 1e-6;

export function makeBrush(
  centreX: number,
  topY: number,
  centreZ: number,
  width: number,
  depth: number,
  thickness: number,
  tag: BrushTag,
  label?: string,
): Brush {
  const halfW = width / 2;
  const halfD = depth / 2;
  return {
    min: { x: centreX - halfW, y: topY - thickness, z: centreZ - halfD },
    max: { x: centreX + halfW, y: topY, z: centreZ + halfD },
    tag,
    label,
  };
}

/** Do the player's AABB and a brush overlap on every axis? */
export function boxOverlaps(pos: Vec3, shape: BodyShape, brush: Brush): boolean {
  return (
    pos.x + shape.halfWidth > brush.min.x + COLLISION_EPS &&
    pos.x - shape.halfWidth < brush.max.x - COLLISION_EPS &&
    pos.z + shape.halfWidth > brush.min.z + COLLISION_EPS &&
    pos.z - shape.halfWidth < brush.max.z - COLLISION_EPS &&
    pos.y + shape.height > brush.min.y + COLLISION_EPS &&
    pos.y < brush.max.y - COLLISION_EPS
  );
}

/** Is the player's footprint above `brush` within support distance? */
export function standsOn(pos: Vec3, shape: BodyShape, brush: Brush, epsilon: number): boolean {
  return (
    pos.x + shape.halfWidth > brush.min.x + COLLISION_EPS &&
    pos.x - shape.halfWidth < brush.max.x - COLLISION_EPS &&
    pos.z + shape.halfWidth > brush.min.z + COLLISION_EPS &&
    pos.z - shape.halfWidth < brush.max.z - COLLISION_EPS &&
    Math.abs(pos.y - brush.max.y) <= epsilon
  );
}

/**
 * Move along one axis and resolve any overlap immediately.
 *
 * Returns true when a surface was touched. Y movement distinguishes ceiling
 * (upward) from floor (downward); X/Z movement is a hard stop against walls.
 */
export function moveAxis(
  pos: Vec3,
  delta: number,
  axis: 'x' | 'y' | 'z',
  shape: BodyShape,
  brushes: readonly Brush[],
): { hit: boolean; floor: boolean; ceiling: boolean } {
  if (delta === 0) return { hit: false, floor: false, ceiling: false };
  const previous = pos[axis];
  pos[axis] += delta;
  let hit = false;
  let floor = false;
  let ceiling = false;
  for (const brush of brushes) {
    if (!boxOverlaps(pos, shape, brush)) continue;
    hit = true;
    if (axis === 'y') {
      if (delta > 0) {
        pos.y = brush.min.y - shape.height;
        ceiling = true;
      } else {
        pos.y = brush.max.y;
        floor = true;
      }
    } else {
      // Restore the exact pre-move coordinate. Reverting by `-= delta` once
      // per overlapping brush would over-correct when two brushes overlap.
      pos[axis] = previous;
    }
  }
  return { hit, floor, ceiling };
}

/** Does any brush sit directly beneath the player's footprint? */
export function findSupport(
  pos: Vec3,
  shape: BodyShape,
  brushes: readonly Brush[],
  epsilon: number,
): Brush | null {
  let best: Brush | null = null;
  for (const brush of brushes) {
    if (!standsOn(pos, shape, brush, epsilon)) continue;
    if (best === null || brush.max.y > best.max.y) best = brush;
  }
  return best;
}

/** Highest brush surface strictly below a point, used for respawn grounding. */
export function surfaceBelow(
  x: number,
  z: number,
  y: number,
  shape: BodyShape,
  brushes: readonly Brush[],
): number | null {
  let best: number | null = null;
  for (const brush of brushes) {
    const insideFootprint =
      x + shape.halfWidth > brush.min.x + COLLISION_EPS &&
      x - shape.halfWidth < brush.max.x - COLLISION_EPS &&
      z + shape.halfWidth > brush.min.z + COLLISION_EPS &&
      z - shape.halfWidth < brush.max.z - COLLISION_EPS;
    if (!insideFootprint) continue;
    if (brush.max.y > y + COLLISION_EPS) continue;
    if (best === null || brush.max.y > best) best = brush.max.y;
  }
  return best;
}
