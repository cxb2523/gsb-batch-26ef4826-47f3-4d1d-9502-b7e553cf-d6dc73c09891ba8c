// Headless integration tests: run the full PlayerController pipeline against
// a tiny brush world and assert emergent CS:GO behaviors (landing, ground
// speed cap, autobhop air-strafe gain, the vanilla no-pogo rule), plus the
// ramp-base regression that doesn't map to a single behavior folder.

import { describe, expect, it } from 'vitest';
import { vec3 } from '../math/vec3';
import { World } from '../physics/World/World';
import { brushFromAABB, brushFromOrientedBox } from '../physics/Collision/Collision';
import type { LadderVolume } from '../physics/Collision/Collision.types';
import { PlayerController } from './PlayerController';
import { DEFAULT_SETTINGS } from '../settings/Settings';
import type { Settings } from '../settings/Settings';

const DT = 1 / 128;

function makeWorld(): World {
  const world = new World();
  world.solids.push(brushFromAABB(vec3(-8192, -64, -8192), vec3(8192, 0, 8192)));
  return world;
}

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...structuredClone(DEFAULT_SETTINGS), ...overrides };
}

function run(player: PlayerController, ticks: number, perTick?: () => void): void {
  for (let i = 0; i < ticks; i++) {
    perTick?.();
    player.tick(DT);
  }
}

describe('PlayerController', () => {
  it('falls, lands, and comes to rest on the floor', () => {
    const player = new PlayerController(makeWorld(), makeSettings(), vec3(0, 100, 0));
    run(player, 256);
    expect(player.onGround).toBe(true);
    expect(player.origin.y).toBeLessThan(0.1);
    expect(player.horizontalSpeed).toBe(0);
  });

  it('caps ground speed at runSpeed', () => {
    const player = new PlayerController(makeWorld(), makeSettings(), vec3(0, 5, 0));
    player.input.forward = true;
    run(player, 512); // 4 seconds
    expect(player.horizontalSpeed).toBeGreaterThan(245);
    expect(player.horizontalSpeed).toBeLessThanOrEqual(250.001);
  });

  it('walk and crouch use their flat speed values', () => {
    const walker = new PlayerController(makeWorld(), makeSettings(), vec3(0, 5, 0));
    walker.input.forward = true;
    walker.input.walk = true;
    run(walker, 512);
    expect(walker.horizontalSpeed).toBeCloseTo(130, 0);

    const croucher = new PlayerController(makeWorld(), makeSettings(), vec3(0, 5, 0));
    croucher.input.forward = true;
    croucher.input.duck = true;
    run(croucher, 512);
    expect(croucher.ducked).toBe(true);
    expect(croucher.horizontalSpeed).toBeCloseTo(85, 0);
  });

  it('bhop speed clamp holds autobhop cruising speed near 1.1 × maxspeed', () => {
    // noPrestrafe is exercised separately (AirMove.test.ts); disabled here so
    // this test isolates bhopSpeedClamp's own takeoff-clamp + air-strafe
    // interaction, same as before that setting existed.
    const player = new PlayerController(makeWorld(), makeSettings({ noPrestrafe: false }), vec3(0, 5, 0));
    player.input.forward = true;
    run(player, 128);
    player.input.forward = false;
    player.input.right = true;
    player.input.jump = true;
    let peak = 0;
    run(player, 1024, () => {
      player.yaw -= 0.8; // steady air-strafe turn
      peak = Math.max(peak, player.horizontalSpeed);
    });
    // Takeoffs clamp to 275; only modest in-air gain on top of that is
    // possible before the next landing re-clamps.
    expect(peak).toBeGreaterThan(250);
    expect(peak).toBeLessThan(340);
  });

  it('gains speed without bound when the clamp is disabled', () => {
    const player = new PlayerController(
      makeWorld(),
      makeSettings({ bhopSpeedClamp: false, noPrestrafe: false }),
      vec3(0, 5, 0),
    );
    player.input.forward = true;
    run(player, 128);
    player.input.forward = false;
    player.input.right = true;
    player.input.jump = true;
    run(player, 512, () => {
      player.yaw -= 0.8;
    });
    expect(player.horizontalSpeed).toBeGreaterThan(300);
  });

  it('does not pogo when autobhop is off and jump is held', () => {
    const player = new PlayerController(makeWorld(), makeSettings({ autobhop: false }), vec3(0, 5, 0));
    run(player, 64); // settle on the ground
    player.input.jump = true;
    run(player, 128); // first press jumps...
    run(player, 256); // ...but by now we've landed again, still holding jump
    expect(player.onGround).toBe(true);
    expect(player.velocity.y).toBe(0);
  });

  it('jump reaches ~57 units above the floor', () => {
    const player = new PlayerController(makeWorld(), makeSettings(), vec3(0, 5, 0));
    run(player, 64);
    player.input.jump = true;
    let apex = 0;
    run(player, 200, () => {
      apex = Math.max(apex, player.origin.y);
    });
    expect(apex).toBeGreaterThan(55.5);
    expect(apex).toBeLessThan(58);
  });
});

// Ramp-base regression, from a live bug report: standing at (-1680, 10, -783)
// — the base of the west wall-ride — the player froze on the ramp's
// hull-expanded face with velocity climbing (the femto-fraction trace bug).
// With that fixed, the base must behave like authentic Source: at worst a
// brief ungrounded slide off the expanded face, resolving to rest on the
// floor — never a runaway.
describe('ramp base', () => {
  /** West wall-ride: ramp(-1663, 0, 270, 52, 2800, 300), sink 32 — no curb. */
  function westRingWorld(): World {
    const world = new World();
    world.solids.push(brushFromAABB(vec3(-2048, -64, -2048), vec3(2048, 0, 2048))); // ground
    world.solids.push(brushFromAABB(vec3(-2112, 0, -2048), vec3(-2048, 512, 2048))); // wall

    const tilt = (52 * Math.PI) / 180;
    const ax = vec3(0, 0, 1);
    const ay = vec3(Math.sin(tilt), Math.cos(tilt), 0);
    const az = vec3(-Math.cos(tilt), Math.sin(tilt), 0);
    const L = 300;
    const foot = vec3(-1663, -32, 0);
    const center = vec3(
      foot.x + az.x * (L / 2) - ay.x * 8,
      foot.y + az.y * (L / 2) - ay.y * 8,
      foot.z + az.z * (L / 2) - ay.z * 8,
    );
    world.solids.push(brushFromOrientedBox(center, vec3(1400, 8, L / 2), ax, ay, az));
    return world;
  }

  it('resolves the reported phantom-hover spot to grounded control', () => {
    const world = westRingWorld();
    const player = new PlayerController(world, structuredClone(DEFAULT_SETTINGS), vec3(-1680, 10, -783));

    let peak = 0;
    for (let i = 0; i < 512; i++) {
      player.tick(DT);
      peak = Math.max(peak, Math.hypot(player.velocity.x, player.velocity.y, player.velocity.z));
    }
    // No runaway: with no input, the player comes to rest on solid ground.
    expect(peak).toBeLessThan(300);
    expect(player.onGround).toBe(true);
    expect(player.horizontalSpeed).toBeLessThan(5);
    expect(world.isPositionFree(player.origin, player.mins, player.maxs)).toBe(true);
  });

  it('pressing into the base surfs the face with bounded speed, then settles', () => {
    const world = westRingWorld();
    const player = new PlayerController(world, structuredClone(DEFAULT_SETTINGS), vec3(-1600, 2, -783));
    player.yaw = 90; // face -x, toward the ramp
    player.input.forward = true;

    // Holding into a surf face pins you on it (that's how surfing works) —
    // the invariant is that speed stays bounded, never a runaway.
    for (let i = 0; i < 256; i++) {
      player.tick(DT);
      expect(Math.hypot(player.velocity.x, player.velocity.y, player.velocity.z)).toBeLessThan(500);
    }

    // Release: slide off, land, and come to rest under friction.
    player.input.forward = false;
    for (let i = 0; i < 384; i++) player.tick(DT);
    expect(player.onGround).toBe(true);
    expect(player.horizontalSpeed).toBeLessThan(100);
  });
});

// Lifecycle boundaries: respawn() and teleport() must cut every piece of
// per-life state so the new position's first tick starts clean, while the
// physics of ordinary, consecutive ticks stay exactly as before.
describe('lifecycle: respawn / teleport', () => {
  /** Wall at x 100 with a west-facing ladder volume in front of it. */
  function ladderWorld(): World {
    const world = makeWorld();
    world.solids.push(brushFromAABB(vec3(100, 0, -200), vec3(164, 600, 200))); // wall
    const volume: LadderVolume = {
      ...brushFromAABB(vec3(60, 0, -24), vec3(100, 600, 24)),
      facing: vec3(-1, 0, 0),
    };
    world.ladders.push(volume);
    return world;
  }

  it('respawn drops the previous life\'s landing impact and perfect-hop carry', () => {
    const settings = makeSettings({ autobhop: false, viewPunch: true });
    settings.perf.enabled = true;
    const player = new PlayerController(makeWorld(), settings, vec3(0, 5, 0));

    // First life: a hard fall produces a real landing view punch.
    player.origin.y = 2000;
    run(player, 300);
    expect(player.onGround).toBe(true);
    expect(player.landPunch).toBeGreaterThan(0); // the previous life did land hard

    // Build a real jump chain so the perfect-bhop bookkeeping is live.
    run(player, 32);
    player.input.jump = true;
    player.tick(DT); // takeoff — hasJumpedBefore flips, lastHopQuality is set
    player.input.jump = false;
    expect(player.hasJumpedBefore).toBe(true);
    expect(player.lastHopQuality).not.toBeNull();

    // Respawn: the impact and every hop bookkeeping field vanish.
    player.respawn();
    expect(player.landPunch).toBe(0);
    expect(player.fallVelocity).toBe(0);
    expect(player.hasJumpedBefore).toBe(false);
    expect(player.lastHopQuality).toBeNull();
    expect(player.groundTicksSinceLanding).toBe(0);
    expect(player.landingVelocity.x).toBe(0);
    expect(player.landingVelocity.y).toBe(0);
    expect(player.landingVelocity.z).toBe(0);
    expect(player.velocity.x).toBe(0);
    expect(player.velocity.y).toBe(0);
    expect(player.velocity.z).toBe(0);

    // A short drop from the spawn can't re-trigger the previous life's
    // impact: the fall never reaches the punch threshold and landPunch
    // stays zero through the landing itself.
    run(player, 128);
    expect(player.onGround).toBe(true);
    expect(player.landPunch).toBe(0);

    // The first real jump of the new life has no earlier jump to chain from,
    // so it can never score a perfect carry — only an ordinary hop.
    run(player, 32);
    player.input.jump = true;
    player.tick(DT);
    expect(player.lastHopQuality).toBe('normal');
  });

  it('respawn zeroes stamina and the first tick cannot recover the old value', () => {
    const settings = makeSettings();
    settings.stamina.enabled = true;
    const player = new PlayerController(makeWorld(), settings, vec3(0, 5, 0));

    // First life: land hard to load stamina up against the pool max.
    player.origin.y = 2000;
    run(player, 300);
    expect(player.stamina).toBeGreaterThan(0); // fatigue really did accumulate

    player.respawn();
    expect(player.stamina).toBe(0);

    // Recovery drains toward zero — from zero it must stay zero, so the very
    // first tick of the new life can't smuggle the previous life's fatigue
    // back in. (Checked on tick one; later grounded ticks can legitimately
    // accrue fresh stamina from jumps of the new life.)
    player.tick(DT);
    expect(player.stamina).toBe(0);
  });

  it('teleport clears ladder cooldown and stuck/blocked counters and pins the snapshots', () => {
    const player = new PlayerController(ladderWorld(), makeSettings(), vec3(70, 5, 0));
    player.yaw = -90; // face +x, into the ladder
    player.input.forward = true;
    for (let i = 0; i < 64 && player.onLadder === null; i++) player.tick(DT);
    expect(player.onLadder).not.toBeNull();

    // Jump off the ladder: jump is ignored for the 0.2s grab grace period,
    // then the jump-off arms the re-grip cooldown.
    player.input.forward = false;
    player.input.jump = true;
    let ticks = 0;
    while (player.onLadder !== null && ticks < 64) {
      player.tick(DT);
      ticks++;
    }
    player.input.jump = false;
    expect(player.onLadder).toBeNull();
    expect(player.ladderCooldown).toBeGreaterThan(0);

    // Wedge counters from the previous life (set directly, as a host-side
    // anomaly detector might find them).
    player.stuckTicks = 7;
    player.blockedTicks = 2;
    player.contactsThisTick.push(vec3(0, 1, 0), 0.5);
    expect(player.contactsThisTick.count).toBe(1);

    const dest = vec3(0, 50, 0);
    player.teleport(dest);

    // Ladder and stuck bookkeeping all return to initial semantics.
    expect(player.ladderCooldown).toBe(0);
    expect(player.ladderJumpAllowedAt).toBe(0);
    expect(player.onLadder).toBeNull();
    expect(player.stuckTicks).toBe(0);
    expect(player.blockedTicks).toBe(0);
    expect(player.contactsThisTick.count).toBe(0);

    // The live position and every interpolation snapshot match the new
    // landing point, so no render lerp can pull the player back.
    expect(player.origin).toEqual(dest);
    expect(player.prevPos).toEqual(dest);
    expect(player.currPos).toEqual(dest);
    const eye = player.eyeHeight;
    expect(player.prevEye).toBe(eye);
    expect(player.currEye).toBe(eye);
    expect(player.velocity.x).toBe(0);
    expect(player.velocity.y).toBe(0);
    expect(player.velocity.z).toBe(0);
    expect(player.time).toBe(0);
  });

  it('teleport leaves the spawn point untouched, so respawn() still goes home', () => {
    const spawn = vec3(42, 5, -17);
    const player = new PlayerController(makeWorld(), makeSettings(), spawn);
    run(player, 32);

    player.teleport(vec3(-300, 200, 300));
    expect(player.origin).toEqual(vec3(-300, 200, 300));
    player.respawn();
    expect(player.origin).toEqual(spawn);
    expect(player.prevPos).toEqual(spawn);
    expect(player.currPos).toEqual(spawn);
  });

  it('handles input.reset inside the same tick before any state is read', () => {
    const spawn = vec3(0, 5, 0);
    const player = new PlayerController(makeWorld(), makeSettings(), spawn);

    // Put the player somewhere else with real velocity and a history.
    player.origin.y = 500;
    player.prevPos.y = 499;
    player.currPos.y = 500;
    player.velocity.x = 400;
    player.velocity.y = -200;
    run(player, 24);
    expect(player.tickHistoryText().split('\n')).toHaveLength(24);

    // Reset and tick in the same tick. jump is held too: the respawn must
    // take precedence — no jump launch on the fresh life.
    player.input.reset = true;
    player.input.jump = true;
    player.tick(DT);

    expect(player.input.reset).toBe(false);
    expect(player.origin.x).toBeCloseTo(spawn.x, 6);
    expect(player.origin.z).toBeCloseTo(spawn.z, 6);
    // Only the first half-tick of gravity acts on a stationary spawn; a jump
    // would instead put a large POSITIVE vertical velocity here.
    expect(player.velocity.y).toBeLessThan(0);
    expect(player.velocity.y).toBeGreaterThan(-10);
    expect(player.horizontalSpeed).toBe(0);

    // The snapshot taken at tick start already reflects the new origin...
    expect(player.prevPos).toEqual(spawn);
    expect(player.currPos.x).toBeCloseTo(spawn.x, 6);
    expect(player.currPos.z).toBeCloseTo(spawn.z, 6);

    // ...and the single history entry recorded by this tick is tick 0 at the
    // spawn, with no entries surviving from the previous life.
    const lines = player.tickHistoryText().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith('0 p ')).toBe(true);
    const recorded = lines[0].split(' v ')[0].replace('0 p ', '').split(',').map(Number);
    expect(recorded[0]).toBeCloseTo(spawn.x, 1);
    expect(recorded[1]).toBeCloseTo(spawn.y, 1);
    expect(recorded[2]).toBeCloseTo(spawn.z, 1);
  });

  it('two teleports in a row never accumulate velocity from the previous life', () => {
    const player = new PlayerController(makeWorld(), makeSettings(), vec3(0, 5, 0));
    player.input.forward = true;
    run(player, 256);
    const firstSpeed = player.horizontalSpeed;
    expect(firstSpeed).toBeGreaterThan(200); // genuinely moving before the cut
    player.input.forward = false; // held movement intent is not part of the cut

    const first = vec3(100, 80, 100);
    player.teleport(first);
    expect(player.horizontalSpeed).toBe(0);
    expect(player.origin).toEqual(first);
    expect(player.prevPos).toEqual(first);
    expect(player.currPos).toEqual(first);

    // No tick in between: the second teleport starts from the clean state of
    // the first and must not revive the pre-teleport run speed.
    const second = vec3(-250, 160, -250);
    player.teleport(second);
    expect(player.velocity.x).toBe(0);
    expect(player.velocity.y).toBe(0);
    expect(player.velocity.z).toBe(0);
    expect(player.horizontalSpeed).toBe(0);
    expect(player.origin).toEqual(second);
    expect(player.prevPos).toEqual(second);
    expect(player.currPos).toEqual(second);

    // The new life then integrates from rest: gravity alone, no carried run.
    player.tick(DT);
    expect(player.horizontalSpeed).toBe(0);
    expect(player.velocity.y).toBeLessThan(0);
    expect(player.origin.x).toBeCloseTo(second.x, 6);
    expect(player.origin.z).toBeCloseTo(second.z, 6);
  });
});
