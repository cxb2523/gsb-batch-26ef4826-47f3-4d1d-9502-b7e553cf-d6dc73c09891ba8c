import { atom } from 'jotai';
import { type ScaleName } from '../lib/audio';
import type { Level } from '../lib/level';

// --- Types ---
export type Screen = 'levelSelect' | 'game' | 'result';

export type { Level };

export interface LevelIndexInfo {
  id: number;
  name: string;
  file: string;
}

// --- Atoms ---

// Controls which screen is currently visible
export const screenAtom = atom<Screen>('levelSelect');

// Asynchronously fetches and holds the list of all available levels
export const levelIndexAtom = atom(async () => {
  const response = await fetch('/levels/index.json');
  if (!response.ok) {
    throw new Error('Failed to fetch level index');
  }
  return response.json() as Promise<LevelIndexInfo[]>;
});

// Controls the currently selected musical scale
export const scaleAtom = atom<ScaleName | 'Custom'>('C Major Scale');

// Holds the info for the level the user has selected
export const selectedLevelInfoAtom = atom<LevelIndexInfo | null>(null);

// Holds the index of the current level being played
export const currentLevelIndexAtom = atom<number>(-1);

// Asynchronously fetches the data for the currently selected level
export const currentLevelAtom = atom(async (get) => {
  const levelInfo = get(selectedLevelInfoAtom);
  if (!levelInfo) {
    return null;
  }

  const response = await fetch(`/levels/${levelInfo.file}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch level: ${response.statusText}`);
  }
  const levelData = await response.json() as Level;
  // Basic validation
  if (!levelData.patterns || !levelData.ranks) {
    throw new Error('Invalid level data format');
  }
  return levelData;
});

/**
 * The level data of the session that is currently mounted.
 *
 * This is published by the game session *after* it has fully reset the
 * per-level state, so the UI never renders one level's dots/steps with
 * another level's data. It intentionally remains readable on the result
 * screen (which needs the level name/ranks) even though the session is gone.
 */
export const levelDataAtom = atom<Level | null>(null);

// Holds the final time when a level is completed
export const finalTimeAtom = atom<number>(0);

/**
 * Incrementing this requests the mounted game session to restart in place
 * (the in-game "Restart Level" button).
 */
export const restartTokenAtom = atom<number>(0);
