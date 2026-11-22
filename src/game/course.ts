/**
 * `bhop_ascent` — the playable course.
 *
 * The course is defined as a sequence of square pads placed on an ascending
 * spiral. Each stage controls four knobs:
 *
 *   - `gap`      edge-to-edge horizontal distance between consecutive pads
 *   - `padSize`  top-surface size of each pad in the stage
 *   - `rise`     height gained per pad
 *   - `turnDeg`  how far around the spiral each hop turns
 *
 * Pads are placed *sequentially* (`chord = halfPrev + gap + halfNext`), so the
 * gap is a designer-facing number rather than an emergent side effect. The
 * map-feasibility test re-derives every hop arc from the physics body, so a
 * bad edit fails the build rather than becoming an impossible jump.
 */

import { makeBrush, type Brush } from '../physics/collision.ts';
import type { Vec3 } from '../math.ts';

export type PadKind = 'start' | 'pad' | 'checkpoint' | 'finish';

export interface PadSpec {
  readonly kind: PadKind;
  /** Position in the course; 0 is the start pad. */
  readonly index: number;
  /** Index into `STAGES`; -1 for the start pad. */
  readonly stage: number;
  /** Centre of the top surface. */
  readonly center: Vec3;
  /** Top-surface size (square, axis-aligned). */
  readonly size: number;
  /** Slab depth below the top surface. */
  readonly thickness: number;
  readonly name: string;
}

export interface StageSpec {
  readonly name: string;
  /** Edge-to-edge gap to the next pad, units. */
  readonly gap: number;
  /** Height gained per pad, units. */
  readonly rise: number;
  /** Top-surface size, units. */
  readonly padSize: number;
  /** Spiral turn per hop, degrees. */
  readonly turnDegrees: number;
  readonly pads: number;
}

export interface Course {
  readonly name: string;
  readonly pads: readonly PadSpec[];
  readonly brushes: readonly Brush[];
  readonly startPad: PadSpec;
  readonly finishPad: PadSpec;
  readonly checkpoints: readonly PadSpec[];
  /** Index ranges [firstPad, lastPad] for each stage, for split timers. */
  readonly stageRanges: readonly { stage: number; name: string; first: number; last: number }[];
  /** Top surface of the decorative ground plane below the course. */
  readonly groundTop: number;
}

export const COURSE_NAME = 'bhop_ascent';

export const STAGES: readonly StageSpec[] = [
  { name: 'IGNITION', gap: 46, rise: 22, padSize: 124, turnDegrees: 20, pads: 4 },
  { name: 'KINETIC', gap: 52, rise: 22, padSize: 114, turnDegrees: 21, pads: 4 },
  { name: 'ORBIT', gap: 58, rise: 22, padSize: 106, turnDegrees: 22, pads: 4 },
  { name: 'SLIPSTREAM', gap: 64, rise: 22, padSize: 100, turnDegrees: 23, pads: 4 },
  { name: 'VERTIGO', gap: 70, rise: 22, padSize: 94, turnDegrees: 24, pads: 4 },
  { name: 'THE NEEDLE', gap: 78, rise: 22, padSize: 90, turnDegrees: 25, pads: 4 },
];

const START_SIZE = 168;
const START_THICKNESS = 30;
const SLAB_THICKNESS = 22;

/** Top surface of the out-of-bounds ground plane, well below the start pad. */
export const GROUND_TOP = -96;
const GROUND_EXTENT = 6000;

/** Course-relative y of the start surface. The renderer places the ground below it. */
export const START_Y = 0;

export function buildCourse(): Course {
  const pads: PadSpec[] = [];
  const brushes: Brush[] = [];

  // The ground is solid so a missed hop lands you somewhere visible (and the
  // fall handler can pick you up there) instead of dropping into a void.
  brushes.push({
    min: { x: -GROUND_EXTENT, y: GROUND_TOP - 40, z: -GROUND_EXTENT },
    max: { x: GROUND_EXTENT, y: GROUND_TOP, z: GROUND_EXTENT },
    tag: 'ground',
    label: 'GROUND',
  });

  const start: PadSpec = {
    kind: 'start',
    index: 0,
    stage: -1,
    center: { x: 0, y: START_Y, z: 0 },
    size: START_SIZE,
    thickness: START_THICKNESS,
    name: 'START',
  };
  pads.push(start);
  brushes.push(
    makeBrush(start.center.x, start.center.y, start.center.z, start.size, start.size, start.thickness, 'start', start.name),
  );

  const stageRanges: { stage: number; name: string; first: number; last: number }[] = [];
  let prev = start;
  let angle = 0;
  let index = 1;

  for (let stageIndex = 0; stageIndex < STAGES.length; stageIndex++) {
    const stage = STAGES[stageIndex];
    let firstIndex = index;
    for (let k = 0; k < stage.pads; k++) {
      const isLastPadOfStage = k === stage.pads - 1;
      const isFinalPad = stageIndex === STAGES.length - 1 && isLastPadOfStage;
      const size = isFinalPad ? stage.padSize * 1.7 : stage.padSize;
      const kind: PadKind = isFinalPad ? 'finish' : isLastPadOfStage ? 'checkpoint' : 'pad';

      // Chord from the previous pad that leaves the requested edge gap.
      const chord = prev.size / 2 + stage.gap + size / 2;
      angle += (stage.turnDegrees * Math.PI) / 180;
      const center: Vec3 = {
        x: prev.center.x + Math.sin(angle) * chord,
        y: prev.center.y + stage.rise,
        z: prev.center.z + Math.cos(angle) * chord,
      };
      const pad: PadSpec = {
        kind,
        index,
        stage: stageIndex,
        center,
        size,
        thickness: SLAB_THICKNESS,
        name: `${stage.name} ${k + 1}`,
      };
      pads.push(pad);
      brushes.push(
        makeBrush(center.x, center.y, center.z, size, size, SLAB_THICKNESS, kind, pad.name),
      );
      prev = pad;
      index++;
    }
    stageRanges.push({ stage: stageIndex, name: stage.name, first: firstIndex, last: index - 1 });
  }

  const finishPad = pads[pads.length - 1];
  const checkpoints = pads.filter((p) => p.kind === 'checkpoint');

  return {
    name: COURSE_NAME,
    pads,
    brushes,
    startPad: start,
    finishPad,
    checkpoints,
    stageRanges,
    groundTop: GROUND_TOP,
  };
}

/** Highest checkpoint at or below `index`. Respawn uses this. */
export function checkpointForIndex(course: Course, index: number): PadSpec {
  let best = course.startPad;
  for (const checkpoint of course.checkpoints) {
    if (checkpoint.index <= index && checkpoint.index > best.index) best = checkpoint;
  }
  return best;
}

export function padByIndex(course: Course, index: number): PadSpec | null {
  for (const pad of course.pads) {
    if (pad.index === index) return pad;
  }
  return null;
}

/** Which pad's footprint contains (x, z), preferring the highest one below y. */
export function padUnder(course: Course, x: number, z: number, y: number): PadSpec | null {
  let best: PadSpec | null = null;
  for (const pad of course.pads) {
    const half = pad.size / 2;
    if (Math.abs(x - pad.center.x) > half || Math.abs(z - pad.center.z) > half) continue;
    if (pad.center.y > y + 2) continue;
    if (best === null || pad.center.y > best.center.y) best = pad;
  }
  return best;
}
