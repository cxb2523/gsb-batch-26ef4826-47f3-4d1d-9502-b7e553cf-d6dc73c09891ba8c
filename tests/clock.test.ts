import test from 'node:test';
import assert from 'node:assert/strict';

import { FixedStepClock, splitEvenly } from '../src/sim/clock.ts';
import { STEP_SECONDS } from '../src/config.ts';

test('accumulator emits whole 128 Hz steps and keeps a sub-step remainder', () => {
  const clock = new FixedStepClock({ stepSeconds: STEP_SECONDS });
  // 60 fps frame: 16.666… ms.
  let total = 0;
  for (let i = 0; i < 60; i++) total += clock.advance(1 / 60);
  // One second of real time must be exactly 128 ticks (no drift either way).
  assert.equal(total, 128);
  assert.ok(clock.alpha >= 0 && clock.alpha < 1);
});

test('step count matches elapsed time across awkward frame rates', () => {
  const rates = [30, 60, 75, 90, 120, 144, 165, 240, 360];
  for (const rate of rates) {
    const clock = new FixedStepClock({ stepSeconds: STEP_SECONDS });
    const frame = 1 / rate;
    const frames = rate * 4; // four seconds
    let ticks = 0;
    for (let i = 0; i < frames; i++) ticks += clock.advance(frame);
    assert.equal(ticks, 512, `${rate} Hz should emit 512 ticks in 4 s`);
  }
});

test('exact multiples do not lose a tick to floating point drift', () => {
  const clock = new FixedStepClock({ stepSeconds: STEP_SECONDS });
  let total = 0;
  for (let i = 0; i < 128; i++) total += clock.advance(STEP_SECONDS);
  assert.equal(total, 128);
});

test('a long stall is clamped instead of producing a catch-up burst', () => {
  const clock = new FixedStepClock({ stepSeconds: STEP_SECONDS, maxFrameSeconds: 0.25 });
  // Tab was hidden for ten minutes.
  const steps = clock.advance(600);
  assert.ok(steps <= 32, `expected at most 32 steps, got ${steps}`);
  assert.equal(steps, Math.floor(0.25 / STEP_SECONDS));
});

test('pausing drops accumulated time so resuming cannot teleport', () => {
  const clock = new FixedStepClock({ stepSeconds: STEP_SECONDS });
  clock.advance(1 / 60); // small remainder
  clock.setPaused(true);
  assert.equal(clock.isPaused, true);
  assert.equal(clock.advance(30), 0);
  clock.setPaused(false);
  // First frame after resume only accounts for its own elapsed time.
  assert.equal(clock.advance(1 / 60), 2);
  assert.equal(clock.advance(0), 0);
});

test('non-finite and negative deltas are ignored', () => {
  const clock = new FixedStepClock({ stepSeconds: STEP_SECONDS });
  assert.equal(clock.advance(Number.NaN), 0);
  assert.equal(clock.advance(Number.POSITIVE_INFINITY), 0);
  assert.equal(clock.advance(-1), 0);
  assert.equal(clock.alpha, 0);
});

test('splitEvenly parts sum exactly to the total', () => {
  for (const total of [0, 1, -1, 37.5, 100, -0.3]) {
    for (const steps of [1, 2, 3, 7, 128]) {
      const parts = splitEvenly(total, steps);
      assert.equal(parts.length, steps);
      const sum = parts.reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(sum - total) < 1e-12, `${total}/${steps} summed to ${sum}`);
    }
  }
  assert.deepEqual(splitEvenly(5, 0), []);
});

test('alpha is leftover time over step time, never 1 or more', () => {
  const clock = new FixedStepClock({ stepSeconds: STEP_SECONDS });
  clock.advance(STEP_SECONDS * 1.5);
  assert.ok(Math.abs(clock.alpha - 0.5) < 1e-9);
  clock.advance(STEP_SECONDS * 0.75);
  assert.ok(clock.alpha >= 0 && clock.alpha < 1);
});
