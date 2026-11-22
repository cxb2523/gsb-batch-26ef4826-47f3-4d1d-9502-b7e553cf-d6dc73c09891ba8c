// The cauldron's sustained voices must follow exactly one condition: the apprentice is at the pot
// and the world is not paused. Drives the real game (manual clock, dev/game.html) and checks:
//
//   1. entering the pot builds one voice per sounding part, matching the current state
//   2. suspending the world while brewing tears every cauldron voice down (no audible pot, no live
//      nodes); resuming rebuilds from the fire/stir that hold then, count matching the state (no
//      stale replay)
//   3. leaving the pot stops and disconnects everything
//   4. an entry requested before audio unlock is not lost and never doubled: after unlock there is
//      exactly one voice per state, even when unlock and entry happen back to back
//
//   node tools/brew-audio-check.mjs
//
// Exits 1 on any failed check or page error. The browser is launched muted; counts, not ears, decide.
import { startServer } from './dev-server.mjs';
import { launch } from './pw.mjs';

const { server, url } = await startServer(0);
const { browser, page, logs } = await launch({ width: 1280, height: 800 });

let passed = 0;
let failed = 0;
const failures = [];
function check(label, cond, note = '') {
  if (cond) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    failures.push(label + (note ? ' — ' + note : ''));
    console.log(`  FAIL ${label}${note ? ' — ' + note : ''}`);
  }
}
const ev = (fn, arg) => page.evaluate(fn, arg);
const step = (n, dt = 1 / 30) => ev(([k, d]) => window.TP.step(k, d), [n, dt]);
const wait = (ms) => page.waitForTimeout(ms);

// Everything handed to page.evaluate must be self-contained: it runs in the browser, where Node
// bindings do not exist. Each function below closes over nothing but its own argument and globals.
function bStatus() {
  const g = window.TP.game;
  const s = g.brewing.voiceStatus();
  return { mode: g.state.mode, ...s, audioPaused: g.audio.debug().paused };
}
function bTeleport() {
  const g = window.TP.game;
  const c = g.world.named.cauldron;
  g.player.teleport(c.x, c.y + 0.1, c.z + 2.2, 0, -0.3);
}
function bEnter() {
  window.TP.game.brewing.enter();
}
function bLeave() {
  window.TP.game.actions.brewLeave();
}
function bHeat(on) {
  const g = window.TP.game;
  g.brewing.autoStir = 0.9;
  g.actions.brewPump(!!on);
}
function bAddIngredient() {
  const g = window.TP.game;
  const id = Object.keys(g.data.INGREDIENTS)[0];
  g.state.inv.ingredients[id] = 5;
  g.actions.brewAdd(id);
}
function bReadout() {
  const b = window.TP.game.brew;
  return { fire: b.fire, heat: b.heat, stir: b.stir, contents: b.contents.length };
}
function bExpected() {
  const b = window.TP.game.brew;
  return (b.fire > 0.03 ? 1 : 0) + (b.contents.length > 0 && b.heat > 0.22 ? 1 : 0) + (b.stir > 0.06 ? 1 : 0);
}
function bBaseline() {
  const d = window.TP.game.audio.debug();
  return { loops: d.loops, handles: d.handles };
}
function bSettled() {
  const d = window.TP.game.audio.debug();
  return { loops: d.loops, handles: d.handles, dying: d.dying || 0, live: d.live };
}
function bUnlock() {
  return window.TP.game.audio.unlock();
}
function bUnlocked() {
  return window.TP.game.audio.unlocked;
}

async function enterBrew() {
  await ev(bTeleport);
  await step(10);
  await ev(bEnter);
  await step(30); // build + several loop-management ticks (manageLoops runs every 0.1 s)
  return ev(bStatus);
}
async function leaveBrew() {
  await ev(bLeave);
  await step(30);
  return ev(bStatus);
}
async function heatUp(frames = 240) {
  await ev(bHeat, true);
  await step(frames);
  await ev(bHeat, false);
  await step(10);
  return ev(bReadout);
}
async function startFresh() {
  await page.goto(`${url}/dev/game.html?still=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.TP && window.DONE, null, { timeout: 180000 });
  await ev(() => window.TP.play());
  await step(20);
}

try {
  // ===========================================================================================
  // Scenarios 1-3 run with an unlocked, running audio context (the normal in-game situation).
  await startFresh();
  await ev(bUnlock);
  await wait(500);
  await step(10);
  check('audio is unlocked and running', (await ev(bUnlocked)) === true);

  const baseline = await ev(bBaseline);
  console.log(`baseline engine loops=${baseline.loops} handles=${baseline.handles}`);

  // ===========================================================================================
  console.log('\n== 1. enter builds one voice per state, no duplicates ==');
  const s1 = await enterBrew();
  console.log('   ', JSON.stringify(s1));
  check('mode is brew', s1.mode === 'brew');
  check('sound gate is on while at the pot', s1.soundOn === true);
  check('no voice sounds before its state asks for one (cold, still pot)', s1.live === 0 && Object.values(s1.handles).every((v) => v === null), JSON.stringify(s1.handles));
  check('no voice is double-tracked: live equals the held handles', s1.live === Object.values(s1.handles).filter(Boolean).length);
  check('the cauldron created no engine loop before it is warranted', s1.engineLoops <= baseline.loops);

  await ev(bAddIngredient);
  await step(5);
  const heat = await heatUp(300);
  console.log('   heat', JSON.stringify(heat));
  const s1b = await ev(bStatus);
  console.log('   ', JSON.stringify(s1b));
  check('fire is burning', heat.fire > 0.03);
  check('heat is above the bubble threshold', heat.heat > 0.22, 'heat=' + heat.heat);
  check('stir is moving', heat.stir > 0.06, 'stir=' + heat.stir);
  check('all three cauldron voices exist', ['fire', 'bubble', 'stir'].every((k) => !!s1b.handles[k]), JSON.stringify(s1b.handles));
  check('all three voices are live (nodes sounding)', s1b.live === 3, 'live=' + s1b.live);
  check('still exactly one voice per part', s1b.live === Object.values(s1b.handles).filter(Boolean).length);

  // ===========================================================================================
  console.log('\n== 2. suspending while brewing silences the pot; resume rebuilds from current state ==');
  // The global lifecycle path the game uses for pause/book. setMode drives audio.setPaused and,
  // through it, Brewing.setPaused — the pot's frame is frozen while this mode holds.
  await ev(() => window.TP.game.setMode('pause'));
  await step(8);
  const paused = await ev(bStatus);
  console.log('   ', JSON.stringify(paused));
  check('suspended mode', paused.mode === 'pause');
  check('global audio reports paused', paused.audioPaused === true);
  check('the cauldron sound gate dropped', paused.soundOn === false);
  check('no cauldron handle remains held', Object.values(paused.handles).every((v) => v === null), JSON.stringify(paused.handles));
  check('no cauldron voice is live', paused.live === 0);
  check('engine loop count returned near baseline', paused.engineLoops <= baseline.loops + 1, 'loops=' + paused.engineLoops);

  // Resume: voices rebuilt to match the fire/stir state that holds now.
  await ev(() => window.TP.game.setMode('brew'));
  await step(30);
  const resumed = await ev(bStatus);
  const heat2 = await ev(bReadout);
  const expect2 = await ev(bExpected);
  console.log('   resumed', JSON.stringify(resumed), JSON.stringify(heat2));
  check('mode back to brew', resumed.mode === 'brew');
  check('global audio no longer paused', resumed.audioPaused === false);
  check('sound gate restored', resumed.soundOn === true);
  check('rebuilt voice count matches the current state (' + expect2 + ')', resumed.live === expect2, 'live=' + resumed.live);
  check('rebuilt voices are live nodes, one per part', resumed.live === Object.values(resumed.handles).filter(Boolean).length);

  // ===========================================================================================
  console.log('\n== 3. leaving the pot stops and disconnects everything ==');
  const s3 = await leaveBrew();
  console.log('   ', JSON.stringify(s3));
  check('mode back to play', s3.mode === 'play');
  check('brew is inactive', s3.active === false);
  check('sound gate off', s3.soundOn === false);
  check('every cauldron handle released', Object.values(s3.handles).every((v) => v === null), JSON.stringify(s3.handles));
  check('no cauldron voice live', s3.live === 0);
  await wait(1500); // let the short release fades finish
  await step(5);
  const settled = await ev(bSettled);
  console.log('   settled', JSON.stringify(settled));
  check('no lingering engine loop handles beyond baseline', settled.handles <= baseline.handles + 1, 'handles=' + settled.handles);
  check('release fades finished (nothing dying)', settled.dying === 0, 'dying=' + settled.dying);

  // ===========================================================================================
  console.log('\n== 4. a pre-unlock entry is kept and never doubled ==');
  await startFresh(); // fresh page: audio is locked again
  check('audio starts locked', (await ev(bUnlocked)) === false);

  // Enter and ask for heat BEFORE unlock. The requests must be held, not thrown away.
  await enterBrew();
  await ev(bAddIngredient);
  await ev(bHeat, true);
  await step(120);
  await ev(bHeat, false);
  const pre = await ev(() => ({ status: window.TP.game.brewing.voiceStatus(), brew: (function () { const b = window.TP.game.brew; return { fire: b.fire, heat: b.heat, stir: b.stir, contents: b.contents.length }; })() }));
  console.log('   pre-unlock', JSON.stringify(pre));
  check('cauldron holds its requests while locked', Object.values(pre.status.handles).filter(Boolean).length >= 1);
  check('nothing is live before unlock', pre.status.live === 0 && pre.status.engineLoops === 0);

  // Unlock immediately after the entry requests: the held controllers are realised once each.
  await ev(bUnlock);
  await step(40);
  await wait(600);
  const post = await ev(() => {
    const g = window.TP.game;
    const b = g.brew;
    const expect = (b.fire > 0.03 ? 1 : 0) + (b.contents.length > 0 && b.heat > 0.22 ? 1 : 0) + (b.stir > 0.06 ? 1 : 0);
    return { status: g.brewing.voiceStatus(), expect };
  });
  console.log('   post-unlock', JSON.stringify(post));
  check('audio is unlocked', (await ev(bUnlocked)) === true);
  check('exactly one live voice per state part after unlock', post.status.live === post.expect, 'live=' + post.status.live + ' expect=' + post.expect);
  check('held handles match the live voices (no shadow/duplicate)', post.status.live === Object.values(post.status.handles).filter(Boolean).length);
  check('no more than three cauldron voices can ever exist', Object.values(post.status.handles).filter(Boolean).length <= 3);

  // A leave then an immediate re-entry must still yield one voice per part (the double-stack case).
  await leaveBrew();
  await enterBrew();
  await ev(bAddIngredient);
  await ev(bHeat, true);
  await step(150);
  await ev(bHeat, false);
  await step(20);
  const reenter = await ev(() => {
    const st = window.TP.game.brewing.voiceStatus();
    const b = window.TP.game.brew;
    const expect = (b.fire > 0.03 ? 1 : 0) + (b.contents.length > 0 && b.heat > 0.22 ? 1 : 0) + (b.stir > 0.06 ? 1 : 0);
    return { live: st.live, held: Object.values(st.handles).filter(Boolean).length, expect };
  });
  console.log('   re-enter', JSON.stringify(reenter));
  check('re-entry still gives one voice per part', reenter.live === reenter.expect && reenter.held === reenter.expect, JSON.stringify(reenter));
} catch (e) {
  failed++;
  failures.push('scenario error: ' + (e && e.stack ? e.stack : e));
  console.log('FAILED:', e && e.stack ? e.stack : e);
} finally {
  const pageErrors = logs.filter((l) => /\[error\]|\[pageerror\]/.test(l));
  if (pageErrors.length) {
    failed++;
    failures.push('page errors: ' + pageErrors.slice(0, 5).join(' | '));
  }
  await browser.close();
  server.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('ALL CLEAR');
