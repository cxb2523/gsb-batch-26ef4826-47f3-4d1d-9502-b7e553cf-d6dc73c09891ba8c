/**
 * The game loop: the only place where real time, input, physics and the
 * renderer meet.
 *
 * Order of operations per animation frame:
 *
 *   1. Ask the clock how many whole 128 Hz ticks this frame's elapsed time
 *      produced. The clock clamps long stalls and drops time while paused, so
 *      a backgrounded tab cannot produce a burst of catch-up ticks.
 *   2. Bind the frame's input to that many ticks (`input.beginFrame(steps)`).
 *      If the frame produced zero ticks, nothing is consumed; the motion and
 *      any jump latch stay pending for the next frame.
 *   3. For each tick: slice the mouse motion evenly, apply it to the view,
 *      copy the view yaw onto the physics body, step physics, advance the run
 *      clock.
 *   4. Hand the previous/current body pair plus `clock.alpha` to the renderer,
 *      which interpolates for display only.
 *
 * Physics state is only ever written in step 3.
 */

import { PHYSICS, SIM, STEP_SECONDS, VIEW } from '../config.ts';
import { FixedStepClock } from '../sim/clock.ts';
import { cloneBody, stepBody, type PhysBody, type TickCommand } from '../physics/body.ts';
import { InputBuffer, type ActiveFrame } from '../input/input.ts';
import {
  createRun,
  markRespawned,
  respawnPad,
  startRun,
  tickRun,
  type RunState,
} from './run.ts';
import type { Course, PadSpec } from './course.ts';
import type { ViewState } from '../render/canvas.ts';
import { clamp } from '../math.ts';
import type { Records } from './save.ts';

export interface FrameSnapshot {
  body: PhysBody;
  previous: PhysBody;
  alpha: number;
  run: RunState;
  view: ViewState;
  steps: number;
  paused: boolean;
  locked: boolean;
  speed: number;
  autoHop: boolean;
}

export type GameEvent =
  | { type: 'jump'; speed: number }
  | { type: 'land'; speed: number; pad: string | null }
  | { type: 'checkpoint'; pad: PadSpec }
  | { type: 'fall' }
  | { type: 'finish'; seconds: number; best: boolean }
  | { type: 'start' }
  | { type: 'pause'; paused: boolean };

export interface GameHooks {
  onFrame?: (snapshot: FrameSnapshot) => void;
  onEvent?: (event: GameEvent) => void;
}

export interface GameOptions {
  course: Course;
  input: InputBuffer;
  records: Records;
  autoHop?: boolean;
  sensitivity?: number;
}

export class Game {
  readonly course: Course;
  readonly input: InputBuffer;
  readonly records: Records;
  readonly clock: FixedStepClock;

  body: PhysBody;
  previous: PhysBody;
  run: RunState;
  view: ViewState;

  autoHop: boolean;
  sensitivity: number;
  paused = false;

  private started = false;
  private hooks: GameHooks = {};

  constructor(options: GameOptions) {
    this.course = options.course;
    this.input = options.input;
    this.records = options.records;
    this.clock = new FixedStepClock({
      stepSeconds: STEP_SECONDS,
      maxFrameSeconds: SIM.maxFrameDeltaSeconds,
    });
    this.autoHop = options.autoHop ?? true;
    this.sensitivity = options.sensitivity ?? 1;

    this.run = createRun();
    this.body = this.spawnAt(this.course.startPad, 0);
    this.previous = cloneBody(this.body);
    this.view = { yaw: 0, pitch: 0 };
  }

  setHooks(hooks: GameHooks): void {
    this.hooks = hooks;
  }

  get isStarted(): boolean {
    return this.started;
  }

  private spawnAt(pad: PadSpec, yaw: number): PhysBody {
    return {
      pos: { x: pad.center.x, y: pad.center.y + 0.02, z: pad.center.z },
      vel: { x: 0, y: 0, z: 0 },
      yaw,
      onGround: true,
    };
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.clock.setPaused(paused);
    this.input.clearMotion();
    this.emit({ type: 'pause', paused });
  }

  togglePause(): void {
    this.setPaused(!this.paused);
  }

  setAutoHop(enabled: boolean): void {
    this.autoHop = enabled;
  }

  setSensitivity(value: number): void {
    this.sensitivity = clamp(value, 0.05, 5);
  }

  restart(): void {
    this.run = createRun();
    this.body = this.spawnAt(this.course.startPad, 0);
    this.previous = cloneBody(this.body);
    this.view = { yaw: 0, pitch: 0 };
    this.started = false;
    this.clock.reset();
    this.input.clearMotion();
  }

  /**
   * Run one animation frame.
   *
   * `realSeconds` is the time since the previous frame (a browser passes
   * `performance.now()` deltas). Returns the snapshot that the renderer should
   * draw this frame.
   */
  update(realSeconds: number): FrameSnapshot {
    const steps = this.clock.advance(realSeconds);

    // One-shot controls are frame-level, not tick-level. They are consumed
    // every frame — including frames that produce zero physics ticks, which is
    // exactly what happens while paused, so P must still be able to unpause.
    // This happens *before* beginFrame so a pause/restart on this frame cannot
    // also consume the frame's mouse motion or jump latch.
    const controls = this.input.consumeControls();
    if (controls.pausePressed) this.togglePause();
    if (controls.restartPressed) {
      this.restart();
      return this.snapshot(0);
    }
    if (controls.toggleAutoHopPressed) this.setAutoHop(!this.autoHop);

    const couldStep = !this.paused && this.run.phase !== 'finished';
    if (couldStep) {
      const frame = this.input.beginFrame(steps);
      if (steps > 0) {
        for (let i = 0; i < steps; i++) {
          this.previous = cloneBody(this.body);
          this.stepTick(frame);
          this.runTick();
          if (this.run.phase === 'finished') break;
        }
      }
    } else {
      // Paused or finished: this frame's mouse motion and jump latch must not
      // be carried forward, or a click that resumes the game would also jump.
      this.input.clearMotion();
    }

    const snapshot = this.snapshot(steps);
    this.hooks.onFrame?.(snapshot);
    return snapshot;
  }

  /** Apply one physics tick. */
  private stepTick(frame: ActiveFrame): void {
    const tick = this.input.nextTick(frame);

    // Mouse look: view only. It sets the body's wish basis next, but it can
    // never change velocity or position on its own.
    const lookScale = (VIEW.mouseSensitivity * this.sensitivity * Math.PI) / 180;
    this.view.yaw += tick.mouseDx * lookScale;
    this.view.pitch = clamp(
      this.view.pitch - tick.mouseDy * lookScale,
      -VIEW.maxPitchRadians,
      VIEW.maxPitchRadians,
    );

    // The physics body faces where the camera faces. This is the one legal
    // write from input into physics, and it happens per tick, after the
    // frame's motion has been split.
    this.body.yaw = this.view.yaw;

    const command: TickCommand = {
      forward: tick.forward,
      right: tick.right,
      jumpPressed: tick.jumpPressed,
      jumpHeld: tick.jumpHeld,
      yawDelta: 0,
    };

    const result = stepBody(this.body, command, this.course.brushes, PHYSICS, this.autoHop);
    this.body = result.body;

    // A jump event fires for both a manual takeoff and an auto-hop re-launch.
    // Auto-hops happen on the landing tick, which is *not* a grounded tick at
    // the start, so this must not be gated on `wasGrounded`.
    if (result.events.jumped) {
      this.emit({ type: 'jump', speed: result.events.speed });
    }
    if (result.events.landed) {
      this.emit({ type: 'land', speed: result.events.speed, pad: this.padNameAt(this.body) });
    }

    if (!this.started && (tick.forward !== 0 || tick.right !== 0 || tick.jumpPressed)) {
      this.started = true;
      startRun(this.run);
      this.emit({ type: 'start' });
    }
  }

  private runTick(): void {
    const result = tickRun(this.run, this.course, this.body);

    if (result.checkpoint) this.emit({ type: 'checkpoint', pad: result.checkpoint });
    if (result.finished) {
      const best = this.records.submitBest(this.run.elapsed, this.run.falls);
      this.records.saveSplits(this.run.elapsed, this.run.splits);
      this.emit({ type: 'finish', seconds: this.run.elapsed, best });
      return;
    }
    if (result.fell) {
      this.emit({ type: 'fall' });
      const pad = respawnPad(this.course, this.run);
      this.body = this.spawnAt(pad, this.body.yaw);
      this.previous = cloneBody(this.body);
      markRespawned(this.run);
    }
  }

  private padNameAt(body: PhysBody): string | null {
    for (const pad of this.course.pads) {
      const half = pad.size / 2;
      if (
        Math.abs(body.pos.y - pad.center.y) < 2 &&
        Math.abs(body.pos.x - pad.center.x) <= half + PHYSICS.halfWidth &&
        Math.abs(body.pos.z - pad.center.z) <= half + PHYSICS.halfWidth
      ) {
        return pad.name;
      }
    }
    return null;
  }

  private snapshot(steps: number): FrameSnapshot {
    return {
      body: this.body,
      previous: this.previous,
      alpha: this.clock.alpha,
      run: this.run,
      view: this.view,
      steps,
      paused: this.paused,
      locked: this.input.isLocked,
      speed: Math.hypot(this.body.vel.x, this.body.vel.z),
      autoHop: this.autoHop,
    };
  }

  private emit(event: GameEvent): void {
    this.hooks.onEvent?.(event);
  }
}
