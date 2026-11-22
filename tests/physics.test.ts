import test from 'node:test';
import assert from 'node:assert/strict';

import { PHYSICS } from '../src/config.ts';
import {
  IDLE_COMMAND,
  createBody,
  overlapsWorld,
  stepBody,
  wishDirection,
  type TickCommand,
} from '../src/physics/body.ts';
import { makeBrush, type Brush } from '../src/physics/collision.ts';

const FLOOR: Brush = {
  min: { x: -2000, y: -24, z: -2000 },
  max: { x: 2000, y: 0, z: 2000 },
  tag: 'ground',
};

function command(partial: Partial<TickCommand>): TickCommand {
  return { ...IDLE_COMMAND, ...partial };
}

function settle(body = createBody({ x: 0, y: 0.5, z: 0 }, 0, false), brushes: Brush[] = [FLOOR]) {
  let current = body;
  for (let i = 0; i < 20; i++) {
    current = stepBody(current, IDLE_COMMAND, brushes, PHYSICS, false).body;
  }
  return current;
}

test('wish direction is normalised so diagonals are not faster', () => {
  const forward = wishDirection(0, 1, 0);
  const diagonal = wishDirection(0, 1, 1);
  assert.ok(Math.abs(Math.hypot(diagonal.x, diagonal.z) - 1) < 1e-12);
  assert.ok(Math.abs(forward.length - 1) < 1e-12);
  // Straight ahead at yaw 0 is +Z.
  assert.ok(Math.abs(forward.z - 1) < 1e-12);
});

test('a body falls under gravity and lands exactly on the surface', () => {
  const body = settle();
  assert.equal(body.onGround, true);
  assert.ok(Math.abs(body.pos.y) < 1e-9, `expected y≈0, got ${body.pos.y}`);
  assert.equal(body.vel.y, 0);
});

test('a body never ends a tick overlapping the world', () => {
  const brushes: Brush[] = [
    FLOOR,
    makeBrush(0, 40, 60, 80, 80, 16, 'pad'),
  ];
  let body = createBody({ x: 0, y: 0.5, z: 0 }, 0, false);
  for (let i = 0; i < 400; i++) {
    const result = stepBody(
      body,
      command({ forward: 1, right: i % 40 < 20 ? 1 : -1, jumpHeld: true, jumpPressed: i % 30 === 0 }),
      brushes,
      PHYSICS,
      true,
    );
    body = result.body;
    assert.equal(overlapsWorld(body, brushes, PHYSICS), false, `overlap at tick ${i}`);
  }
});

test('jump is edge-triggered: holding space does not bunny-hop with auto-hop off', () => {
  let body = settle();
  let jumps = 0;
  for (let i = 0; i < 200; i++) {
    // Space held the whole time, never "pressed" again.
    const result = stepBody(body, command({ jumpHeld: true, jumpPressed: false }), [FLOOR], PHYSICS, false);
    body = result.body;
    if (result.events.jumped) jumps++;
  }
  assert.equal(jumps, 0);
});

test('auto-hop re-jumps on every landing tick and never adds speed', () => {
  let body = settle();
  const startSpeed = Math.hypot(body.vel.x, body.vel.z);

  // Take off once manually, then never press again: auto-hop must keep the
  // chain alive on its own, and only on landing ticks.
  body = stepBody(body, command({ jumpHeld: true, jumpPressed: true }), [FLOOR], PHYSICS, true).body;
  assert.equal(body.onGround, false);

  let jumps = 0;
  let landedTicks = 0;
  let lastJumpWasOnLanding = true;
  let airborneTicks = 0;
  for (let i = 0; i < 300; i++) {
    const wasGrounded = body.onGround;
    const result = stepBody(body, command({ jumpHeld: true }), [FLOOR], PHYSICS, true);
    body = result.body;
    if (result.events.landed) landedTicks++;
    if (result.events.jumped) {
      jumps++;
      // A re-jump must happen on a tick where the body had just landed,
      // i.e. it was airborne before this tick and is airborne after it.
      lastJumpWasOnLanding = !wasGrounded;
    }
    if (!body.onGround) airborneTicks++;
  }
  assert.ok(jumps >= 2, `expected several auto-hops in ~2.3 s, got ${jumps}`);
  assert.equal(jumps, landedTicks, 'every landing should produce exactly one auto-hop');
  assert.equal(lastJumpWasOnLanding, true, 'auto-hop must never fire mid-air');
  assert.ok(airborneTicks > 0);

  // Auto-hop only re-jumps; it must not inject horizontal speed. Compare to a
  // body that never jumps at all.
  let passive = settle();
  for (let i = 0; i < 300; i++) passive = stepBody(passive, command({}), [FLOOR], PHYSICS, false).body;
  assert.ok(Math.hypot(passive.vel.x, passive.vel.z) <= startSpeed + 1e-9);
});

test('air acceleration wish speed is capped at 30 while each gain stays unclamped', () => {
  // Airborne, moving along +Z. Yaw so W points +X: the wish is sideways.
  const air: Brush[] = [];
  let body = createBody({ x: 0, y: 1000, z: 0 }, 0, false);
  body.vel.z = 250;
  body.yaw = Math.PI / 2;
  const gainPerTick = PHYSICS.airAccel * PHYSICS.airWishCap * PHYSICS.stepSeconds;

  // Until the along-wish component reaches the 30 u/s cap, every tick adds the
  // full (unclamped) gain.
  const fullGainTicks = Math.floor(PHYSICS.airWishCap / gainPerTick);
  assert.ok(fullGainTicks >= 2);
  let totalGain = 0;
  for (let i = 0; i < fullGainTicks; i++) {
    const result = stepBody(body, command({ forward: 1 }), air, PHYSICS, false);
    body = result.body;
    assert.ok(Math.abs(result.events.airGain - gainPerTick) < 1e-9, `tick ${i} gain`);
    totalGain += result.events.airGain;
  }
  assert.ok(Math.abs(body.vel.x - totalGain) < 1e-9);

  // The final tick that crosses the cap still applies the FULL gain, so the
  // along-wish component overshoots 30 rather than being trimmed to it. That
  // overshoot is the "unclamped gain" rule in one assertion.
  const overshoot = stepBody(body, command({ forward: 1 }), air, PHYSICS, false);
  body = overshoot.body;
  assert.ok(Math.abs(overshoot.events.airGain - gainPerTick) < 1e-9, 'crossing tick keeps its full gain');
  assert.ok(body.vel.x > PHYSICS.airWishCap, 'along-wish component overshoots the 30 u/s cap');

  // Now the along-wish component exceeds the cap, so no further gain is added.
  const result = stepBody(body, command({ forward: 1 }), air, PHYSICS, false);
  assert.equal(result.events.airGain, 0);
  // The total speed is already above the ground cap because the gain was sideways.
  assert.ok(Math.hypot(result.body.vel.x, result.body.vel.z) > 250);
});

test('strafing with a swept mouse builds air speed without bound', () => {
  // The real mechanic: hold a strafe key and sweep the yaw while airborne so
  // the wish direction stays perpendicular to velocity. Each tick then adds a
  // little sideways speed, and the total keeps climbing well past the 250 u/s
  // ground cap. This is exactly what a player's sideways mouse swing does.
  const air: Brush[] = [];
  const sweepRateDeg = 90;
  for (const sweepSeconds of [1, 2, 3]) {
    let body = createBody({ x: 0, y: 1000, z: 0 }, 0, false);
    body.vel.z = 250;
    let yaw = 0;
    let peak = Math.hypot(body.vel.x, body.vel.z);
    const ticks = Math.round((sweepSeconds * 128) / 1);
    for (let i = 0; i < ticks; i++) {
      yaw += ((sweepRateDeg * Math.PI) / 180) * PHYSICS.stepSeconds;
      body.yaw = yaw;
      body = stepBody(body, command({ right: 1 }), air, PHYSICS, false).body;
      peak = Math.max(peak, Math.hypot(body.vel.x, body.vel.z));
    }
    // Speed must keep increasing with time — that is the unbounded gain.
    assert.ok(peak > 250 + sweepSeconds * 30, `${sweepSeconds}s sweep only reached ${peak}`);
  }
});

test('air wish never accelerates backwards along the wish direction', () => {
  const air: Brush[] = [];
  let body = createBody({ x: 0, y: 1000, z: 0 }, 0, false);
  body.vel.z = 500; // already faster than the 30 u/s wish cap along +Z
  let gain = 0;
  for (let i = 0; i < 10; i++) {
    const result = stepBody(body, command({ forward: 1 }), air, PHYSICS, false);
    body = result.body;
    gain += result.events.airGain;
  }
  assert.equal(gain, 0);
});

test('ground friction and acceleration cap speed at maxGroundSpeed', () => {
  let body = settle();
  for (let i = 0; i < 400; i++) {
    body = stepBody(body, command({ forward: 1 }), [FLOOR], PHYSICS, false).body;
  }
  const speed = Math.hypot(body.vel.x, body.vel.z);
  assert.ok(speed <= PHYSICS.maxGroundSpeed + 1e-9, `speed ${speed} exceeded ground cap`);
  assert.ok(speed > PHYSICS.maxGroundSpeed - 1, 'body should reach the ground cap');
});

test('stepBody never mutates its input body', () => {
  const original = settle();
  const snapshot = JSON.stringify(original);
  stepBody(original, command({ forward: 1, jumpPressed: true }), [FLOOR], PHYSICS, true);
  assert.equal(JSON.stringify(original), snapshot);
});

test('landing event fires exactly once on the tick the body touches down', () => {
  const body = createBody({ x: 0, y: 5, z: 0 }, 0, false);
  let landings = 0;
  let current = body;
  for (let i = 0; i < 200; i++) {
    const result = stepBody(current, IDLE_COMMAND, [FLOOR], PHYSICS, false);
    current = result.body;
    if (result.events.landed) landings++;
  }
  assert.equal(landings, 1);
});

test('walking off an edge makes the body airborne on that tick', () => {
  const small: Brush = makeBrush(0, 0, 0, 100, 100, 10, 'pad');
  let body = createBody({ x: 0, y: 0.02, z: 0 }, -Math.PI / 2, true); // facing +X
  body.vel.x = PHYSICS.maxGroundSpeed;
  let airborneAt = -1;
  for (let i = 0; i < 300; i++) {
    const result = stepBody(body, command({ forward: 1 }), [small], PHYSICS, false);
    body = result.body;
    if (!body.onGround) {
      airborneAt = i;
      break;
    }
  }
  assert.ok(airborneAt >= 0, 'body should have left the pad');
  // On the tick it leaves, it should not still be "grounded and supported".
  assert.equal(body.onGround, false);
});
