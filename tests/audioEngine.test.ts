import { describe, expect, it } from 'bun:test';
import { AudioEngine, type AudioBackend } from '../src/lib/audioEngine';

/**
 * A recording audio backend whose `start()` is resolved manually, so tests
 * can model "the Tone.js context is still initialising".
 */
class DeferredBackend implements AudioBackend {
  startCalls = 0;
  attacks: string[] = [];
  releases: string[] = [];
  releaseAllCalls = 0;

  private resolveStart: (() => void) | null = null;
  private rejectStart: ((error: unknown) => void) | null = null;

  start(): Promise<void> {
    this.startCalls += 1;
    return new Promise<void>((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
    });
  }

  resolve(): void {
    const resolve = this.resolveStart;
    this.resolveStart = null;
    this.rejectStart = null;
    resolve?.();
  }

  reject(error: unknown): void {
    const reject = this.rejectStart;
    this.resolveStart = null;
    this.rejectStart = null;
    reject?.(error);
  }

  triggerAttack(note: string): void {
    this.attacks.push(note);
  }

  triggerRelease(note: string): void {
    this.releases.push(note);
  }

  releaseAll(): void {
    this.releaseAllCalls += 1;
  }
}

const NOTES: Record<string, string> = {
  a: 'C2', s: 'D2', d: 'E2', f: 'F2', ' ': 'G2', j: 'A2', k: 'B2', l: 'C3', ';': 'D3',
};
const resolveNote = (key: string) => NOTES[key];

describe('AudioEngine', () => {
  it('never calls the backend before initialisation; queues and flushes for the same session', async () => {
    const backend = new DeferredBackend();
    const engine = new AudioEngine(backend, resolveNote);

    engine.playNote('a');
    expect(backend.attacks).toEqual([]);
    expect(backend.startCalls).toBe(1);

    backend.resolve();
    await engine.ensureStarted();
    await Promise.resolve();

    expect(engine.isInitialized()).toBe(true);
    expect(backend.attacks).toEqual(['C2']);
  });

  it('shares one start promise across concurrent callers', async () => {
    const backend = new DeferredBackend();
    const engine = new AudioEngine(backend, resolveNote);

    const p1 = engine.ensureStarted();
    const p2 = engine.ensureStarted();
    engine.playNote('s');
    expect(backend.startCalls).toBe(1);

    backend.resolve();
    await Promise.all([p1, p2]);
    expect(backend.startCalls).toBe(1);
  });

  it('drops notes queued for a previous session when the level switches', async () => {
    const backend = new DeferredBackend();
    const engine = new AudioEngine(backend, resolveNote);

    engine.playNote('a'); // pressed in level 1, before audio is ready
    engine.beginLevelSession(); // player switches level before init completes
    backend.resolve();
    await engine.ensureStarted();
    await Promise.resolve();

    expect(backend.attacks).toEqual([]); // old level's note must not replay
  });

  it('does not replay old-level notes after a level was completed before init', async () => {
    const backend = new DeferredBackend();
    const engine = new AudioEngine(backend, resolveNote);

    engine.playNote('a');
    engine.endLevelSession(); // level completed
    backend.resolve();
    await engine.ensureStarted();
    await Promise.resolve();

    expect(backend.attacks).toEqual([]);
  });

  it('allows a retry after a failed start and initialises exactly once on success', async () => {
    const backend = new DeferredBackend();
    const engine = new AudioEngine(backend, resolveNote);

    const first = engine.ensureStarted();
    backend.reject(new Error('gesture required'));
    await expect(first).rejects.toThrow('gesture required');
    expect(engine.isInitialized()).toBe(false);

    const second = engine.ensureStarted();
    backend.resolve();
    await second;

    const third = engine.ensureStarted();
    await third;
    expect(engine.isInitialized()).toBe(true);
    expect(backend.startCalls).toBe(2); // one failure + one success, no extra
  });

  it('dedupes a held note and releases it once', () => {
    const backend = new DeferredBackend();
    const engine = new AudioEngine(backend, resolveNote);

    void engine.ensureStarted();
    backend.resolve();

    return Promise.resolve().then(() => {
      engine.playNote('a');
      engine.playNote('a');
      expect(backend.attacks).toEqual(['C2']);

      engine.releaseNote('a');
      engine.releaseNote('a');
      expect(backend.releases).toEqual(['C2']);
    });
  });

  it('beginLevelSession silences sounding notes', async () => {
    const backend = new DeferredBackend();
    const engine = new AudioEngine(backend, resolveNote);

    const started = engine.ensureStarted();
    backend.resolve();
    await started;

    engine.playNote('a');
    expect(backend.attacks).toEqual(['C2']);

    engine.beginLevelSession();
    expect(backend.releaseAllCalls).toBe(1);

    engine.releaseNote('a'); // was cleared by the session switch
    expect(backend.releases).toEqual([]);
  });
});
