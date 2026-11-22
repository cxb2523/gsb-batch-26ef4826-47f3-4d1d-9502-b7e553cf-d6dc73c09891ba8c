import type { Quaternion } from 'three';
import type { V3 } from '../../core/entities';
import type { Game } from '../../core/Game';
import { PRIORITY, type GameSystem, type SystemModule } from '../../core/System';
import { AmbientManager } from './ambientManager';
import type { AudioApi, AudioBus, LoopHandle, LoopParams, PlayOptions } from './api';
import { AudioConfig } from './config';
import { EventCues } from './eventCues';
import { FootstepDriver } from './footstepDriver';
import { AudioGraph, BUSES } from './graph';
import { defaultBus, getRecipe, isLoopId } from './recipes';
import { isSoundId, SOUND_IDS, type SoundId } from './sounds';
import { Voice } from './voice';
import { VoicePool } from './voicePool';

const V = AudioConfig.voices;

/**
 * Procedural Web Audio implementation of `AudioApi` (docs/TEAM-PLAN.md §3.6).
 * Every sound is synthesised from a recipe in `./recipes`; voices are pooled and
 * capped; ambient beds and footsteps are driven from `update`. When Web Audio is
 * unavailable it behaves exactly like `NullAudio`.
 *
 * Loop handle contract: a handle is live while `handle.alive` and the voice is in
 * `loopVoices`. Both `stop()` and a pool steal run the same `retireLoop` teardown
 * (handle invalidated, slot freed, voice faded then killed), so every handle-based
 * call degrades to a silent no-op once the handle dies.
 */
export class AudioSystem implements GameSystem, AudioApi {
  private graph: AudioGraph | null = null;
  private readonly warned = new Set<string>();
  private graphFailed = false;
  private readonly busVolumes: Record<AudioBus, number>;
  private readonly pool = new VoicePool<Voice>(V.maxOneShots, V.maxLoops);
  private readonly loopVoices = new Map<number, Voice>();
  /** Stopped or stolen loops fading out; killed by `update` once their fade ends. */
  private readonly retiring: Voice[] = [];
  private nextHandleId = 1;
  private nextVoiceId = 1;
  private readonly ambient: AmbientManager;
  private readonly footsteps: FootstepDriver;
  private readonly cues: EventCues;
  private radioHandle: LoopHandle | null = null;
  private readonly failedIds = new Set<string>();
  private readonly offs: (() => void)[] = [];
  private pruneNow = 0;
  private pruneWall = 0;
  /** Wall clock of the latest `update` (the pause path has no other time source). */
  private updateWallNow = 0;
  /** True while the pause menu owns the screen and the context is suspended on purpose. */
  private menuPaused = false;
  private readonly isExpired = (v: Voice): boolean => v.expired(this.pruneNow, this.pruneWall);
  private readonly onGesture = (): void => this.resume();
  private readonly onPause = (): void => {
    this.menuPaused = true;
    // Freeze the context while the menu owns the screen: nothing advances underneath,
    // so no loop can ring into the menu. Live loops keep their handles and are fully
    // adjustable after the resume; loops stopped while paused are never revived.
    // One-shots keep expiring by wall clock, so a frozen transient still dies.
    this.graph?.suspend();
  };
  private readonly onResume = (): void => {
    this.menuPaused = false;
    // Loops that were live keep playing (and stay adjustable); loops stopped while
    // paused already left `loopVoices` and are never revived. Stale one-shot tails
    // are expired by their wall-clock deadline, which kept running during the pause.
    this.graph?.resume();
  };
  private readonly onVoiceEnd = (voice: Voice): void => {
    this.pool.remove(voice);
    const i = this.retiring.indexOf(voice);
    if (i >= 0) this.retiring.splice(i, 1);
    this.releaseHandle(voice);
  };

  constructor(private readonly game: Game) {
    this.busVolumes = loadVolumes();
    this.ambient = new AmbientManager(game, this);
    this.footsteps = new FootstepDriver(game, this);
    this.cues = new EventCues(game, this);
  }

  init(): void {
    this.game.perf.set('sounds', SOUND_IDS.length);
    for (const type of ['keydown', 'mousedown', 'pointerdown'] as const) {
      window.addEventListener(type, this.onGesture, { passive: true });
    }
    this.offs.push(this.game.events.on('ui:newGame', this.onGesture), this.game.events.on('ui:continue', this.onGesture));
    this.offs.push(this.game.events.on('ui:paused', this.onPause), this.game.events.on('ui:resumed', this.onResume));
    this.cues.attach();
  }

  update(dt: number): void {
    this.updateWallNow = performance.now();
    const graph = this.graph;
    if (graph) {
      const now = graph.now;
      this.pruneNow = now;
      this.pruneWall = this.updateWallNow;
      this.prunePool();
      const loops = this.pool.loops;
      for (let i = 0; i < loops.length; i++) loops[i].synth.onUpdate?.(now);
      this.pruneRetiring(now);
      this.game.perf.set('voices', this.pool.active);
    }
    this.footsteps.update(dt);
    this.ambient.update(dt);
  }

  dispose(): void {
    for (const type of ['keydown', 'mousedown', 'pointerdown'] as const) window.removeEventListener(type, this.onGesture);
    for (const off of this.offs) off();
    this.cues.dispose();
    this.ambient.dispose();
    this.pool.killAll();
    // `kill()` can re-enter `onVoiceEnd`, which splices `retiring`; walk it from the end.
    for (let i = this.retiring.length - 1; i >= 0; i--) this.retiring[i].kill();
    this.retiring.length = 0;
    this.loopVoices.clear();
    this.graph?.dispose();
    this.graph = null;
  }

  // --- AudioApi ---------------------------------------------------------------------

  play(id: SoundId, opts?: PlayOptions): void {
    this.validate(id);
    if (!isSoundId(id)) return;
    try {
      if (isLoopId(id)) {
        const voice = this.startVoice(id, true, opts);
        if (voice) voice.fadeOut(voice.startedAt + V.playLoopSeconds, V.stopFade * 3);
      } else {
        this.startVoice(id, false, opts);
      }
    } catch (err) {
      this.reportFailure(id, err);
    }
  }

  loop(id: SoundId, opts?: PlayOptions): LoopHandle {
    this.validate(id);
    const handle: LoopHandle = { id: this.nextHandleId++, sound: id, alive: true };
    if (!isSoundId(id)) return handle;
    try {
      const voice = this.startVoice(id, true, opts);
      if (voice) {
        voice.handle = handle;
        this.loopVoices.set(handle.id, voice);
      }
    } catch (err) {
      this.reportFailure(id, err);
    }
    return handle;
  }

  stop(handle: LoopHandle): void {
    handle.alive = false;
    const voice = this.loopVoices.get(handle.id);
    if (!voice) return;
    if (!this.graph) {
      // No graph (silent fallback): nothing is playing, just drop the bookkeeping.
      this.pool.remove(voice);
      this.releaseHandle(voice);
      voice.kill();
      return;
    }
    this.retireLoop(voice, this.graph.now);
  }

  setLoopParams(handle: LoopHandle, params: LoopParams): void {
    if (!handle.alive) return;
    const voice = this.loopVoices.get(handle.id);
    if (!voice || !this.graph) return;
    const now = this.graph.now;
    if (params.volume !== undefined) voice.setVolume(clamp01(params.volume), now);
    if (params.pitch !== undefined) voice.setPitch(Math.max(0.05, params.pitch), now);
    if (params.position) voice.setPosition(params.position, now);
  }

  /** Long volume ramp for a live loop (ambient crossfades). */
  fadeLoop(handle: LoopHandle, volume: number, seconds: number): void {
    if (!handle.alive) return;
    const voice = this.loopVoices.get(handle.id);
    if (!voice || !this.graph) return;
    voice.setVolume(clamp01(volume), this.graph.now, Math.max(0.01, seconds / 3));
  }

  engine(handle: LoopHandle, rpm01: number, throttle01: number, speedMs: number): void {
    if (!handle.alive) return;
    const voice = this.loopVoices.get(handle.id);
    if (!voice || !this.graph) return;
    voice.synth.onEngine?.(clamp01(rpm01), clamp01(throttle01), speedMs, this.graph.now);
  }

  siren(handle: LoopHandle, on: boolean): void {
    if (!handle.alive) return;
    const voice = this.loopVoices.get(handle.id);
    if (!voice || !this.graph) return;
    voice.synth.onSiren?.(on, this.graph.now);
  }

  setListener(position: V3, quaternion: Quaternion, velocity: V3): void {
    this.graph?.setListener(position, quaternion, velocity);
  }

  setBusVolume(bus: AudioBus, volume: number): void {
    const v = clamp01(volume);
    this.busVolumes[bus] = v;
    this.graph?.setBusVolume(bus, v);
    saveVolumes(this.busVolumes);
  }

  getBusVolume(bus: AudioBus): number {
    return this.busVolumes[bus];
  }

  radio(on: boolean): void {
    if (on) {
      if (this.radioHandle?.alive) return;
      this.play('radio.switch', { bus: 'music' });
      this.radioHandle = this.loop('radio.synthwave.loop', { bus: 'music' });
    } else if (this.radioHandle) {
      this.stop(this.radioHandle);
      this.radioHandle = null;
      this.play('radio.off', { bus: 'music' });
    }
  }

  resume(): void {
    if (this.menuPaused) return;
    this.graph?.resume();
  }

  // --- Introspection -----------------------------------------------------------------

  get activeVoices(): number {
    return this.pool.active;
  }

  get radioOn(): boolean {
    return this.radioHandle?.alive === true;
  }

  voiceStats(): { oneShots: number; loops: number; maxOneShots: number; maxLoops: number; stolen: number } {
    return { oneShots: this.pool.oneShots.length, loops: this.pool.loops.length, maxOneShots: V.maxOneShots, maxLoops: V.maxLoops, stolen: this.pool.stolen };
  }

  // --- Internals ------------------------------------------------------------------------

  private ensureGraph(): AudioGraph | null {
    if (this.graph || this.graphFailed) return this.graph;
    this.graph = AudioGraph.tryCreate(this.busVolumes);
    if (!this.graph) {
      this.graphFailed = true;
      return null;
    }
    // A context created while the pause menu is open must start frozen with the rest.
    if (this.menuPaused) this.graph.suspend();
    return this.graph;
  }

  private startVoice(id: SoundId, loop: boolean, opts?: PlayOptions): Voice | null {
    const graph = this.ensureGraph();
    if (!graph) return null;
    const position = opts?.position;
    if (position && !loop && graph.distanceTo(position) > V.maxDistance) return null;
    const bus = graph.buses[opts?.bus ?? defaultBus(id)];
    const volume = clamp01(opts?.volume ?? 1);
    const pitch = Math.max(0.05, opts?.pitch ?? 1);
    const voice = new Voice(this.nextVoiceId++, id, loop, graph, bus, getRecipe(id), volume, pitch, position, V.maxDistance);
    voice.onEnd = this.onVoiceEnd;
    // A stolen loop must go through the same teardown as `stop()`: fade out and
    // invalidate its handle, never keep operating on a voice the pool has freed.
    if (loop) voice.onStolen = (): void => this.retireLoop(voice, graph.now);
    this.pool.add(voice);
    return voice;
  }

  /** Detaches the handle bookkeeping for a voice (idempotent). */
  private releaseHandle(voice: Voice): void {
    const handle = voice.handle;
    if (!handle) return;
    voice.handle = null;
    handle.alive = false;
    if (this.loopVoices.get(handle.id) === voice) this.loopVoices.delete(handle.id);
  }

  /**
   * The single teardown path for a live loop, shared by `stop()` and pool steals:
   * forget the handle and free the pool slot immediately (so later calls are silent
   * no-ops and neither `loopVoices` nor `voiceStats()` keeps residue), then let the
   * voice fade out; it is killed once the fade window is over.
   */
  private retireLoop(voice: Voice, now: number): void {
    this.releaseHandle(voice);
    this.pool.remove(voice);
    if (voice.ended) return;
    if (!voice.stopping) voice.fadeOut(now, V.stopFade);
    if (this.retiring.indexOf(voice) < 0) this.retiring.push(voice);
  }

  /** Kills expired one-shots and loops left in the pool (e.g. `play()` of a loop id). */
  private prunePool(): void {
    this.pool.prune(this.isExpired);
  }

  /** Kills retired loops once their fade window is over so their nodes are freed. */
  private pruneRetiring(now: number): void {
    // While the context is frozen the audio clock does not advance, so a fade that
    // would end during the pause is allowed to finish after the resume instead.
    if (this.menuPaused) return;
    for (let i = this.retiring.length - 1; i >= 0; i--) {
      const v = this.retiring[i];
      if (!v.expired(now, this.updateWallNow)) continue;
      this.retiring.splice(i, 1);
      v.kill();
    }
  }

  /** Same one-time warning as `NullAudio` for ids missing from `sounds.ts`. */
  private validate(id: string): void {
    if (isSoundId(id) || this.warned.has(id)) return;
    this.warned.add(id);
    console.warn(`[audio] unknown sound id '${id}' (add it to src/systems/audio/sounds.ts)`);
  }

  private reportFailure(id: string, err: unknown): void {
    if (this.failedIds.has(id)) return;
    this.failedIds.add(id);
    console.warn(`[audio] recipe '${id}' failed`, err);
  }

  debugActions = {
    /** Plays every sound id once, 30 ms apart. Returns the count. */
    playAll: (): number => {
      SOUND_IDS.forEach((id, i) => setTimeout(() => this.play(id), i * AudioConfig.debug.playAllStaggerMs));
      return SOUND_IDS.length;
    },
    voices: (): ReturnType<AudioSystem['voiceStats']> => this.voiceStats(),
    radio: (on: unknown): boolean => {
      this.radio(on === undefined || on === true || on === 'true' || on === 1 || on === 'on');
      return this.radioOn;
    },
    bus: (bus: unknown, volume: unknown): number => {
      const b = String(bus) as AudioBus;
      if (!BUSES.includes(b)) throw new Error(`unknown bus '${String(bus)}'`);
      this.setBusVolume(b, Number(volume));
      return this.getBusVolume(b);
    },
    state: (): Record<string, unknown> => ({
      context: this.graph ? this.graph.ctx.state : this.graphFailed ? 'unavailable' : 'not-created',
      buses: { ...this.busVolumes },
      ambient: this.ambient.currentId,
      radio: this.radioOn,
      voices: this.voiceStats(),
    }),
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}

function loadVolumes(): Record<AudioBus, number> {
  const volumes = { ...AudioConfig.defaultBusVolumes };
  try {
    const raw = localStorage.getItem(AudioConfig.storageKey);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Record<AudioBus, unknown>>;
      for (const bus of BUSES) {
        const v = parsed[bus];
        if (typeof v === 'number' && Number.isFinite(v)) volumes[bus] = clamp01(v);
      }
    }
  } catch {
    // No storage (headless / privacy mode): keep defaults.
  }
  return volumes;
}

function saveVolumes(volumes: Record<AudioBus, number>): void {
  try {
    localStorage.setItem(AudioConfig.storageKey, JSON.stringify(volumes));
  } catch {
    // Storage unavailable.
  }
}

const module: SystemModule = {
  id: 'audio',
  priority: PRIORITY.audio,
  create: (game) => new AudioSystem(game),
};

export default module;
