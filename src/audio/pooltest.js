/**
 * Opponent voice-pool lifecycle verification.
 *
 * The engine voice pool is the one part of the audio system whose correctness is a *timeline*
 * property, not a spectrum: voices must be created, rebound, faded and released in step with car
 * changes, quality tiers and race phases. This file drives the real `AudioSystem` with a synthetic
 * but fully-featured `ctx` inside an OfflineAudioContext and asserts on the pool's own state and
 * on the rendered samples.
 *
 * It is loaded on demand by `src/audio/pooltest.mjs`; nothing in the game imports it.
 *
 * Scenarios, matching the acceptance criteria:
 *   A  normal driving — nearest opponents have voices, never more than the tier allows
 *   B  car swap       — every voice is rebuilt from the new car's definition
 *   C  quality drop   — surplus voices fade out, then their nodes are disconnected
 *   D  pause / resume — voices are silent while paused, and resume with no new/duplicate voices
 * plus a binding-stability check for the hysteresis that keeps the pool from thrashing.
 */
import { AudioSystem } from './AudioSystem.js';
import { CAR_DEFS } from '../vehicle/carDefs.js';
import { profileForCar } from './engineProfiles.js';

const SR = 48000;

/* ---------------------------------------------------------------- fixtures */

/** A CarInstance stand-in with only the fields the audio lane reads. */
function fakeCar(def, x, z, o = {}) {
  const car = {
    id: def.id,
    def,
    isPlayer: !!o.isPlayer,
    state: {
      position: { x, y: o.y ?? 0, z },
      velocity: { x: 0, y: 0, z: o.vz ?? 0 },
      rpm: o.rpm ?? 4200,
      gear: 3,
      engineLoad: 0.85,
      throttle: 1,
      brake: 0,
      speed: o.speed ?? 40,
      speedKmh: (o.speed ?? 40) * 3.6,
      nosActive: false,
      wheels: [],
    },
  };
  for (let i = 0; i < 4; i++) {
    car.state.wheels.push({
      contact: true,
      surface: 'asphalt',
      slipRatio: 0,
      slipAngle: 0,
      slipSpeed: 0,
      load: 3600,
      lockedUp: false,
    });
  }
  return car;
}

/** A bus, settings and car list — enough of `ctx` for AudioSystem. */
function fakeCtx(player) {
  const handlers = new Map();
  const bus = {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(fn);
      return () => handlers.get(name)?.delete(fn);
    },
    emit(name, payload) {
      for (const fn of handlers.get(name) ?? []) fn(payload);
    },
  };
  const cars = { player, instances: [player], defs: CAR_DEFS };
  return {
    bus,
    cars,
    player,
    settings: { tier: 'high' },
    race: { phase: 'racing', paused: false },
    hud: { screen: 'race' },
    camera: null,
    audio: null,
    /** Swap which car is in the player's seat, as CarSystem.swapPlayer does. */
    swapTo(newCar) {
      const i = cars.instances.indexOf(cars.player);
      cars.instances[i] = newCar;
      cars.player = newCar;
      this.player = newCar;
      bus.emit('car:change', { car: newCar, previous: player, def: newCar.def });
    },
  };
}

const defOf = (id) => CAR_DEFS.find((d) => d.id === id);

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail });
  return pass;
}

/** Create a context sized for `seconds` and build the system into it. */
function makeSized(seconds, tier = 'high', playerDefId = 'apex-gt') {
  const player = fakeCar(defOf(playerDefId), 0, 0, { isPlayer: true });
  const ctx = fakeCtx(player);
  const ac = new OfflineAudioContext(2, Math.ceil(SR * seconds), SR);
  const audio = new AudioSystem(ctx);
  ctx.audio = audio;
  audio.attachContext(ac, { tier, def: player.def, music: false });
  return { ctx, audio, ac, player };
}

/** Add `n` opponent cars at increasing distance from the origin. */
function addPack(ctx, n, startX = 6, step = 5) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const car = fakeCar(CAR_DEFS[(i + 1) % CAR_DEFS.length], startX + i * step, 0);
    ctx.cars.instances.push(car);
    out.push(car);
  }
  return out;
}

/* --------------------------------------------------------------- rendering */

/**
 * Drive an AudioSystem for `seconds`, calling `at(t, i)` once per simulated 1/60 s frame so a
 * test can mutate the world at exact times. `offlineTime` is set before every update, which makes
 * every scheduled ramp deterministic. When the race is paused the frame loop's paused branch is
 * exercised (`updatePaused`), exactly as main.js does.
 */
async function run(audio, ctx, seconds, at) {
  const dt = 1 / 60;
  const n = Math.ceil(seconds / dt);
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    audio.offlineTime = t;
    at?.(t, i);
    if (ctx.race.paused) audio.updatePaused(dt, ctx);
    else audio.update(dt, ctx);
  }
  const buf = await audio.ac.startRendering();
  audio.flushRetired();
  return buf;
}

/** RMS of a stereo buffer between two times, summed to mono. */
function rmsBetween(buf, t0, t1) {
  const a = Math.max(0, Math.floor(t0 * SR));
  const b = Math.min(buf.length, Math.floor(t1 * SR));
  if (b <= a) return 0;
  const L = buf.getChannelData(0);
  const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  let sum = 0;
  for (let i = a; i < b; i++) {
    const m = (L[i] + R[i]) * 0.5;
    sum += m * m;
  }
  return Math.sqrt(sum / (b - a));
}

const boundCars = (audio) => audio._opponentSlots.map((s) => s.car).filter(Boolean);

/* ------------------------------------------------------------ A: driving */

async function testNearestOpponents() {
  const { ctx, audio } = makeSized(2.0, 'high');
  const pack = addPack(ctx, 6, 8, 30); // 8, 38, 68, 98, 128, 158 m
  await run(audio, ctx, 2.0);

  const bound = boundCars(audio);
  const set = new Set(bound);
  check(
    'driving: pool fills up to the tier limit',
    bound.length === 4,
    `${bound.length} bound of ${audio._opponentSlots.length} slots at high`
  );
  check(
    'driving: the voices are the four nearest opponents',
    pack.slice(0, 4).every((c) => set.has(c)),
    bound.map((c) => c.def.id).join(',')
  );
  check(
    'driving: no voice is spent on a distant car',
    pack.slice(4).every((c) => !set.has(c)),
    'nearest-only'
  );
  check(
    'driving: voice count never exceeds the tier limit',
    audio.stats.voices <= 1 + 4 + 0,
    `${audio.stats.voices} voices total`
  );
  return { bound: bound.length };
}

async function testDrivingAudible() {
  const seconds = 2.6;
  const place = (ctx) => addPack(ctx, 4, 7, 12);
  const { ctx, audio } = makeSized(seconds, 'high');
  place(ctx);
  const withPack = await run(audio, ctx, seconds);

  const { ctx: ctx0, audio: audio0 } = makeSized(seconds, 'high');
  place(ctx0);
  audio0._forceMute = true;
  const withoutPack = await run(audio0, ctx0, seconds);

  const loud = rmsBetween(withPack, 1.4, 2.5);
  const quiet = rmsBetween(withoutPack, 1.4, 2.5);
  check(
    'driving: the nearest opponents add audible engine sound',
    loud > quiet * 1.05,
    `rms with pack ${loud.toFixed(4)} vs pack muted ${quiet.toFixed(4)}`
  );
}

/* ----------------------------------------------------------- B: car swap */

async function testCarSwap() {
  const seconds = 2.6;
  const { ctx, audio } = makeSized(seconds, 'high', 'apex-gt');
  const pack = addPack(ctx, 3, 8, 10);

  const before = new Set();
  await run(audio, ctx, seconds, (t) => {
    if (before.size === 0 && t >= 0.9) {
      for (const s of audio._opponentSlots) if (s.voice) before.add(s.voice);
      ctx.swapTo(fakeCar(defOf('volt'), 0, 0, { isPlayer: true }));
    }
  });

  check('car swap: voices existed before the swap', before.size === 3, `${before.size} voices pre-swap`);

  const after = audio._opponentSlots.filter((s) => s.voice).map((s) => s.voice);
  check(
    'car swap: every bound voice was replaced',
    after.length > 0 && after.every((v) => !before.has(v)),
    `${after.length} voices after swap, none reused`
  );
  check(
    'car swap: no disposed voice is left bound to a slot',
    after.every((v) => !v.disposed),
    'all live voices undisposed'
  );
  check(
    'car swap: player engine rebuilt from the new definition',
    audio.engine?.def?.id === 'volt',
    `engine def = ${audio.engine?.def?.id}`
  );
  check(
    'car swap: player profile follows the new car',
    audio.engine && profileForCar(audio.engine.def) === profileForCar(defOf('volt')),
    `profile = ${audio.stats.profile}`
  );
  const defs = audio._opponentSlots.filter((s) => s.car && s.voice).map((s) => s.voice.def.id);
  check(
    'car swap: rebound voices use each opponent car def',
    defs.length === 3 && defs.every((id, i) => id === pack[i].def.id),
    defs.join(',')
  );
}

/* ------------------------------------------------------- C: quality drop */

async function testQualityShrink() {
  const seconds = 3.2;
  const { ctx, audio } = makeSized(seconds, 'ultra');
  addPack(ctx, 6, 6, 5);

  let surplus = [];
  const packed = await run(audio, ctx, seconds, (t) => {
    if (t >= 1.4 && t < 1.4 + 1 / 60) {
      surplus = audio._opponentSlots.map((s) => s.voice).filter(Boolean);
      audio.onQuality('medium'); // 5 slots -> 2
    }
  });

  check(
    'quality drop: pool shrinks to the new tier count',
    audio._opponentSlots.length === 2,
    `${audio._opponentSlots.length} slots after dropping to medium`
  );
  const live = audio._opponentSlots.filter((s) => s.voice).length;
  check(
    'quality drop: no surplus voice survives in the pool',
    live <= 2,
    `${live} voices for 2 slots`
  );
  check(
    'quality drop: retired voices were torn down',
    audio._retiring.length === 0 && audio._reaped.length === 0,
    `${audio._retiring.length} retiring / ${audio._reaped.length} reaped left`
  );

  const dropped = surplus.filter((v) => !audio._opponentSlots.some((s) => s.voice === v));
  check(
    'quality drop: the three dropped voices were released',
    dropped.length === 3,
    `${dropped.length} voices dropped (5 -> 2)`
  );
  check(
    'quality drop: released voices were faded before teardown (silent, not cut)',
    dropped.every((v) => v._released === true && v.loudness === 0),
    'released + loudness 0'
  );
  check(
    'quality drop: released voices are disconnected and disposed',
    dropped.every((v) => v.connected === false && v.disposed === true),
    dropped.map((v) => `${v.connected ? 'connected' : 'cut'}/${v.disposed ? 'freed' : 'live'}`).join(',')
  );
  check(
    'quality drop: live voices stay connected',
    audio._opponentSlots.filter((s) => s.voice).every((s) => s.voice.connected === true),
    'bound voices connected'
  );

  const loud = rmsBetween(packed, 0.8, 1.3);
  const quiet = rmsBetween(packed, 2.6, 3.1);
  check(
    'quality drop: the mix gets quieter once the surplus voices go',
    quiet < loud * 0.99,
    `rms ${loud.toFixed(4)} → ${quiet.toFixed(4)}`
  );
  return { loud, quiet };
}

async function testQualityGrow() {
  const seconds = 1.6;
  const { ctx, audio } = makeSized(seconds, 'low');
  addPack(ctx, 5, 6, 5);
  check('quality rise: low tier starts with no opponent slots', audio._opponentSlots.length === 0, '0 slots');

  // Record the output gain of every voice at the instant it is constructed. A voice that starts
  // audible would click on the frame the pool expands.
  const initialGains = [];
  const origMake = audio._makeOpponentVoice.bind(audio);
  audio._makeOpponentVoice = (def, t) => {
    const v = origMake(def, t);
    initialGains.push(v.out.gain.value);
    return v;
  };

  await run(audio, ctx, seconds, (t) => {
    if (t >= 0.5 && t < 0.5 + 1 / 60) audio.onQuality('high'); // 0 -> 4
  });
  audio._makeOpponentVoice = origMake;

  check(
    'quality rise: pool grows to the new tier count',
    audio._opponentSlots.length === 4,
    `${audio._opponentSlots.length} slots at high`
  );
  check(
    'quality rise: new voices are created silent',
    initialGains.length === 4 && initialGains.every((g) => g === 0),
    `${initialGains.length} voices, initial gains ${JSON.stringify(initialGains)}`
  );
  check(
    'quality rise: new voices are only created for cars that need one',
    audio._opponentSlots.filter((s) => s.car).length === 4 &&
      audio._opponentSlots.filter((s) => s.voice).length === 4,
    `${audio._opponentSlots.filter((s) => s.car).length} bound / ${audio._opponentSlots.filter((s) => s.voice).length} voiced`
  );
}

/* ------------------------------------------------------ D: pause / resume */

async function testPauseResume() {
  const seconds = 4.0;
  const { ctx, audio } = makeSized(seconds, 'high');
  addPack(ctx, 4, 7, 6);

  let pausedVoices = null;
  let resumeVoices = null;
  const buf = await run(audio, ctx, seconds, (t) => {
    if (t >= 1.2 && t < 1.2 + 1 / 60) {
      ctx.race.paused = true;
      pausedVoices = audio._opponentSlots.filter((s) => s.voice).map((s) => s.voice);
    }
    if (t >= 2.2 && t < 2.2 + 1 / 60) {
      ctx.race.paused = false;
      audio._rebindCooldown = 0;
      resumeVoices = audio._opponentSlots.filter((s) => s.voice).map((s) => s.voice);
    }
  });

  const pausedRms = rmsBetween(buf, 1.5, 2.1);
  const drivingRms = rmsBetween(buf, 2.6, 3.4);
  check(
    'pause: the pack falls silent while paused',
    pausedRms < drivingRms * 0.35,
    `rms paused ${pausedRms.toFixed(4)} vs driving ${drivingRms.toFixed(4)}`
  );
  check(
    'pause: bindings are retained (voices are not destroyed)',
    pausedVoices.length === 4 && resumeVoices.length === 4,
    `${pausedVoices.length} voices held through the pause`
  );
  check(
    'resume: the same voice objects are reused, not recreated',
    resumeVoices.every((v, i) => v === pausedVoices[i]),
    'object identity preserved'
  );

  const carsBound = boundCars(audio);
  const unique = new Set(carsBound);
  check(
    'resume: no duplicate voice for the same car',
    unique.size === carsBound.length,
    `${carsBound.length} bound cars, ${unique.size} unique`
  );
  check(
    'resume: voice count does not grow across a pause',
    audio._opponentSlots.filter((s) => s.voice).length === 4 && audio.stats.voices === 5,
    `${audio._opponentSlots.filter((s) => s.voice).length} voices, stats.voices=${audio.stats.voices}`
  );
  return { pausedRms, drivingRms };
}

async function testPauseKeepsNearest() {
  // A pause must not let a rebind happen against frozen positions (which would churn the pool
  // on every frame of the freeze) and must not change who is bound.
  const seconds = 2.4;
  const { ctx, audio } = makeSized(seconds, 'high');
  addPack(ctx, 4, 7, 6);
  let boundAtPause = null;
  await run(audio, ctx, seconds, (t) => {
    if (t >= 0.8 && t < 0.8 + 1 / 60) {
      boundAtPause = boundCars(audio).slice();
      ctx.race.paused = true;
    }
    if (t >= 1.8 && t < 1.8 + 1 / 60) ctx.race.paused = false;
  });
  const after = boundCars(audio);
  check(
    'pause: the same cars stay bound across the freeze',
    boundAtPause && after.length === boundAtPause.length && after.every((c, i) => c === boundAtPause[i]),
    boundAtPause ? after.map((c) => c.def.id).join(',') : 'no binding'
  );
}

/* -------------------------------------------------- E: hysteresis stability */

async function testHysteresis() {
  const seconds = 3.0;
  const { ctx, audio } = makeSized(seconds, 'high');
  const a = fakeCar(defOf('nocturne'), 10, 0);
  const b = fakeCar(defOf('vantablack'), 10.4, 0);
  ctx.cars.instances.push(a, b);

  let leadChanges = 0;
  let lastLead = null;
  await run(audio, ctx, seconds, (t, i) => {
    const wob = Math.sin(i * 0.12) * 0.5;
    a.state.position.x = 10 + wob;
    b.state.position.x = 10 - wob;
    const lead = a.state.position.x < b.state.position.x ? a : b;
    if (lastLead && lead !== lastLead) leadChanges++;
    lastLead = lead;
  });

  const bound = boundCars(audio);
  check(
    'hysteresis: a marginal lead swap does not duplicate a voice',
    new Set(bound).size === bound.length,
    bound.map((c) => c.def.id).join(',')
  );
  check(
    'hysteresis: the physical lead really did swap underneath',
    leadChanges >= 2,
    `${leadChanges} lead changes`
  );

  // Decisive approach: a car that was out of the pool races past the farthest bound car.
  const { ctx: ctx2, audio: audio2 } = makeSized(2.0, 'high');
  const pool = addPack(ctx2, 4, 6, 4); // 6, 10, 14, 18 m -> all bound
  const late = fakeCar(defOf('zenith'), 200, 0);
  ctx2.cars.instances.push(late);
  await run(audio2, ctx2, 2.0, (t, i) => {
    if (i > 20) late.state.position.x = Math.max(2, 200 - (i - 20) * 4);
  });
  check(
    'hysteresis: a decisive approach does rebind to the closer car',
    boundCars(audio2).includes(late),
    boundCars(audio2).map((c) => c.def.id).join(',')
  );
  void pool;
}

/* ------------------------------------------------------------- entry point */

export async function runPoolSelfTest() {
  results.length = 0;
  const report = { sampleRate: SR };

  report.driving = await testNearestOpponents();
  await testDrivingAudible();
  await testCarSwap();
  report.qualityShrink = await testQualityShrink();
  await testQualityGrow();
  report.pause = await testPauseResume();
  await testPauseKeepsNearest();
  await testHysteresis();

  report.checks = results.map((r) => ({ ...r }));
  report.passed = results.filter((r) => r.pass).length;
  report.failed = results.filter((r) => !r.pass).length;
  return report;
}

if (typeof window !== 'undefined') window.__NFT_POOL_TEST = runPoolSelfTest;
