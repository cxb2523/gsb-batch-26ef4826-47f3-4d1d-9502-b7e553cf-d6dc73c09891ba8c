// Shared CDP plumbing for the local acceptance scripts.
//
// Finds a Chromium-family browser binary (Chrome, Edge, Playwright's bundled
// Chromium) without pinning a machine-specific path, launches it headless with
// a throwaway profile, and exposes a tiny CDP client.
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CANDIDATES = [
  process.env.FD_CHROME,
  '/c/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

function playwrightRoots() {
  const roots = new Set([
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : null,
    path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'ms-playwright'),
  ]);

  // The home directory can be relocated (CI sandboxes, roaming profiles), so
  // also scan the conventional per-user locations on Windows and macOS.
  const userRoots = [];
  if (process.platform === 'win32') {
    for (const drive of ['C:', 'D:']) userRoots.push(path.join(`${drive}/`, 'Users'));
  } else {
    userRoots.push('/home', '/Users');
  }
  for (const usersDir of userRoots) {
    let users = [];
    try {
      users = fs.readdirSync(usersDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const user of users) {
      if (!user.isDirectory()) continue;
      roots.add(path.join(usersDir, user.name, 'AppData', 'Local', 'ms-playwright'));
      roots.add(path.join(usersDir, user.name, '.cache', 'ms-playwright'));
    }
  }

  return [...roots].filter(Boolean);
}

function playwrightBrowsers() {
  const found = [];
  for (const root of playwrightRoots()) {
    let entries = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const dir of entries) {
      if (/^chromium_headless_shell-/.test(dir)) {
        found.push(path.join(root, dir, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
        found.push(path.join(root, dir, 'chrome-headless-shell-linux64', 'chrome-headless-shell'));
      } else if (/^chromium-/.test(dir)) {
        found.push(path.join(root, dir, 'chrome-win64', 'chrome.exe'));
        found.push(path.join(root, dir, 'chrome-linux', 'chrome'));
      }
    }
  }
  // Prefer the newest headless shell, which is the most reliably scriptable.
  return found.sort((a, b) => {
    const rank = (p) => (p.includes('headless_shell') ? 0 : 1);
    return rank(a) - rank(b);
  });
}

/**
 * Returns candidate browser binaries, most-likely-to-work first. A plain
 * installed Chrome/Edge is tried last: recent versions refuse to expose the
 * DevTools socket unless a non-default profile is used *and* may still
 * complain, whereas Playwright's bundled headless shell always works.
 */
function findBrowsers() {
  const seen = new Set();
  const ordered = [];
  for (const candidate of [...playwrightBrowsers(), ...CANDIDATES]) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      if (fs.statSync(candidate).isFile()) ordered.push(candidate);
    } catch {
      // try next
    }
  }
  if (ordered.length === 0) {
    throw new Error(
      'No Chromium-family browser found. Set FD_CHROME to a chrome/edge/chromium binary.',
    );
  }
  return ordered;
}

function findBrowser() {
  return findBrowsers()[0];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Windows may keep profile files locked briefly after the browser exits. */
function safeRemove(dir) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      // retry shortly
    }
  }
}

async function waitForJson(port, pathname, pick) {
  for (let i = 0; i < 150; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}${pathname}`)).json();
      const hit = pick(list);
      if (hit) return hit;
    } catch {
      // not up yet
    }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for CDP on port ${port}`);
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
      }
    });
  }

  on(fn) {
    this.listeners.add(fn);
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value;
  }
}

/**
 * Launches a headless browser and connects to its first page target.
 * Returns `{ cdp, close }`; `close` always kills only this child process.
 * If a candidate binary fails to expose CDP, the next candidate is tried.
 */
async function launch({ port, touch = false, width = 1200, height = 800 }) {
  const binaries = findBrowsers();
  let lastError = null;

  for (const binary of binaries) {
    try {
      return await launchWith(binary, { port, touch, width, height });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('failed to launch a browser');
}

async function launchWith(binary, { port, touch, width, height }) {
  // A unique profile per launch avoids stale locks from a previous run.
  const profile = path.join(os.tmpdir(), `fd-cdp-${process.pid}-${port}-${Date.now().toString(36)}`);
  safeRemove(profile);

  const isHeadlessShell = /chrome-headless-shell/.test(binary);
  const args = [
    isHeadlessShell ? '--headless' : '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required',
    `--window-size=${width},${height}`,
    'about:blank',
  ];

  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += String(d);
  });
  // Never let a spawn failure crash the process; surface it as a launch error.
  child.on('error', (e) => {
    stderr += String(e);
  });

  let target;
  try {
    target = await waitForJson(port, '/json/list', (list) =>
      Array.isArray(list) ? list.find((t) => t.type === 'page') : null,
    );
  } catch (error) {
    try { child.kill(); } catch {}
    safeRemove(profile);
    throw new Error(`${error.message}\n${stderr.slice(0, 400)}`);
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: touch,
  });
  if (touch) {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await cdp.send('Browser.close').catch(() => {});
    await sleep(150);
    try { child.kill(); } catch {}
    await sleep(150);
    try { ws.close(); } catch {}
    safeRemove(profile);
  };

  return { cdp, close, binary };
}

module.exports = { launch, sleep, findBrowser };
