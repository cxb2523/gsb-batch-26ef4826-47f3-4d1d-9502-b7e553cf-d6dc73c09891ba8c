// Cockpit warning annunciation: what the pilot hears, not what the aircraft knows.
//
// systems.js already decides what the panel shows (`ind`) and the flight model
// reports stall and speed. This module turns those instantaneous readings into
// a small, hysteretic summary that the main loop hands to the sound engine once
// a frame. Every channel has separate on/off thresholds and a short delay in
// each direction, so a reading trembling around a limit cannot make the horn
// chatter. Nothing here touches the DOM, Web Audio or the flight model, so it
// runs under node: test/warnings.mjs.
//
// The summary is plain numbers (0 = silent, 1 = full):
//   { stall, overspeed, lowOil, lowVac, lowVolts, ice, tc }
// The worklet only ever sees this structure; it never reads the flight model.

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

// A threshold with memory. raw is already a boolean (the thresholds live in
// Warnings.update); this only holds it steady for a moment in each direction.
class Latch {
  constructor(onDelay, offDelay) {
    this.onDelay = onDelay;
    this.offDelay = offDelay;
    this.active = false;
    this.t = 0;
  }
  update(dt, raw) {
    if (raw) {
      if (this.active) { this.t = 0; return true; }
      this.t += dt;
      if (this.t >= this.onDelay) { this.active = true; this.t = 0; }
    } else {
      if (!this.active) { this.t = 0; return false; }
      this.t += dt;
      if (this.t >= this.offDelay) { this.active = false; this.t = 0; }
    }
    return this.active;
  }
  reset() { this.active = false; this.t = 0; }
}

// delay on / delay off, in seconds. Hysteresis thresholds are per-channel and
// live in update(): around the limit, the "already on" side needs a little less
// to stay on than it took to come on.
const DELAYS = {
  stall: [0.12, 0.20],       // a stall must warn at once, and drop out cleanly
  overspeed: [0.25, 0.40],
  lowOil: [0.50, 0.90],      // oil pressure wobbles with rpm and temperature
  lowVac: [0.80, 1.20],
  lowVolts: [0.60, 1.50],
  ice: [0.80, 3.00],         // ice builds slowly and melts more slowly still
  tc: [0.40, 0.80],          // turn coordinator flag: the electrics are dead
};

export class Warnings {
  constructor() {
    this.ch = {};
    for (const k in DELAYS) this.ch[k] = new Latch(DELAYS[k][0], DELAYS[k][1]);
    this.out = { stall: 0, overspeed: 0, lowOil: 0, lowVac: 0, lowVolts: 0, ice: 0, tc: 0 };
  }

  // src:
  //   stall      flight model stall warning, 0..1 (o.stallWarn)
  //   iasKt      indicated airspeed in knots (o.ias / KT)
  //   vne        never-exceed speed in knots (def.limits.vne)
  //   lowOil, lowVac, lowVolts, tcFlag, ice   straight from systems.ind
  update(dt, src = {}) {
    dt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.5);
    const c = this.ch;

    const stallV = clamp(src.stall || 0, 0, 1);
    c.stall.update(dt, stallV > (c.stall.active ? 0.12 : 0.30));

    const vne = src.vne > 0 ? src.vne : Infinity;
    const ratio = (src.iasKt || 0) / vne;
    c.overspeed.update(dt, ratio > (c.overspeed.active ? 0.97 : 1.0));

    c.lowOil.update(dt, !!src.lowOil);
    c.lowVac.update(dt, !!src.lowVac);
    c.lowVolts.update(dt, !!src.lowVolts);

    const iceV = clamp(src.ice || 0, 0, 1);
    c.ice.update(dt, iceV > (c.ice.active ? 0.08 : 0.15));

    c.tc.update(dt, !!src.tcFlag);

    const o = this.out;
    // the reed horn rises with the stall margin; keep a floor while latched
    o.stall = c.stall.active ? Math.max(0.30, stallV) : 0;
    // how far past the red line, for the urgency of the overspeed beeper
    o.overspeed = c.overspeed.active ? clamp((ratio - 0.95) / 0.10, 0.25, 1) : 0;
    o.lowOil = c.lowOil.active ? 1 : 0;
    o.lowVac = c.lowVac.active ? 1 : 0;
    o.lowVolts = c.lowVolts.active ? 1 : 0;
    o.ice = c.ice.active ? Math.max(0.15, iceV) : 0;
    o.tc = c.tc.active ? 1 : 0;
    return o;
  }

  // A copy for the audio thread: it is posted across a message boundary every
  // frame and must not alias the live structure.
  summary() { return { ...this.out }; }

  // R (restart), a new aircraft or a new airport: forget everything latched.
  reset() {
    for (const k in this.ch) this.ch[k].reset();
    for (const k in this.out) this.out[k] = 0;
  }
}
