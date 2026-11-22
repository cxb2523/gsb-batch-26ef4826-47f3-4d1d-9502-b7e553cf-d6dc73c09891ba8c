import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCourse } from '../src/game/course.ts';
import { DEFAULT_BOT, planHop, runBot } from '../src/bot/bot.ts';
import { createBody } from '../src/physics/body.ts';
import { PHYSICS } from '../src/config.ts';

const course = buildCourse();

test('every pad can be reached from the pad before it, at ground-launch speed', () => {
  // A cheap structural feasibility check: start at the pad centre with a full
  // head of speed aimed at the next pad and verify a hop exists. This catches
  // the most common map-edit mistake (moving a pad out of reach) in a fraction
  // of the time a full bot run takes.
  for (let i = 0; i < course.pads.length - 1; i++) {
    const from = course.pads[i];
    const to = course.pads[i + 1];
    const bearing = Math.atan2(to.center.x - from.center.x, to.center.z - from.center.z);
    const body = createBody({ x: from.center.x, y: from.center.y + 0.02, z: from.center.z }, bearing, true);
    body.vel.x = Math.sin(bearing) * PHYSICS.maxGroundSpeed;
    body.vel.z = Math.cos(bearing) * PHYSICS.maxGroundSpeed;
    const plan = planHop(body, to, course.brushes, DEFAULT_BOT);
    assert.ok(plan, `pad ${from.name} -> ${to.name} has no feasible hop`);
  }
});

test('the course grows steadily: each pad is higher than the last', () => {
  for (let i = 1; i < course.pads.length; i++) {
    assert.ok(
      course.pads[i].center.y > course.pads[i - 1].center.y,
      `pad ${course.pads[i].name} is not higher than ${course.pads[i - 1].name}`,
    );
  }
});

test('the scripted bot finishes the course, using only human inputs', () => {
  const result = runBot(course, DEFAULT_BOT);
  assert.equal(result.failure, null, result.failure ?? '');
  assert.equal(result.finished, true, `bot got stuck at pad ${result.furthestPad}`);
  assert.equal(result.padsCleared, course.pads.length);
  assert.equal(result.hops, course.pads.length - 1, 'one hop per pad');
  assert.ok(result.seconds > 5, `implausibly fast: ${result.seconds}s`);
  assert.ok(result.seconds < 120, `implausibly slow: ${result.seconds}s`);
});

test('the bot run stays within the physics rules', () => {
  const result = runBot(course, DEFAULT_BOT);
  // Ground launch speed is capped, so any speed above the cap must have come
  // from air strafing — the bot earned it with allowed inputs.
  assert.ok(result.peakSpeed > PHYSICS.maxGroundSpeed);
  assert.ok(result.peakSpeed < PHYSICS.maxGroundSpeed * 3, 'speed should not explode');
  assert.equal(result.respawns, 0, 'a clean run should not need respawns');
});
