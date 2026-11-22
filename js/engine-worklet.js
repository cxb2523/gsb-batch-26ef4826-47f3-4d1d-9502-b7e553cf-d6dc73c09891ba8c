// Every sound is synthesised here, sample by sample, from the physics:
// four cylinders firing through exhaust resonances at the real crank speed,
// two blades passing at the same rate, air over the airframe scaled by dynamic
// pressure, tyres, the reed stall horn, flap motor, starter, rain.
//
// Cockpit annunciators are synthesised too. The main loop posts a small,
// already-hysteretic summary (`warn`) once a frame; nothing here reads the
// flight model. Each warning has its own voice so they are told apart by ear:
//   stall      the reed horn, rising in pitch toward the stall
//   overspeed  fast, high, gated beeps that quicken past the red line
//   low oil    a steady, rough low buzz
//   low vacuum a slow, medium beep
//   low volts  a triple chirp, then a pause
//   ice        a soft two-tone advisory chime
//   turn flag  a quiet periodic tick
// They sit in the cabin with the pilot: pronounced in the cockpit, only a
// hint from outside. The whole bus is soft-limited so it never drowns the
// engine, and nothing is produced while a channel is silent.
class SVF {
  constructor() { this.low = 0; this.band = 0; }
  // returns band-pass; this.low holds the low-pass
  run(x, f, q) {
    this.low += f * this.band;
    const high = x - this.low - q * this.band;
    this.band += f * high;
    return this.band;
  }
}

class FlightSound extends AudioWorkletProcessor {
  constructor() {
    super();
    this.p = { rpm: 0, load: 0, firing: 0, speed: 0, interior: 1, roll: 0, flap: 0, rain: 0, starter: 0, doppler: 1, turb: 0, distance: 1, scrape: 0 };
    this.warn = { stall: 0, overspeed: 0, lowOil: 0, lowVac: 0, lowVolts: 0, ice: 0, tc: 0 };
    this.s = { ...this.p };
    this.ws = { ...this.warn };                 // smoothed copies of the annunciators
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.touch) { this.chirp = Math.min(1, d.touch); this.thump = Math.min(1, d.touch * 1.2); }
      else if (d.warn) Object.assign(this.warn, d.warn);
      // a reset posts warn = null: drop every channel at once (R, new aircraft)
      else if (d.warn === null) for (const k in this.warn) this.warn[k] = 0;
      else Object.assign(this.p, d);
    };
    this.crank = 0; this.cyl = 0; this.exc = 0;
    this.cylAmp = [1.0, 0.84, 0.95, 0.78];
    this.r1 = new SVF(); this.r2 = new SVF(); this.r3 = new SVF(); this.mech = new SVF();
    this.windL = new SVF(); this.windR = new SVF(); this.rumble = new SVF(); this.gnd = new SVF(); this.chirpF = new SVF();
    this.oilF = new SVF();
    this.lpL = 0; this.lpR = 0; this.lp2L = 0; this.lp2R = 0;
    this.horn = 0; this.flapPh = 0; this.startPh = 0; this.thumpPh = 0;
    this.chirp = 0; this.thump = 0; this.rainLp = 0; this.slow = 0; this.bump = 0;
    this.hornEnv = 0; this.flapEnv = 0;
    // warning phases: one oscillator phase per voice, plus each voice's own gate clock
    this.ovPh = 0; this.ovEnv = 0; this.ovBeat = 0;
    this.oilBeat = 0;
    this.vacPh = 0; this.vacEnv = 0; this.vacBeat = 0;
    this.voltPh = 0; this.voltEnv = 0; this.voltBeat = 0;
    this.icePh = 0; this.iceEnv = 0; this.iceBeat = 0;
    this.tcPh = 0; this.tcEnv = 0; this.tcBeat = 0;
    this.env = {}; for (const k in this.warn) this.env[k] = 0;   // per-channel attack envelopes
    this.warnGain = 0;                          // smoothed cabin bus level for the annunciators
  }
  process(_, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || out[0];
    const sr = sampleRate, p = this.p, s = this.s, n = L.length;
    const rpm0 = s.rpm;
    for (const k in p) s[k] += (p[k] - s[k]) * 0.2;
    const w = this.warn, ws = this.ws;
    for (const k in w) ws[k] += (w[k] - ws[k]) * 0.08;
    const TWO_PI = Math.PI * 2;
    const pulseDecay = Math.exp(-1 / (sr * 0.0035));
    const fz = (hz) => 2 * Math.sin(Math.PI * Math.min(hz, sr * 0.22) / sr);
    const f1 = fz(92 * s.doppler), f2 = fz(215 * s.doppler), f3 = fz(470 * s.doppler), fm = fz(1400);
    const V = s.speed;
    const fw = fz(260 + 13 * V), frum = fz(110), fg = fz(70), fc = fz(1150);
    const windGain = Math.min(1.3, (V / 62) * (V / 62)) * (0.20 + 0.16 * (1 - s.interior));
    const cut = 1 - Math.exp(-TWO_PI * (1500 + 6500 * (1 - s.interior)) / sr);
    const rpmN = Math.min(1.2, s.rpm / 2700);
    const propAmp = Math.pow(rpmN, 2.3) * (0.20 + 0.25 * (1 - s.interior));
    const beta = 0.3 + 1.9 * rpmN * rpmN;
    const engGain = (0.55 + 0.45 * s.load) * (0.5 + 0.5 * Math.min(1, s.rpm / 800));
    const fire = s.firing > 0.5 ? 0.35 + 0.65 * s.load : 0.10;
    const dist = s.distance;
    for (let i = 0; i < n; i++) {
      const rpm = rpm0 + (s.rpm - rpm0) * (i / n);
      const w1 = Math.random() * 2 - 1, w2 = Math.random() * 2 - 1;
      // ---- engine
      const before = Math.floor(this.crank * 2);
      this.crank += (rpm / 60 / sr) * s.doppler;
      if (Math.floor(this.crank * 2) !== before) {
        this.cyl = (this.cyl + 1) & 3;
        this.exc += this.cylAmp[this.cyl] * fire * (0.9 + 0.2 * Math.random());
      }
      if (this.crank > 1024) this.crank -= 1024;
      this.exc *= pulseDecay;
      const e = this.exc;
      const eng = (this.r1.run(e, f1, 0.35) * 0.95 + this.r2.run(e, f2, 0.28) * 0.55 + this.r3.run(e, f3, 0.4) * 0.28) * engGain;
      const bp = this.crank * 2 * TWO_PI;
      const prop = Math.sin(bp + beta * Math.sin(bp)) * propAmp * (1 + 0.08 * Math.sin(this.crank * Math.PI));
      const mech = this.mech.run(w1, fm, 0.9) * 0.035 * rpmN;
      let core = eng * 0.42 + prop + mech;
      // ---- starter
      if (s.starter > 0.02) {
        this.startPh += (240 + rpm * 1.1) / sr;
        const ph = this.startPh % 1;
        core += (ph * 2 - 1) * 0.05 * s.starter + Math.sin(this.startPh * TWO_PI * 3.01) * 0.025 * s.starter;
      }
      // ---- air
      this.slow += (w2 - this.slow) * 0.0008;
      const gust = 1 + s.turb * this.slow * 22;
      const aL = this.windL.run(w1, fw, 1.3) * windGain * gust;
      const aR = this.windR.run(w2, fw, 1.3) * windGain * gust;
      this.rumble.run(w1 + w2, frum, 1.2);
      const low = this.rumble.low * 0.012 * Math.min(1.5, (V / 55) * (V / 55));
      // ---- wheels on the ground
      this.gnd.run(w2, fg, 0.9);
      if (s.roll > 0.5 && Math.random() < s.roll * 0.00012) this.bump = 0.6 + Math.random() * 0.5;
      this.bump *= 0.9993;
      let ground = this.gnd.low * 0.05 * Math.min(1, s.roll / 28) * (1 + this.bump * 3) + s.scrape * this.chirpF.band * 0.2;
      // ---- touchdown
      const ch = this.chirpF.run(w1, fc, 0.5);
      if (this.chirp > 0.001) { ground += ch * this.chirp * 0.5; this.chirp *= 0.99965; }
      if (this.thump > 0.001) { this.thumpPh += 58 / sr; ground += Math.sin(this.thumpPh * TWO_PI) * this.thump * 0.6; this.thump *= 0.9996; } else this.thumpPh = 0;
      // ---- cockpit annunciators
      // The bus level follows the view: clear in the cabin, a hint from outside.
      this.warnGain += ((0.30 + 0.70 * s.interior) - this.warnGain) * 0.05;
      const wg = this.warnGain, eg = this.env;
      for (const k in ws) eg[k] += ((ws[k] > 0.02 ? 1 : 0) - eg[k]) * 0.003;   // ~7 ms attack, click-free
      let alarms = 0;

      // stall: the reed horn, rising in pitch as the wing lets go
      if (eg.stall > 1e-4) {
        this.horn += (540 + 300 * ws.stall) / sr;
        const h = Math.sin(this.horn * TWO_PI);
        alarms += Math.tanh(h * 4 + Math.sin(this.horn * TWO_PI * 2) * 1.5) * 0.10 * eg.stall * wg;
      }
      // overspeed: fast high beeps that crowd together past the red line
      if (eg.overspeed > 1e-4) {
        const period = 0.15 - 0.08 * ws.overspeed;
        this.ovPh += 1 / sr; if (this.ovPh >= period) this.ovPh -= period;
        this.ovEnv += ((this.ovPh < period * 0.6 ? 1 : 0) - this.ovEnv) * 0.006;
        this.ovBeat += (1620 + 520 * ws.overspeed) / sr;
        alarms += (Math.sin(this.ovBeat * TWO_PI) + 0.3 * Math.sin(this.ovBeat * TWO_PI * 2)) * 0.11 * this.ovEnv * eg.overspeed * wg;
      }
      // low oil pressure: a steady, rough buzz well above the exhaust's rumble
      if (eg.lowOil > 1e-4) {
        this.oilBeat += 330 / sr;
        const saw = (this.oilBeat % 1) * 2 - 1, am = 0.6 + 0.4 * Math.sin(this.oilBeat * TWO_PI * 31);
        const raw = (saw * 0.7 + Math.sin(this.oilBeat * TWO_PI * 2) * 0.3) * am;
        alarms += this.oilF.run(raw, fz(1500), 0.8) * 0.38 * eg.lowOil * wg;
      }
      // low vacuum: a slow, medium beep
      if (eg.lowVac > 1e-4) {
        const period = 0.9;
        this.vacPh += 1 / sr; if (this.vacPh >= period) this.vacPh -= period;
        this.vacEnv += ((this.vacPh < 0.28 ? 1 : 0) - this.vacEnv) * 0.006;
        this.vacBeat += 740 / sr;
        alarms += Math.sin(this.vacBeat * TWO_PI) * 0.12 * this.vacEnv * eg.lowVac * wg;
      }
      // low volts: a triple chirp, then a pause
      if (eg.lowVolts > 1e-4) {
        const period = 1.5, t = this.voltPh;
        this.voltPh += 1 / sr; if (this.voltPh >= period) this.voltPh -= period;
        const g = (t < 0.09 || (t > 0.19 && t < 0.28) || (t > 0.38 && t < 0.47)) ? 1 : 0;
        this.voltEnv += (g - this.voltEnv) * 0.01;
        this.voltBeat += 990 / sr;
        alarms += Math.sin(this.voltBeat * TWO_PI) * 0.11 * this.voltEnv * eg.lowVolts * wg;
      }
      // airframe ice: a soft two-tone advisory chime
      if (eg.ice > 1e-4) {
        const period = 2.6, t = this.icePh;
        this.icePh += 1 / sr; if (this.icePh >= period) this.icePh -= period;
        const g = (t < 0.16 || (t > 0.22 && t < 0.38)) ? 1 : 0;
        this.iceEnv += (g - this.iceEnv) * 0.006;
        this.iceBeat += (t < 0.22 ? 660 : 880) / sr;
        alarms += Math.sin(this.iceBeat * TWO_PI) * 0.10 * this.iceEnv * eg.ice * wg;
      }
      // turn coordinator flag: a quiet periodic tick, easily told from the rest
      if (eg.tc > 1e-4) {
        const period = 0.85;
        this.tcPh += 1 / sr; if (this.tcPh >= period) this.tcPh -= period;
        this.tcEnv += ((this.tcPh < 0.045 ? 1 : 0) - this.tcEnv) * 0.02;
        this.tcBeat += 2100 / sr;
        alarms += Math.sin(this.tcBeat * TWO_PI) * 0.16 * this.tcEnv * eg.tc * wg;
      }
      // ---- flap motor
      this.flapEnv += ((s.flap > 0.5 ? 1 : 0) - this.flapEnv) * 0.001;
      let flap = 0;
      if (this.flapEnv > 0.002) { this.flapPh += 173 / sr; flap = (((this.flapPh * 2) % 1) - 0.5 + Math.sin(this.flapPh * TWO_PI) * 0.6) * 0.022 * this.flapEnv; }
      // ---- rain on the airframe
      this.rainLp += (w1 - this.rainLp) * 0.35;
      const rain = (w1 - this.rainLp) * s.rain * 0.10;
      // cabin: the airframe swallows the highs; the annunciators stay dry in the cockpit
      const xl = (core + aL + low + ground) * dist, xr = (core + aR + low + ground) * dist;
      this.lpL += (xl - this.lpL) * cut; this.lp2L += (this.lpL - this.lp2L) * cut;
      this.lpR += (xr - this.lpR) * cut; this.lp2R += (this.lpR - this.lp2R) * cut;
      const alm = Math.tanh(alarms) * 0.75;          // soft-limit the bus: it never drowns the engine
      L[i] = Math.tanh((this.lp2L + alm + flap + rain) * 1.5) * 0.6;
      R[i] = Math.tanh((this.lp2R + alm + flap + rain) * 1.5) * 0.6;
    }
    return true;
  }
}
registerProcessor('flight-sound', FlightSound);
