#!/usr/bin/env node
/**
 * Audio voice-pool lifecycle verification driver.
 *
 * Boots the real game dev server in headless Chromium (with `--mute-audio`; nothing is audible —
 * every assertion is numeric), then runs `src/audio/pooltest.js` in the page. That test drives the
 * actual `AudioSystem` inside an OfflineAudioContext, so it needs a browser only for Web Audio —
 * never a sound card.
 *
 *   node src/audio/pooltest.mjs
 *   node src/audio/pooltest.mjs --json report.json
 *   node src/audio/pooltest.mjs --port 5273
 *
 * Exits non-zero if any check fails. Also serves as the regression gate for:
 *   • nearest-opponent binding and the tier cap
 *   • car-swap rebuild of every bound voice
 *   • quality-drop fade → disconnect → free
 *   • pause/resume with no duplicate or extra voices
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const PORT = parseInt(arg('port', '5273'), 10);
const JSON_OUT = arg('json', '');

const t0 = Date.now();
const log = (...a) => console.log(`[pool +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

function portOpen(port) {
  return new Promise((res) => {
    const s = net.createConnection({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });
}

async function ensureServer() {
  if (await portOpen(PORT)) {
    log(`reusing dev server on :${PORT}`);
    return null;
  }
  log(`starting vite on :${PORT}`);
  const proc = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await portOpen(PORT)) return proc;
    await new Promise((r) => setTimeout(r, 300));
  }
  proc.kill('SIGKILL');
  throw new Error('vite failed to start');
}

let server = null;
let browser = null;
try {
  server = await ensureServer();
  browser = await chromium.launch({
    headless: true,
    args: [
      '--use-gl=angle',
      '--enable-unsafe-swiftshader',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message || e)));

  // No need to boot the whole game — the pool test imports the audio modules directly. Serve a
  // blank document from the dev server's own origin so module resolution works, without paying
  // for (or interfering with) a full game boot.
  await page.route(`**/__pooltest__`, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>pool</title>' })
  );
  await page.goto(`http://127.0.0.1:${PORT}/__pooltest__`, { waitUntil: 'domcontentloaded' });
  const report = await page.evaluate(async () => {
    const mod = await import('/src/audio/pooltest.js');
    return mod.runPoolSelfTest();
  });

  console.log();
  console.log('════════════════════════ OPPONENT VOICE POOL ════════════════════════');
  for (const c of report.checks) {
    console.log(`  ${c.pass ? '✓' : '✗'} ${c.name}${c.detail ? `\n      ${c.detail}` : ''}`);
  }
  console.log();
  console.log(`${report.passed} passed, ${report.failed} failed`);
  console.log('═════════════════════════════════════════════════════════════════════');

  if (JSON_OUT) {
    await writeFile(path.resolve(ROOT, JSON_OUT), JSON.stringify(report, null, 2));
    log(`wrote ${JSON_OUT}`);
  }
  if (report.failed > 0) process.exitCode = 1;
  if (pageErrors.length) {
    console.error('page errors:', pageErrors.slice(0, 10));
    process.exitCode = 2;
  }
} catch (err) {
  console.error('[pool] FATAL:', err?.stack || err);
  process.exitCode = 3;
} finally {
  await browser?.close().catch(() => {});
  server?.kill?.('SIGTERM');
  setTimeout(() => process.exit(process.exitCode || 0), 300).unref?.();
}
