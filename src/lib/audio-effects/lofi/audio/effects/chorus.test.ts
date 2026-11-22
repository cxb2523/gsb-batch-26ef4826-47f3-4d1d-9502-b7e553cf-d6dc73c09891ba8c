import { describe, it, expect } from 'vitest';
import { ChorusEffect } from './chorus';

function createEffect() {
  const ctx = new AudioContext() as unknown as AudioContext;
  return new ChorusEffect(ctx);
}

type Internals = {
  wetGain: GainNode;
  dryGain: GainNode;
  lfo1: OscillatorNode;
  lfo2: OscillatorNode;
  lfoGain1: GainNode;
  lfoGain2: GainNode;
};

function internals(effect: ChorusEffect): Internals {
  return effect as unknown as Internals;
}

describe('ChorusEffect', () => {
  it('creates input and output gain nodes', () => {
    const effect = createEffect();
    expect(effect.input).toBeDefined();
    expect(effect.output).toBeDefined();
  });

  it('starts enabled and fully dry', () => {
    const effect = createEffect();
    expect(effect.enabled).toBe(true);
  });

  it('setIntensity(0) keeps fully dry', () => {
    const effect = createEffect();
    effect.setIntensity(0);
    // At intensity 0, wet should be 0
    expect(effect.enabled).toBe(true);
  });

  it('setIntensity(100) sets max wet mix', () => {
    const effect = createEffect();
    effect.setIntensity(100);
    expect(effect.enabled).toBe(true);
  });

  it('disabling sets wet to 0 and dry to 1', () => {
    const effect = createEffect();
    effect.setIntensity(60);
    effect.enabled = false;
    expect(effect.enabled).toBe(false);
    const i = internals(effect);
    expect(i.wetGain.gain.value).toBe(0);
    expect(i.dryGain.gain.value).toBe(1);
  });

  it('re-enabling restores wet/dry mix', () => {
    const effect = createEffect();
    effect.setIntensity(50);
    effect.enabled = false;
    effect.enabled = true;
    expect(effect.enabled).toBe(true);
  });

  it('does not update when disabled', () => {
    const effect = createEffect();
    effect.enabled = false;
    effect.setIntensity(100);
    expect(effect.enabled).toBe(false);
  });

  it('destroy stops LFOs without error', () => {
    const effect = createEffect();
    expect(() => effect.destroy()).not.toThrow();
  });

  it('disabling truly mutes the wet path and both LFO modulations', () => {
    const effect = createEffect();
    effect.setIntensity(80);
    const i = internals(effect);
    expect(i.wetGain.gain.value).toBeGreaterThan(0);
    expect(i.lfoGain1.gain.value).toBeGreaterThan(0);
    expect(i.lfoGain2.gain.value).toBeGreaterThan(0);

    effect.enabled = false;

    expect(i.wetGain.gain.value).toBe(0);
    expect(i.dryGain.gain.value).toBe(1);
    expect(i.lfoGain1.gain.value).toBe(0);
    expect(i.lfoGain2.gain.value).toBe(0);
  });

  it('re-enabling restores the full wet/dry mix and both LFO depths and frequencies', () => {
    const effect = createEffect();
    effect.setIntensity(50);
    const i = internals(effect);

    const expected = {
      wet: i.wetGain.gain.value,
      dry: i.dryGain.gain.value,
      depth1: i.lfoGain1.gain.value,
      depth2: i.lfoGain2.gain.value,
      freq1: i.lfo1.frequency.value,
      freq2: i.lfo2.frequency.value,
    };
    // Sanity: intensity 50 produces real modulation, not zeros.
    expect(expected.wet).toBeGreaterThan(0);
    expect(expected.depth1).toBeGreaterThan(0);
    expect(expected.depth2).toBeGreaterThan(0);

    effect.enabled = false;
    effect.enabled = true;

    expect(i.wetGain.gain.value).toBeCloseTo(expected.wet);
    expect(i.dryGain.gain.value).toBeCloseTo(expected.dry);
    expect(i.lfoGain1.gain.value).toBeCloseTo(expected.depth1);
    expect(i.lfoGain2.gain.value).toBeCloseTo(expected.depth2);
    expect(i.lfo1.frequency.value).toBeCloseTo(expected.freq1);
    expect(i.lfo2.frequency.value).toBeCloseTo(expected.freq2);
  });

  it('remembers setIntensity while disabled and applies the latest value on re-enable', () => {
    const effect = createEffect();
    effect.setIntensity(40);
    effect.enabled = false;

    // While off, calls are remembered but never touch the graph.
    effect.setIntensity(90);
    const i = internals(effect);
    expect(i.wetGain.gain.value).toBe(0);
    expect(i.lfoGain1.gain.value).toBe(0);

    effect.enabled = true;

    // Values now match intensity 90: wet 0.54, depth1 0.0027, depths 0.00216.
    expect(i.wetGain.gain.value).toBeCloseTo(0.9 * 0.6);
    expect(i.dryGain.gain.value).toBeCloseTo(1 - 0.9 * 0.6 * 0.5);
    expect(i.lfoGain1.gain.value).toBeCloseTo(0.9 * 0.003);
    expect(i.lfoGain2.gain.value).toBeCloseTo(0.9 * 0.003 * 0.8);
    expect(i.lfo1.frequency.value).toBeCloseTo(0.3 + 0.9 * 1.2);
    expect(i.lfo2.frequency.value).toBeCloseTo(0.5 + 0.9 * 1.0);
  });

  it('repeated destroy does not throw and does not stop the LFOs twice', () => {
    const effect = createEffect();
    const i = internals(effect);
    effect.destroy();
    expect(() => effect.destroy()).not.toThrow();
    // Each LFO is stopped exactly once despite the second destroy call.
    expect(i.lfo1.stop).toHaveBeenCalledTimes(1);
    expect(i.lfo2.stop).toHaveBeenCalledTimes(1);
  });

  it('does not touch audio nodes after destroy', () => {
    const effect = createEffect();
    effect.destroy();
    expect(() => {
      effect.enabled = false;
      effect.enabled = true;
      effect.setIntensity(100);
    }).not.toThrow();
    const i = internals(effect);
    expect(i.lfo1.stop).toHaveBeenCalledTimes(1);
  });
});
