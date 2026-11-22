import { describe, it, expect } from 'vitest';
import { PitchWobbleEffect } from './pitch-wobble';

function createEffect() {
  const ctx = new AudioContext() as unknown as AudioContext;
  return new PitchWobbleEffect(ctx);
}

describe('PitchWobbleEffect', () => {
  it('creates an AudioWorkletNode', () => {
    const effect = createEffect();
    expect(effect.node).toBeDefined();
    expect(effect.node.parameters).toBeDefined();
  });

  it('setIntensity(0) sets speed=0.3 depth=0', () => {
    const effect = createEffect();
    effect.setIntensity(0);
    expect(effect.node.parameters.get('speed')!.value).toBeCloseTo(0.3);
    expect(effect.node.parameters.get('depth')!.value).toBe(0);
  });

  it('setIntensity(100) sets speed=3 depth=20', () => {
    const effect = createEffect();
    effect.setIntensity(100);
    expect(effect.node.parameters.get('speed')!.value).toBeCloseTo(3);
    expect(effect.node.parameters.get('depth')!.value).toBeCloseTo(20);
  });

  it('disabled sets depth=0', () => {
    const effect = createEffect();
    effect.setIntensity(50);
    effect.enabled = false;
    expect(effect.node.parameters.get('depth')!.value).toBe(0);
  });

  it('setSpeed clamps to 0.1-5', () => {
    const effect = createEffect();
    effect.setSpeed(0.01);
    expect(effect.node.parameters.get('speed')!.value).toBeCloseTo(0.1);
    effect.setSpeed(10);
    expect(effect.node.parameters.get('speed')!.value).toBe(5);
  });

  it('setDepth clamps to 0-20', () => {
    const effect = createEffect();
    effect.setDepth(-5);
    expect(effect.node.parameters.get('depth')!.value).toBe(0);
    effect.setDepth(30);
    expect(effect.node.parameters.get('depth')!.value).toBe(20);
  });

  it('setIntensity is no-op on the graph when disabled', () => {
    const effect = createEffect();
    effect.enabled = false;
    effect.setIntensity(100);
    expect(effect.node.parameters.get('depth')!.value).toBe(0);
  });

  it('re-enabling restores speed and a non-zero depth from before the disable', () => {
    const effect = createEffect();
    effect.setIntensity(50);
    const speedBefore = effect.node.parameters.get('speed')!.value;
    const depthBefore = effect.node.parameters.get('depth')!.value;
    expect(depthBefore).toBeGreaterThan(0);

    effect.enabled = false;
    expect(effect.node.parameters.get('depth')!.value).toBe(0);

    effect.enabled = true;
    expect(effect.node.parameters.get('speed')!.value).toBeCloseTo(speedBefore);
    // Regression: depth used to stay 0 after re-enable, killing the effect.
    expect(effect.node.parameters.get('depth')!.value).toBeCloseTo(depthBefore);
    expect(effect.node.parameters.get('depth')!.value).toBeGreaterThan(0);
  });

  it('remembers setIntensity while disabled and applies the latest values on re-enable', () => {
    const effect = createEffect();
    effect.setIntensity(30);
    effect.enabled = false;

    // Calls while off are remembered but the node stays in bypass.
    effect.setIntensity(80);
    expect(effect.node.parameters.get('depth')!.value).toBe(0);

    effect.enabled = true;
    expect(effect.node.parameters.get('speed')!.value).toBeCloseTo(0.3 + 0.8 * 2.7);
    expect(effect.node.parameters.get('depth')!.value).toBeCloseTo(0.8 * 20);
    expect(effect.node.parameters.get('depth')!.value).toBeGreaterThan(0);
  });

  it('setSpeed and setDepth while disabled are applied after re-enable', () => {
    const effect = createEffect();
    effect.enabled = false;
    effect.setSpeed(2.5);
    effect.setDepth(12);
    expect(effect.node.parameters.get('depth')!.value).toBe(0);

    effect.enabled = true;
    expect(effect.node.parameters.get('speed')!.value).toBeCloseTo(2.5);
    expect(effect.node.parameters.get('depth')!.value).toBeCloseTo(12);
  });

  it('destroy disconnects the node and repeated destroy does not throw', () => {
    const effect = createEffect();
    expect(() => effect.destroy()).not.toThrow();
    expect(effect.node.disconnect).toHaveBeenCalledTimes(1);
    expect(() => effect.destroy()).not.toThrow();
    expect(effect.node.disconnect).toHaveBeenCalledTimes(1);
  });

  it('does not touch the worklet node after destroy', () => {
    const effect = createEffect();
    effect.setIntensity(70);
    effect.destroy();

    expect(() => {
      effect.enabled = false;
      effect.enabled = true;
      effect.setIntensity(100);
      effect.setSpeed(2);
      effect.setDepth(10);
    }).not.toThrow();

    // No further parameter writes or disconnects after destruction.
    expect(effect.node.disconnect).toHaveBeenCalledTimes(1);
    expect(effect.node.parameters.get('depth')!.value).toBeCloseTo(0.7 * 20);
  });
});
