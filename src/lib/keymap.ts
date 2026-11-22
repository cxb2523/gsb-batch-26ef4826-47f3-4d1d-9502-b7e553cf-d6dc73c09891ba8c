/**
 * Single source of truth for the nine-key mapping.
 *
 * The public mapping (physical key <-> player-state slot <-> note character)
 * and the touch zone layout are intentionally unchanged from the original
 * implementation. Every input path (keyboard, touch overlay) resolves keys
 * through this module so they cannot drift apart.
 */

export interface KeyBinding {
  /** `KeyboardEvent.code` for the physical key. */
  code: string;
  /** Index in the player-state / target-pattern array (0..8). */
  index: number;
  /** Character key used to look up a note in the scale map. */
  key: string;
}

/**
 * Ordered by player-state index:
 * A S D F SPACE J K L ;
 */
export const KEY_BINDINGS: readonly KeyBinding[] = [
  { code: 'KeyA', index: 0, key: 'a' },
  { code: 'KeyS', index: 1, key: 's' },
  { code: 'KeyD', index: 2, key: 'd' },
  { code: 'KeyF', index: 3, key: 'f' },
  { code: 'Space', index: 4, key: ' ' },
  { code: 'KeyJ', index: 5, key: 'j' },
  { code: 'KeyK', index: 6, key: 'k' },
  { code: 'KeyL', index: 7, key: 'l' },
  { code: 'Semicolon', index: 8, key: ';' },
];

export const KEY_COUNT = KEY_BINDINGS.length;

export const CODE_TO_KEY: Readonly<Record<string, KeyBinding>> = Object.fromEntries(
  KEY_BINDINGS.map((binding) => [binding.code, binding]),
);

/**
 * Touch overlay zone -> physical key code.
 * Zones 0..7 are the top row (A S D F J K L ;); zone 8 is the space bar.
 * This matches the original overlay layout.
 */
export const ZONE_TO_CODE: Readonly<Record<number, string>> = {
  0: 'KeyA',
  1: 'KeyS',
  2: 'KeyD',
  3: 'KeyF',
  4: 'KeyJ',
  5: 'KeyK',
  6: 'KeyL',
  7: 'Semicolon',
  8: 'Space',
};

export const KEY_LABELS = ['A', 'S', 'D', 'F', 'SPACE', 'J', 'K', 'L', ';'] as const;

export function createEmptyPlayerState(): number[] {
  return new Array<number>(KEY_COUNT).fill(0);
}
