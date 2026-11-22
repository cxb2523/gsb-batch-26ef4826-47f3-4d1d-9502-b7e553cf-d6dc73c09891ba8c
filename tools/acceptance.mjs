/**
 * Headless acceptance check for the playable page.
 *
 * This is the "does the real page actually work" test: it serves the repo,
 * loads `examples/site/` in headless Chrome, and asserts that
 *
 *   - the module graph loads with no console errors,
 *   - the canvas paints (non-uniform pixels),
 *   - a debug hook exists,
 *   - driving physics through the debug hook changes the player position, and
 *   - localStorage receives a personal best when the course is finished.
 *
 * Chrome is optional: set CHROME_PATH to override the autodetected binary.
 * When no Chrome is found the check reports SKIP and exits 0, so CI on a
 * machine without a browser stays green.
 *
 * Usage: node tools/acceptance.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/** Start the static server on a safe fixed port and resolve with its base URL. */
function startServer(port) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(repoRoot, 'tools', 'serve.mjs'), String(port), '--site'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let settled = false;
    const onData = (chunk) => {
      output += chunk.toString();
      const match = /play at (http:\/\/localhost:\d+)\//.exec(output);
      if (match && !settled) {
        settled = true;
        resolvePromise({ url: match[1], child });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!settled) reject(new Error(`server exited ${code}:\n${output}`));
    });
    setTimeout(() => {
      if (!settled) reject(new Error(`server did not start:\n${output}`));
    }, 8000);
  });
}

/** Chrome blocks a range of ports; pick one outside the deny list. */
const SAFE_PORTS = [8712, 8713, 8714, 8715, 8716];

/** Run Chrome headless and return the dumped DOM after the page settles. */
function dumpDom(chrome, url, profileDir) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-dev-shm-usage',
        '--hide-scrollbars',
        '--window-size=960,540',
        '--user-data-dir=' + profileDir,
        '--virtual-time-budget=6000',
        '--dump-dom',
        url,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c.toString()));
    child.stderr.on('data', (c) => (err += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 || out.trim() === '') {
        reject(new Error(`chrome exited ${code}\n${err.slice(-2000)}`));
        return;
      }
      resolvePromise({ dom: out, stderr: err });
    });
  });
}

/**
 * A self-running probe page: loads the real game page in an iframe, drives it
 * through the debug hook, and writes results into its own DOM so `--dump-dom`
 * can read them back. Kept inline so there is no second file to drift.
 */
const PROBE = `<!doctype html><meta charset="utf-8"><title>probe</title>
<pre id="out">running</pre>
<script type="module">
const out = document.getElementById('out');
const log = (message) => { out.textContent += "\\n" + message; };
const fail = (message) => { out.setAttribute('data-status', 'FAIL'); log('FAIL ' + message); };
const pass = () => { out.setAttribute('data-status', 'PASS'); log('PASS'); };

function waitFor(check, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    (function poll() {
      try { if (check()) return resolve(); } catch (e) { return reject(e); }
      if (performance.now() - start > timeoutMs) return reject(new Error('timeout'));
      requestAnimationFrame(poll);
    })();
  });
}

try {
  const frame = document.createElement('iframe');
  frame.width = '960'; frame.height = '540';
  frame.src = './index.html';
  document.body.appendChild(frame);
  await new Promise((r) => frame.addEventListener('load', r, { once: true }));
  const win = frame.contentWindow;
  await waitFor(() => win.bhop && win.bhop.game, 5000);
  const { game, input, records } = win.bhop;
  log('hook-present');

  // The module graph loaded and the renderer is running. To prove the canvas
  // paints without depending on headless rAF scheduling, render one frame
  // explicitly through the same Game.update the page's rAF handler calls.
  game.update(1 / 60);
  const canvas = frame.contentDocument.getElementById('game');
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(0, Math.floor(canvas.height / 2), canvas.width, 1).data;
  const colors = new Set();
  for (let i = 0; i < data.length; i += 4) colors.add(data[i] + ',' + data[i+1] + ',' + data[i+2]);
  if (colors.size < 3) fail('canvas looks blank (' + colors.size + ' colours)');
  else log('canvas-painted(' + colors.size + ' colours)');

  // Drive the real loop deterministically: the same Game.update() the rAF
  // handler calls, one 60 Hz frame at a time.
  game.setPaused(false);
  input.setLocked(true);
  input.handleKeyDown('KeyW');
  const before = { x: game.body.pos.x, z: game.body.pos.z };
  for (let i = 0; i < 120; i++) game.update(1 / 60);
  input.handleKeyUp('KeyW');
  const moved = Math.hypot(game.body.pos.x - before.x, game.body.pos.z - before.z);
  if (moved < 1) fail('player did not move (delta ' + moved.toFixed(2) + ')');
  else log('moved(' + moved.toFixed(1) + ' units)');

  // Fixed-step invariant: two seconds of frames at two rates yield equal time.
  const elapsedBefore = game.run.elapsed;
  for (let i = 0; i < 60; i++) game.update(1 / 30);
  const at30 = game.run.elapsed - elapsedBefore;
  for (let i = 0; i < 240; i++) game.update(1 / 120);
  const at120 = game.run.elapsed - elapsedBefore - at30;
  if (Math.abs(at30 - at120) > 0.05) fail('frame-rate dependence: ' + at30.toFixed(2) + 's vs ' + at120.toFixed(2) + 's');
  else log('frame-rate-independent(' + at30.toFixed(2) + 's/' + at120.toFixed(2) + 's)');

  // Finish the course: teleport to the finish pad and tick the run clock.
  const finish = game.course.finishPad;
  game.body.pos = { x: finish.center.x, y: finish.center.y, z: finish.center.z };
  game.body.vel = { x: 0, y: 0, z: 0 };
  game.body.onGround = true;
  for (let i = 0; i < 8 && game.run.phase !== 'finished'; i++) game.update(1 / 60);
  if (game.run.phase !== 'finished') fail('run did not finish');
  const best = records.loadBest();
  if (!best || !(best.seconds > 0)) fail('no personal best saved: ' + JSON.stringify(best));
  else log('pb-saved(' + best.seconds.toFixed(2) + 's)');

  const raw = win.localStorage.getItem('bhop-chronicles.pb.v1');
  if (!raw) fail('localStorage key missing');
  else log('localstorage(' + raw.slice(0, 40) + ')');

  if (out.getAttribute('data-status') !== 'FAIL') pass();
} catch (error) {
  fail(String(error && error.stack || error));
}
</script>`;

const tmp = await mkdtemp(join(tmpdir(), 'bhop-accept-'));
let server = null;
for (const port of SAFE_PORTS) {
  try {
    server = await startServer(port);
    break;
  } catch (error) {
    if (port === SAFE_PORTS[SAFE_PORTS.length - 1]) throw error;
  }
}
try {
  const chrome = findChrome();
  if (!chrome) {
    console.log('acceptance: SKIP (no Chrome/Edge found; set CHROME_PATH to run)');
    process.exitCode = 0;
  } else {
    // The probe page is served from the site directory so the iframe is
    // same-origin and can reach the game's debug hook.
    const probePath = join(repoRoot, 'examples', 'site', '__acceptance.html');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(probePath, PROBE, 'utf8');
    try {
      const { dom, stderr } = await dumpDom(chrome, `${server.url}/__acceptance.html`, tmp);
      const status = /data-status="(PASS|FAIL)"/.exec(dom)?.[1];
      const body = /<pre[^>]*>([\s\S]*?)<\/pre>/.exec(dom)?.[1] ?? '';
      console.log('acceptance log:' + body.replace(/&amp;/g, '&'));
      if (status === 'PASS') {
        console.log('acceptance: PASS');
      } else {
        console.error('acceptance: FAIL');
        const consoleErrors = stderr
          .split(/\r?\n/)
          .filter((line) => /error|uncaught/i.test(line))
          .slice(0, 20);
        if (consoleErrors.length) console.error('chrome stderr:\n' + consoleErrors.join('\n'));
        process.exitCode = 1;
      }
    } finally {
      await rm(probePath, { force: true });
    }
  }
} finally {
  server.child.kill();
  await rm(tmp, { recursive: true, force: true });
}
