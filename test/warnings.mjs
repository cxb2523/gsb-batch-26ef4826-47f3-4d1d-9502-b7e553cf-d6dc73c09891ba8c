// Checks the cockpit annunciator summary: what comes on, what holds it on, and
// what clears it.   node test/warnings.mjs
import { Warnings } from '../js/warnings.js';

const DT = 1 / 240, rows = [];
const check = (name, pass, note = '') => rows.push({ name, pass: !!pass, note });
const quiet = { stall: 0, iasKt: 90, vne: 163, lowOil: false, lowVac: false, lowVolts: false, tcFlag: false, ice: 0 };

// Run the aggregator for `sec` seconds against a (possibly moving) source.
const run = (W, sec, src) => {
  let o = W.out;
  for (let i = 0; i < sec / DT; i++) o = W.update(DT, typeof src === 'function' ? src(i * DT) : src);
  return o;
};

// ---- nothing is audible in a healthy aircraft
{
  const W = new Warnings();
  const o = run(W, 2, quiet);
  check('A healthy aircraft is silent', Object.values(o).every((v) => v === 0), JSON.stringify(o));
}

// ---- each source lights exactly its own channel
{
  const cases = [
    ['stall', { stall: 0.8 }],
    ['overspeed', { iasKt: 175 }],
    ['lowOil', { lowOil: true }],
    ['lowVac', { lowVac: true }],
    ['lowVolts', { lowVolts: true }],
    ['ice', { ice: 0.4 }],
    ['tc', { tcFlag: true }],
  ];
  for (const [ch, patch] of cases) {
    const W = new Warnings();
    const o = run(W, 3, { ...quiet, ...patch });
    const others = Object.keys(o).filter((k) => k !== ch && o[k] !== 0);
    check(`${ch} sounds when its condition holds`, o[ch] > 0, `level ${o[ch].toFixed(2)}`);
    check(`...and only ${ch} sounds`, others.length === 0, others.join(','));
    run(W, 6, quiet);
    check(`${ch} falls silent when the condition clears`, W.out[ch] === 0);
  }
}

// ---- stall: the horn follows needle tremor without chattering
{
  // a sender that is genuinely stalled, but drops out for 60 ms four times a second
  const sender = (t) => ({ ...quiet, stall: (t % 0.25) < 0.06 ? 0.08 : 0.5 });
  let changes = 0, prev = 0, W = new Warnings(), lit = 0, samples = 0;
  for (let i = 0; i < 3 / DT; i++) {
    const s = W.update(DT, sender(i * DT));
    const now = s.stall > 0 ? 1 : 0; if (now !== prev) { changes++; prev = now; }
    if (now) lit++; samples++;
  }
  check('Stall horn holds steady through a flickering sender', changes <= 2, `${changes} transitions in 3 s`);
  check('...and reports the stall through the tremor', lit / samples > 0.9, `lit ${(100 * lit / samples).toFixed(0)} % of the time`);
}

// ---- overspeed: onset just past Vne, with hysteresis so it does not rattle
{
  const W = new Warnings();
  const a = run(W, 1, { ...quiet, iasKt: 163 * 0.99 });
  check('Overspeed stays quiet just below Vne', a.overspeed === 0);
  const b = run(W, 1, { ...quiet, iasKt: 163 * 1.01 });
  check('Overspeed sounds just past Vne', b.overspeed > 0);
  const c = run(W, 1, { ...quiet, iasKt: 163 * 0.985 });     // a shade under the red line, but latched
  check('...and holds through a small dip below Vne', c.overspeed > 0);
  const d = run(W, 1.5, { ...quiet, iasKt: 163 * 0.9 });
  check('...then clears once clearly below it', d.overspeed === 0);
  const e = run(W, 1, { ...quiet, iasKt: 200 });
  check('Overspeed urgency rises with how far past the line', e.overspeed > 0.9, `level ${e.overspeed.toFixed(2)}`);
}

// ---- low oil: the oil pressure sits right on its limit and must not chatter
{
  const W = new Warnings(); let changes = 0, prev = 0;
  for (let i = 0; i < 6 / DT; i++) {
    const s = W.update(DT, { ...quiet, lowOil: Math.sin(i * DT * 2 * Math.PI * 3) > 0 });   // on/off three times a second
    const now = s.lowOil > 0 ? 1 : 0; if (now !== prev) { changes++; prev = now; }
  }
  check('Low-oil warning ignores a pressure needle trembling on its limit', changes <= 2, `${changes} transitions in 6 s`);
}

// ---- a real fault latches quickly enough to be useful
{
  const W = new Warnings();
  const t0 = 0.4; W.update(t0, { ...quiet, lowVolts: true });
  check('Low volts comes on within its delay', W.out.lowVolts === 0, 'silent before the delay');
  run(W, 0.5, { ...quiet, lowVolts: true });
  check('...and sounds shortly after', W.out.lowVolts > 0);
}

// ---- ice: builds slowly, warns, and lingers as it melts
{
  const W = new Warnings();
  run(W, 0.5, { ...quiet, ice: 0.05 });
  check('A trace of ice does not sound', W.out.ice === 0);
  run(W, 2, { ...quiet, ice: 0.3 });
  check('Meaningful ice sounds', W.out.ice > 0);
  run(W, 1.5, { ...quiet, ice: 0.1 });                       // below the on-threshold but not yet the off-threshold
  check('...holds through a partial melt', W.out.ice > 0);
  run(W, 5, { ...quiet, ice: 0 });
  check('...and clears once the airframe is clean', W.out.ice === 0);
}

// ---- reset (R or a new aircraft) drops everything at once
{
  const W = new Warnings();
  run(W, 2, { stall: 1, iasKt: 200, lowOil: true, lowVac: true, lowVolts: true, tcFlag: true, ice: 1 });
  check('All channels lit before a reset', Object.values(W.out).filter((v) => v > 0).length >= 6);
  W.reset();
  check('Reset silences every channel', Object.values(W.out).every((v) => v === 0));
  // and a still-bad aircraft has to sound again from clean, not stay stuck silent
  run(W, 3, { ...quiet, lowOil: true });
  check('...and warnings re-arm after a reset', W.out.lowOil > 0);
}

// ---- the posted summary is a copy, not the live structure
{
  const W = new Warnings();
  run(W, 2, { ...quiet, lowOil: true });
  const s = W.summary();
  s.lowOil = 0;
  check('summary() is a detached copy', W.out.lowOil > 0);
}

let bad = 0;
const pad = (s, n) => String(s).padEnd(n);
for (const r of rows) { if (!r.pass) bad++; console.log(`${r.pass ? '  ok  ' : ' MISS '}${pad(r.name, 78)}${r.note}`); }
console.log(`\n${rows.length - bad}/${rows.length}\n`);
process.exitCode = bad ? 1 : 0;
