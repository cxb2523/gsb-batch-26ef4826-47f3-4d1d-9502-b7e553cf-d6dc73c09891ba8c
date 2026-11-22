import { CODE_TO_KEY } from './keymap';

/** The subset of `KeyboardEvent` the controller needs (easy to fake). */
export interface KeyboardEventLike {
  code: string;
  repeat?: boolean;
  preventDefault(): void;
}

export interface KeyboardInputOptions {
  /** Whether a level session is currently accepting input. */
  isLevelActive(): boolean;
  /** Whether the level-select screen (menu free-play) is showing. */
  isMenu(): boolean;
  press(code: string): void;
  release(code: string): void;
  startAudio(): void;
  /** Menu free-play feedback (no game session involved). */
  playMenuNote(key: string): void;
  releaseMenuNote(key: string): void;
  /** Drop keys held by the keyboard (e.g. on window blur). */
  releaseAllHeld(): void;
}

/**
 * The keyboard input path, extracted from React so it can be exercised in
 * tests. It owns the set of *physically* held key codes for the life of the
 * window, which gives every screen the same auto-repeat/duplicate filter and
 * guarantees that a key held across a level transition cannot start the new
 * level's timer (it must be released and pressed again).
 */
export class KeyboardInputController {
  private readonly physicalDown = new Set<string>();
  private readonly menuNotes = new Set<string>();
  private readonly options: KeyboardInputOptions;

  constructor(options: KeyboardInputOptions) {
    this.options = options;
  }

  /** Codes the keyboard currently holds (for diagnostics/tests). */
  get heldCodes(): string[] {
    return Array.from(this.physicalDown);
  }

  handleKeyDown(event: KeyboardEventLike): void {
    const binding = CODE_TO_KEY[event.code];
    if (event.repeat || this.physicalDown.has(event.code)) {
      if (binding) event.preventDefault();
      return;
    }

    this.physicalDown.add(event.code);
    if (!binding) return;

    event.preventDefault();
    // Must happen inside the gesture handler to unlock the AudioContext.
    this.options.startAudio();

    if (this.options.isLevelActive()) {
      this.options.press(event.code);
    } else if (this.options.isMenu() && !this.menuNotes.has(event.code)) {
      this.menuNotes.add(event.code);
      this.options.playMenuNote(binding.key);
    }
  }

  handleKeyUp(event: KeyboardEventLike): void {
    this.physicalDown.delete(event.code);
    if (!CODE_TO_KEY[event.code]) return;
    event.preventDefault();

    // Both are idempotent; only one of them is the active path.
    this.options.release(event.code);
    if (this.menuNotes.delete(event.code)) {
      this.options.releaseMenuNote(CODE_TO_KEY[event.code].key);
    }
  }

  /** Focus/visibility loss: matching keyups will never arrive. */
  handleBlur(): void {
    this.physicalDown.clear();
    this.menuNotes.clear();
    this.options.releaseAllHeld();
  }
}
