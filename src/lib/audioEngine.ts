/**
 * Session-aware audio engine.
 *
 * The engine is deliberately free of Tone.js imports so it can be unit tested
 * with a fake backend. `audio.ts` provides the Tone-backed singleton.
 *
 * Key guarantees:
 *  - `ensureStarted()` is idempotent: concurrent callers share one start promise.
 *  - Notes requested before the backend is ready are queued ("pending") and only
 *    sounded once the backend is ready *and* their audio session is still the
 *    active one. Notes from a previous level/session are dropped, never replayed.
 *  - Every level transition bumps the session and releases all sounding notes.
 *  - A note is never attacked twice without an intervening release, regardless
 *    of how many input sources (keyboard/touch) press it.
 */

export interface AudioBackend {
  /** Must only be called once; resolves when audio is actually usable. */
  start(): Promise<void>;
  triggerAttack(note: string): void;
  triggerRelease(note: string): void;
  releaseAll(): void;
}

export type NoteResolver = (key: string) => string | undefined;

/**
 * The audio surface the game session needs. Implemented by `AudioEngine`
 * (Tone-backed in production) and by a recording fake in tests.
 */
export interface AudioPort {
  playNote(key: string): void;
  releaseNote(key: string): void;
  releaseAll(): void;
  /** Starts a fresh audio session (silences the previous one). */
  beginLevelSession(): number;
  /** Ends the current audio session (silences it). */
  endLevelSession(): number;
}

interface PendingAttack {
  note: string;
  session: number;
}

export class AudioEngine {
  private backend: AudioBackend;
  private noteResolver: NoteResolver;

  private initialized = false;
  private startPromise: Promise<void> | null = null;
  private session = 0;

  /** key -> note currently sounding */
  private activeNotes = new Map<string, string>();
  /** key -> deferred attack, valid only for the session it was created in */
  private pendingAttacks = new Map<string, PendingAttack>();

  constructor(backend: AudioBackend, noteResolver: NoteResolver = () => undefined) {
    this.backend = backend;
    this.noteResolver = noteResolver;
  }

  setNoteResolver(resolver: NoteResolver): void {
    this.noteResolver = resolver;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getSessionId(): number {
    return this.session;
  }

  /**
   * Starts the audio backend exactly once. Concurrent callers share the same
   * promise; a rejection clears the promise so a later gesture can retry.
   */
  ensureStarted(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (this.startPromise) return this.startPromise;

    const promise = this.backend
      .start()
      .then(() => {
        this.initialized = true;
        this.startPromise = null;
        this.flushPendingAttacks();
      })
      .catch((error: unknown) => {
        this.startPromise = null;
        throw error;
      });

    this.startPromise = promise;
    return promise;
  }

  /** Begin a new audio session (new level / restart), silencing old notes. */
  beginSession(): number {
    this.session += 1;
    this.releaseAll();
    return this.session;
  }

  /** Begin a new level's audio session. Alias used by the game session. */
  beginLevelSession(): number {
    return this.beginSession();
  }

  /** End the active audio session (level finished / returned to menu). */
  endSession(): number {
    return this.beginSession();
  }

  /** End the active level's audio session. Alias used by the game session. */
  endLevelSession(): number {
    return this.endSession();
  }

  playNote(key: string): void {
    const note = this.noteResolver(key);
    if (!note) return;

    if (!this.initialized) {
      // Defer; remember which session asked so a level switch can drop it.
      this.pendingAttacks.set(key, { note, session: this.session });
      void this.ensureStarted().catch(() => {
        // Audio start is best-effort; the game must keep working silently.
      });
      return;
    }

    if (this.activeNotes.has(key)) return;
    this.activeNotes.set(key, note);
    this.backend.triggerAttack(note);
  }

  releaseNote(key: string): void {
    this.pendingAttacks.delete(key);
    const note = this.activeNotes.get(key);
    if (note === undefined) return;
    this.activeNotes.delete(key);
    this.backend.triggerRelease(note);
  }

  releaseAll(): void {
    this.pendingAttacks.clear();
    this.activeNotes.clear();
    if (this.initialized) {
      this.backend.releaseAll();
    }
  }

  private flushPendingAttacks(): void {
    const session = this.session;
    for (const [key, pending] of this.pendingAttacks) {
      if (pending.session !== session) continue;
      if (this.activeNotes.has(key)) continue;
      this.activeNotes.set(key, pending.note);
      this.backend.triggerAttack(pending.note);
    }
    this.pendingAttacks.clear();
  }
}
