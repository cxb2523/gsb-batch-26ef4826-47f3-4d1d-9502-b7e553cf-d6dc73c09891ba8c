/**
 * Rendering: a read-only view of the physics.
 *
 * Rules this module obeys:
 *   - It never mutates a `PhysBody`, the run state, or the world.
 *   - It draws the *interpolated* body between the previous and current physics
 *     tick, using the clock's `alpha`. Physics and rendering are decoupled:
 *     a 240 Hz display just draws more intermediate frames.
 *   - It is pure Canvas 2D so the single-file build has no asset or WebGL
 *     dependency, and the same code path can be exercised in a headless smoke
 *     test.
 *
 * The camera is derived from the body each frame. Pitch lives only in the view
 * (mouse look), never in the physics state, so looking up can't change a hop.
 */

import { lerp, lerpAngle, type Vec3 } from '../math.ts';
import { VIEW } from '../config.ts';
import type { PhysBody } from '../physics/body.ts';
import type { Brush } from '../physics/collision.ts';
import type { Course, PadSpec } from '../game/course.ts';
import type { RunState } from '../game/run.ts';

export interface ViewState {
  /** Radians, unwrapped. */
  yaw: number;
  /** Radians, clamped to ±maxPitch. */
  pitch: number;
}

export interface RenderInput {
  previous: PhysBody;
  current: PhysBody;
  /** 0..1 fraction into the current tick. */
  alpha: number;
  view: ViewState;
  run: RunState;
  course: Course;
  width: number;
  height: number;
}

const PALETTE = {
  skyTop: '#0b1026',
  skyBottom: '#22325a',
  fog: '#1a2340',
  ground: '#1d2740',
  groundEdge: '#33456b',
  padTop: '#7aa8ff',
  padTopCheckpoint: '#57d99f',
  padTopFinish: '#ffbe3d',
  padSide: '#2a3a5f',
  startTop: '#a6b2cc',
  player: '#f2f5ff',
  trail: 'rgba(122, 168, 255, 0.35)',
} as const;

/** Distance (units) at which a face is fully faded into the sky. */
const FOG_FAR = 2600;
const FOG_NEAR = 900;

/** Camera basis derived from a view yaw/pitch. */
export function cameraBasis(view: ViewState): {
  forward: Vec3;
  right: Vec3;
  up: Vec3;
} {
  const cy = Math.cos(view.yaw);
  const sy = Math.sin(view.yaw);
  const cp = Math.cos(view.pitch);
  const sp = Math.sin(view.pitch);
  // yaw 0 looks along +Z; positive yaw turns toward +X.
  const forward: Vec3 = { x: sy * cp, y: sp, z: cy * cp };
  const right: Vec3 = { x: cy, y: 0, z: -sy };
  // up = forward × right. (right × forward would point *down*, mirroring the
  // whole scene vertically — the order matters here.)
  const up: Vec3 = {
    x: forward.y * right.z - forward.z * right.y,
    y: forward.z * right.x - forward.x * right.z,
    z: forward.x * right.y - forward.y * right.x,
  };
  return { forward, right, up };
}

/** Project a world point into normalised device coords + depth. Null if behind. */
export function projectPoint(
  point: Vec3,
  camera: Vec3,
  view: ViewState,
  aspect: number,
): { x: number; y: number; depth: number } | null {
  const { forward, right, up } = cameraBasis(view);
  const rel = { x: point.x - camera.x, y: point.y - camera.y, z: point.z - camera.z };
  const depth = rel.x * forward.x + rel.y * forward.y + rel.z * forward.z;
  if (depth <= 0.1) return null;
  const rx = rel.x * right.x + rel.y * right.y + rel.z * right.z;
  const uy = rel.x * up.x + rel.y * up.y + rel.z * up.z;
  const tanHalf = Math.tan((VIEW.fovDegrees * Math.PI) / 360);
  const ndcX = rx / (depth * tanHalf * aspect);
  const ndcY = uy / (depth * tanHalf);
  return { x: ndcX, y: ndcY, depth };
}

/** Interpolate the body used for drawing. Never written back to physics. */
export function interpolatedBody(previous: PhysBody, current: PhysBody, alpha: number): PhysBody {
  return {
    pos: {
      x: lerp(previous.pos.x, current.pos.x, alpha),
      y: lerp(previous.pos.y, current.pos.y, alpha),
      z: lerp(previous.pos.z, current.pos.z, alpha),
    },
    vel: {
      x: lerp(previous.vel.x, current.vel.x, alpha),
      y: lerp(previous.vel.y, current.vel.y, alpha),
      z: lerp(previous.vel.z, current.vel.z, alpha),
    },
    yaw: lerpAngle(previous.yaw, current.yaw, alpha),
    onGround: current.onGround,
  };
}

export interface RenderStats {
  padsDrawn: number;
  brushCount: number;
  camera: Vec3;
}

export interface Renderer {
  draw(input: RenderInput): RenderStats;
  resize(width: number, height: number): void;
}

export interface Canvas2DContext {
  canvas: { width: number; height: number };
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillStyle: string | CanvasGradientStub;
  strokeStyle: string;
  lineWidth: number;
  globalAlpha: number;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradientStub;
  arc(x: number, y: number, radius: number, start: number, end: number): void;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  font: string;
  textAlign: string;
  textBaseline: string;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
}

export interface CanvasGradientStub {
  addColorStop(offset: number, color: string): void;
}

/**
 * Canvas 2D renderer.
 *
 * World-to-screen uses a simple pinhole projection (the same one the camera
 * basis above defines). Each brush is drawn as its top face plus a side wall
 * facing the camera. Painter's algorithm: sort by depth, far to near. At this
 * course's scale that is plenty; there are 25 boxes, not 25 000.
 */
export class CanvasRenderer implements Renderer {
  private ctx: Canvas2DContext;
  private width: number;
  private height: number;

  constructor(ctx: Canvas2DContext, width: number, height: number) {
    this.ctx = ctx;
    this.width = width;
    this.height = height;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  draw(input: RenderInput): RenderStats {
    const { ctx } = this;
    const { width, height } = this;
    const body = interpolatedBody(input.previous, input.current, input.alpha);
    const camera: Vec3 = {
      x: body.pos.x,
      y: body.pos.y + VIEW.eyeHeight,
      z: body.pos.z,
    };
    const aspect = width / Math.max(1, height);

    // Sky.
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, PALETTE.skyTop);
    gradient.addColorStop(1, PALETTE.skyBottom);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    // Ground plane backdrop at the course's real ground height.
    this.drawGround(camera, input.view, aspect, input.course.groundTop);

    // Collect drawable faces with depth.
    interface Face {
      depth: number;
      points: { x: number; y: number }[];
      color: string;
      edge: string;
      alpha: number;
    }
    const faces: Face[] = [];

    for (const brush of input.course.brushes) {
      this.collectBrushFaces(brush, camera, input.view, aspect, faces);
    }

    faces.sort((a, b) => b.depth - a.depth);
    for (const face of faces) {
      if (face.points.length < 3) continue;
      ctx.beginPath();
      ctx.moveTo(face.points[0].x, face.points[0].y);
      for (let i = 1; i < face.points.length; i++) ctx.lineTo(face.points[i].x, face.points[i].y);
      ctx.closePath();
      ctx.globalAlpha = face.alpha;
      ctx.fillStyle = face.color;
      ctx.fill();
      ctx.strokeStyle = face.edge;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Checkpoint beacons: a thin vertical line so pads are readable from afar.
    this.drawBeacons(camera, input.view, aspect, input.course);

    // Crosshair.
    ctx.strokeStyle = 'rgba(242, 245, 255, 0.7)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(width / 2 - 7, height / 2);
    ctx.lineTo(width / 2 + 7, height / 2);
    ctx.moveTo(width / 2, height / 2 - 7);
    ctx.lineTo(width / 2, height / 2 + 7);
    ctx.stroke();

    return {
      padsDrawn: input.course.pads.length,
      brushCount: input.course.brushes.length,
      camera,
    };
  }

  private toScreen(ndc: { x: number; y: number }, width: number, height: number) {
    return { x: (ndc.x * 0.5 + 0.5) * width, y: (0.5 - ndc.y * 0.5) * height };
  }

  private drawGround(camera: Vec3, view: ViewState, aspect: number, groundTop: number): void {
    const { ctx } = this;
    // Fill the backdrop below the horizon using the real ground height, so the
    // visual horizon matches the collider the player actually lands on.
    const far = 6000;
    const corners: Vec3[] = [
      { x: -far, y: groundTop, z: -far },
      { x: far, y: groundTop, z: -far },
      { x: far, y: groundTop, z: far },
      { x: -far, y: groundTop, z: far },
    ];
    let minY = this.height;
    let any = false;
    for (const corner of corners) {
      const ndc = projectPoint(corner, camera, view, aspect);
      if (!ndc) continue;
      const screen = this.toScreen(ndc, this.width, this.height);
      if (screen.y < minY) minY = screen.y;
      any = true;
    }
    if (!any) return;
    ctx.fillStyle = PALETTE.ground;
    ctx.fillRect(0, Math.min(this.height, Math.max(0, minY)), this.width, this.height);
    ctx.strokeStyle = PALETTE.groundEdge;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, minY);
    ctx.lineTo(this.width, minY);
    ctx.stroke();
  }

  private collectBrushFaces(
    brush: Brush,
    camera: Vec3,
    view: ViewState,
    aspect: number,
    faces: { depth: number; points: { x: number; y: number }[]; color: string; edge: string; alpha: number }[],
  ): void {
    const topColor = topColorFor(brush);
    const top: Vec3[] = [
      { x: brush.min.x, y: brush.max.y, z: brush.min.z },
      { x: brush.max.x, y: brush.max.y, z: brush.min.z },
      { x: brush.max.x, y: brush.max.y, z: brush.max.z },
      { x: brush.min.x, y: brush.max.y, z: brush.max.z },
    ];
    this.pushFace(top, topColor, PALETTE.groundEdge, camera, view, aspect, faces);

    // One side wall: pick the vertical face whose outward normal points most
    // toward the camera. Cheap and looks right for boxes.
    const centre = {
      x: (brush.min.x + brush.max.x) / 2,
      z: (brush.min.z + brush.max.z) / 2,
    };
    const sides: { a: Vec3; b: Vec3; normal: Vec3 }[] = [
      {
        a: { x: brush.min.x, y: brush.min.y, z: brush.min.z },
        b: { x: brush.max.x, y: brush.min.y, z: brush.min.z },
        normal: { x: 0, y: 0, z: -1 },
      },
      {
        a: { x: brush.max.x, y: brush.min.y, z: brush.min.z },
        b: { x: brush.max.x, y: brush.min.y, z: brush.max.z },
        normal: { x: 1, y: 0, z: 0 },
      },
      {
        a: { x: brush.max.x, y: brush.min.y, z: brush.max.z },
        b: { x: brush.min.x, y: brush.min.y, z: brush.max.z },
        normal: { x: 0, y: 0, z: 1 },
      },
      {
        a: { x: brush.min.x, y: brush.min.y, z: brush.max.z },
        b: { x: brush.min.x, y: brush.min.y, z: brush.min.z },
        normal: { x: -1, y: 0, z: 0 },
      },
    ];
    let bestSide = sides[0];
    let bestDot = -Infinity;
    for (const side of sides) {
      const toCamera = {
        x: camera.x - centre.x,
        z: camera.z - centre.z,
      };
      const dot = toCamera.x * side.normal.x + toCamera.z * side.normal.z;
      if (dot > bestDot) {
        bestDot = dot;
        bestSide = side;
      }
    }
    if (bestDot > 0) {
      const wall: Vec3[] = [
        bestSide.a,
        bestSide.b,
        { x: bestSide.b.x, y: brush.max.y, z: bestSide.b.z },
        { x: bestSide.a.x, y: brush.max.y, z: bestSide.a.z },
      ];
      this.pushFace(wall, PALETTE.padSide, PALETTE.groundEdge, camera, view, aspect, faces);
    }
  }

  private pushFace(
    corners: Vec3[],
    color: string,
    edge: string,
    camera: Vec3,
    view: ViewState,
    aspect: number,
    faces: { depth: number; points: { x: number; y: number }[]; color: string; edge: string; alpha: number }[],
  ): void {
    const points: { x: number; y: number }[] = [];
    let totalDepth = 0;
    let projected = 0;
    for (const corner of corners) {
      const ndc = projectPoint(corner, camera, view, aspect);
      if (!ndc) return; // Any corner behind the camera: skip the whole face.
      points.push(this.toScreen(ndc, this.width, this.height));
      totalDepth += ndc.depth;
      projected++;
    }
    if (projected === 0) return;
    const depth = totalDepth / projected;
    // Distance fog: far pads fade toward the sky so depth reads at a glance.
    const alpha = depth <= FOG_NEAR ? 1 : Math.max(0.18, 1 - (depth - FOG_NEAR) / (FOG_FAR - FOG_NEAR));
    faces.push({ depth, points, color, edge, alpha });
  }

  private drawBeacons(camera: Vec3, view: ViewState, aspect: number, course: Course): void {
    const { ctx } = this;
    for (const pad of course.pads) {
      if (pad.kind !== 'checkpoint' && pad.kind !== 'finish') continue;
      const base: Vec3 = { x: pad.center.x, y: pad.center.y, z: pad.center.z };
      const top: Vec3 = { x: pad.center.x, y: pad.center.y + 90, z: pad.center.z };
      const a = projectPoint(base, camera, view, aspect);
      const b = projectPoint(top, camera, view, aspect);
      if (!a || !b) continue;
      const pa = this.toScreen(a, this.width, this.height);
      const pb = this.toScreen(b, this.width, this.height);
      ctx.strokeStyle = pad.kind === 'finish' ? 'rgba(240,180,41,0.6)' : 'rgba(72,199,142,0.5)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
  }
}

function topColorFor(brush: Brush): string {
  switch (brush.tag) {
    case 'start':
      return PALETTE.startTop;
    case 'checkpoint':
      return PALETTE.padTopCheckpoint;
    case 'finish':
      return PALETTE.padTopFinish;
    case 'ground':
      return PALETTE.ground;
    default:
      return PALETTE.padTop;
  }
}


/** Pads sorted by index, used by the minimap/HUD in the browser shell. */
export function padProgress(course: Course, run: RunState): { phase: string; next: PadSpec | null } {
  const nextPad = course.pads[run.reachedPad + 1] ?? null;
  return { phase: run.phase, next: nextPad };
}
