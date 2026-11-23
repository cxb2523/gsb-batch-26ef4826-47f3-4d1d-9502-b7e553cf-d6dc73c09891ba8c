import { describe, it, expect } from 'vitest';
import { StreamingAnalyzer } from './streaming.js';
import { frameSignal } from './frame.js';
import { resampleMono } from './resample.js';
import { fft } from './fft.js';
import { magnitude, halfSpectrum } from './spectrum.js';
import { spectralCentroid } from './features-spectral.js';

describe('streaming analyzer', () => {
  it('produces one frame per hop', () => {
    const a = new StreamingAnalyzer({ sampleRate: 8000, frameSize: 256, hopSize: 128 });
    const samples = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) samples[i] = Math.sin((2 * Math.PI * 100 * i) / 8000);
    const frames = a.push(samples);
    expect(frames.length).toBeGreaterThan(0);
  });

  it('streaming RMS matches batched frame RMS within tolerance', () => {
    const sr = 8000;
    const samples = new Float32Array(2048);
    for (let i = 0; i < 2048; i++) samples[i] = Math.sin((2 * Math.PI * 200 * i) / sr);
    const a = new StreamingAnalyzer({ sampleRate: sr, frameSize: 256, hopSize: 256 });
    const streamed = a.push(samples);
    const batched = frameSignal(samples, 256, { hopSize: 256, window: null });
    for (let i = 0; i < Math.min(streamed.length, batched.length); i++) {
      const rms1 = streamed[i]?.rms ?? 0;
      let sum = 0;
      const f = batched[i];
      if (!f) continue;
      for (let k = 0; k < f.length; k++) sum += (f[k] ?? 0) * (f[k] ?? 0);
      const rms2 = Math.sqrt(sum / f.length);
      expect(rms1).toBeCloseTo(rms2, 4);
    }
  });

  it('reset clears the frame history', () => {
    const a = new StreamingAnalyzer({ sampleRate: 8000, frameSize: 64, hopSize: 32 });
    a.push(new Float32Array(128).fill(0.5));
    a.reset();
    expect(a.framesOut().length).toBe(0);
  });
});

it('rejects invalid streaming settings during construction', () => {
  for (const frameSize of [0, 3, 1.5, Infinity, 2 ** 21]) {
    expect(() => new StreamingAnalyzer({ sampleRate: 8000, frameSize, hopSize: 1 })).toThrow();
  }
  for (const hopSize of [0, -1, 1.5, NaN, Infinity]) {
    expect(() => new StreamingAnalyzer({ sampleRate: 8000, frameSize: 4, hopSize })).toThrow();
  }
  const analyzer = new StreamingAnalyzer({ sampleRate: 8, frameSize: 4, hopSize: 4 });
  expect(() => analyzer.push([1, 2, NaN])).toThrow();
  expect(analyzer.push([1, 1, 1, 1])[0]?.rms).toBe(1);
});

it('matches direct windows for every two-chunk partition and hop policy', () => {
  const signal = [1, 2, 3, 4, 0, -1, 0, 1, 2, 1, 0, -2, 1, 1, 1, 1];
  for (const hopSize of [1, 2, 4, 8]) {
    const expected: number[] = [];
    for (let start = 0; start + 4 <= signal.length; start += hopSize) {
      expected.push(
        Math.sqrt(signal.slice(start, start + 4).reduce((sum, x) => sum + x * x, 0) / 4),
      );
    }
    for (let split = 0; split <= signal.length; split++) {
      const analyzer = new StreamingAnalyzer({ sampleRate: 8, frameSize: 4, hopSize });
      const frames = [
        ...analyzer.push(signal.slice(0, split)),
        ...analyzer.push(signal.slice(split)),
      ];
      expect(frames.map((frame) => frame.rms)).toEqual(expected);
    }
  }
});

it('bounds history while returning every new frame to the caller', () => {
  const analyzer = new StreamingAnalyzer({
    sampleRate: 8,
    frameSize: 4,
    hopSize: 4,
    retainFrames: 2,
  });
  const result = analyzer.push([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);
  expect(result).toHaveLength(3);
  expect(analyzer.framesOut().map((frame) => frame.rms)).toEqual([2, 3]);
  expect(Object.isFrozen(result[0])).toBe(true);
  expect(analyzer.framesOut()).not.toBe(analyzer.framesOut());
  analyzer.reset();
  expect(analyzer.framesOut()).toEqual([]);
  expect(analyzer.push([1, 1, 1, 1])[0]?.rms).toBe(1);
});

it('locates a real tone at its frequency instead of the mirrored-spectrum midpoint', () => {
  const analyzer = new StreamingAnalyzer({ sampleRate: 8000, frameSize: 64, hopSize: 64 });
  const signal = Float32Array.from({ length: 64 }, (_, i) =>
    Math.sin((2 * Math.PI * 1000 * i) / 8000),
  );
  expect(analyzer.push(signal)[0]?.centroid).toBeCloseTo(1000, 2);
});

describe('streaming analyzer with resampling', () => {
  const signalAt = (rate: number, length: number, frequency: number): Float32Array => {
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) out[i] = Math.sin((2 * Math.PI * frequency * i) / rate);
    return out;
  };

  it('defaults sourceSampleRate to sampleRate and stays bit-identical to the old path', () => {
    const options = { sampleRate: 8000, frameSize: 64, hopSize: 32 };
    const samples = signalAt(8000, 512, 700);
    const plain = new StreamingAnalyzer(options);
    const explicit = new StreamingAnalyzer({ ...options, sourceSampleRate: 8000 });
    expect(plain.sourceSampleRate).toBe(8000);
    expect(explicit.sourceSampleRate).toBe(8000);
    expect(explicit.push(samples)).toEqual(plain.push(samples));
    expect(explicit.flush()).toEqual([]);
  });

  it('matches whole-buffer resample plus framing for upsampling and downsampling', () => {
    const cases = [
      { source: 48000, rate: 16000, frameSize: 256, hopSize: 128 },
      { source: 16000, rate: 48000, frameSize: 256, hopSize: 128 },
      { source: 44100, rate: 16000, frameSize: 512, hopSize: 256 },
      { source: 8000, rate: 11025, frameSize: 128, hopSize: 64 },
      { source: 22050, rate: 44100, frameSize: 256, hopSize: 128 },
    ];
    for (const item of cases) {
      const samples = signalAt(item.source, 6000, item.source * 0.09);
      const converted = resampleMono(samples, item.source, item.rate, 'sinc');
      const reference = frameSignal(converted, item.frameSize, {
        hopSize: item.hopSize,
        window: null,
      });
      const analyzer = new StreamingAnalyzer({
        sampleRate: item.rate,
        sourceSampleRate: item.source,
        frameSize: item.frameSize,
        hopSize: item.hopSize,
      });
      const frames = [...analyzer.push(samples), ...analyzer.flush()];
      expect(frames).toHaveLength(reference.length);
      for (let i = 0; i < frames.length; i++) {
        const expected = reference[i]!;
        let sum = 0;
        for (const value of expected) sum += value * value;
        expect(frames[i]!.rms).toBeCloseTo(Math.sqrt(sum / expected.length), 6);
      }
    }
  });

  it('keeps frame count, RMS and centroid aligned with batched conversion', () => {
    const source = 32000;
    const rate = 16000;
    const frameSize = 256;
    const hopSize = 128;
    const frequency = 1000;
    const samples = signalAt(source, 8000, frequency);
    const converted = resampleMono(samples, source, rate, 'sinc');
    const reference = frameSignal(converted, frameSize, { hopSize, window: null });
    const analyzer = new StreamingAnalyzer({
      sampleRate: rate,
      sourceSampleRate: source,
      frameSize,
      hopSize,
    });
    const frames = [...analyzer.push(samples), ...analyzer.flush()];
    expect(frames.length).toBe(reference.length);
    const centroidOf = (frame: Float32Array): number =>
      spectralCentroid(halfSpectrum(magnitude(fft(frame))), frameSize, rate);
    for (let i = 0; i < frames.length; i++) {
      expect(frames[i]!.centroid).toBeCloseTo(centroidOf(reference[i]!), 3);
    }
    expect(frames[10]!.centroid).toBeCloseTo(frequency, 0);
  });

  it('produces the same frame sequence regardless of chunk split positions', () => {
    const source = 22050;
    const rate = 16000;
    const samples = signalAt(source, 5000, 900);
    const settings = { sampleRate: rate, sourceSampleRate: source, frameSize: 128, hopSize: 64 };
    const wholeAnalyzer = new StreamingAnalyzer(settings);
    const whole = [...wholeAnalyzer.push(samples), ...wholeAnalyzer.flush()];
    expect(whole.length).toBeGreaterThan(0);
    for (const size of [1, 3, 17, 73, 501, 4096]) {
      const analyzer = new StreamingAnalyzer(settings);
      const frames = [];
      for (let offset = 0; offset < samples.length; offset += size)
        frames.push(...analyzer.push(samples.subarray(offset, offset + size)));
      frames.push(...analyzer.flush());
      expect(frames).toEqual(whole);
    }
  });

  it('clears history and the unfinished tail when the analysis rate changes', () => {
    const analyzer = new StreamingAnalyzer({
      sampleRate: 8000,
      sourceSampleRate: 8000,
      frameSize: 16,
      hopSize: 8,
    });
    analyzer.push(new Float32Array(10).fill(0.5));
    expect(analyzer.framesOut()).toHaveLength(0);
    analyzer.setSampleRate(16000);
    expect(analyzer.framesOut()).toHaveLength(0);
    const frames = analyzer.push(new Float32Array(16).fill(1));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.rms).toBeCloseTo(1, 6);
    expect(analyzer.framesOut()).toHaveLength(1);
    expect(analyzer.sampleRate).toBe(16000);
  });

  it('discards retained frames and the unfinished tail from the old session', () => {
    const oldSession = new StreamingAnalyzer({ sampleRate: 16000, frameSize: 16, hopSize: 16 });
    // 30 samples: one complete frame plus a 14-sample unfinished tail.
    expect(oldSession.push(new Float32Array(30).fill(0.5))).toHaveLength(1);
    expect(oldSession.framesOut()).toHaveLength(1);

    oldSession.setSampleRate(12000);
    expect(oldSession.framesOut()).toHaveLength(0);

    // Fewer samples than one frame: no new frame may complete from the
    // old session's leftover 14 samples.
    expect(oldSession.push(new Float32Array(4).fill(1))).toHaveLength(0);

    // A fresh analyzer at the new rate is the reference for the next
    // session. If the old tail leaked in, the first frame would differ.
    const fresh = new StreamingAnalyzer({ sampleRate: 12000, frameSize: 16, hopSize: 16 });
    fresh.push(new Float32Array(4).fill(1));
    const samples = new Float32Array(26).fill(1);
    expect(oldSession.push(samples)).toEqual(fresh.push(samples));
  });

  it('drops converted samples from a resampled session when the rate changes', () => {
    const analyzer = new StreamingAnalyzer({
      sampleRate: 16000,
      sourceSampleRate: 8000,
      frameSize: 16,
      hopSize: 16,
    });
    expect(analyzer.push(new Float32Array(40).fill(0.5)).length).toBeGreaterThan(0);
    analyzer.setSampleRate(12000, 6000);
    expect(analyzer.framesOut()).toHaveLength(0);
    const fresh = new StreamingAnalyzer({
      sampleRate: 12000,
      sourceSampleRate: 6000,
      frameSize: 16,
      hopSize: 16,
    });
    const samples = new Float32Array(60).fill(1);
    expect(analyzer.push(samples)).toEqual(fresh.push(samples));
  });

  it('does not reset when switching to the rate already in effect', () => {
    const analyzer = new StreamingAnalyzer({
      sampleRate: 8000,
      sourceSampleRate: 4000,
      frameSize: 16,
      hopSize: 8,
    });
    const pushed = analyzer.push(new Float32Array(40).fill(0.5));
    expect(pushed.length).toBeGreaterThan(0);
    analyzer.setSampleRate(8000);
    expect(analyzer.framesOut()).toHaveLength(pushed.length);
    analyzer.setSampleRate(8000, 4000);
    expect(analyzer.framesOut()).toHaveLength(pushed.length);
    expect(analyzer.push(new Float32Array(64).fill(0.5))).not.toHaveLength(0);
  });

  it('throws on invalid rates and over-budget ratios while leaving the session usable', () => {
    for (const bad of [0, -1, NaN, Infinity, 192001]) {
      expect(
        () =>
          new StreamingAnalyzer({
            sampleRate: 8000,
            sourceSampleRate: bad,
            frameSize: 16,
            hopSize: 8,
          }),
      ).toThrow();
    }
    // 1 : 192000 needs a sinc radius far above the kernel budget.
    expect(
      () =>
        new StreamingAnalyzer({
          sampleRate: 1,
          sourceSampleRate: 192000,
          frameSize: 16,
          hopSize: 8,
        }),
    ).toThrow(/kernel budget/);

    const analyzer = new StreamingAnalyzer({ sampleRate: 8000, frameSize: 16, hopSize: 16 });
    const before = analyzer.push(new Float32Array(16).fill(0.5));
    expect(before).toHaveLength(1);
    for (const call of [
      () => analyzer.setSampleRate(0),
      () => analyzer.setSampleRate(NaN),
      () => analyzer.setSampleRate(8000, 0),
      () => analyzer.setSampleRate(1, 192000),
      () => analyzer.setSampleRate(1, 8000),
    ])
      expect(call).toThrow(RangeError);
    expect(analyzer.sampleRate).toBe(8000);
    expect(analyzer.sourceSampleRate).toBe(8000);
    expect(analyzer.framesOut()).toHaveLength(1);
    const after = analyzer.push(new Float32Array(16).fill(0.5));
    expect(after).toHaveLength(1);
    expect(after[0]!.rms).toBeCloseTo(before[0]!.rms, 6);
  });
});
