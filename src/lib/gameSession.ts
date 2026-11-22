import { CODE_TO_KEY, createEmptyPlayerState } from './keymap';
import type { AudioPort } from './audioEngine';
import type { Level } from './level';

export interface GameSnapshot {
  level: Level | null;
  active: boolean;
  /** Increments on every `begin`; identifies this level's session. */
  generation: number;
  /** Physical key codes currently held, in press order. */
  pressedCodes: string[];
  playerState: number[];
  currentStep: number;
  /** 0 means the timer has not started for this session. */
  startTime: number;
  completed: boolean;
  finalTime: number;
}

type Listener = () => void;

/**
 * Pure, framework-free game session for one level.
 *
 * It is the single owner of:
 *  - which physical keys are held (shared by keyboard and touch input),
 *  - the player's nine-slot key state,
 *  - the current step and the timer origin,
 *  - the audio session bound to this level.
 *
 * Input is *ownership based*: every source (the keyboard, or an individual
 * touch point) must `press` and later `release` the same code. A code only
 * becomes "down" when its first owner presses it and only becomes "up" when
 * its last owner releases it. This is the single dedup rule for both input
 * paths, so multi-touch on the same zone and keyboard+touch on the same key
 * cannot produce ghost keys or cut a note short.
 */
export class GameSession {
  private readonly audio: AudioPort;
  private readonly clock: () => number;

  private level: Level | null = null;
  private active = false;
  private completed = false;
  private finalTime = 0;
  private generation = 0;

  private playerState: number[] = createEmptyPlayerState();
  private currentStep = 0;
  private startTime = 0;

  /** code -> set of sources currently holding it */
  private readonly heldSources = new Map<string, Set<string>>();

  private readonly listeners = new Set<Listener>();
  /** Cached snapshot so `useSyncExternalStore` sees a stable identity. */
  private cachedSnapshot: GameSnapshot | null = null;

  /** Called exactly once when the final pattern is matched. */
  onComplete: ((finalTime: number) => void) | null = null;

  constructor(audio: AudioPort, clock: () => number = () => Date.now()) {
    this.audio = audio;
    this.clock = clock;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): GameSnapshot {
    if (!this.cachedSnapshot) {
      this.cachedSnapshot = {
        level: this.level,
        active: this.active,
        generation: this.generation,
        pressedCodes: Array.from(this.heldSources.keys()),
        playerState: [...this.playerState],
        currentStep: this.currentStep,
        startTime: this.startTime,
        completed: this.completed,
        finalTime: this.finalTime,
      };
    }
    return this.cachedSnapshot;
  }

  /**
   * Start (or restart) this session for a level.
   *
   * Resets every piece of per-level state and opens a new audio session,
   * releasing anything still sounding from the previous level.
   */
  begin(level: Level): void {
    this.audio.beginLevelSession();

    this.generation += 1;
    this.level = level;
    this.active = true;
    this.completed = false;
    this.finalTime = 0;
    this.playerState = createEmptyPlayerState();
    this.currentStep = 0;
    this.startTime = 0;
    this.heldSources.clear();

    this.emit();
  }

  /**
   * Tear the session down (level finished, back to menu, unmount).
   * Releases every sounding note and clears all input state.
   */
  stop(): void {
    this.active = false;
    this.heldSources.clear();
    this.playerState = createEmptyPlayerState();
    this.currentStep = 0;
    this.startTime = 0;
    this.audio.endLevelSession();
    this.emit();
  }

  /**
   * A source reports that `code` is down. Returns true if this call changed
   * the player-visible state (i.e. it was the first owner).
   */
  press(code: string, source = 'keyboard'): boolean {
    if (!this.active || !this.level) return false;
    const binding = CODE_TO_KEY[code];
    if (!binding) return false;

    let sources = this.heldSources.get(code);
    if (sources) {
      if (sources.has(source)) return false; // duplicate press from same source
      sources.add(source);
      return false; // key was already down; nothing visible/audio changes
    }

    sources = new Set<string>([source]);
    this.heldSources.set(code, sources);

    // A real press is what starts the timer; it never restarts it.
    if (this.startTime === 0) {
      this.startTime = this.clock();
    }

    this.playerState = [...this.playerState];
    this.playerState[binding.index] = 1;
    this.audio.playNote(binding.key);

    this.evaluate();
    this.emit();
    return true;
  }

  /**
   * A source reports that `code` is up. Returns true if this call actually
   * released the key (i.e. it was the last owner).
   */
  release(code: string, source = 'keyboard'): boolean {
    if (!this.active || !this.level) return false;
    const binding = CODE_TO_KEY[code];
    if (!binding) return false;

    const sources = this.heldSources.get(code);
    if (!sources || !sources.has(source)) return false;

    sources.delete(source);
    if (sources.size > 0) return false; // another owner still holds it

    this.heldSources.delete(code);

    this.playerState = [...this.playerState];
    this.playerState[binding.index] = 0;
    this.audio.releaseNote(binding.key);

    this.evaluate();
    this.emit();
    return true;
  }

  /**
   * Release every key currently held by one source (e.g. a lifted touch
   * point, or the keyboard on window blur). Never affects other sources.
   */
  releaseSource(source: string): void {
    const held = Array.from(this.heldSources.entries());
    for (const [code, sources] of held) {
      if (sources.has(source)) {
        this.release(code, source);
      }
    }
  }

  private evaluate(): void {
    if (!this.active || !this.level) return;
    const target = this.level.patterns[this.currentStep];
    if (!target) return;

    const matches = this.playerState.every((value, index) => value === target[index]);
    if (!matches) return;

    if (this.currentStep < this.level.patterns.length - 1) {
      this.currentStep += 1;
      return;
    }

    // Final pattern: finish the level exactly once.
    this.completed = true;
    this.active = false;
    this.finalTime = this.startTime === 0 ? 0 : Math.max(0, this.clock() - this.startTime);
    this.heldSources.clear();
    this.playerState = createEmptyPlayerState();
    this.audio.endLevelSession();
    this.emit();
    this.onComplete?.(this.finalTime);
  }

  private emit(): void {
    this.cachedSnapshot = null;
    for (const listener of Array.from(this.listeners)) {
      listener();
    }
  }
}
