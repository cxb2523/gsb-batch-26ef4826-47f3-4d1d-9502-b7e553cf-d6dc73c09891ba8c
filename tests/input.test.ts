import test from 'node:test';
import assert from 'node:assert/strict';

import { InputBuffer } from '../src/input/input.ts';

/** Gather one frame's worth of motion, then consume it across `steps` ticks. */
function runFrame(buffer: InputBuffer, steps: number) {
  const frame = buffer.beginFrame(steps);
  const ticks = [];
  for (let i = 0; i < steps; i++) ticks.push(buffer.nextTick(frame));
  return { frame, ticks };
}

test('mouse motion is ignored entirely while the pointer is unlocked', () => {
  const buffer = new InputBuffer();
  buffer.handleMouseMove(50, 10);
  const { ticks } = runFrame(buffer, 2);
  assert.equal(ticks[0].mouseDx, 0);
  assert.equal(ticks[1].mouseDx, 0);
});

test('the first movement event after locking is swallowed', () => {
  const buffer = new InputBuffer();
  buffer.setLocked(true);
  // Browsers can report a huge bogus jump when the cursor is captured.
  buffer.handleMouseMove(9999, 9999);
  buffer.handleMouseMove(20, -10);
  const { ticks } = runFrame(buffer, 1);
  assert.equal(ticks[0].mouseDx, 20);
  assert.equal(ticks[0].mouseDy, -10);
});

test('frame mouse delta is split evenly across ticks and sums exactly', () => {
  const buffer = new InputBuffer();
  buffer.setLocked(true);
  buffer.handleMouseMove(0, 0); // swallow
  buffer.handleMouseMove(90, -45);
  const { ticks } = runFrame(buffer, 3);
  assert.equal(ticks.length, 3);
  for (const tick of ticks) {
    assert.ok(Math.abs(tick.mouseDx - 30) < 1e-12);
    assert.ok(Math.abs(tick.mouseDy - -15) < 1e-12);
  }
  const totalX = ticks.reduce((a, t) => a + t.mouseDx, 0);
  assert.ok(Math.abs(totalX - 90) < 1e-9);
});

test('same hand movement produces the same total rotation at 60 Hz and 240 Hz', () => {
  // 60 Hz: each frame drives 128/60 ≈ 2.13 ticks, so frames alternate between
  // 2 and 3 ticks. 240 Hz frames drive ~0.53 ticks. Feeding the same total
  // pixels over the same wall time must produce the same total yaw.
  const pixelsPerSecond = 600;
  const seconds = 2;

  function totalYaw(fps: number): number {
    const buffer = new InputBuffer();
    buffer.setLocked(true);
    buffer.handleMouseMove(0, 0); // swallow
    let yaw = 0;
    let steps = 0;
    const frames = Math.round(fps * seconds);
    let carried = 0;
    for (let f = 0; f < frames; f++) {
      // Distribute each second's pixels uniformly across that second's frames.
      const exact = pixelsPerSecond / fps + carried;
      const whole = Math.round(exact);
      carried = exact - whole;
      buffer.handleMouseMove(whole, 0);
      // 128 ticks/sec → ticks per frame.
      const ticks = Math.floor(((f + 1) * 128) / fps) - Math.floor((f * 128) / fps);
      if (ticks > 0) {
        const frame = buffer.beginFrame(ticks);
        for (let i = 0; i < ticks; i++) yaw += buffer.nextTick(frame).mouseDx;
        steps += ticks;
      } else {
        // No tick this frame: motion must stay pending.
        runFrame(buffer, 0);
      }
    }
    // Consume any remainder with one final tick.
    yaw += runFrame(buffer, 1).ticks[0].mouseDx;
    void steps;
    return yaw;
  }

  const at60 = totalYaw(60);
  const at240 = totalYaw(240);
  assert.ok(Math.abs(at60 - pixelsPerSecond * seconds) < 12, `60 Hz total ${at60}`);
  assert.ok(Math.abs(at240 - pixelsPerSecond * seconds) < 12, `240 Hz total ${at240}`);
  assert.ok(Math.abs(at60 - at240) <= 2, `60 Hz=${at60}, 240 Hz=${at240}`);
});

test('a frame with zero ticks consumes nothing and carries motion to the next frame', () => {
  const buffer = new InputBuffer();
  buffer.setLocked(true);
  buffer.handleMouseMove(0, 0); // swallow
  buffer.handleMouseMove(64, 0);
  const idle = buffer.beginFrame(0);
  assert.equal(idle.stepsTotal, 0);
  buffer.nextTick(idle); // safe no-op
  // Nothing lost: the next real frame sees the full 64 px.
  const { ticks } = runFrame(buffer, 2);
  assert.equal(ticks[0].mouseDx + ticks[1].mouseDx, 64);
});

test('jump keydown latches exactly once per press, not per tick or per repeat', () => {
  const buffer = new InputBuffer();
  buffer.handleKeyDown('Space', false);
  buffer.handleKeyDown('Space', true); // OS repeat
  const { ticks } = runFrame(buffer, 4);
  assert.equal(ticks[0].jumpPressed, true);
  assert.equal(ticks[1].jumpPressed, false);
  assert.equal(ticks[2].jumpPressed, false);
  assert.equal(ticks[3].jumpPressed, false);
  assert.equal(ticks[0].jumpHeld, true);
});

test('jump held without a new press does not latch', () => {
  const buffer = new InputBuffer();
  buffer.handleKeyDown('Space', false);
  runFrame(buffer, 1); // consume the press
  const { ticks } = runFrame(buffer, 3);
  assert.equal(ticks.every((t) => !t.jumpPressed), true);
  assert.equal(ticks[0].jumpHeld, true);
});

test('wheel notch is an edge-triggered jump', () => {
  const buffer = new InputBuffer();
  buffer.handleWheel(100);
  const { ticks } = runFrame(buffer, 3);
  assert.equal(ticks[0].jumpPressed, true);
  assert.equal(ticks[1].jumpPressed, false);
});

test('unlocking clears pending motion so re-lock cannot spin the view', () => {
  const buffer = new InputBuffer();
  buffer.setLocked(true);
  buffer.handleMouseMove(0, 0);
  buffer.handleMouseMove(300, 300);
  buffer.setLocked(false);
  buffer.setLocked(true);
  buffer.handleMouseMove(0, 0); // swallow on re-lock
  const { ticks } = runFrame(buffer, 1);
  assert.equal(ticks[0].mouseDx, 0);
  assert.equal(ticks[0].mouseDy, 0);
});

test('a single absurd event is clamped and an overflow burst is dropped', () => {
  const buffer = new InputBuffer({ maxEventPixels: 100, maxPendingPixels: 250 });
  buffer.setLocked(true);
  buffer.handleMouseMove(0, 0);
  buffer.handleMouseMove(10000, 0); // clamped to 100
  buffer.handleMouseMove(10000, 0); // 200
  buffer.handleMouseMove(10000, 0); // 300 → over 250, dropped
  const { ticks } = runFrame(buffer, 1);
  assert.equal(ticks[0].mouseDx, 0);
});

test('clearMotion drops motion and one-shot latches but keeps held keys', () => {
  const buffer = new InputBuffer();
  buffer.setLocked(true);
  buffer.handleMouseMove(0, 0);
  buffer.handleMouseMove(50, 50);
  buffer.handleKeyDown('KeyW');
  buffer.handleKeyDown('Space');
  buffer.clearMotion();
  const { ticks } = runFrame(buffer, 1);
  assert.equal(ticks[0].mouseDx, 0);
  assert.equal(ticks[0].jumpPressed, false);
  assert.equal(ticks[0].forward, 1);
  assert.equal(ticks[0].jumpHeld, true);
});

test('opposing movement keys cancel to zero', () => {
  const buffer = new InputBuffer();
  buffer.handleKeyDown('KeyW');
  buffer.handleKeyDown('KeyS');
  buffer.handleKeyDown('KeyD');
  const { ticks } = runFrame(buffer, 1);
  assert.equal(ticks[0].forward, 0);
  assert.equal(ticks[0].right, 1);
  buffer.handleKeyUp('KeyD');
  buffer.handleKeyUp('KeyS');
  const second = runFrame(buffer, 1).ticks[0];
  assert.equal(second.forward, 1);
  assert.equal(second.right, 0);
});

test('pause, restart and auto-hop toggles are one-shot frame latches', () => {
  const buffer = new InputBuffer();
  buffer.handleKeyDown('KeyP');
  buffer.handleKeyDown('KeyR');
  buffer.handleKeyDown('KeyH');
  const controls = buffer.consumeControls();
  assert.equal(controls.pausePressed, true);
  assert.equal(controls.restartPressed, true);
  assert.equal(controls.toggleAutoHopPressed, true);
  const again = buffer.consumeControls();
  assert.equal(again.pausePressed, false);
  assert.equal(again.restartPressed, false);
  assert.equal(again.toggleAutoHopPressed, false);
});

test('frame controls survive a zero-tick frame so pause can be toggled while paused', () => {
  const buffer = new InputBuffer();
  buffer.handleKeyDown('KeyP');
  const idle = buffer.beginFrame(0); // paused frame: no physics ticks
  assert.equal(idle.stepsTotal, 0);
  const controls = buffer.consumeControls();
  assert.equal(controls.pausePressed, true);
});

test('releaseAll forgets held keys so a lost keyup cannot leave a phantom jump', () => {
  const buffer = new InputBuffer();
  buffer.setLocked(true);
  buffer.handleMouseMove(0, 0);
  buffer.handleKeyDown('Space');
  buffer.handleKeyDown('KeyW');
  buffer.handleMouseMove(40, 0);
  buffer.releaseAll();
  const { ticks } = runFrame(buffer, 2);
  assert.equal(ticks[0].jumpHeld, false, 'jump must be released');
  assert.equal(ticks[0].forward, 0, 'W must be released');
  assert.equal(ticks[0].mouseDx, 0, 'pending motion must be dropped');
  assert.equal(ticks[0].jumpPressed, false);
  // A fresh press still works afterwards.
  buffer.handleKeyDown('Space');
  const next = runFrame(buffer, 1).ticks[0];
  assert.equal(next.jumpPressed, true);
});
