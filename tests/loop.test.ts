import test from 'node:test';
import assert from 'node:assert/strict';

import { Game } from '../src/game/loop.ts';
import { InputBuffer } from '../src/input/input.ts';
import { Records, memoryStorage } from '../src/game/save.ts';
import { buildCourse } from '../src/game/course.ts';
import { interpolatedBody } from '../src/render/canvas.ts';
import { PHYSICS, STEP_SECONDS, VIEW } from '../src/config.ts';

function newGame() {
  const course = buildCourse();
  const input = new InputBuffer();
  const game = new Game({ course, input, records: new Records(memoryStorage()) });
  return { course, input, game };
}

test('the loop produces the same physics ticks as real time at any frame rate', () => {
  for (const fps of [30, 60, 144, 240]) {
    const { input, game } = newGame();
    input.setLocked(true);
    input.handleMouseMove(0, 0);
    input.handleKeyDown('KeyW');
    const frames = fps * 2;
    for (let i = 0; i < frames; i++) game.update(1 / fps);
    // Two seconds of game time = 256 ticks, regardless of frame rate.
    assert.ok(
      Math.abs(game.run.elapsed - 2) < 1e-9,
      `${fps} Hz elapsed ${game.run.elapsed}`,
    );
  }
});

test('rotation totals match between 60 Hz and 240 Hz for identical hand motion', () => {
  function play(fps: number): number {
    const { input, game } = newGame();
    input.setLocked(true);
    input.handleMouseMove(0, 0);
    let sent = 0;
    let acc = 0;
    const frames = fps * 2;
    for (let i = 0; i < frames; i++) {
      // 300 px/s of hand motion spread evenly over the frames.
      acc += 300 / fps;
      const whole = Math.floor(acc);
      acc -= whole;
      if (whole > 0) input.handleMouseMove(whole, 0);
      sent += whole;
      game.update(1 / fps);
    }
    // Consume any motion still pending in a tick.
    game.update(STEP_SECONDS);
    void sent;
    return game.view.yaw;
  }
  const a = play(60);
  const b = play(240);
  // Both should rotate almost exactly 600 px worth of yaw.
  const expectedPixels = 600;
  const perPixel = gameYawPerPixel();
  assert.ok(Math.abs(a - expectedPixels * perPixel) < 12 * perPixel + 1e-9, `60 Hz yaw ${a}`);
  assert.ok(Math.abs(b - expectedPixels * perPixel) < 12 * perPixel + 1e-9, `240 Hz yaw ${b}`);
  assert.ok(Math.abs(a - b) < 3 * perPixel, `60 Hz=${a} 240 Hz=${b}`);
});

function gameYawPerPixel(): number {
  // Must mirror the loop's look scale (VIEW.mouseSensitivity * sensitivity).
  return (VIEW.mouseSensitivity * Math.PI) / 180;
}

test('pausing stops physics and resuming does not fast-forward', () => {
  const { input, game } = newGame();
  input.setLocked(true);
  input.handleKeyDown('KeyW');
  for (let i = 0; i < 60; i++) game.update(1 / 60);
  const beforePause = game.body.pos.z;
  assert.ok(beforePause > 0);

  // Press P: the latch is consumed during this frame, which also pauses.
  input.handleKeyDown('KeyP');
  game.update(1 / 60);
  input.handleKeyUp('KeyP');
  assert.equal(game.paused, true);

  const pausedPos = { ...game.body.pos };
  // Ten seconds pass while paused.
  for (let i = 0; i < 600; i++) game.update(1 / 60);
  assert.deepEqual(game.body.pos, pausedPos, 'physics must not move while paused');

  // Unpause on the next frame, then measure one normal frame's movement.
  input.handleKeyDown('KeyP');
  game.update(1 / 60);
  input.handleKeyUp('KeyP');
  assert.equal(game.paused, false);
  const afterResume = { ...game.body.pos };
  const delta = Math.hypot(afterResume.x - pausedPos.x, afterResume.z - pausedPos.z);
  assert.ok(delta < 20, `teleported ${delta} units on resume`);
});

test('a huge real-time delta is clamped, not integrated in one gulp', () => {
  const { input, game } = newGame();
  input.setLocked(true);
  input.handleKeyDown('KeyW');
  game.update(0.5); // 64 ticks' worth of real time
  assert.ok(game.run.ticks <= Math.floor(0.25 / STEP_SECONDS) + 1);
});

test('rendering interpolates between the previous and current tick', () => {
  const previous = {
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    onGround: true,
  };
  const current = {
    pos: { x: 10, y: 4, z: 20 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 1,
    onGround: true,
  };
  const mid = interpolatedBody(previous, current, 0.5);
  assert.deepEqual(mid.pos, { x: 5, y: 2, z: 10 });
  assert.equal(mid.yaw, 0.5);
  // The endpoints themselves are untouched.
  assert.deepEqual(previous.pos, { x: 0, y: 0, z: 0 });
  assert.deepEqual(current.pos, { x: 10, y: 4, z: 20 });
});

test('the renderer never mutates physics state', () => {
  const { input, game } = newGame();
  input.setLocked(true);
  input.handleKeyDown('KeyW');
  for (let i = 0; i < 30; i++) game.update(1 / 60);
  const snapshot = JSON.stringify({ body: game.body, run: game.run, view: game.view });
  // Interpolate at several alphas; none may write back.
  for (const alpha of [0, 0.25, 0.5, 0.99, 1]) {
    interpolatedBody(game.previous, game.body, alpha);
  }
  assert.equal(JSON.stringify({ body: game.body, run: game.run, view: game.view }), snapshot);
});

test('auto-hop chains on its own after a single jump press', () => {
  function jumps(autoHop: boolean): number {
    const course = buildCourse();
    const input = new InputBuffer();
    const game = new Game({ course, input, records: new Records(memoryStorage()), autoHop });
    input.setLocked(true);
    let count = 0;
    game.setHooks({ onEvent: (event) => { if (event.type === 'jump') count++; } });
    // Jump on the start pad and hold W so the player keeps hopping in place /
    // forwards. Auto-hop should keep re-jumping on every landing.
    input.handleKeyDown('Space');
    input.handleKeyDown('KeyW');
    for (let i = 0; i < 480; i++) game.update(1 / 60);
    return count;
  }
  const auto = jumps(true);
  const manual = jumps(false);
  assert.ok(auto >= 2, `auto-hop should chain, got ${auto} jumps`);
  assert.equal(manual, 1, `without auto-hop a single press must jump once, got ${manual}`);
});

test('a body that walks off the start pad and lands on the ground is respawned', () => {
  const { course, input, game } = newGame();
  input.setLocked(true);
  // Start the run so fall detection is armed.
  input.handleKeyDown('KeyW');
  game.update(1 / 60);
  input.handleKeyUp('KeyW');

  const fallsBefore = game.run.falls;
  // Drop onto the ground plane far from any pad.
  game.body.pos = { x: course.startPad.center.x + 2000, y: 20, z: course.startPad.center.z + 2000 };
  game.body.vel = { x: 0, y: 0, z: 0 };
  game.body.onGround = false;

  const elapsedBeforeFall = game.run.elapsed;
  for (let i = 0; i < 128 * 6; i++) {
    game.update(1 / 60);
    if (game.run.falls > fallsBefore) break;
  }
  assert.equal(game.run.falls, fallsBefore + 1);
  assert.ok(game.run.elapsed > elapsedBeforeFall, 'clock keeps running through the fall');
  assert.ok(Math.abs(game.body.pos.x - course.startPad.center.x) < 1, 'respawned at the start pad');
  assert.ok(Math.abs(game.body.pos.y - course.startPad.center.y) < 1);
});

test('without auto-hop, tapping jump in the air does not queue a ground jump', () => {
  const { input, game } = newGame();
  input.setLocked(true);
  input.handleKeyDown('Space'); // takeoff
  input.handleKeyUp('Space');
  game.update(1 / 60);
  assert.equal(game.body.onGround, false);
  // Spam jump in the air.
  for (let i = 0; i < 20; i++) {
    input.handleKeyDown('Space');
    input.handleKeyUp('Space');
    game.update(1 / 60);
  }
  // Jump edge was consumed in the air; landing must not auto-launch.
  input.handleKeyUp('Space');
  for (let i = 0; i < 120; i++) game.update(1 / 60);
  assert.equal(game.body.onGround, true, 'player should be standing after the air taps');
});

test('falling to the ground respawns at the checkpoint without stopping the clock', () => {
  const { course, input, game } = newGame();
  input.setLocked(true);
  // Start the run so checkpoint banking and fall detection are armed.
  input.handleKeyDown('KeyW');
  game.update(1 / 60);
  input.handleKeyUp('KeyW');

  // Put the runner on the first checkpoint and bank it.
  const cp = course.checkpoints[0];
  game.body.pos = { x: cp.center.x, y: cp.center.y, z: cp.center.z };
  game.body.vel = { x: 0, y: 0, z: 0 };
  game.body.onGround = true;
  for (let i = 0; i < 4; i++) game.update(1 / 60);
  assert.equal(game.run.checkpointIndex, cp.index);

  const elapsedBeforeFall = game.run.elapsed;
  const fallsBefore = game.run.falls;
  // Drop the body out over the void beside the course.
  game.body.pos = { x: cp.center.x + 3000, y: 400, z: cp.center.z };
  game.body.onGround = false;
  for (let i = 0; i < 60 * 8; i++) {
    game.update(1 / 60);
    if (game.run.falls > fallsBefore) break;
  }

  assert.equal(game.run.falls, fallsBefore + 1);
  assert.ok(game.run.elapsed > elapsedBeforeFall, 'clock must keep running through a fall');
  assert.ok(Math.abs(game.body.pos.x - cp.center.x) < 1, 'respawned on the checkpoint x');
  assert.ok(Math.abs(game.body.pos.y - cp.center.y) < 1, 'respawned on the checkpoint top');
});

test('completing the course saves a personal best', () => {
  const { course, input, game } = newGame();
  input.setLocked(true);
  // Start the clock with a movement tick, then stand on the finish pad.
  input.handleKeyDown('KeyW');
  game.update(1 / 60);
  input.handleKeyUp('KeyW');
  const finish = course.finishPad;
  game.body.pos = { x: finish.center.x, y: finish.center.y, z: finish.center.z };
  game.body.vel = { x: 0, y: 0, z: 0 };
  game.body.onGround = true;
  for (let i = 0; i < 4; i++) game.update(1 / 60);
  assert.equal(game.run.phase, 'finished');
  const best = game.records.loadBest();
  assert.ok(best);
  assert.ok(best.seconds > 0);
});

test('restart resets the body, timer, checkpoints and view', () => {
  const { course, input, game } = newGame();
  input.setLocked(true);
  const cp = course.checkpoints[1];
  game.body.pos = { x: cp.center.x, y: cp.center.y, z: cp.center.z };
  game.body.onGround = true;
  input.handleKeyDown('KeyW');
  game.update(1 / 60);
  input.handleKeyDown('KeyR');
  game.update(1 / 60);
  assert.equal(game.run.phase, 'ready');
  assert.equal(game.run.elapsed, 0);
  assert.equal(game.run.checkpointIndex, -1);
  assert.deepEqual(game.body.pos, {
    x: course.startPad.center.x,
    y: course.startPad.center.y + 0.02,
    z: course.startPad.center.z,
  });
  assert.equal(game.view.yaw, 0);
});

test('the player cannot gain speed by holding W on the ground past the cap', () => {
  const { input, game } = newGame();
  input.setLocked(true);
  input.handleKeyDown('KeyW');
  let peak = 0;
  for (let i = 0; i < 480; i++) {
    game.update(1 / 60);
    peak = Math.max(peak, Math.hypot(game.body.vel.x, game.body.vel.z));
  }
  assert.ok(peak <= PHYSICS.maxGroundSpeed + 1e-6, `ground speed peaked at ${peak}`);
});

test('motion accumulated while paused is not applied on resume', () => {
  const { input, game } = newGame();
  input.setLocked(true);
  input.handleMouseMove(0, 0); // swallow the post-lock jump
  game.setPaused(true);
  const yawBefore = game.view.yaw;
  // While paused, the player sweeps the mouse and mashes jump.
  for (let i = 0; i < 20; i++) {
    input.handleMouseMove(50, 0);
    input.handleKeyDown('Space');
    input.handleKeyUp('Space');
    game.update(1 / 60); // paused frames still draw, but must not integrate
  }
  assert.equal(game.view.yaw, yawBefore, 'yaw must not move while paused');
  // Resume and run one idle frame: none of the paused motion may appear.
  game.setPaused(false);
  game.update(1 / 60);
  assert.equal(game.view.yaw, yawBefore, 'paused motion leaked through resume');
});

test('a finished run ignores further mouse and key input', () => {
  const { course, input, game } = newGame();
  input.setLocked(true);
  input.handleMouseMove(0, 0);
  input.handleKeyDown('KeyW');
  game.update(1 / 60);
  input.handleKeyUp('KeyW');
  const finish = course.finishPad;
  game.body.pos = { x: finish.center.x, y: finish.center.y, z: finish.center.z };
  game.body.onGround = true;
  for (let i = 0; i < 4; i++) game.update(1 / 60);
  assert.equal(game.run.phase, 'finished');
  const yawAtFinish = game.view.yaw;
  const posAtFinish = { ...game.body.pos };
  for (let i = 0; i < 30; i++) {
    input.handleMouseMove(40, 0);
    game.update(1 / 60);
  }
  assert.equal(game.view.yaw, yawAtFinish);
  assert.deepEqual(game.body.pos, posAtFinish);
});

test('sweeping the mouse sideways while airborne builds speed through the real loop', () => {
  const { course, input, game } = newGame();
  input.setLocked(true);
  input.handleMouseMove(0, 0); // swallow the post-lock jump

  // Launch high above the start pad with upward velocity so gravity alone keeps
  // the test genuinely airborne for the whole sweep. No physics value is poked.
  const start = course.startPad;
  game.body = {
    pos: { x: start.center.x, y: start.center.y + 3000, z: start.center.z },
    vel: { x: 0, y: 700, z: 250 },
    yaw: 0,
    onGround: false,
  };
  game.previous = { ...game.body, pos: { ...game.body.pos }, vel: { ...game.body.vel } };
  game.setPaused(false);

  // Hold D and sweep the mouse right steadily. The look scale turns pixels into
  // yaw; a strafe key plus a swept yaw is the whole speed mechanic.
  input.handleKeyDown('KeyD');
  const startSpeed = Math.hypot(game.body.vel.x, game.body.vel.z);
  let peak = startSpeed;
  let airborneFrames = 0;
  for (let i = 0; i < 60; i++) {
    input.handleMouseMove(18, 0);
    game.update(1 / 60);
    if (game.body.onGround) break;
    airborneFrames++;
    peak = Math.max(peak, Math.hypot(game.body.vel.x, game.body.vel.z));
  }
  input.handleKeyUp('KeyD');
  assert.ok(airborneFrames > 30, `expected a long air phase, got ${airborneFrames} frames`);
  assert.ok(peak > startSpeed + 20, `mouse sweep should build speed (start ${startSpeed}, peak ${peak})`);
});
