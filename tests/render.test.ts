import test from 'node:test';
import assert from 'node:assert/strict';

import { CanvasRenderer, cameraBasis, interpolatedBody, projectPoint } from '../src/render/canvas.ts';
import type { Canvas2DContext } from '../src/render/canvas.ts';
import { buildCourse } from '../src/game/course.ts';
import { createRun } from '../src/game/run.ts';
import { createBody } from '../src/physics/body.ts';

/** A fake Canvas2D that records call counts so drawing can be exercised headlessly. */
function recordingContext() {
  const calls: Record<string, number> = {};
  const bump = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  const ctx: Canvas2DContext = {
    canvas: { width: 640, height: 360 },
    setTransform: () => bump('setTransform'),
    clearRect: () => bump('clearRect'),
    fillRect: () => bump('fillRect'),
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 0,
    globalAlpha: 1,
    beginPath: () => bump('beginPath'),
    moveTo: () => bump('moveTo'),
    lineTo: () => bump('lineTo'),
    closePath: () => bump('closePath'),
    fill: () => bump('fill'),
    stroke: () => bump('stroke'),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    arc: () => bump('arc'),
    save: () => bump('save'),
    restore: () => bump('restore'),
    translate: () => bump('translate'),
    rotate: () => bump('rotate'),
    font: '',
    textAlign: 'left',
    textBaseline: 'top',
    fillText: () => bump('fillText'),
    measureText: () => ({ width: 10 }),
  };
  return { ctx, calls };
}

test('camera basis is orthonormal for representative views', () => {
  for (const yaw of [0, 0.5, Math.PI / 2, -1.2]) {
    for (const pitch of [0, 0.4, -0.6]) {
      const { forward, right, up } = cameraBasis({ yaw, pitch });
      const dot = (a: typeof forward, b: typeof forward) => a.x * b.x + a.y * b.y + a.z * b.z;
      assert.ok(Math.abs(dot(forward, forward) - 1) < 1e-9);
      assert.ok(Math.abs(dot(right, right) - 1) < 1e-9);
      assert.ok(Math.abs(dot(up, up) - 1) < 1e-9);
      assert.ok(Math.abs(dot(forward, right)) < 1e-9);
      assert.ok(Math.abs(dot(forward, up)) < 1e-9);
      assert.ok(Math.abs(dot(right, up)) < 1e-9);
    }
  }
});

test('points in front project, points behind do not', () => {
  const camera = { x: 0, y: 0, z: 0 };
  const view = { yaw: 0, pitch: 0 };
  const ahead = projectPoint({ x: 0, y: 0, z: 100 }, camera, view, 16 / 9);
  assert.ok(ahead);
  assert.ok(ahead.depth > 0);
  assert.ok(Math.abs(ahead.x) < 1e-9 && Math.abs(ahead.y) < 1e-9);

  const behind = projectPoint({ x: 0, y: 0, z: -100 }, camera, view, 16 / 9);
  assert.equal(behind, null);
});

test('a point to the right projects to positive NDC x', () => {
  const camera = { x: 0, y: 0, z: 0 };
  const view = { yaw: 0, pitch: 0 };
  const right = projectPoint({ x: 100, y: 0, z: 100 }, camera, view, 16 / 9);
  assert.ok(right && right.x > 0);
  const left = projectPoint({ x: -100, y: 0, z: 100 }, camera, view, 16 / 9);
  assert.ok(left && left.x < 0);
});

test('interpolation never overshoots its endpoints', () => {
  const a = createBody({ x: 0, y: 0, z: 0 });
  const b = createBody({ x: 10, y: 0, z: 0 });
  for (const alpha of [0, 0.1, 0.5, 0.9, 1]) {
    const mid = interpolatedBody(a, b, alpha);
    assert.ok(mid.pos.x >= 0 && mid.pos.x <= 10);
  }
});

test('drawing the course fills pixels and reports stats', () => {
  const { ctx, calls } = recordingContext();
  const renderer = new CanvasRenderer(ctx, 640, 360);
  const course = buildCourse();
  const start = course.startPad;
  const body = createBody({ x: start.center.x, y: start.center.y, z: start.center.z }, 0.6, true);
  // Look slightly up at the spiral.
  const stats = renderer.draw({
    previous: body,
    current: body,
    alpha: 0,
    view: { yaw: 0.6, pitch: 0.12 },
    run: createRun(),
    course,
    width: 640,
    height: 360,
  });
  assert.ok(calls.fillRect >= 1, 'sky/ground must be filled');
  assert.ok(calls.moveTo > 0, 'faces must be drawn');
  assert.ok(calls.stroke > 0);
  assert.equal(stats.brushCount, course.brushes.length);
});

test('a resize updates the renderer viewport', () => {
  const { ctx, calls } = recordingContext();
  const renderer = new CanvasRenderer(ctx, 320, 180);
  const course = buildCourse();
  const start = course.startPad;
  const body = createBody({ x: start.center.x, y: start.center.y, z: start.center.z }, 0, true);
  renderer.resize(1280, 720);
  renderer.draw({
    previous: body,
    current: body,
    alpha: 0.5,
    view: { yaw: 0, pitch: 0 },
    run: createRun(),
    course,
    width: 1280,
    height: 720,
  });
  assert.ok(calls.fillRect >= 1);
});

test('camera up vector points up in world space', () => {
  for (const yaw of [0, 0.7, Math.PI / 2, -2.1]) {
    const { up } = cameraBasis({ yaw, pitch: 0 });
    assert.ok(Math.abs(up.x) < 1e-9 && Math.abs(up.z) < 1e-9, `up has horizontal component at yaw ${yaw}`);
    assert.ok(up.y > 0, `up should point +Y at yaw ${yaw}, got ${up.y}`);
  }
  // Looking up should tilt the up vector's +Y world component down but keep it
  // orthogonal to forward, never flipping the scene.
  const { forward, up } = cameraBasis({ yaw: 1, pitch: 0.5 });
  const dot = forward.x * up.x + forward.y * up.y + forward.z * up.z;
  assert.ok(Math.abs(dot) < 1e-9);
});
