import { describe, expect, it } from 'vitest';
import { LookaheadLimiter } from '../../public/limiter-core.js';

function render(input: Float32Array[], sampleRate = 48000) {
  const limiter = new LookaheadLimiter(sampleRate, input.length);
  const length = input[0].length + limiter.delaySamples;
  const output = input.map(() => new Float32Array(length));
  // Uneven blocks catch state errors at render-quantum and ring-buffer boundaries.
  for (let at = 0; at < length; at += 127) {
    const size = Math.min(127, length - at);
    const block = input.map(channel => Float32Array.from({length:size}, (_, i) => channel[at + i] ?? 0));
    const result = input.map(() => new Float32Array(size));
    limiter.process(block, result);
    result.forEach((channel, i) => output[i].set(channel, at));
  }
  return { limiter, output };
}

describe('shared output lookahead limiter', () => {
  it('passes quiet audio exactly, apart from the declared delay', () => {
    const input = Float32Array.from({length:12000}, (_, i) => .1 * Math.sin(i * .2));
    const {limiter, output} = render([input]);
    expect([...output[0].slice(0, limiter.delaySamples)]).toEqual(Array(limiter.delaySamples).fill(0));
    expect([...output[0].slice(limiter.delaySamples)]).toEqual([...input]);
  });

  it.each([44100, 48000, 96000])('contains loud impulses and combined streams at %i Hz', sampleRate => {
    let seed = 1729;
    const input = Float32Array.from({length:sampleRate}, (_, i) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return i % 577 === 0 ? 10000 : 20 * Math.sin(i * .19) + 10 * Math.sin(i * .07) + (seed / 2 ** 32 - .5) * 3;
    });
    const {limiter, output} = render([input, Float32Array.from(input, x => -.5*x)], sampleRate);
    expect(output[0].every(v => Number.isFinite(v) && Math.abs(v) <= limiter.ceiling)).toBe(true);
    // Stereo-linked gain preserves the channel relationship, including opposite phase.
    expect(output[0].every((v,i) => output[1][i] === -.5*v)).toBe(true);
  });

  it('reduces gain before a transient and recovers smoothly instead of clipping its waveform', () => {
    const input = new Float32Array(48000).fill(.2);
    input[12000] = 8;
    const {limiter, output} = render([input]);
    const onset = 12000 + limiter.delaySamples;
    expect(output[0][onset-1]).toBeLessThan(.04);
    expect(output[0][onset]).toBeLessThanOrEqual(limiter.ceiling);
    expect(output[0][onset+1]).toBeLessThan(.04);
    expect(output[0][output[0].length-1]).toBeCloseTo(.2, 5);
  });

  it('does not propagate invalid samples', () => {
    const {output} = render([new Float32Array([NaN, Infinity, -Infinity, .1])]);
    expect(output[0].every(Number.isFinite)).toBe(true);
  });
});

// A bypass toggle swaps the signal arriving at the ONE shared output stage. Whatever gain
// reduction the old signal earned is state about the old signal, and the switch must not carry it
// into the new one — that carry is the short dip users hear right after toggling.
describe('reset drops every trace of the signal it was limiting', () => {
  const quiet = (n = 4800) => Float32Array.from({length:n}, (_, i) => .1 * Math.sin(i * .2));

  it('a reset limiter is sample-for-sample a freshly constructed one', () => {
    const hot = Float32Array.from({length:4800}, (_, i) => i % 97 === 0 ? 40 : 6 * Math.sin(i * .3));
    const dirty = new LookaheadLimiter(48000, 1);
    const scratch = new Float32Array(hot.length);
    dirty.process([hot], [scratch]);
    dirty.reset();

    const fresh = new LookaheadLimiter(48000, 1);
    const tail = quiet();
    const afterReset = new Float32Array(tail.length);
    const afterFresh = new Float32Array(tail.length);
    dirty.process([tail], [afterReset]);
    fresh.process([tail], [afterFresh]);
    expect([...afterReset]).toEqual([...afterFresh]);
    // And it really is "recovered": the detector took the hot block down well below unity.
    expect(Math.max(...scratch.map(Math.abs))).toBeLessThan(1);
  });

  it('without the reset, the old gain reduction ducks the quiet signal — the defect this fixes', () => {
    const hot = Float32Array.from({length:4800}, () => 40);
    const limiter = new LookaheadLimiter(48000, 1);
    limiter.process([hot], [new Float32Array(hot.length)]);
    // Same block length as quiet(), so the delayed samples land exactly where the fresh one's do.
    const tail = quiet(hot.length);
    const output = new Float32Array(tail.length);
    limiter.process([tail], [output]);
    const afterLookahead = output.slice(limiter.delaySamples);
    expect(Math.max(...afterLookahead.map(Math.abs))).toBeLessThan(.1 * .6);
    // Now the same limiter, but reset: the quiet signal comes out at its own level.
    limiter.reset();
    const clean = new Float32Array(tail.length);
    limiter.process([tail], [clean]);
    // output[n] is the sample from n - delaySamples, so past the declared delay the block is unity.
    expect([...clean.slice(limiter.delaySamples)]).toEqual([...tail.slice(0, tail.length - limiter.delaySamples)]);
  });

  it('the ring and detector really do empty, so an isolated first block cannot be ducked', () => {
    // An impulse is the sharpest case: it leaves maximum gain reduction behind, and the first
    // render quantum after a reset must not spend it on samples that arrived after the switch.
    const limiter = new LookaheadLimiter(48000, 1);
    const impulse = new Float32Array(4800).fill(100);
    limiter.process([impulse], [new Float32Array(4800)]);
    limiter.reset();
    // The detector's internals are not part of the public .d.ts (nothing outside this test should
    // reach into them); read them here rather than widening the surface the engine is typed against.
    const state = limiter as any;
    expect(state.detector).toBe(0);
    expect(state.count).toBe(0);
    expect(state.at).toBe(0);
    expect([...state.delay[0]].every((v: number) => v === 0)).toBe(true);
    expect([...state.peaks].every((v: number) => v === 0)).toBe(true);
    expect([...state.indices].every((v: number) => v === 0)).toBe(true);

    // One render quantum's worth of quiet audio past the lookahead: nothing but the delay.
    const frames = 512;
    const block = Float32Array.from({length:frames}, () => .2);
    const output = new Float32Array(frames);
    limiter.process([block], [output]);
    expect([...output.slice(limiter.delaySamples)]).toEqual([...block.slice(0, frames - limiter.delaySamples)]);
  });
});
