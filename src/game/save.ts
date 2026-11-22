/**
 * Persistent best times and settings, backed by `localStorage`.
 *
 * Storage is untrusted input: it may be missing, full, disabled (private
 * mode), or hold data written by an older build. Every read is validated and
 * every write is best-effort; a broken profile must never stop the game from
 * running.
 */

import { GAME, DEFAULT_SETTINGS, type Settings } from '../config.ts';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface BestRecord {
  /** Best completion time in seconds. */
  seconds: number;
  /** ISO timestamp of when it was set. */
  at: string;
  /** Number of falls in that run. */
  falls: number;
  /** Schema version, so future migrations can detect old data. */
  version: number;
}

export interface SplitsRecord {
  seconds: number;
  splits: number[];
  at: string;
  version: number;
}

const RECORD_VERSION = 1;

function isValidRecord(value: unknown): value is BestRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.seconds === 'number' &&
    Number.isFinite(record.seconds) &&
    record.seconds > 0 &&
    typeof record.at === 'string' &&
    typeof record.falls === 'number' &&
    record.falls >= 0
  );
}

export class Records {
  private storage: StorageLike | null;

  constructor(storage: StorageLike | null) {
    this.storage = storage;
  }

  get available(): boolean {
    return this.storage !== null;
  }

  private safeGet(key: string): string | null {
    if (!this.storage) return null;
    try {
      return this.storage.getItem(key);
    } catch {
      return null;
    }
  }

  private safeSet(key: string, value: string): boolean {
    if (!this.storage) return false;
    try {
      this.storage.setItem(key, value);
      return true;
    } catch {
      // Quota exceeded or storage disabled: the run still counts, it just
      // won't persist. Never throw into the game loop.
      return false;
    }
  }

  loadBest(): BestRecord | null {
    const raw = this.safeGet(GAME.storageKey);
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isValidRecord(parsed)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /** Save a time only if it beats the stored record. Returns true when it did. */
  submitBest(seconds: number, falls: number): boolean {
    if (!Number.isFinite(seconds) || seconds <= 0) return false;
    const existing = this.loadBest();
    if (existing && existing.seconds <= seconds) return false;
    const record: BestRecord = {
      seconds,
      falls,
      at: new Date().toISOString(),
      version: RECORD_VERSION,
    };
    return this.safeSet(GAME.storageKey, JSON.stringify(record));
  }

  loadSplits(): SplitsRecord | null {
    const raw = this.safeGet(GAME.storageKey + '.splits');
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as SplitsRecord;
      if (typeof parsed.seconds !== 'number' || !Array.isArray(parsed.splits)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  saveSplits(seconds: number, splits: number[]): boolean {
    const record: SplitsRecord = {
      seconds,
      splits: splits.filter((s) => Number.isFinite(s)),
      at: new Date().toISOString(),
      version: RECORD_VERSION,
    };
    return this.safeSet(GAME.storageKey + '.splits', JSON.stringify(record));
  }

  clear(): void {
    if (!this.storage) return;
    try {
      this.storage.removeItem(GAME.storageKey);
      this.storage.removeItem(GAME.storageKey + '.splits');
      this.storage.removeItem(GAME.settingsKey);
    } catch {
      // ignore
    }
  }
}

export function loadSettings(storage: StorageLike | null): Settings {
  if (!storage) return { ...DEFAULT_SETTINGS };
  try {
    const raw = storage.getItem(GAME.settingsKey);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      autoHop: typeof parsed.autoHop === 'boolean' ? parsed.autoHop : DEFAULT_SETTINGS.autoHop,
      sensitivity:
        typeof parsed.sensitivity === 'number' &&
        Number.isFinite(parsed.sensitivity) &&
        parsed.sensitivity >= 0.05 &&
        parsed.sensitivity <= 5
          ? parsed.sensitivity
          : DEFAULT_SETTINGS.sensitivity,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(storage: StorageLike | null, settings: Settings): void {
  if (!storage) return;
  try {
    storage.setItem(GAME.settingsKey, JSON.stringify(settings));
  } catch {
    // ignore
  }
}

/**
 * Resolve `window.localStorage` defensively. Some browsers throw on mere
 * access (private mode, third-party cookie blocking), so this never assumes it
 * exists.
 */
export function browserStorage(): StorageLike | null {
  try {
    const storage = (globalThis as { localStorage?: StorageLike }).localStorage;
    if (!storage) return null;
    const probe = '__bhop_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

/** In-memory storage, for tests and for browsers that block localStorage. */
export function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}
