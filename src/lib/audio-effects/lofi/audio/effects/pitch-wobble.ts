import { createAudioWorkletNodeCompat } from './audio-worklet-context';

export class PitchWobbleEffect {
  readonly node: AudioWorkletNode;
  private _enabled = true;
  private _destroyed = false;
  // Last parameters derived from setIntensity / setSpeed / setDepth. They are
  // retained while disabled so re-enabling restores the wobble instead of
  // leaving the depth stuck at the bypass value of 0.
  private _lastSpeed = 0.3;
  private _lastDepth = 0;

  constructor(ctx: AudioContext) {
    this.node = createAudioWorkletNodeCompat(ctx, 'pitch-wobble-processor');
  }

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(value: boolean) {
    if (this._destroyed || this._enabled === value) return;
    this._enabled = value;
    if (value) {
      // Restore the remembered speed and depth, including a non-zero depth.
      this.applyParameters();
    } else {
      // Pass-through: zero depth means the delay line reads the dry signal.
      // The remembered depth is deliberately left untouched.
      this.node.parameters.get('depth')!.value = 0;
    }
  }

  /** Push the remembered parameters onto the worklet's AudioParams. */
  private applyParameters(): void {
    this.node.parameters.get('speed')!.value = this._lastSpeed;
    this.node.parameters.get('depth')!.value = this._lastDepth;
  }

  setSpeed(hz: number): void {
    if (this._destroyed) return;
    this._lastSpeed = Math.max(0.1, Math.min(5, hz));
    if (this._enabled) {
      this.node.parameters.get('speed')!.value = this._lastSpeed;
    }
  }

  setDepth(ms: number): void {
    if (this._destroyed) return;
    this._lastDepth = Math.max(0, Math.min(20, ms));
    if (this._enabled) {
      this.node.parameters.get('depth')!.value = this._lastDepth;
    }
  }

  /** Map 0-100 intensity to wobble parameters */
  setIntensity(value: number): void {
    if (this._destroyed) return;
    const normalized = Math.max(0, Math.min(100, value)) / 100;
    this._lastSpeed = 0.3 + normalized * 2.7; // 0.3-3 Hz
    this._lastDepth = normalized * 20; // 0-20ms
    // Remember the values while disabled, but only touch the node while on.
    if (this._enabled) {
      this.applyParameters();
    }
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this.node.disconnect();
  }
}
