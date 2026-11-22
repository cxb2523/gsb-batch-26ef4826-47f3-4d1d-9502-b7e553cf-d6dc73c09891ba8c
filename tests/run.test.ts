import test from 'node:test';
import assert from 'node:assert/strict';

import { createRun, formatTime, padTouched, respawnPad, startRun, tickRun } from '../src/game/run.ts';
import { buildCourse } from '../src/game/course.ts';
import { createBody } from '../src/physics/body.ts';
import { GAME } from '../src/config.ts';

const course = buildCourse();

function bodyOn(padIndex: number) {
  const pad = course.pads[padIndex];
  return createBody({ x: pad.center.x, y: pad.center.y, z: pad.center.z }, 0, true);
}

test('a fresh run is ready and does not tick until started', () => {
  const run = createRun();
  const before = tickRun(run, course, bodyOn(0));
  assert.equal(run.elapsed, 0);
  assert.equal(before.fell, false);
  assert.equal(startRun(run), true);
  assert.equal(startRun(run), false); // already running
  tickRun(run, course, bodyOn(0));
  assert.ok(run.elapsed > 0);
});

test('falling below the kill plane triggers a fall, but only after the grace period', () => {
  const run = createRun();
  startRun(run);
  const fallen = createBody({ x: 0, y: GAME.killPlaneY - 10, z: 0 }, 0, false);
  let fellAt = -1;
  for (let i = 0; i < GAME.respawnGraceTicks + 4; i++) {
    const result = tickRun(run, course, fallen);
    if (result.fell) {
      fellAt = i;
      break;
    }
  }
  assert.ok(fellAt >= GAME.respawnGraceTicks, `fell at tick ${fellAt}`);
  assert.equal(run.falls, 1);
});

test('the run clock keeps ticking through a fall', () => {
  const run = createRun();
  startRun(run);
  const fallen = createBody({ x: 0, y: GAME.killPlaneY - 10, z: 0 }, 0, false);
  for (let i = 0; i < GAME.respawnGraceTicks + 2; i++) tickRun(run, course, fallen);
  const elapsedAtFall = run.elapsed;
  // Host respawns the body; the clock must not reset.
  tickRun(run, course, bodyOn(0));
  assert.ok(run.elapsed > elapsedAtFall);
  assert.equal(run.phase, 'running');
});

test('touching a checkpoint banks it and records a stage split', () => {
  const run = createRun();
  startRun(run);
  const cp = course.checkpoints[0];
  const result = tickRun(run, course, bodyOn(cp.index));
  assert.ok(result.checkpoint);
  assert.equal(result.checkpoint.index, cp.index);
  assert.equal(run.checkpointIndex, cp.index);
  assert.ok(run.splits.length >= 1);
  assert.ok(Number.isFinite(run.splits[cp.stage]));
});

test('re-touching an earlier checkpoint never rolls progress backwards', () => {
  const run = createRun();
  startRun(run);
  const later = course.checkpoints[1];
  tickRun(run, course, bodyOn(later.index));
  const earlier = course.checkpoints[0];
  const result = tickRun(run, course, bodyOn(earlier.index));
  assert.equal(result.checkpoint, null);
  assert.equal(run.checkpointIndex, later.index);
});

test('respawn goes to the last checkpoint, or the start pad', () => {
  const run = createRun();
  assert.equal(respawnPad(course, run), course.startPad);
  const cp = course.checkpoints[2];
  run.checkpointIndex = cp.index;
  assert.equal(respawnPad(course, run).index, cp.index);
  // A garbage index falls back to the start rather than crashing.
  run.checkpointIndex = 999;
  assert.equal(respawnPad(course, run), course.startPad);
});

test('reaching the finish ends the run', () => {
  const run = createRun();
  startRun(run);
  const result = tickRun(run, course, bodyOn(course.pads.length - 1));
  assert.equal(result.finished, true);
  assert.equal(run.phase, 'finished');
});

test('padTouched ignores airborne bodies', () => {
  const pad = course.pads[2];
  const body = createBody({ x: pad.center.x, y: pad.center.y, z: pad.center.z }, 0, false);
  assert.equal(padTouched(course, body), null);
});

test('formatTime renders m:ss.mmm', () => {
  assert.equal(formatTime(0), '0:00.000');
  assert.equal(formatTime(9.5), '0:09.500');
  assert.equal(formatTime(61.234), '1:01.234');
  assert.equal(formatTime(-3), '0:00.000');
});
