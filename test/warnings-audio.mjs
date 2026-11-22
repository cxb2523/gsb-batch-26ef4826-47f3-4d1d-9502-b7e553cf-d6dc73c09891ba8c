// Checks the audio side of the cockpit annunciators: that the Sound wrapper
// never throws before audio is ready or while muted, and that the worklet
// synthesises finite sound for every channel and falls silent on a reset.
//   node test/warnings-audio.mjs
//
// The worklet runs here under a tiny fake AudioWorkletProcessor, no browser.
import { readFileSync } from 'node:fs';
import { Sound } from '../js/audio.js';

const rows = [];
const check = (name, pass, note = '') => rows.push({ name, pass: !!pass, note });

// ---- the wrapper is inert, and silent, until audio is ready
{
  const s = new Sound();
  let threw = false;
  try {
    s.setLevel(0.9); s.update({ rpm: 2000 }); s.warn({ lowOil: 1 }); s.touch(1);
  } catch (e) { threw = true; }
  check('Sound methods are safe before audio is ready', !threw);
  const m = new Sound();
  m.ready = true;
  m.ctx = { currentTime: 0 };
  m.gain = { gain: { setTargetAtTime() {} } };
  m.node = { port: { postMessage() {} } };
  m.muted = true;
  let mutedThrew = false;
  try { m.setLevel(0.9); m.warn(null); } catch (e) { mutedThrew = true; }
  check('Sound methods are safe while muted', !mutedThrew);
}

// ---- load the worklet into a fake audio thread
const src = readFileSync(new URL('../js/engine-worklet.js', import.meta.url), 'utf8');
globalThis.sampleRate = 48000;
let Ctor = null;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { onmessage: null }; } };
globalThis.registerProcessor = (name, c) => { Ctor = c; };
new Function(src)();
check('Worklet registers its processor', typeof Ctor === 'function');

// Render `sec` seconds; return peak, whether every sample was finite, and rms.
// `hpHz` also returns the rms of the signal above that one-pole high-pass, where
// the annunciators sit and the cabin-filtered engine does not.
function render(node, sec, hpHz = 0) {
  let peak = 0, sum = 0, count = 0, finite = true, hpSum = 0;
  const a = hpHz ? Math.exp(-2 * Math.PI * hpHz / 48000) : 0;
  let lp = 0;
  const frames = Math.round(sec * 48000 / 128);
  for (let b = 0; b < frames; b++) {
    const out = [[new Float32Array(128), new Float32Array(128)]];
    node.process([], out);
    for (const ch of out[0]) for (const x of ch) {
      if (!Number.isFinite(x)) finite = false;
      peak = Math.max(peak, Math.abs(x)); sum += x * x; count++;
      if (hpHz) { lp = a * lp + (1 - a) * x; hpSum += (x - lp) * (x - lp); }
    }
  }
  const rms = Math.sqrt(sum / count);
  return { peak, rms, finite, hp: hpHz ? Math.sqrt(hpSum / count) : 0 };
}
const posts = (node, d) => node.port.onmessage({ data: d });
const quiet = { stall: 0, overspeed: 0, lowOil: 0, lowVac: 0, lowVolts: 0, ice: 0, tc: 0 };
const cruise = { rpm: 2400, load: 0.7, firing: 1, speed: 65, interior: 1, doppler: 1, distance: 1 };

{
  const node = new Ctor();
  posts(node, cruise);
  const idle = render(node, 0.5);
  check('No warnings, no signal beyond the engine', idle.finite, `peak ${idle.peak.toFixed(3)}`);
}

// ---- every channel is finite, and adds signal over the engine alone
{
  const engineNode = new Ctor(); posts(engineNode, cruise);
  const engine = render(engineNode, 1.5);
  for (const k of Object.keys(quiet)) {
    const node = new Ctor();
    posts(node, cruise);
    posts(node, { warn: { ...quiet, [k]: k === 'stall' || k === 'ice' ? 0.7 : 1 } });
    const r = render(node, 1.5);
    check(`${k}: worklet output is finite`, r.finite);
    check(`${k}: warning adds sound over the engine`, r.rms > engine.rms * 1.005, `rms ${r.rms.toFixed(4)} vs ${engine.rms.toFixed(4)}`);
  }
}

// ---- a reset (warn = null) silences the bus within a moment
{
  const node = new Ctor();
  posts(node, cruise);
  posts(node, { warn: { ...quiet, lowOil: 1, lowVac: 1, lowVolts: 1, ice: 1, tc: 1 } });
  const loud = render(node, 1, 700);
  posts(node, { warn: null });
  render(node, 0.6);                       // let the smoothing and gates settle
  const after = render(node, 1, 700);
  const quietNode = new Ctor(); posts(quietNode, cruise);
  render(quietNode, 0.6);
  const ref = render(quietNode, 1, 700);
  check('Before a reset the annunciators are audible in their band', loud.hp > ref.hp * 1.3, `hp ${loud.hp.toFixed(4)} vs ${ref.hp.toFixed(4)}`);
  check('After a reset the annunciator band is back to engine-only', after.hp < ref.hp * 1.05,
    `hp ${after.hp.toFixed(4)} vs engine ${ref.hp.toFixed(4)}`);
}

// ---- outside the cockpit they are markedly quieter than inside
{
  const measure = (interior) => {
    const node = new Ctor();
    posts(node, { rpm: 0, load: 0, firing: 0, speed: 0, interior, doppler: 1, distance: 1 });
    posts(node, { warn: { ...quiet, overspeed: 1 } });
    return render(node, 1.5).rms;
  };
  const inside = measure(1), outside = measure(0);
  check('Annunciators are much louder in the cockpit than outside', inside > outside * 2, `${inside.toFixed(4)} vs ${outside.toFixed(4)}`);
}

let bad = 0;
const pad = (s, n) => String(s).padEnd(n);
for (const r of rows) { if (!r.pass) bad++; console.log(`${r.pass ? '  ok  ' : ' MISS '}${pad(r.name, 74)}${r.note}`); }
console.log(`\n${rows.length - bad}/${rows.length}\n`);
process.exitCode = bad ? 1 : 0;
