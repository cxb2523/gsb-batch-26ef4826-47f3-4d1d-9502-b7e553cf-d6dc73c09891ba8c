/**
 * End-to-end test through the real UI-facing WarioPlayer wrapper, including
 * WAV byte export. Exercises the exact path src/main.ts drives:
 *   prepare() -> play() -> stop() -> play() -> exportMotifWAVBytes()
 *
 * Run with:
 *   node --import ./test-harness/register-hooks.mjs --test test-harness/wario-player.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { installGlobals, __resetTime } from './mock-audio.mjs';
installGlobals();

import { WarioPlayer } from '../src/core/WarioPlayer.ts';
import { buildDrumGrooveMidi } from './make-midi.mjs';

function parseWavHeader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riff = String.fromCharCode(...bytes.subarray(0, 4));
  const wave = String.fromCharCode(...bytes.subarray(8, 12));
  const sampleRate = view.getUint32(24, true);
  const channels = view.getUint16(22, true);
  const dataSize = view.getUint32(40, true);
  return { riff, wave, sampleRate, channels, dataSize };
}

test('WarioPlayer: prepare/play/stop/replay keeps noise channels clean', async () => {
  __resetTime();
  const midi = buildDrumGrooveMidi({ bars: 2, bpm: 120 });
  const engine = new WarioPlayer();

  await engine.prepare(midi);
  assert.ok(engine.hasGeneratedContent());
  assert.ok(engine.getDuration() > 0);

  await engine.play();
  const player = engine['player'];
  const apu = player.getAPU();
  const n1 = apu.getNoiseChannel('n1');
  const n2 = apu.getNoiseChannel('n2');

  // Noise outputs must be audible (regression: they used to be gain 0).
  assert.ok(n1['outputNode'].gain.value > 0);
  assert.ok(n2['outputNode'].gain.value > 0);

  await new Promise((r) => setTimeout(r, 120));
  engine.stop();
  assert.equal(player.getIsPlaying(), false);
  assert.equal(n1.getActiveVoiceCount(), 0);
  assert.equal(n2.getActiveVoiceCount(), 0);
  assert.equal(n1.getCacheSize(), 0);
  assert.equal(n2.getCacheSize(), 0);

  // Replay from the start.
  await engine.play();
  assert.equal(player.getIsPlaying(), true);
  await new Promise((r) => setTimeout(r, 120));
  const voices = n1.getActiveVoiceCount() + n2.getActiveVoiceCount();
  assert.ok(voices > 0, 'drums reschedule on replay');
  engine.stop();
  assert.equal(n1.getActiveVoiceCount(), 0);
});

test('WarioPlayer: seek restarts from the given position', async () => {
  __resetTime();
  const midi = buildDrumGrooveMidi({ bars: 2, bpm: 120 });
  const engine = new WarioPlayer();
  await engine.prepare(midi);
  await engine.play();
  engine.stop();

  const duration = engine.getDuration();
  engine.seek(0.5);
  const player = engine['player'];
  assert.equal(player.getIsPlaying(), true);
  assert.ok(player.getElapsedTime() >= duration * 0.5 - 0.5);
  engine.stop();
});

test('WarioPlayer: exports a valid 30s WAV with noise content', async () => {
  __resetTime();
  const midi = buildDrumGrooveMidi({ bars: 4, bpm: 120 });
  const engine = new WarioPlayer();
  await engine.prepare(midi);

  const bytes = await engine.exportMotifWAVBytes();
  assert.ok(bytes instanceof Uint8Array);
  assert.ok(bytes.length > 44, 'WAV has header + data');

  const header = parseWavHeader(bytes);
  assert.equal(header.riff, 'RIFF');
  assert.equal(header.wave, 'WAVE');
  assert.equal(header.channels, 2);
  assert.equal(header.sampleRate, 22050);
  assert.ok(header.dataSize > 0, 'WAV carries PCM payload');

  // Count non-silent 16-bit samples in the data section.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let nonZero = 0;
  for (let offset = 44; offset + 1 < bytes.length; offset += 2) {
    if (view.getInt16(offset, true) !== 0) nonZero++;
  }
  assert.ok(nonZero > 1000, `exported WAV contains audible samples (${nonZero} nonzero)`);
});

test('WarioPlayer: exporting without preparing throws', async () => {
  const engine = new WarioPlayer();
  await assert.rejects(() => engine.exportMotifWAVBytes(), /Nothing to export/);
});
