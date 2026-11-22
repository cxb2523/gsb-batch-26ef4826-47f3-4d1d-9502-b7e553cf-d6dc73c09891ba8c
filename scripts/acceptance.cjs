// Local browser acceptance: runs both the keyboard and the touch scenarios
// against a production build.
//
//   bun run test:e2e
//
// This script builds, serves `dist` with `vite preview`, launches a headless
// Chromium (see cdp.cjs for binary discovery), and asserts the cross-level
// hand-off behaviour through the real DOM and real input events. It only ever
// kills the browser process it started itself.
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { launch, sleep } = require('./cdp.cjs');

const PORT = Number(process.env.FD_E2E_PORT || 4180);
const BASE_URL = `http://127.0.0.1:${PORT}/`;

const KEY_DEFS = {
  KeyA: { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a' },
  KeyS: { key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, text: 's' },
  KeyD: { key: 'd', code: 'KeyD', windowsVirtualKeyCode: 68, text: 'd' },
  KeyF: { key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, text: 'f' },
  KeyJ: { key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74, text: 'j' },
  KeyK: { key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, text: 'k' },
  KeyL: { key: 'l', code: 'KeyL', windowsVirtualKeyCode: 76, text: 'l' },
  Semicolon: { key: ';', code: 'Semicolon', windowsVirtualKeyCode: 186, text: ';' },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
};

const LEVELS = {
  1: ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'Space', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon',
      'Semicolon', 'KeyL', 'KeyK', 'KeyJ', 'Space', 'KeyF', 'KeyD', 'KeyS', 'KeyA'],
  2: ['KeyA', 'KeyD', 'Space', 'KeyK', 'Semicolon', 'Semicolon', 'KeyK', 'Space', 'KeyD', 'KeyA',
      'KeyS', 'KeyF', 'KeyJ', 'KeyL', 'KeyL', 'KeyJ', 'KeyF', 'KeyS'],
};

function startServer() {
  // Run Vite through the current Node binary so the script does not depend on
  // a `bun`/`vite` shim being on PATH.
  const viteBin = path.join(__dirname, '..', 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(
    process.execPath,
    [viteBin, 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });

  const ready = (async () => {
    for (let i = 0; i < 100; i++) {
      try {
        const res = await fetch(BASE_URL);
        if (res.ok) return;
      } catch {}
      await sleep(150);
    }
    throw new Error(`preview server did not start:\n${log.slice(0, 600)}`);
  })();

  return {
    ready,
    stop: () => {
      try { child.kill(); } catch {}
    },
  };
}

function makeRecorder() {
  const results = [];
  return {
    results,
    record(name, ok, detail) {
      results.push({ name, ok, detail });
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
    },
  };
}

function makeState(cdp) {
  return () =>
    cdp.eval(`(() => {
      const txt = document.body.innerText;
      const step = txt.match(/Step (\\d+) \\/ (\\d+)/) || [];
      return {
        step: step[1] ? Number(step[1]) : null,
        total: step[2] ? Number(step[2]) : null,
        timer: (txt.match(/([\\d.]+)s/) || [])[1] ?? null,
        title: (txt.match(/^(\\d+\\. [^\\n]+)/m) || [])[1] ?? null,
        complete: txt.includes('Complete!'),
        menu: txt.includes('SELECT MUSICAL SCALE'),
      };
    })()`);
}

const parseTimer = (s) => (s.timer === null ? NaN : parseFloat(s.timer));

function clickHelpers(cdp) {
  const clickText = (text) =>
    cdp.eval(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes(${JSON.stringify(text)}));
      if (!b) return false;
      b.click();
      return true;
    })()`);
  const clickTitle = (title) =>
    cdp.eval(`(() => {
      const b = document.querySelector('button[title=${JSON.stringify(title)}]');
      if (!b) return false;
      b.click();
      return true;
    })()`);
  return { clickText, clickTitle };
}

async function keyboardScenario(cdp, rec) {
  const state = makeState(cdp);
  const { clickText, clickTitle } = clickHelpers(cdp);
  const keyDown = (code, autoRepeat = false) =>
    cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', autoRepeat, ...KEY_DEFS[code] });
  const keyUp = (code) => cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...KEY_DEFS[code] });
  const press = async (code, hold = 25) => {
    await keyDown(code);
    await sleep(hold);
    await keyUp(code);
    await sleep(25);
  };

  let s = await state();
  rec.record('[keyboard] menu loads', s.menu === true);

  await clickText('1. Learn All Keys');
  await sleep(900);
  s = await state();
  rec.record('[keyboard] level 1 mounts clean', s.title === '1. Learn All Keys' && s.step === 1, JSON.stringify(s));
  rec.record('[keyboard] timer starts at 0.00', s.timer === '0.00', s.timer);

  for (const code of LEVELS[1].slice(0, -1)) await press(code);
  await keyDown(LEVELS[1][LEVELS[1].length - 1]); // hold the final key
  await sleep(300);
  s = await state();
  rec.record('[keyboard] level 1 completes', s.complete === true, JSON.stringify(s));

  await keyDown('Enter'); // advance while the final key is still held
  await sleep(1000);
  await keyUp('Enter');
  s = await state();
  rec.record('[keyboard] next level mounts', s.title === '2. Odd and Even', JSON.stringify(s));
  rec.record('[keyboard] next level step 1', s.step === 1, `step=${s.step}`);
  rec.record('[keyboard] next level timer 0.00', s.timer === '0.00', s.timer);

  await keyDown('KeyA', true); // auto-repeat of the held key
  await sleep(300);
  s = await state();
  rec.record('[keyboard] held key auto-repeat does not start new timer', s.timer === '0.00' && s.step === 1, JSON.stringify(s));

  await keyUp('KeyA');
  await sleep(250);
  s = await state();
  rec.record('[keyboard] release alone does not start new timer', s.timer === '0.00' && s.step === 1, JSON.stringify(s));

  await keyDown('KeyA');
  await sleep(250);
  s = await state();
  rec.record('[keyboard] fresh press starts new level', parseTimer(s) > 0 && s.step === 2, JSON.stringify(s));

  await keyUp('KeyA');
  await keyDown('KeyD');
  await keyDown('KeyD'); // duplicate without keyup
  await sleep(250);
  s = await state();
  rec.record('[keyboard] duplicate keydown advances once', s.step === 3, `step=${s.step}`);
  await keyUp('KeyD');

  await clickTitle('Restart Level');
  await sleep(600);
  s = await state();
  rec.record('[keyboard] restart resets step and timer', s.step === 1 && s.timer === '0.00', JSON.stringify(s));

  await press('KeyA');
  await clickTitle('Back to Menu');
  await sleep(700);
  s = await state();
  rec.record('[keyboard] back to menu returns cleanly', s.menu === true, JSON.stringify(s));

  await clickText('2. Odd and Even');
  await sleep(900);
  s = await state();
  rec.record('[keyboard] level 2 from menu: step 1 / 0.00s', s.step === 1 && s.timer === '0.00', JSON.stringify(s));

  for (const code of LEVELS[2]) await press(code);
  await sleep(350);
  s = await state();
  rec.record('[keyboard] level 2 completes', s.complete === true, JSON.stringify(s));

  await keyDown('Enter');
  await keyDown('Enter', true);
  await sleep(1000);
  await keyUp('Enter');
  s = await state();
  rec.record('[keyboard] result screen advances to level 3', s.title === '3. Left Hand Melody', JSON.stringify(s));
  rec.record('[keyboard] level 3 starts clean', s.step === 1 && s.timer === '0.00', JSON.stringify(s));
}

async function touchScenario(cdp, rec) {
  const state = makeState(cdp);
  const { clickText, clickTitle } = clickHelpers(cdp);
  const touch = (type, points = []) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points.map((p) => ({ id: p.id, x: p.x, y: p.y, radiusX: 5, radiusY: 5, force: 1 })),
    });

  await clickText('1. Learn All Keys');
  await sleep(900);
  let s = await state();
  rec.record('[touch] level 1 mounts', s.title === '1. Learn All Keys' && s.step === 1, JSON.stringify(s));
  rec.record('[touch] overlay rendered', await cdp.eval("document.querySelectorAll('.z-10').length > 0"));

  await touch('touchStart', [{ id: 1, x: 75, y: 300 }]); // zone 0 => A
  await sleep(250);
  s = await state();
  rec.record('[touch] zone 0 advances step 1', s.step === 2, `step=${s.step}`);
  rec.record('[touch] touch press starts timer', parseTimer(s) > 0, s.timer);

  await touch('touchMove', [{ id: 1, x: 225, y: 300 }]); // zone 1 => S
  await sleep(250);
  s = await state();
  rec.record('[touch] slide to zone 1 advances step 2', s.step === 3, `step=${s.step}`);

  await touch('touchMove', [{ id: 1, x: 1199, y: 120 }]); // out of every zone
  await sleep(200);
  await touch('touchEnd', []);
  await sleep(200);
  s = await state();
  rec.record('[touch] move off board releases without corrupting step', s.step === 3, `step=${s.step}`);

  await touch('touchStart', [{ id: 2, x: 75, y: 300 }]); // A held
  await sleep(150);
  await clickTitle('Restart Level');
  await sleep(500);
  s = await state();
  rec.record('[touch] restart mid-touch resets to step 1 / 0.00s', s.step === 1 && s.timer === '0.00', JSON.stringify(s));

  await touch('touchMove', [{ id: 2, x: 375, y: 300 }]);
  await sleep(300);
  s = await state();
  rec.record('[touch] finger held across restart cannot start new level', s.step === 1 && s.timer === '0.00', JSON.stringify(s));

  await touch('touchEnd', []);
  await sleep(150);
  await touch('touchStart', [{ id: 3, x: 75, y: 300 }]);
  await sleep(250);
  s = await state();
  rec.record('[touch] fresh touch after restart starts new level', s.step === 2 && parseTimer(s) > 0, JSON.stringify(s));
  await touch('touchEnd', []);

  await clickTitle('Back to Menu');
  await sleep(600);
  s = await state();
  rec.record('[touch] returns to menu cleanly', s.menu === true, JSON.stringify(s));
}

function collectConsoleErrors(cdp) {
  const errors = [];
  cdp.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(String(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
    }
  });
  return errors;
}

// Headless Chromium refuses fullscreen; that is environmental, not a bug.
const isExpected = (e) => /Failed to enter fullscreen/i.test(e);

async function main() {
  const server = startServer();
  let browser;
  const rec = makeRecorder();
  const errors = [];

  try {
    await server.ready;

    // --- Keyboard pass ---
    let session = await launch({ port: 9333, touch: false });
    browser = session;
    const kbErrors = collectConsoleErrors(session.cdp);
    await session.cdp.send('Page.navigate', { url: BASE_URL });
    await sleep(2500);
    await keyboardScenario(session.cdp, rec);
    errors.push(...kbErrors);
    await session.close();
    browser = null;

    // --- Touch pass (emulation enabled before the app mounts) ---
    session = await launch({ port: 9334, touch: true });
    browser = session;
    const touchErrors = collectConsoleErrors(session.cdp);
    await session.cdp.send('Page.navigate', { url: BASE_URL });
    await sleep(2500);
    await touchScenario(session.cdp, rec);
    errors.push(...touchErrors);
    await session.close();
    browser = null;

    const unexpected = errors.filter((e) => !isExpected(e));
    rec.record('no unexpected console errors', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.stop();
  }

  const failures = rec.results.filter((r) => !r.ok);
  console.log(`\n${rec.results.length - failures.length}/${rec.results.length} checks passed`);
  if (failures.length) {
    for (const f of failures) console.log(`  failed: ${f.name}`);
  }
  process.exitCode = failures.length ? 1 : 0;
  // Exit explicitly: a lingering keep-alive socket or child handle must not
  // keep the runner (and its CI job) alive after the results are in.
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
}

main().catch((error) => {
  console.error('E2E ERROR', error);
  process.exit(1);
});
