/**
 * Input aggregation.
 *
 * Two things matter here, and both are easy to get subtly wrong:
 *
 * 1. Pointer lock. Mouse movement must only count while the pointer is
 *    actually locked. Browsers fire `mousemove` with `movementX` even when the
 *    cursor is loose, and `movementX` is garbage right after locking (it can
 *    contain the jump from wherever the cursor was to the centre). So:
 *      - a `mousemove` is ignored unless `pointerlockchange` says locked;
 *      - the first move event after locking is swallowed.
 *
 * 2. Frame-to-tick splitting. Input is gathered per animation frame, but the
 *    simulation asks for one tick's worth at a time. Mouse deltas accumulated
 *    during a frame are divided evenly across the ticks that frame's elapsed
 *    time produced. A hand movement that covers 40 px produces the same total
 *    rotation whether the frame drives 1 tick (low refresh) or 4 (high
 *    refresh). Jump edges (key down, wheel notch) are latched and delivered on
 *    the first tick of the frame that observed them, exactly once.
 *
 * If a frame produces zero ticks, nothing is consumed: the mouse motion and
 * the jump latch stay pending for the next frame. Nothing is lost, and nothing
 * is applied twice.
 *
 * This module is DOM-agnostic in its core: `KeyboardLike` and `PointerLockLike`
 * are tiny interfaces so tests can drive it without a browser. `bindInput` is
 * the only part that touches real DOM objects.
 */

export interface KeyboardLike {
  addEventListener(type: 'keydown' | 'keyup', handler: (event: KeyboardEventLike) => void): void;
  removeEventListener(type: 'keydown' | 'keyup', handler: (event: KeyboardEventLike) => void): void;
}

export interface KeyboardEventLike {
  code: string;
  repeat?: boolean;
  preventDefault?: () => void;
}

export interface PointerLockLike {
  addEventListener(
    type: 'mousemove' | 'mousedown' | 'wheel' | 'pointerlockchange' | 'pointerlockerror',
    handler: (event: PointerEventLike) => void,
  ): void;
  removeEventListener(
    type: 'mousemove' | 'mousedown' | 'wheel' | 'pointerlockchange' | 'pointerlockerror',
    handler: (event: PointerEventLike) => void,
  ): void;
  pointerLockElement?: unknown;
  requestPointerLock?: () => void | Promise<void>;
  exitPointerLock?: () => void;
}

export interface PointerEventLike {
  movementX?: number;
  movementY?: number;
  deltaY?: number;
  button?: number;
  preventDefault?: () => void;
}

export const KEY = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  jump: 'Space',
  pause: 'KeyP',
  restart: 'KeyR',
  toggleAutoHop: 'KeyH',
} as const;

export interface InputFrame {
  /** Raw pixels of horizontal mouse motion gathered this frame. */
  mouseDx: number;
  /** Raw pixels of vertical mouse motion gathered this frame. */
  mouseDy: number;
  /** -1..1 */
  forward: number;
  /** -1..1 */
  right: number;
  /** Edge latch: how many jump presses happened this frame (keydown or wheel). */
  jumpPresses: number;
  jumpHeld: boolean;
}

/** A frame that has been bound to a tick count and is being consumed tick by tick. */
export interface ActiveFrame extends InputFrame {
  readonly stepsTotal: number;
  stepsDone: number;
  /** Running-total differencing keeps the per-tick parts summing exactly. */
  emittedDx: number;
  emittedDy: number;
}

export interface TickInput {
  mouseDx: number;
  mouseDy: number;
  forward: number;
  right: number;
  jumpPressed: boolean;
  jumpHeld: boolean;
}

export interface InputState {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  pause: boolean;
  restart: boolean;
  toggleAutoHop: boolean;
}

export interface FrameControls {
  pausePressed: boolean;
  restartPressed: boolean;
  toggleAutoHopPressed: boolean;
}

export class InputBuffer {
  private state: InputState = {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
    pause: false,
    restart: false,
    toggleAutoHop: false,
  };

  private locked = false;
  private swallowNextMove = false;

  private pendingMouseX = 0;
  private pendingMouseY = 0;
  private pendingJumpPresses = 0;
  private pendingPause = false;
  private pendingRestart = false;
  private pendingToggleAutoHop = false;

  /** Max pixels a single event may contribute (guards post-lock garbage). */
  readonly maxEventPixels: number;
  /** Pending motion beyond this is dropped rather than carried indefinitely. */
  readonly maxPendingPixels: number;

  /** True between `beginFrame(steps>0)` and the last `nextTick`. */
  private activeFrame: ActiveFrame | null = null;

  constructor(options: { maxEventPixels?: number; maxPendingPixels?: number } = {}) {
    this.maxEventPixels = options.maxEventPixels ?? 400;
    this.maxPendingPixels = options.maxPendingPixels ?? 4000;
  }

  get isLocked(): boolean {
    return this.locked;
  }

  get snapshot(): Readonly<InputState> {
    return this.state;
  }

  setLocked(locked: boolean): void {
    if (this.locked === locked) return;
    this.locked = locked;
    // Re-locking must not convert stale motion into a spin. Locking also
    // swallows the first movement event (see class docs).
    this.swallowNextMove = locked;
    this.pendingMouseX = 0;
    this.pendingMouseY = 0;
  }

  handleKeyDown(code: string, repeat = false): void {
    switch (code) {
      case KEY.forward:
        this.state.forward = true;
        break;
      case KEY.back:
        this.state.back = true;
        break;
      case KEY.left:
        this.state.left = true;
        break;
      case KEY.right:
        this.state.right = true;
        break;
      case KEY.jump:
        // OS key-repeat must not create extra jump edges.
        if (!repeat && !this.state.jump) this.pendingJumpPresses++;
        this.state.jump = true;
        break;
      case KEY.pause:
        if (!repeat) this.pendingPause = true;
        this.state.pause = true;
        break;
      case KEY.restart:
        if (!repeat) this.pendingRestart = true;
        this.state.restart = true;
        break;
      case KEY.toggleAutoHop:
        if (!repeat) this.pendingToggleAutoHop = true;
        this.state.toggleAutoHop = true;
        break;
      default:
        break;
    }
  }

  handleKeyUp(code: string): void {
    switch (code) {
      case KEY.forward:
        this.state.forward = false;
        break;
      case KEY.back:
        this.state.back = false;
        break;
      case KEY.left:
        this.state.left = false;
        break;
      case KEY.right:
        this.state.right = false;
        break;
      case KEY.jump:
        this.state.jump = false;
        break;
      case KEY.pause:
        this.state.pause = false;
        break;
      case KEY.restart:
        this.state.restart = false;
        break;
      case KEY.toggleAutoHop:
        this.state.toggleAutoHop = false;
        break;
      default:
        break;
    }
  }

  handleMouseMove(movementX: number, movementY: number): void {
    if (!this.locked) return;
    if (this.swallowNextMove) {
      this.swallowNextMove = false;
      return;
    }
    if (!Number.isFinite(movementX) || !Number.isFinite(movementY)) return;
    this.pendingMouseX += clampNumber(movementX, -this.maxEventPixels, this.maxEventPixels);
    this.pendingMouseY += clampNumber(movementY, -this.maxEventPixels, this.maxEventPixels);
    if (Math.abs(this.pendingMouseX) > this.maxPendingPixels) this.pendingMouseX = 0;
    if (Math.abs(this.pendingMouseY) > this.maxPendingPixels) this.pendingMouseY = 0;
  }

  handleWheel(deltaY: number): void {
    // A wheel notch is an edge-triggered jump, the same as Space's keydown.
    if (deltaY !== 0) this.pendingJumpPresses++;
  }

  /** Drop all motion and one-shot latches (used on pause and window blur). */
  clearMotion(): void {
    this.pendingMouseX = 0;
    this.pendingMouseY = 0;
    this.pendingJumpPresses = 0;
    if (this.activeFrame) {
      this.activeFrame.stepsDone = this.activeFrame.stepsTotal;
      this.activeFrame.jumpPresses = 0;
      this.activeFrame = null;
    }
  }

  /**
   * Forget every held key. A keyup delivered while the window is unfocused is
   * lost, so a player who alt-tabs with Space down would otherwise come back
   * with a phantom held jump that auto-hop could chain forever. Called on blur.
   */
  releaseAll(): void {
    this.state.forward = false;
    this.state.back = false;
    this.state.left = false;
    this.state.right = false;
    this.state.jump = false;
    this.state.pause = false;
    this.state.restart = false;
    this.state.toggleAutoHop = false;
    this.clearMotion();
  }

  /**
   * Take and clear the frame-level one-shot controls. The host calls this once
   * per animation frame, before deciding whether to pause, restart, or toggle
   * auto-hop — even on frames that will run zero physics ticks.
   */
  consumeControls(): FrameControls {
    const controls: FrameControls = {
      pausePressed: this.pendingPause,
      restartPressed: this.pendingRestart,
      toggleAutoHopPressed: this.pendingToggleAutoHop,
    };
    this.pendingPause = false;
    this.pendingRestart = false;
    this.pendingToggleAutoHop = false;
    return controls;
  }

  /**
   * Read the frame's input and bind it to `steps` physics ticks.
   *
   * When `steps` is 0 everything stays pending (nothing is consumed), so the
   * motion is applied on the next frame that actually runs physics.
   * Calling `beginFrame` while a previous frame is still active is a bug in the
   * caller, but any unconsumed mouse motion is carried rather than lost.
   */
  beginFrame(steps: number): ActiveFrame {
    if (this.activeFrame) {
      const leftoverX = this.activeFrame.mouseDx - this.activeFrame.emittedDx;
      const leftoverY = this.activeFrame.mouseDy - this.activeFrame.emittedDy;
      this.pendingMouseX += leftoverX;
      this.pendingMouseY += leftoverY;
      this.activeFrame = null;
    }

    const ticks = Math.max(0, Math.floor(steps));
    if (ticks === 0) {
      // Report nothing and keep every accumulator untouched.
      const idle: ActiveFrame = {
        mouseDx: 0,
        mouseDy: 0,
        forward: (this.state.forward ? 1 : 0) - (this.state.back ? 1 : 0),
        right: (this.state.right ? 1 : 0) - (this.state.left ? 1 : 0),
        jumpPresses: 0,
        jumpHeld: this.state.jump,
        stepsTotal: 0,
        stepsDone: 0,
        emittedDx: 0,
        emittedDy: 0,
      };
      return idle;
    }

    const frame: ActiveFrame = {
      mouseDx: this.pendingMouseX,
      mouseDy: this.pendingMouseY,
      forward: (this.state.forward ? 1 : 0) - (this.state.back ? 1 : 0),
      right: (this.state.right ? 1 : 0) - (this.state.left ? 1 : 0),
      jumpPresses: this.pendingJumpPresses,
      jumpHeld: this.state.jump,
      stepsTotal: ticks,
      stepsDone: 0,
      emittedDx: 0,
      emittedDy: 0,
    };

    this.pendingMouseX = 0;
    this.pendingMouseY = 0;
    this.pendingJumpPresses = 0;
    this.activeFrame = frame;
    return frame;
  }

  /**
   * Slice the next tick out of an active frame.
   *
   * Mouse motion is divided with running-total differencing:
   *   emit_k = total * (k+1)/n - total * k/n
   * so the parts sum to exactly `total` (a dropped remainder would be a slow
   * aim drift that varies with frame rate).
   */
  nextTick(frame: ActiveFrame): TickInput {
    if (frame.stepsTotal <= 0) {
      return {
        mouseDx: 0,
        mouseDy: 0,
        forward: frame.forward,
        right: frame.right,
        jumpPressed: false,
        jumpHeld: frame.jumpHeld,
      };
    }
    const k = frame.stepsDone;
    const n = frame.stepsTotal;
    const nextDx = (frame.mouseDx * (k + 1)) / n;
    const nextDy = (frame.mouseDy * (k + 1)) / n;
    const partX = nextDx - frame.emittedDx;
    const partY = nextDy - frame.emittedDy;
    frame.emittedDx = nextDx;
    frame.emittedDy = nextDy;

    const first = k === 0;
    const jumpPressed = first && frame.jumpPresses > 0;
    if (first) frame.jumpPresses = 0;

    frame.stepsDone = k + 1;
    if (frame.stepsDone >= frame.stepsTotal) this.activeFrame = null;

    return {
      mouseDx: partX,
      mouseDy: partY,
      forward: frame.forward,
      right: frame.right,
      jumpPressed,
      jumpHeld: frame.jumpHeld,
    };
  }
}

function clampNumber(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export interface BindTarget {
  keyboard?: KeyboardLike | null;
  pointer?: PointerLockLike | null;
  /** Element to lock the pointer on (usually the canvas). */
  lockElement?: { requestPointerLock?: () => void | Promise<void> } | null;
  onLockChange?: (locked: boolean) => void;
  onBlur?: (handler: () => void) => () => void;
  /**
   * Request pointer lock on a left mousedown while unlocked. Defaults to true;
   * the browser shell turns it off and locks on the canvas click instead, so
   * clicking pause-menu buttons doesn't re-lock the mouse.
   */
  requestLockOnClick?: boolean;
}

/**
 * Attach an `InputBuffer` to real DOM objects. Returns a disposer. Missing
 * pieces are simply skipped, so Node tests can pass partial targets.
 */
export function bindInput(buffer: InputBuffer, target: BindTarget): () => void {
  const { keyboard, pointer, lockElement, onLockChange, onBlur, requestLockOnClick = true } = target;
  const disposers: (() => void)[] = [];

  if (keyboard) {
    const onKeyDown = (event: KeyboardEventLike) => {
      if (event.code === KEY.jump) event.preventDefault?.();
      buffer.handleKeyDown(event.code, event.repeat ?? false);
    };
    const onKeyUp = (event: KeyboardEventLike) => buffer.handleKeyUp(event.code);
    keyboard.addEventListener('keydown', onKeyDown);
    keyboard.addEventListener('keyup', onKeyUp);
    disposers.push(() => {
      keyboard.removeEventListener('keydown', onKeyDown);
      keyboard.removeEventListener('keyup', onKeyUp);
    });
  }

  if (pointer) {
    const onMouseMove = (event: PointerEventLike) => {
      buffer.handleMouseMove(event.movementX ?? 0, event.movementY ?? 0);
    };
    const onWheel = (event: PointerEventLike) => {
      event.preventDefault?.();
      buffer.handleWheel(event.deltaY ?? 0);
    };
    const onMouseDown = (event: PointerEventLike) => {
      if (event.button !== 0) return;
      if (!buffer.isLocked) {
        if (requestLockOnClick) void lockElement?.requestPointerLock?.();
        return;
      }
      buffer.handleWheel(1);
    };
    const onLockChange = () => {
      const locked = pointer.pointerLockElement !== null && pointer.pointerLockElement !== undefined;
      buffer.setLocked(locked);
      onLockChange?.(locked);
    };
    const onLockError = () => {
      buffer.setLocked(false);
      onLockChange?.(false);
    };

    pointer.addEventListener('mousemove', onMouseMove);
    pointer.addEventListener('wheel', onWheel);
    pointer.addEventListener('mousedown', onMouseDown);
    pointer.addEventListener('pointerlockchange', onLockChange);
    pointer.addEventListener('pointerlockerror', onLockError);
    disposers.push(() => {
      pointer.removeEventListener('mousemove', onMouseMove);
      pointer.removeEventListener('wheel', onWheel);
      pointer.removeEventListener('mousedown', onMouseDown);
      pointer.removeEventListener('pointerlockchange', onLockChange);
      pointer.removeEventListener('pointerlockerror', onLockError);
    });
  }

  if (onBlur) {
    // On blur we both drop in-flight motion and forget held keys: a keyup
    // delivered to an unfocused window is lost, and a phantom held Space would
    // let auto-hop chain forever on return.
    disposers.push(onBlur(() => buffer.releaseAll()));
  }

  return () => {
    for (const dispose of disposers) dispose();
  };
}
