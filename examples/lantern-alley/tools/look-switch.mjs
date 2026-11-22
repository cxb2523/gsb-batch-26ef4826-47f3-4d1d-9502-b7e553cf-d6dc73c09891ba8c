// Verifies the greybox <-> models look switch in a real browser:
//   1. normal switch: combat state (hp, combo, attack, hitstop, invuln, knockback, attack
//      turn, wave/queue) is identical before and after each switch; grounding, facing and
//      size stay correct; GPU geometry/texture counts do not grow over repeated switches
//   2. load failure: a missing GLB falls back to greybox for that character/prop only,
//      with a visible notice; already-tried files are never requested again
//   3. rapid clicks: with the load artificially slowed, bursts of clicks always settle on
//      the look of the last click, and every GLB is requested exactly once
// Test GLBs (plain boxes) are generated into public/assets for the run and removed after;
// real Tripo GLBs already there are used as-is and never touched.
// Usage: node tools/look-switch.mjs
import { spawn, execSync } from 'node:child_process';
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { Document, NodeIO } from '@gltf-transform/core';

const PORT = 4266, ORIGIN = `http://localhost:${PORT}`;
const ASSETS = new URL('../public/assets/', import.meta.url);
const IDS = ['hero', 'thug_skinny', 'thug_kicker', 'thug_fat', 'thug_crusher', 'boss', 'dumpster', 'crate', 'trash_can', 'street_lamp'];

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

// Prefer playwright's own chromium (system Chrome 136+ can refuse the debug pipe); fall back
// to an installed Chrome/Edge.
let browser = null;
try {
  browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
} catch {
  const exe = CHROME_CANDIDATES.find(existsSync);
  if (!exe) { console.error('No usable browser found; set CHROME_PATH or run: node node_modules/playwright-core/cli.js install chromium'); process.exit(1); }
  browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-unsafe-swiftshader'] });
}

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

// A minimal valid GLB: one box mesh (24 verts, flat normals), no rig, no clips.
function makeGlb(w, h, d, rgb) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const x = w / 2, y = h / 2, z = d / 2;
  const faces = [
    [[1, 0, 0], [[x, -y, -z], [x, y, -z], [x, y, z], [x, -y, z]]],
    [[-1, 0, 0], [[-x, -y, z], [-x, y, z], [-x, y, -z], [-x, -y, -z]]],
    [[0, 1, 0], [[-x, y, -z], [-x, y, z], [x, y, z], [x, y, -z]]],
    [[0, -1, 0], [[-x, -y, z], [-x, -y, -z], [x, -y, -z], [x, -y, z]]],
    [[0, 0, 1], [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]]],
    [[0, 0, -1], [[x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]]],
  ];
  const pos = [], nrm = [], idx = [];
  faces.forEach(([n, verts], f) => {
    verts.forEach(v => { pos.push(...v); nrm.push(...n); });
    const b = f * 4;
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(pos)).setBuffer(buffer))
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(nrm)).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(idx)).setBuffer(buffer))
    .setMaterial(doc.createMaterial('box').setBaseColorFactor([...rgb, 1]));
  doc.createScene('s').addChild(doc.createNode('box').setMesh(doc.createMesh('box').addPrimitive(prim)));
  return new NodeIO().writeBinary(doc);
}

// --- generate test models (only where no real one exists) ---
mkdirSync(ASSETS, { recursive: true });
const made = [];
for (const id of IDS) {
  const file = new URL(`${id}.glb`, ASSETS);
  if (existsSync(file)) continue;
  const isChar = ['hero', 'thug_skinny', 'thug_kicker', 'thug_fat', 'thug_crusher', 'boss'].includes(id);
  const glb = await makeGlb(isChar ? 0.6 : 1, isChar ? 1.7 : 1, isChar ? 0.4 : 1, [0.4, 0.6, 0.9]);
  writeFileSync(file, glb);
  made.push(file);
}
if (made.length) console.log(`generated ${made.length} test GLB(s) into public/assets (removed after the run)`);

const VITE = new URL('../node_modules/vite/bin/vite.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
execSync(`"${process.execPath}" "${VITE}" build`, { stdio: 'inherit', cwd: new URL('..', import.meta.url) });
const server = spawn(process.execPath, [VITE, 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore', cwd: new URL('..', import.meta.url) });
for (let i = 0; i < 40; i++) { try { await (await fetch(ORIGIN)).text(); break; } catch { await new Promise(r => setTimeout(r, 250)); } }

const problems = [];

// Combat-state snapshot: everything the switch must leave untouched.
const SNAP = `(() => {
  const g = __game, h = g.hero, f = f => ({ hp: f.hp, state: f.state, anim: f.anim, freeze: f.freeze, invuln: f.invuln,
    kb: f.kb ? [f.kb.dir, f.kb.remaining] : null, x: f.pos.x, z: f.pos.z, facing: f.facing });
  return { hero: f(h), combo: g.combo, lastComboHit: g.lastComboHit, wave: g.wave, queue: [...g.spawnQueue],
    time: g.time, holder: g.turns.holder ? g.turns.holder.id : null,
    attack: h.attack && { name: h.attack.name, t: h.attack.t, dur: h.attack.dur, hits: h.attack.hits.size },
    enemies: g.enemies.map(e => ({ id: e.id, kind: e.kind, ...f(e) })) };
})()`;

async function newPage() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', e => problems.push(`page error: ${e.message}`));
  // net::ERR_FAILED is the deliberately aborted GLB in the failure scenario, not a bug.
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('ERR_FAILED')) problems.push(`console.error: ${m.text()}`); });
  return page;
}
const looks = page => page.evaluate(() => ({
  fighters: [__game.hero, ...__game.enemies].map(f => f.visual.look),
  props: __game.props.map(p => p.visual.look),
  pickups: __game.pickups.map(p => p.visual.look),
}));

try {
  // ---------- 1. normal switch, combat state preserved ----------
  {
    const page = await newPage();
    const glbRequests = new Map();
    page.on('request', r => { if (r.url().endsWith('.glb')) glbRequests.set(r.url(), (glbRequests.get(r.url()) ?? 0) + 1); });
    await page.goto(`${ORIGIN}/?manual=1&seed=7`);
    await page.waitForFunction(() => window.__game);
    ok(await page.evaluate(() => document.getElementById('look').textContent) === 'GREYBOX', 'starts in greybox, button enabled');
    ok(glbRequests.size === 0, `no GLB requested before the first switch (${glbRequests.size})`);

    await page.evaluate(() => {
      __steps(400);   // wave 1: several thugs on the street
      const g = __game, h = g.hero;
      h.hp = 63; h.invuln = 0.42; h.freeze = 0.1; h.kb = { dir: -1, remaining: 0.6 };
      h.startAttack('cross'); h.attack.t = h.attack.dur * 0.4; h.attack.hits.add('dummy');
      g.combo = 4; g.lastComboHit = g.time;
      const e = g.enemies[0];
      e.hp = 17; e.invuln = 0.3; e.freeze = 0.08; e.kb = { dir: 1, remaining: 0.4 };
      g.turns.holder = e;
    });
    const before = await page.evaluate(SNAP);
    ok(before.enemies.length > 0 && before.attack, `fight state set up: ${before.enemies.length} enemies, mid-${before.attack?.name}, combo ${before.combo}, wave ${before.wave + 1}`);

    await page.click('#look');
    await page.waitForFunction(() => window.__loadReport && document.getElementById('look').textContent === 'MODELS');
    const report = await page.evaluate(() => window.__loadReport);
    ok(report.length === 10 && report.every(r => r.ok), `all ${report.length}/10 models loaded on first switch`);
    const afterModels = await page.evaluate(SNAP);
    ok(JSON.stringify(afterModels) === JSON.stringify(before), 'combat state identical after switching to models');
    const lm = await looks(page);
    const modelProps = await page.evaluate(() => __game.props.filter(p => p.id !== 'floor' && p.id !== 'wall').map(p => p.visual.look));
    ok(lm.fighters.every(l => l === 'model') && modelProps.every(l => l === 'model'),
      `fighters and props use models (floor/wall stay code-built: ${(await looks(page)).props.join(', ')})`);
    ok([...glbRequests.values()].every(n => n === 1) && glbRequests.size === 10, `each GLB requested exactly once (${glbRequests.size} files)`);

    const geo = await page.evaluate(() => {
      const T = __THREE, g = __game;
      for (const f of [g.hero, ...g.enemies]) f.sync(0.016, {}, 1);   // sync() writes rotation/position (visual only)
      g.scene.updateMatrixWorld(true);
      const out = {};
      for (const f of [g.hero, g.enemies[0]]) {
        const b = new T.Box3().setFromObject(f.visual.root, true);
        out[f.kind] = { minY: b.min.y, height: b.max.y - b.min.y, rotY: f.node.rotation.y, facing: f.facing };
      }
      return out;
    });
    for (const [kind, m] of Object.entries(geo)) {
      ok(Math.abs(m.minY) < 0.06 && m.height > 1.2 && m.height < 2.6 && Math.abs(m.rotY - m.facing * Math.PI / 2) < 1e-6,
        `${kind} (model): feet on ground (minY ${m.minY.toFixed(3)}), height ${m.height.toFixed(2)} m, facing matches rotation`);
    }

    await page.click('#look');
    await page.waitForFunction(() => document.getElementById('look').textContent === 'GREYBOX');
    const afterGrey = await page.evaluate(SNAP);
    ok(JSON.stringify(afterGrey) === JSON.stringify(before), 'combat state identical after switching back to greybox');
    ok((await looks(page)).fighters.every(l => l === 'greybox'), 'everything back to greybox');
    ok([...glbRequests.values()].every(n => n === 1), 'switching forth and back triggered no new GLB requests');

    // Memory: three more full cycles, drawing each look without advancing the fight
    // (render only, no game steps); GPU resource counts must not grow.
    const draw = () => page.evaluate(() => { for (let i = 0; i < 5; i++) { __game.render(0.016, 1); __renderer.render(__game.scene, __game.camera); } });
    const mem = [];
    for (let c = 0; c < 3; c++) {
      await page.click('#look');
      await page.waitForFunction(() => document.getElementById('look').textContent === 'MODELS');
      await draw();
      await page.click('#look');
      await page.waitForFunction(() => document.getElementById('look').textContent === 'GREYBOX');
      await draw();
      mem.push(await page.evaluate(() => ({ ...__renderer.info.memory })));
    }
    ok(mem[0].geometries === mem[2].geometries && mem[0].textures === mem[2].textures,
      `GPU resources stable over 3 switch cycles (geometries ${mem.map(m => m.geometries).join('->')}, textures ${mem.map(m => m.textures).join('->')})`);
    await page.close();
  }

  // ---------- 2. load failure: per-character greybox fallback + visible notice ----------
  {
    const page = await newPage();
    const counts = new Map();
    const count = u => counts.set(u, (counts.get(u) ?? 0) + 1);
    await page.route('**/assets/*.glb', route => {
      count(route.request().url());
      if (route.request().url().match(/\/(hero|crate)\.glb$/)) return route.abort();
      return route.continue();
    });
    await page.goto(`${ORIGIN}/?manual=1&seed=7`);
    await page.waitForFunction(() => window.__game);
    await page.evaluate(() => __steps(300));
    await page.click('#look');
    await page.waitForFunction(() => window.__loadReport && document.getElementById('look').textContent === 'MODELS');
    const report = await page.evaluate(() => window.__loadReport);
    const failed = report.filter(r => !r.ok).map(r => r.file).sort();
    ok(failed.join(',') === 'crate.glb,hero.glb', `hero.glb and crate.glb reported as failed (${failed.join(', ') || 'none'})`);
    const l = await looks(page);
    ok(l.fighters[0] === 'greybox' && l.fighters.slice(1).every(x => x === 'model'),
      `Volt falls back to greybox, the ${l.fighters.length - 1} thugs still switch to models`);
    const crates = await page.evaluate(() => __game.props.filter(p => p.id === 'crate').map(p => p.visual.look));
    const others = await page.evaluate(() => __game.props.filter(p => p.id !== 'crate' && p.id !== 'floor' && p.id !== 'wall').map(p => p.visual.look));
    ok(crates.every(x => x === 'greybox') && others.every(x => x === 'model'), 'crates fall back to greybox, other props use models');
    const notice = await page.evaluate(() => ({ show: document.getElementById('notice').classList.contains('show'), text: document.getElementById('notice').textContent }));
    ok(notice.show && notice.text.includes('hero.glb') && notice.text.includes('crate.glb'), `visible notice names the missing files ("${notice.text}")`);

    // Toggle away and back: the failed files must not be requested again.
    await page.click('#look');
    await page.waitForFunction(() => document.getElementById('look').textContent === 'GREYBOX');
    await page.click('#look');
    await page.waitForFunction(() => document.getElementById('look').textContent === 'MODELS');
    await page.waitForTimeout(400);
    ok([...counts.values()].every(n => n === 1), `no GLB re-requested after the first load (incl. failed ones): ${[...counts.values()].join(',')}`);
    ok((await looks(page)).fighters[0] === 'greybox', 'Volt still greybox after re-switching (fallback is stable)');
    await page.close();
  }

  // ---------- 3. rapid clicks during the load: last click wins, no race ----------
  {
    const page = await newPage();
    const counts = new Map();
    await page.route('**/assets/*.glb', async route => {
      const u = route.request().url();
      counts.set(u, (counts.get(u) ?? 0) + 1);
      await new Promise(r => setTimeout(r, 800));   // slow the load so clicks land mid-flight
      return route.continue();
    });
    await page.goto(`${ORIGIN}/?manual=1&seed=7`);
    await page.waitForFunction(() => window.__game);

    const burst = async n => { for (let i = 0; i < n; i++) await page.click('#look', { timeout: 5000 }); };
    await page.click('#look');
    ok(await page.evaluate(() => document.getElementById('look').textContent) === 'LOADING…', 'button shows LOADING… while models load');
    await burst(4);   // 5 total (odd) -> models
    await page.waitForFunction(() => window.__loadReport && document.getElementById('look').textContent === 'MODELS', null, { timeout: 15000 });
    ok((await looks(page)).fighters.every(x => x === 'model'), '5 rapid clicks during load -> models (last click wins)');
    await burst(3);   // odd -> greybox
    await page.waitForFunction(() => document.getElementById('look').textContent === 'GREYBOX');
    ok((await looks(page)).fighters.every(x => x === 'greybox'), '3 rapid clicks -> greybox');
    await burst(4);   // even -> still greybox
    await page.waitForTimeout(300);
    ok(await page.evaluate(() => document.getElementById('look').textContent) === 'GREYBOX'
      && (await looks(page)).fighters.every(x => x === 'greybox'), '4 rapid clicks -> back to greybox');
    await burst(1);   // -> models again, from the cache
    await page.waitForFunction(() => document.getElementById('look').textContent === 'MODELS');
    ok((await looks(page)).fighters.every(x => x === 'model'), 'final click -> models');
    ok(counts.size === 10 && [...counts.values()].every(n => n === 1), `every GLB requested exactly once across all bursts (${counts.size} files)`);
    await page.close();
  }
} catch (e) {
  console.error('FAIL ', e);
  failures++;
} finally {
  await browser.close();
  server.kill();
  for (const f of made) { try { unlinkSync(f); } catch {} }
  if (made.length) console.log(`removed ${made.length} test GLB(s)`);
}
console.log(problems.length ? `\nPage problems:\n${[...new Set(problems)].join('\n')}` : '\nConsole: no page errors');
if (problems.length) failures++;
console.log(failures ? `\n${failures} check(s) failed` : '\nAll look-switch checks passed');
process.exitCode = failures ? 1 : 0;
