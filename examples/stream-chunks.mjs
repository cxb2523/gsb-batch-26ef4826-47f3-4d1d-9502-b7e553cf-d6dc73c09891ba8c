import assert from 'node:assert/strict';
import { StreamingAnalyzer, generateSine, resampleMono, frameSignal } from '../dist/core/index.js';
const settings = { sampleRate: 16000, sourceSampleRate: 48000, frameSize: 256, hopSize: 128 };
const signal = generateSine(48000, 0.1, 500).getChannel(0);

// Chunk boundaries never change the frame sequence.
const collect = (chunkSize) => {
  const analyzer = new StreamingAnalyzer(settings);
  const frames = [];
  for (let offset = 0; offset < signal.length; offset += chunkSize)
    frames.push(...analyzer.push(signal.subarray(offset, offset + chunkSize)));
  frames.push(...analyzer.flush());
  return frames;
};
const whole = collect(signal.length);
assert.deepEqual(collect(73), whole);

// The converted output matches resampling the whole signal first.
const batch = frameSignal(resampleMono(signal, 48000, 16000, 'sinc'), 256, {
  hopSize: 128,
  window: null,
});
assert.equal(whole.length, batch.length);
for (let i = 0; i < whole.length; i++) {
  const rms = Math.sqrt(batch[i].reduce((sum, value) => sum + value * value, 0) / batch[i].length);
  assert.ok(Math.abs(whole[i].rms - rms) < 1e-5);
}

// A rate switch starts a clean session at the new rate.
const analyzer = new StreamingAnalyzer(settings);
analyzer.push(signal);
analyzer.flush();
analyzer.setSampleRate(8000, 8000);
assert.equal(analyzer.framesOut().length, 0);
assert.equal(analyzer.push(new Float32Array(256).fill(0.5)).length, 1);
console.log('Converted frames:', whole.length);
