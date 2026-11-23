/**
 * Need for Tokens — audio. Everything is synthesised at runtime with the Web Audio API.
 * There are no sample files, no fetches and no downloads. See CONTRACTS.md §12.
 *
 * Signal flow
 * -----------
 *                       ┌────────── reverbSend ──► convolver ──► verbReturn ──┐
 *   engine (player) ────┤                                                     │
 *   opponent engines ───┤──► spatialBus ─┐                                    │
 *   tyres ──────────────┤                ├──► sfxSum (sfxVolume) ─────────────┼──► preMaster
 *   wind / road ────────┤ (ducked)       │                                    │       │
 *   one-shot sfx ───────┘                ┘                                    │   limiter
 *   music (ducked by engine + sfx) ──────────► musicBus (musicVolume) ────────┘       │
 *                                                                                 softClip
 *                                                                                     │
 *                                                                        master (masterVolume)
 *                                                                                     │
 *                                                                                destination
 *
 * The limiter is a hard-knee compressor; the soft clipper after it is a tanh curve, so the final
 * output is mathematically incapable of exceeding full scale no matter what the game throws at it.
 */
import { clamp, clamp01, damp } from '../core/MathX.js';
import { buildImpulseResponse, softClipCurve, ramp, noiseBuffer } from './dsp.js';
import { EngineVoice } from './EngineVoice.js';
import { TyreVoice } from './TyreVoice.js';
import { AmbienceVoice } from './AmbienceVoice.js';
import { SfxBank } from './SfxBank.js';
import { MusicBed } from './MusicBed.js';
import { profileNameForCar } from './engineProfiles.js';

const NOOP = { stop() {}, setVolume() {}, setRate() {} };

const TIER = {
  low: { opponents: 0, hrtf: false, verb: 0.55, harmonics: 128, music: true },
  medium: { opponents: 2, hrtf: false, verb: 0.8, harmonics: 176, music: true },
  high: { opponents: 4, hrtf: true, verb: 0.95, harmonics: 240, music: true },
  ultra: { opponents: 5, hrtf: true, verb: 1.2, harmonics: 288, music: true },
};

/** Seconds a retired voice takes to fade out before its nodes are disconnected. */
const VOICE_FADE = 0.24;
/** How often the nearest-opponent set may be recomputed, seconds. */
const REBIND_COOLDOWN = 0.4;
/**
 * Hysteresis margin: an unbound challenger must be this much closer than the slot's current car
 * before it takes the slot over. Without it, two cars trading places at 0.1 m/s re-bind the pool
 * four times a second and the field audibly stutters even with the cooldown in place.
 */
const REBIND_HYSTERESIS = 0.12;
/** A car beyond this range is not worth a voice, metres. */
const AUDIBLE_RANGE = 260;

export class AudioSystem {
  constructor(ctx) {
    this.ctx = ctx;
    this.enabled = true;
    this.masterVolume = 0.75;
    this.musicVolume = 0.5;
    this.sfxVolume = 0.9;
    this.ac = null;
    this.unlocked = false;
    this.listenerCamera = null;

    this._tier = TIER.high;
    this._deferred = [];
    this._opponentSlots = [];
    /** Voices fading out after a shrink/rebind; each is retired when its fade completes. */
    this._retiring = [];
    /** Offline only: voices whose scheduled stop has been queued, awaiting flushRetired(). */
    this._reaped = [];
    this._rebindCooldown = 0;
    /** Bumped whenever the whole pool must be rebuilt (a car swap); read by the self-test. */
    this._opponentEpoch = 0;
    this._engineDuck = 0;
    this._sfxDuck = 0;
    this._camMode = 'chase';
    this._lastVols = { m: -1, s: -1, mu: -1, en: null };
    this._listenerPos = { x: 0, y: 0, z: 0 };
    this._listenerVel = { x: 0, y: 0, z: 0 };
    this._lastListener = null;
    this._playerThrottle = 0;
    this._unsub = [];
    this._scrapeCarryover = 0;
    /**
     * Test hook: force the opponent pack silent regardless of race state. The self-test uses it to
     * assert that "silent but still bound" really is silent, then releases it and checks the same
     * voices come back rather than new ones.
     */
    this._forceMute = false;
    /**
     * Self-test hook. When non-null every schedule uses this instead of `ac.currentTime`, which is
     * what lets the whole system be driven deterministically inside an OfflineAudioContext.
     */
    this.offlineTime = null;
    this.stats = { voices: 0, opponents: 0, profile: '—' };
  }

  /** Current schedule time (see `offlineTime`). */
  _t() {
    return this.offlineTime ?? this.ac?.currentTime ?? 0;
  }

  /**
   * True when it is safe to schedule sound. Before the user's first gesture the context is
   * suspended and its clock is frozen — scheduling then would pile every event onto t=0 and fire
   * them all at once the moment audio starts.
   */
  _live() {
    return (
      this.unlocked &&
      this.enabled &&
      !!this.ac &&
      (this.offlineTime !== null || this.ac.state !== 'suspended')
    );
  }

  async init() {
    this._subscribe();
    // Create the context here, during boot, rather than in the gesture handler. A browser will
    // happily construct an AudioContext without a gesture — it just starts `suspended` — and the
    // construction itself costs ~90 ms of audio-device startup. Paying that behind the loading
    // screen means unlock() is a resume() and never hitches the first frame of gameplay.
    this._createContext();
    return this;
  }

  /** Wire the bus handlers. Idempotent; split out so the offline harness can use them too. */
  _subscribe() {
    const bus = this.ctx?.bus;
    if (!bus?.on || this._unsub.length) return;
    const on = (name, fn) => this._unsub.push(bus.on(name, fn));

    on('car:shift', (e) => this._onShift(e));
    on('car:backfire', (e) => this._onBackfire(e));
    on('car:nos', (e) => this._onNos(e));
    on('car:collision', (e) => this._onCollision(e));
    on('car:land', (e) => this._onLand(e));
    on('race:countdown', (e) => this._onCountdown(e));
    on('race:start', () => this._onStart());
    on('race:finish', () => this._onFinish());
    on('lap:complete', (e) => this._onLap(e));
    on('camera:mode', (e) => (this._camMode = e?.mode ?? 'chase'));
    on('quality:change', (e) => this.onQuality(e?.tier));
    // A different car in the player's seat changes what the whole field should sound like: the
    // opponent slot set is tied to the car definitions, so it is rebuilt from scratch.
    on('car:change', (e) => this._onPlayerCarChange(e));
    on('race:restart', () => this._onRaceRestart());
    on('race:mode', () => this._onRaceRestart());
  }

  /* ------------------------------------------------------------ lifecycle */

  _createContext() {
    if (this.ac) return true;
    try {
      const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
      if (!AC) return false;
      this._buildMaster(new AC({ latencyHint: 'interactive' }));
      this.unlocked = true;
      // Voice construction is drained one task per frame in update(), so no single frame pays for
      // the whole graph.
      this._deferred = [
        // Generating a noise bed is the single most expensive task here (a 2 s stereo buffer is
        // ~400k samples on a 96 kHz device), so each colour gets its own frame.
        () => noiseBuffer(this.ac, 'white'),
        () => noiseBuffer(this.ac, 'pink'),
        () => noiseBuffer(this.ac, 'brown'),
        () => this._buildAmbience(),
        () => this._buildEngine(),
        () => this._buildSfx(),
        () => this._buildTyres(),
        () => this._buildReverb(0),
        () => this._buildReverb(1),
        () => this._buildMusic(),
        () => this._buildOpponents(),
      ];
      return true;
    } catch (e) {
      console.warn('[audio] unavailable:', e);
      this.enabled = false;
      return false;
    }
  }

  /**
   * Called from a user gesture (main.js arms it on first pointerdown/keydown). By this point the
   * graph already exists, so this is a resume() — sub-millisecond.
   */
  unlock() {
    if (!this.ac && !this._createContext()) return;
    try {
      this.ac.resume?.();
    } catch (e) {
      console.warn('[audio] resume failed:', e);
    }
  }

  /** True once the context is actually producing sound (i.e. the gesture has happened). */
  get running() {
    return !!this.ac && this.ac.state === 'running';
  }

  /** Build against an explicit context (used by the offline self-test). */
  attachContext(ac, opts = {}) {
    this.ac = null;
    this._subscribe();
    this._buildMaster(ac);
    this.unlocked = true;
    this._tier = TIER[opts.tier] ?? this._tier;
    this._buildAmbience();
    this._buildEngine(opts.def);
    this._buildSfx();
    this._buildTyres();
    this._buildReverb(0);
    this._buildReverb(1);
    if (opts.music !== false) this._buildMusic();
    // The pool matters to the lifecycle tests (shrink/expand/pause/car swap), so it is built here
    // rather than left to the deferred task queue, which an offline render never drains.
    this._buildOpponents();
    this._deferred = [];
    return this;
  }

  _buildMaster(ac) {
    this.ac = ac;
    const t0 = ac.currentTime;
    this._startTime = t0;

    this.master = ac.createGain();
    this.master.gain.value = this.enabled ? this.masterVolume : 0;
    this.master.connect(ac.destination);

    // Final safety net: tanh soft clip — |y| < 1 for any input.
    this.softClip = ac.createWaveShaper();
    this.softClip.curve = softClipCurve(1.35);
    this.softClip.oversample = '2x';
    this.softClip.connect(this.master);

    this.limiter = ac.createDynamicsCompressor();
    this.limiter.threshold.value = -3.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;
    this.limiter.connect(this.softClip);

    this.preMaster = ac.createGain();
    this.preMaster.gain.value = 0.72; // headroom
    this.preMaster.connect(this.limiter);

    this.sfxSum = ac.createGain();
    this.sfxSum.gain.value = this.sfxVolume;
    this.sfxSum.connect(this.preMaster);

    this.musicBus = ac.createGain();
    this.musicBus.gain.value = this.musicVolume;
    this.musicBus.connect(this.preMaster);

    this.engineBus = ac.createGain();
    this.engineBus.gain.value = 0.55;
    this.engineBus.connect(this.sfxSum);

    this.spatialBus = ac.createGain();
    this.spatialBus.gain.value = 0.8;
    this.spatialBus.connect(this.sfxSum);

    this.ambBus = ac.createGain();
    this.ambBus.gain.value = 0.7;
    this.ambBus.connect(this.sfxSum);

    this.sfxBus = ac.createGain();
    this.sfxBus.gain.value = 0.85;
    this.sfxBus.connect(this.sfxSum);

    // Sends exist immediately; the convolver is spliced in when it is built.
    this.reverbSend = ac.createGain();
    this.reverbSend.gain.value = 1;
    this.verbReturn = ac.createGain();
    this.verbReturn.gain.value = 0.5;
    this.verbReturn.connect(this.sfxSum);

    if (ac.listener?.forwardX) {
      ac.listener.forwardX.value = 0;
      ac.listener.forwardY.value = 0;
      ac.listener.forwardZ.value = -1;
      ac.listener.upX.value = 0;
      ac.listener.upY.value = 1;
      ac.listener.upZ.value = 0;
    }
  }

  _verbOpts() {
    return { seconds: this._tier.verb, decay: 2.4, damping: 0.5, predelay: 0.014 };
  }

  /**
   * The IR is rendered one channel per frame — a 1 s stereo tail is ~200k samples per channel and
   * rendering both at once is the single largest frame cost in the whole build.
   */
  _buildReverb(channel) {
    const ac = this.ac;
    if (!ac || this.convolver) return;
    const o = this._verbOpts();
    if (!this._verbBuffer) {
      this._verbBuffer = ac.createBuffer(2, Math.max(16, Math.floor(ac.sampleRate * o.seconds)), ac.sampleRate);
    }
    buildImpulseResponse(ac, { ...o, into: this._verbBuffer, only: channel });
    if (channel !== 1) return;
    this.convolver = ac.createConvolver();
    this.convolver.normalize = false;
    this.convolver.buffer = this._verbBuffer;
    this.reverbSend.connect(this.convolver).connect(this.verbReturn);
  }

  _buildAmbience() {
    if (this.ambience || !this.ac) return;
    this.ambience = new AmbienceVoice(this.ac, {
      dest: this.ambBus,
      startTime: this._startTime,
    });
  }

  _buildEngine(defOverride) {
    if (!this.ac) return;
    const def = defOverride ?? this.ctx?.cars?.player?.def ?? this.ctx?.player?.def;
    if (!def) return; // retried next frame
    if (this.engine && !this.engine.disposed && this.engine.def === def) return;
    // A car change is a change of note, but cutting the old voice dead is an audible click. Fade
    // it through the same retirement queue the opponent pool uses, then start the new one.
    if (this.engine) this._retire(this.engine, this._t());
    this.engine = new EngineVoice(this.ac, def, {
      dest: this.engineBus,
      reverbSend: this.reverbSend,
      harmonics: this._tier.harmonics,
      startTime: this._t(),
    });
    this.stats.profile = profileNameForCar(def);
  }

  _buildSfx() {
    if (this.sfx || !this.ac) return;
    this.sfx = new SfxBank(this.ac, {
      dest: this.sfxBus,
      spatialDest: this.spatialBus,
      reverbSend: this.reverbSend,
      startTime: this._startTime,
    });
  }

  _buildTyres() {
    if (this.tyres || !this.ac) return;
    this.tyres = new TyreVoice(this.ac, {
      dest: this.sfxBus,
      reverbSend: this.reverbSend,
      startTime: this._startTime,
    });
  }

  _buildMusic() {
    if (this.music || !this.ac || !this._tier.music) return;
    this.music = new MusicBed(this.ac, { dest: this.musicBus, startTime: this.ac.currentTime });
    const phase = this.ctx?.race?.phase;
    this.music.setSection(phase === 'racing' ? 'race' : phase === 'countdown' ? 'countdown' : 'idle');
  }

  /**
   * Resize the pool to the tier's voice count.
   *
   * Shrinking fades each surplus voice out first and hands it to `_retiring`; it is only
   * disconnected and its nodes freed once the fade has actually elapsed (see `_reapRetiring`).
   * Cutting it dead at the shrink instant is what left silent-but-connected voices in the mix.
   * Growing appends slots with no voice at all — a new voice is never created until a car is
   * actually bound to it, and it starts at zero gain, so expansion can never click.
   */
  _buildOpponents() {
    const n = Math.max(0, this._tier.opponents | 0);
    let changed = false;
    while (this._opponentSlots.length > n) {
      const slot = this._opponentSlots.pop();
      slot.car = null;
      if (slot.voice) {
        this._retire(slot.voice, this._t());
        slot.voice = null;
      }
      changed = true;
    }
    while (this._opponentSlots.length < n) {
      this._opponentSlots.push({ car: null, voice: null });
      changed = true;
    }
    if (changed) this._rebindCooldown = Math.min(this._rebindCooldown, REBIND_COOLDOWN);
  }

  /** Start a voice's fade and queue it for node teardown when the fade completes. */
  _retire(voice, t) {
    if (!voice || voice.disposed) return;
    let end;
    try {
      end = voice.release(t, VOICE_FADE);
    } catch {
      end = t;
    }
    // A voice already queued for teardown must not be queued twice.
    if (this._retiring.some((r) => r.voice === voice) || this._reaped.some((r) => r.voice === voice)) return;
    this._retiring.push({ voice, at: end });
  }

  /**
   * Disconnect + dispose every retired voice whose fade has elapsed. Called each update.
   *
   * In an OfflineAudioContext the whole timeline is scheduled before any of it is rendered, so
   * tearing nodes down mid-loop would erase the voice from the start of the render rather than
   * from the end of its fade. Offline, the source stops are therefore scheduled at the fade end
   * and the actual disconnect is deferred to `flushRetired()`, which the self-test calls after
   * `startRendering()`; live, teardown happens at the right wall-clock moment.
   */
  _reapRetiring(t) {
    for (let i = this._retiring.length - 1; i >= 0; i--) {
      const r = this._retiring[i];
      if (r.at > t) continue;
      if (this.offlineTime !== null) {
        r.voice.scheduleStop?.(r.at);
        this._reaped.push(r);
      } else {
        r.voice.disconnect?.();
        r.voice.dispose?.();
      }
      this._retiring.splice(i, 1);
    }
  }

  /** Offline only: tear down nodes whose fade completed during the scheduled run. */
  flushRetired() {
    for (const r of this._reaped) {
      r.voice.disconnect?.();
      r.voice.dispose?.();
    }
    this._reaped.length = 0;
  }

  onQuality(tier) {
    const t = TIER[tier] ?? TIER[this.ctx?.settings?.tier] ?? TIER.high;
    this._tier = t;
    if (!this.unlocked) return;
    this._buildOpponents();
    if (this.convolver && this.convolver.buffer && Math.abs(this.convolver.buffer.duration - t.verb) > 0.2) {
      this._verbBuffer = null;
      this.convolver.buffer = buildImpulseResponse(this.ac, this._verbOpts());
    }
  }

  /**
   * The player is now in a different car. Everything the pool knows about "what an opponent
   * sounds like" was derived from the previous hero car, so the pool is dropped and rebuilt:
   * every bound voice is faded out, freed by `_reapRetiring`, and the player's own engine is
   * rebuilt from the new definition. The next rebind creates voices from the new car's def.
   */
  _onPlayerCarChange(e) {
    const def = e?.car?.def ?? this.ctx?.cars?.player?.def ?? this.ctx?.player?.def;
    this._resetOpponentPool();
    this._engineDuck = 0;
    if (def) this._buildEngine(def);
  }

  /**
   * Race restart / mode change: the pack is re-spawned at the line, and may be a different set of
   * cars. Bindings are dropped (not re-pointed) so no voice can survive over to the wrong car,
   * and the player engine is rebuilt if the seat changed.
   */
  _onRaceRestart() {
    this._resetOpponentPool();
    const def = this.ctx?.cars?.player?.def ?? this.ctx?.player?.def;
    if (def && this.engine?.def !== def) this._buildEngine(def);
  }

  /** Fade out and forget every bound voice, keeping the pool's capacity for the new binding. */
  _resetOpponentPool() {
    const t = this._t();
    for (const slot of this._opponentSlots) {
      slot.car = null;
      if (slot.voice) {
        this._retire(slot.voice, t);
        slot.voice = null;
      }
    }
    this._rebindCooldown = Math.min(this._rebindCooldown, REBIND_COOLDOWN);
    this._opponentEpoch++;
  }

  /* -------------------------------------------------------------- listener */

  setListener(camera) {
    this.listenerCamera = camera ?? null;
  }

  _updateListener(t, dt) {
    const ac = this.ac;
    const cam = this.listenerCamera ?? this.ctx?.camera;
    const L = ac?.listener;
    if (!cam || !L) return;
    const m = cam.matrixWorld?.elements;
    if (!m) return;

    const px = m[12];
    const py = m[13];
    const pz = m[14];
    // Three.js camera looks down its local -Z.
    const fx = -m[8];
    const fy = -m[9];
    const fz = -m[10];
    const ux = m[4];
    const uy = m[5];
    const uz = m[6];

    if (this._lastListener && dt > 1e-4) {
      const k = clamp01(dt * 12);
      this._listenerVel.x += ((px - this._lastListener.x) / dt - this._listenerVel.x) * k;
      this._listenerVel.y += ((py - this._lastListener.y) / dt - this._listenerVel.y) * k;
      this._listenerVel.z += ((pz - this._lastListener.z) / dt - this._listenerVel.z) * k;
    }
    this._lastListener = this._lastListener || { x: px, y: py, z: pz };
    this._lastListener.x = px;
    this._lastListener.y = py;
    this._lastListener.z = pz;
    this._listenerPos.x = px;
    this._listenerPos.y = py;
    this._listenerPos.z = pz;

    if (L.positionX) {
      // Short time constants: the listener must not lag the camera or panning smears.
      ramp(L.positionX, px, t, 0.012);
      ramp(L.positionY, py, t, 0.012);
      ramp(L.positionZ, pz, t, 0.012);
      ramp(L.forwardX, fx, t, 0.02);
      ramp(L.forwardY, fy, t, 0.02);
      ramp(L.forwardZ, fz, t, 0.02);
      ramp(L.upX, ux, t, 0.05);
      ramp(L.upY, uy, t, 0.05);
      ramp(L.upZ, uz, t, 0.05);
    } else {
      L.setPosition?.(px, py, pz);
      L.setOrientation?.(fx, fy, fz, ux, uy, uz);
    }
  }

  /* ---------------------------------------------------------------- events */

  _carOf(e) {
    return e?.car ?? null;
  }

  _isPlayer(car) {
    const p = this.ctx?.cars?.player ?? this.ctx?.player;
    return !car || car === p;
  }

  /** World position for spatialised event sfx; null for the player (heard dry, in the cabin). */
  _posOf(car, fallback) {
    if (!car || this._isPlayer(car)) return null;
    return car.state?.position ?? fallback ?? null;
  }

  _onShift({ car, up } = {}) {
    if (!this._live()) return;
    const t = this._t();
    const player = this._isPlayer(car);
    this.sfx?.trigger('shift', { volume: player ? 1 : 0.5, up, position: this._posOf(car) }, t);
    if (player && this.engine) {
      if (up) {
        this.engine.cut(0.75, 0.06, t);
        this.engine.blowOff(0.9, t + 0.02);
        // Ignition-cut overrun crackle: two or three pops in the pipe, not one.
        const s = clamp01(this._playerThrottle);
        if (s > 0.35) {
          this.sfx?.trigger('backfire', { strength: 0.55 + 0.45 * s, volume: 0.9 }, t + 0.045);
          this.sfx?.trigger('backfire', { strength: 0.3 + 0.3 * s, volume: 0.6 }, t + 0.075);
          if (s > 0.7) this.sfx?.trigger('backfire', { strength: 0.4, volume: 0.45 }, t + 0.108);
        }
      } else {
        this.engine.cut(0.3, 0.04, t);
      }
    }
  }

  _onBackfire({ car, strength = 1 } = {}) {
    if (!this._live()) return;
    const t = this._t();
    this.sfx?.trigger('backfire', {
      strength: clamp01(strength),
      volume: this._isPlayer(car) ? 1 : 0.5,
      position: this._posOf(car),
    }, t);
  }

  _onNos({ car, active } = {}) {
    if (!this._live()) return;
    if (!this._isPlayer(car)) return;
    this.sfx?.trigger('nos', { active: !!active, volume: 1 }, this._t());
  }

  _onCollision({ car, impulse = 0, point, tag } = {}) {
    if (!this._live()) return;
    const t = this._t();
    // impulse arrives in N·s; normalise against a ~1.4 t car hitting a wall at ~25 m/s.
    const str = clamp01(Math.abs(impulse) / 34000);
    const vol = this._isPlayer(car) ? 1 : 0.55;
    if (str < 0.02) return;
    this.sfx?.trigger('impact', { strength: str, volume: vol, position: this._posOf(car, point), tag }, t);
    // Glancing hits leave a scrape behind them.
    const s = car?.state ?? this.ctx?.cars?.player?.state;
    const glancing = str < 0.35 && Math.abs(s?.speed ?? 0) > 8;
    if (glancing && this._isPlayer(car)) this._scrapeCarryover = Math.max(this._scrapeCarryover, 0.55);
  }

  _onLand({ car, impact = 0 } = {}) {
    if (!this._live()) return;
    const str = clamp01(Math.abs(impact) / 11);
    this.sfx?.trigger('land', {
      strength: str,
      volume: this._isPlayer(car) ? 1 : 0.5,
      position: this._posOf(car),
    }, this._t());
  }

  _onCountdown({ n } = {}) {
    if (!this._live()) return;
    const t = this._t();
    this.music?.setSection('countdown', t);
    if (n === 3) this.music?.riser(3.05, t);
    this.sfx?.trigger('countdown', { final: n === 0, volume: 1 }, t);
  }

  _onStart() {
    if (!this._live()) return;
    const t = this._t();
    this.music?.setSection('race', t);
    this.music?.hit(t, 1);
  }

  _onFinish() {
    if (!this._live()) return;
    const t = this._t();
    this.music?.setSection('finish', t);
    this.music?.hit(t, 0.8);
  }

  _onLap({ car, lap } = {}) {
    if (!this._live()) return;
    if (!this._isPlayer(car)) return;
    const t = this._t();
    this.sfx?.trigger('lap', { volume: 0.8 }, t);
    const total = this.ctx?.race?.totalLaps ?? 3;
    if (lap >= total - 1 && this.ctx?.race?.phase !== 'finished') {
      this.music?.setSection('final', t);
      this.music?.riser(2.2, t);
    }
  }

  /* -------------------------------------------------------------- public API */

  /**
   * Fire a one-shot (or toggle a sustained voice). Returns a handle even when audio is unavailable,
   * so callers never need to null-check.
   * @param {string} name  'shift'|'impact'|'backfire'|'land'|'nos'|'scrape'|'countdown'|'lap'|'ui'
   * @param {object} opts  { volume, strength, position:{x,y,z}, rate, up, active, tag, freq }
   */
  play(name, opts = {}) {
    if (!this._live() || !this.sfx) return NOOP;
    try {
      const h = this.sfx.trigger(name, opts, this._t());
      if (opts.rate && h?.setRate) h.setRate(opts.rate);
      return h ?? NOOP;
    } catch (e) {
      console.warn('[audio] play failed', name, e);
      return NOOP;
    }
  }

  /* ---------------------------------------------------------------- update */

  update(dt, ctx) {
    if (!this.unlocked) return;
    const ac = this.ac;
    if (!ac) return;
    const t = this._t();
    const step = clamp(dt || 1 / 60, 1 / 480, 0.2);

    // volume / enable plumbing
    if (this._lastVols.en !== this.enabled || this._lastVols.m !== this.masterVolume) {
      ramp(this.master.gain, this.enabled ? clamp(this.masterVolume, 0, 1.5) : 0, t, 0.03);
      this._lastVols.en = this.enabled;
      this._lastVols.m = this.masterVolume;
    }
    if (this._lastVols.s !== this.sfxVolume) {
      ramp(this.sfxSum.gain, clamp(this.sfxVolume, 0, 1.5), t, 0.05);
      this._lastVols.s = this.sfxVolume;
    }
    if (this._lastVols.mu !== this.musicVolume) {
      ramp(this.musicBus.gain, clamp(this.musicVolume, 0, 1.5), t, 0.15);
      this._lastVols.mu = this.musicVolume;
    }
    if (!this.enabled) return;

    // While the context is suspended (pre-gesture) nothing is audible and currentTime is frozen —
    // keep building the graph, but don't run the schedulers against a clock that isn't moving.
    const suspended = this.ac.state === 'suspended' && this.offlineTime === null;

    // one deferred build per frame
    if (this._deferred.length) {
      const task = this._deferred.shift();
      try {
        task();
      } catch (e) {
        console.warn('[audio] deferred build failed', e);
      }
    } else if (!this.engine) {
      this._buildEngine(); // the player car does not exist yet when init() runs
    }
    if (suspended) return;

    this._updateListener(t, step);

    const player = ctx?.cars?.player ?? ctx?.player ?? null;
    const s = player?.state ?? null;
    this._playerThrottle = s?.throttle ?? 0;

    // Camera perspective changes the mix: inside the car you hear engine, outside you hear air.
    const inCar = this._camMode === 'hood' || this._camMode === 'bumper';
    const cine = this._camMode === 'cinematic' || this._camMode === 'orbit' || this._camMode === 'photo';
    const engineGain = inCar ? 1.16 : cine ? 0.82 : 1;
    const ambGain = inCar ? 0.75 : cine ? 1.1 : 1;

    /* ---- player engine ---- */
    if (this.engine && s) {
      if (player?.def && this.engine.def !== player.def) this._buildEngine(player.def);
      this.engine.update(s, t, { dt: step, gain: engineGain });
      this._engineDuck = damp(this._engineDuck, this.engine.loudness, 10, step);
    } else if (this.engine) {
      this.engine.silence(t);
      this._engineDuck = damp(this._engineDuck, 0, 6, step);
    }
    ramp(this.engineBus.gain, 0.55, t, 0.2);

    /* ---- tyres ---- */
    if (this.tyres) this.tyres.update(s, t, { gain: inCar ? 1.1 : 1 });

    /* ---- wind + road ---- */
    if (this.ambience) {
      this.ambience.update(s, t, { gain: ambGain, duck: this._engineDuck });
    }

    /* ---- sfx housekeeping ---- */
    if (this.sfx) {
      if (this._scrapeCarryover > 0) {
        this.sfx.trigger('scrape', { strength: this._scrapeCarryover }, t);
        this._scrapeCarryover = Math.max(0, this._scrapeCarryover - step * 1.4);
      }
      this.sfx.update(step, t, { speed: Math.abs(s?.speed ?? 0) });
      this._sfxDuck = damp(this._sfxDuck, this.sfx.loudness, 12, step);
    }

    /* ---- opponents ---- */
    // Retired voices finish their fade even while the pack is muted or the pool is empty.
    this._reapRetiring(t);
    this._updateOpponents(t, step, ctx, this._packAudible(ctx));

    /* ---- music ---- */
    if (this.music) {
      this.music.update(step, t, {
        engine: this._engineDuck,
        sfx: Math.max(this._sfxDuck, (this.tyres?.loudness ?? 0) * 0.7),
      });
    }

    this.stats.voices =
      (this.engine ? 1 : 0) + this._opponentSlots.filter((x) => x.voice).length + (this.music ? 1 : 0);
  }

  /**
   * Update while the simulation is frozen (Esc / pause screen). The player's own layers are
   * driven with an empty state so wind, road and tyre noise stop with the car; the opponent pool
   * is silenced but its bindings are kept, so resuming picks the same voice up on the same car.
   * Called by main.js from the paused branch of the frame loop instead of `update()`.
   */
  updatePaused(dt, ctx) {
    if (!this.unlocked || !this.ac || !this.enabled) return;
    const t = this._t();
    const step = clamp(dt || 1 / 60, 1 / 480, 0.2);
    this._reapRetiring(t);
    // The camera still settles while paused, so the listener keeps tracking it; only the car
    // layers are parked.
    this._updateListener(t, step);
    this.engine?.silence(t);
    this.tyres?.update(null, t, {});
    this.ambience?.update(null, t, { gain: 1, duck: 0 });
    this.sfx?.update(step, t, { speed: 0 });
    for (const slot of this._opponentSlots) slot.voice?.silence(t);
    this._engineDuck = damp(this._engineDuck, 0, 10, step);
    this._sfxDuck = damp(this._sfxDuck, 0, 10, step);
    this.stats.opponents = 0;
    void ctx;
  }

  /**
   * Should the car voices be sounding right now?
   *
   * A paused race, the results screen, the front end, or any overlay that freezes the pack all
   * mean the same thing: the field is not moving, so its engines must not keep droning. Bindings
   * are kept (see `_updateOpponents`) — only the sound is parked — so resuming never has to
   * rebuild the pool and can never end up with two voices for one car.
   */
  _packAudible(ctx) {
    if (this._forceMute) return false;
    // `ctx.game.paused` is the harness/QA freeze; `race.paused` is the player's pause screen.
    // Both freeze the pack, so both must silence it.
    if (ctx?.game?.paused ?? this.ctx?.game?.paused) return false;
    const race = ctx?.race ?? this.ctx?.race;
    if (race) {
      if (race.paused) return false;
      const phase = race.phase;
      if (phase === 'finished' || phase === 'idle') return false;
    }
    const screen = ctx?.hud?.screen ?? this.ctx?.hud?.screen;
    // 'paused' keeps the HUD screen name while the pause flag is set, so it is already covered by
    // the race.paused check; 'race' is the only driving screen. Everything else is a menu.
    if (screen && screen !== 'race' && screen !== 'paused') return false;
    return true;
  }

  /**
   * Assign the pooled spatial voices to the nearest opponents.
   *
   * The pool is a fixed number of voices; cars are bound to them by distance. Three properties
   * matter and each has a test:
   *
   *  • **nearest first, never more than the tier allows.** The candidate list is sorted by
   *    listener distance and truncated to the slot count.
   *  • **no churn when places swap.** A currently bound car keeps its slot unless a challenger
   *    is closer by `REBIND_HYSTERESIS` (12%), and rebinding only happens once per
   *    `REBIND_COOLDOWN`. Two cars side by side therefore do not trade the voice every frame.
   *  • **silent-but-bound while frozen.** When the race is paused/finished or the front end is
   *    up, every voice is silenced but the `car` binding is left intact. Unfreezing resumes the
   *    same voice on the same car from its current state, so no duplicate voice is ever created.
   */
  _updateOpponents(t, dt, ctx, audible = true) {
    const slots = this._opponentSlots;
    this.stats.opponents = 0;
    if (!slots.length) {
      // Still park anything bound to a slot that no longer exists (shouldn't happen, but a
      // shrink + a rebind in the same frame must not leave an unowned voice running).
      this._rebindCooldown = Math.min(this._rebindCooldown, REBIND_COOLDOWN);
      return;
    }
    const cars = ctx?.cars?.instances;
    const player = ctx?.cars?.player ?? ctx?.player ?? null;
    const lp = this._listenerPos;

    // Frozen: keep bindings, park the voices. This is the pause / results / menu path.
    if (!audible) {
      for (const slot of slots) {
        slot.voice?.silence(t);
      }
      return;
    }

    this._rebindCooldown -= dt;

    if (cars?.length && this._rebindCooldown <= 0) {
      this._rebindCooldown = REBIND_COOLDOWN;
      this._rebind(t, cars, player, lp);
    }

    // Follow each bound car. A slot whose car went away (spawn churn, restart) is silenced but
    // keeps its voice; the next rebind decides whether that voice is reused or retired.
    let live = 0;
    for (const slot of slots) {
      if (!slot.voice) continue;
      if (!slot.car?.state) {
        slot.voice.silence(t);
        continue;
      }
      live++;
      const st = slot.car.state;
      const cents = slot.voice.place(st.position, st.velocity, lp, this._listenerVel, t);
      slot.voice.update(st, t, { dt, gain: 0.85, doppler: cents });
    }
    this.stats.opponents = live;
  }

  /**
   * Recompute the binding set, keeping hysteresis on the cars that already hold a voice.
   * Split out from `_updateOpponents` so the self-test can reason about a single rebind tick.
   */
  _rebind(t, cars, player, lp) {
    const slots = this._opponentSlots;
    const n = slots.length;

    // ---- candidates, nearest first ----
    const cand = [];
    for (const c of cars) {
      if (c === player || !c.state || !c.def) continue;
      const p = c.state.position;
      const d = Math.hypot(p.x - lp.x, p.y - lp.y, p.z - lp.z);
      if (d < AUDIBLE_RANGE) cand.push({ car: c, d });
    }
    cand.sort((a, b) => a.d - b.d);
    if (!cand.length) {
      for (const slot of slots) if (slot.car) slot.car = null;
      return;
    }
    const distOf = new Map();
    for (const c of cand) distOf.set(c.car, c.d);

    // ---- keep what is still in range, then fill the free slots with the nearest newcomers ----
    const want = [];
    for (const slot of slots) {
      if (slot.car && distOf.has(slot.car)) want.push(slot.car);
    }
    // A car can only be in one slot; drop any duplicate a previous bug may have left behind.
    for (let i = 0; i < want.length; i++) {
      for (let j = want.length - 1; j > i; j--) {
        if (want[j] === want[i]) want.splice(j, 1);
      }
    }
    for (const c of cand) {
      if (want.length >= n) break;
      if (!want.includes(c.car)) want.push(c.car);
    }
    // Trim if the retained set somehow exceeds capacity (defensive; cannot happen normally).
    while (want.length > n) want.pop();

    // ---- hysteresis: only a clearly closer car displaces a bound one ----
    // Iterate because one swap changes who the "farthest bound car" is. Bounded by the candidate
    // count, so this cannot spin.
    for (let guard = 0; guard < cand.length + n; guard++) {
      let worstIdx = -1;
      let worstD = -Infinity;
      for (let i = 0; i < want.length; i++) {
        const d = distOf.get(want[i]) ?? Infinity;
        if (d > worstD) {
          worstD = d;
          worstIdx = i;
        }
      }
      let bestNew = null;
      for (const c of cand) {
        if (want.includes(c.car)) continue;
        if (!bestNew || c.d < bestNew.d) bestNew = c;
      }
      if (!bestNew || worstIdx < 0) break;
      // The challenger must beat the incumbent by the margin, and the incumbent must still be
      // a real candidate for the swap to make sense.
      if (bestNew.d >= worstD * (1 - REBIND_HYSTERESIS)) break;
      want[worstIdx] = bestNew.car;
    }

    // ---- apply ----
    const wanted = new Set(want);
    for (const slot of slots) {
      if (slot.car && !wanted.has(slot.car)) {
        slot.car = null;
        // Keep the voice: an unbound voice is silent and may be reused for a car of the same
        // type next rebind. Only a type change forces a rebuild.
        slot.voice?.silence(t);
      }
    }
    for (const car of want) {
      if (slots.some((sl) => sl.car === car)) continue;
      const free = slots.find((sl) => !sl.car);
      if (!free) break;
      free.car = car;
      if (!free.voice || free.voice.disposed || free.voice.def !== car.def) {
        if (free.voice) this._retire(free.voice, t);
        free.voice = this._makeOpponentVoice(car.def, t);
      }
    }
  }

  /** Build one spatial opponent voice. Always starts at zero gain (see EngineVoice's out node). */
  _makeOpponentVoice(def, t) {
    const voice = new EngineVoice(this.ac, def, {
      spatial: true,
      dest: this.spatialBus,
      reverbSend: this.reverbSend,
      harmonics: Math.min(112, this._tier.harmonics),
      startTime: t,
    });
    if (voice.panner && !this._tier.hrtf) voice.panner.panningModel = 'equalpower';
    return voice;
  }

  dispose() {
    for (const u of this._unsub) {
      try {
        u?.();
      } catch {
        /* ignore */
      }
    }
    this._unsub.length = 0;
    this.engine?.dispose();
    this.tyres?.dispose();
    this.ambience?.dispose();
    this.sfx?.dispose();
    this.music?.dispose();
    for (const r of this._retiring) r.voice.dispose?.();
    this._retiring.length = 0;
    for (const r of this._reaped) r.voice.dispose?.();
    this._reaped.length = 0;
    for (const s of this._opponentSlots) s.voice?.dispose();
    this._opponentSlots.length = 0;
    this.ac?.close?.();
    this.unlocked = false;
  }
}
