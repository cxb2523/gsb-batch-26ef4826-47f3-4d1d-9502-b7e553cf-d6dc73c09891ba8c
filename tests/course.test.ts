import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCourse, checkpointForIndex, padByIndex, STAGES } from '../src/game/course.ts';
import { PHYSICS } from '../src/config.ts';

const course = buildCourse();

test('the course has a start, five checkpoints and a finish', () => {
  assert.equal(course.pads[0].kind, 'start');
  assert.equal(course.pads[course.pads.length - 1].kind, 'finish');
  assert.equal(course.checkpoints.length, STAGES.length - 1);
  assert.equal(course.pads.length, 1 + STAGES.reduce((sum, s) => sum + s.pads, 0));
});

test('pad indices are sequential and unique', () => {
  course.pads.forEach((pad, i) => assert.equal(pad.index, i));
});

test('every checkpoint is followed by a stage run-up', () => {
  for (const range of course.stageRanges) {
    assert.ok(range.last - range.first + 1 === STAGES[range.stage].pads);
    // The last pad of every stage except the final one is a checkpoint.
    const last = course.pads[range.last];
    if (range.stage < STAGES.length - 1) assert.equal(last.kind, 'checkpoint');
  }
});

test('consecutive pads gain the configured rise and keep the configured edge gap', () => {
  for (let i = 1; i < course.pads.length; i++) {
    const a = course.pads[i - 1];
    const b = course.pads[i];
    const stage = b.stage >= 0 ? STAGES[b.stage] : null;
    if (!stage) continue;
    assert.ok(Math.abs(b.center.y - a.center.y - stage.rise) < 1e-9, `rise before ${b.name}`);
    const chord = Math.hypot(b.center.x - a.center.x, b.center.z - a.center.z);
    const edgeGap = chord - (a.size + b.size) / 2;
    assert.ok(Math.abs(edgeGap - stage.gap) < 1e-9, `gap before ${b.name}: ${edgeGap}`);
  }
});

test('no two pads at similar heights overlap in plan view', () => {
  for (let i = 0; i < course.pads.length; i++) {
    for (let j = i + 2; j < course.pads.length; j++) {
      const a = course.pads[i];
      const b = course.pads[j];
      if (Math.abs(a.center.y - b.center.y) > 120) continue;
      const dx = Math.max(0, Math.abs(a.center.x - b.center.x) - (a.size + b.size) / 2);
      const dz = Math.max(0, Math.abs(a.center.z - b.center.z) - (a.size + b.size) / 2);
      assert.ok(Math.hypot(dx, dz) > 24, `pads ${a.name} and ${b.name} are too close`);
    }
  }
});

test('every pad is at least as wide as the player', () => {
  for (const pad of course.pads) {
    assert.ok(pad.size >= PHYSICS.halfWidth * 2 + 40, `${pad.name} is too small`);
  }
});

test('checkpoint lookup only ever returns pads at or below the given index', () => {
  assert.equal(checkpointForIndex(course, 0), course.startPad);
  for (let index = 0; index < course.pads.length; index++) {
    const cp = checkpointForIndex(course, index);
    assert.ok(cp.index <= index);
    assert.ok(cp.kind === 'checkpoint' || cp.kind === 'start');
    // It must be the highest such checkpoint.
    for (const other of course.checkpoints) {
      if (other.index <= index) assert.ok(other.index <= cp.index);
    }
  }
});

test('padByIndex finds pads and rejects out-of-range indices', () => {
  assert.equal(padByIndex(course, 3)?.index, 3);
  assert.equal(padByIndex(course, -1), null);
  assert.equal(padByIndex(course, 999), null);
});

test('every brush matches a pad footprint and top height', () => {
  const padBrushes = course.brushes.filter((b) => b.tag !== 'ground');
  const groundBrushes = course.brushes.filter((b) => b.tag === 'ground');
  assert.equal(groundBrushes.length, 1, 'exactly one out-of-bounds ground plane');
  assert.equal(groundBrushes[0].max.y, course.groundTop);
  assert.equal(padBrushes.length, course.pads.length);
  for (const pad of course.pads) {
    const brush = padBrushes.find((b) => b.label === pad.name);
    assert.ok(brush, `missing brush for ${pad.name}`);
    assert.equal(brush.max.y, pad.center.y);
    assert.ok(Math.abs(brush.max.x - brush.min.x - pad.size) < 1e-9);
  }
});

test('the ground plane sits well below the start pad', () => {
  assert.ok(course.groundTop < course.startPad.center.y - 20);
  // The start pad must hold the player, not sink them into the ground brush.
  const ground = course.brushes.find((b) => b.tag === 'ground')!;
  assert.ok(ground.max.y < course.startPad.center.y);
});
