import * as Tone from 'tone';
import { AudioEngine, type AudioBackend } from './audioEngine';
import { KEY_BINDINGS } from './keymap';

const KEYS = KEY_BINDINGS.map((binding) => binding.key);

export const scales = {
  'C Major Chord': ['C2', 'E2', 'G2', 'A2', 'C3', 'G3', 'A3', 'C4', 'E4'],
  'C Major Scale': ['C2', 'D2', 'E2', 'F2', 'G2', 'A2', 'B2', 'C3', 'D3'],
  'Pentatonic':    ['C2', 'D2', 'E2', 'G2', 'A2', 'C3', 'D3', 'E3', 'G3'],
  'Harmonic Minor':['C2', 'D2', 'Eb2', 'F2', 'G2', 'Ab2', 'B2', 'C3', 'D3'],
  'Blues':         ['C2', 'Eb2', 'F2', 'F#2', 'G2', 'Bb2', 'C3', 'Eb3', 'F3'],
};

export type ScaleName = keyof typeof scales;

let currentScale: Record<string, string> = {};

function buildScaleMap(scaleName: ScaleName): Record<string, string> {
  const notes = scales[scaleName];
  const scaleMap: Record<string, string> = {};
  KEYS.forEach((key, index) => {
    scaleMap[key] = notes[index];
  });
  return scaleMap;
}

currentScale = buildScaleMap('C Major Scale');

/**
 * Lazily creates the Tone graph inside the first `start()` call, which runs
 * only after `Tone.start()` has resumed the AudioContext. Nodes must not be
 * constructed before the context is running.
 */
class ToneBackend implements AudioBackend {
  private polySynth: Tone.PolySynth | null = null;
  private reverb: Tone.Reverb | null = null;

  async start(): Promise<void> {
    await Tone.start();
    // Re-check: another caller may have completed the graph while we awaited.
    if (this.polySynth) return;
    this.reverb = new Tone.Reverb(0.7).toDestination();
    this.polySynth = new Tone.PolySynth(Tone.Synth, {
      volume: 10,
    }).connect(this.reverb);
  }

  triggerAttack(note: string): void {
    this.polySynth?.triggerAttack(note, Tone.now());
  }

  triggerRelease(note: string): void {
    this.polySynth?.triggerRelease(note, Tone.now());
  }

  releaseAll(): void {
    this.polySynth?.releaseAll();
  }
}

const engine = new AudioEngine(new ToneBackend(), (key) => currentScale[key]);

export const audioManager = {
  /** Idempotent; concurrent calls share one Tone.start()/graph setup. */
  start: () => engine.ensureStarted(),
  setScale: (scaleName: ScaleName) => {
    currentScale = buildScaleMap(scaleName);
  },
  setCustomScale: (notes: string[]) => {
    const scaleMap: Record<string, string> = {};
    KEYS.forEach((key, index) => {
      scaleMap[key] = notes[index];
    });
    currentScale = scaleMap;
  },
  playNote: (key: string) => engine.playNote(key),
  releaseNote: (key: string) => engine.releaseNote(key),
  releaseAll: () => engine.releaseAll(),
  isInitialized: () => engine.isInitialized(),
  /**
   * Binds audio to the level lifecycle: starts a new session and silences
   * every note from the previous one. Returns the new session id.
   */
  beginLevelSession: () => engine.beginSession(),
  endLevelSession: () => engine.endSession(),
  getSessionId: () => engine.getSessionId(),
};
