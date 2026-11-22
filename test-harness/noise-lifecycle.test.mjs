/**
 * Verification suite for the noise-channel lifecycle fixes.
 *
 * Run with:
 *   node --import ./test-harness/register-hooks.mjs --test test-harness/noise-lifecycle.test.mjs
 *
 * Covers:
 *  1. Noise channels are audible (non-zero channel gain) in the live APU.
 *  2. Cache hits never return a buffer shorter than the requested note+tail.
 *  3. stopAll() tears down every noise voice (no connected residual nodes),
 *     resets channel state and clears the buffer cache.
 *  4. Replay after stop schedules fresh nodes and produces audible drums.
 *  5. Offline renderToBuffer() routes drum notes to the noise channels with
 *     mode applied and non-zero output gain (no silent export).
 *  6. Full GameBoyPlayer prepare -> playFrom -> stop -> playFrom cycle.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AudioContext,
  OfflineAudioContext,
  installGlobals,
  flushEnded,
  __advanceTime,
  __resetTime,
} from './mock-audio.mjs';

installGlobals();

import { NoiseChannel } from '../src-v2/audio/apu/NoiseChannel.ts';
import { GameBoyAPU } from '../src-v2/audio/apu/APU.ts';
import { GameBoyPlayer } from '../src-v2/core/GameBoyPlayer.ts';
import { buildDrumGrooveMidi } from './make-midi.mjs';

/** Walk the audio graph from a node and collect every connected descendant. */
function connectedGraph(root) {
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length) {
    const node = queue.shift();
    for (const child of node.connected || []) {
      if (!seen.has(child)) {
        seen.add(child);
        queue.push(child);
      }
    }
  }
  return seen;
}

function makeChannel(mode = '15bit') {
  const ctx = new AudioContext();
  const output = ctx.createGain();
  output.connect(ctx.destination);
  return { ctx, output, channel: new NoiseChannel(ctx, output, mode) };
}

test('noise channel drum helpers schedule sources with sufficient buffers', () => {
  __resetTime();
  const { channel } = makeChannel('7bit');

  const kick = channel.playKick(110, 0.0);
  const snare = channel.playSnare(100, 0.5);
  const hat = channel.playHihat(90, false, 1.0);
  const openHat = channel.playHihat(90, true, 1.5);

  for (const { source, stopTime } of [kick, snare, hat, openHat]) {
    // Buffer must outlast the source's stop time (no truncation at buffer end).
    assert.ok(
      source.buffer.duration >= stopTime - source._started,
      `buffer ${source.buffer.duration}s must cover note ending ${stopTime}`
    );
    assert.ok(source.connected.length > 0, 'source is connected to a gain node');
  }
  assert.equal(channel.getActiveVoiceCount(), 4);
});

test('cache hit only returns a buffer long enough for the requested note', () => {
  __resetTime();
  const { channel } = makeChannel('15bit');

  // First request: a long note populates the cache with a long buffer.
  const long = channel.playNote(60, 1.0, 100, 0);
  const longBufferLength = long.source.buffer.length;
  assert.ok(channel.getCacheSize() >= 1);

  // Short note at same freq/mode reuses the long-enough cached buffer.
  const short = channel.playNote(60, 0.1, 100, 2);
  assert.equal(short.source.buffer.length, longBufferLength,
    'short note reuses the long-enough cached buffer');

  // A short note on a DIFFERENT frequency creates a short cache entry; a
  // subsequent longer note on that same frequency must NOT reuse it.
  const firstShort = channel.playNote(36, 0.05, 100, 3);
  const shortBufLen = firstShort.source.buffer.length;

  const thenLong = channel.playNote(36, 0.8, 100, 4);
  assert.ok(thenLong.source.buffer.length > shortBufLen,
    'longer note gets a newly generated longer buffer, not the truncated short one');
  assert.ok(thenLong.source.buffer.duration >= 0.8,
    'new buffer covers the full 0.8s note plus tail padding');
});

test('different LFSR modes never share a cached buffer', () => {
  __resetTime();
  const { channel } = makeChannel('15bit');
  const a = channel.playNoise(0.2, 2000, 100, 0);
  channel.setMode('7bit');
  const b = channel.playNoise(0.2, 2000, 100, 0.5);
  assert.notEqual(a.source.buffer, b.source.buffer, 'mode change partitions cache');
});

test('stopAll stops every voice, disconnects nodes and clears voices+cache', () => {
  __resetTime();
  const { output, channel } = makeChannel('7bit');

  const r1 = channel.playKick(100, 0);
  const r2 = channel.playSnare(100, 0.25);
  const r3 = channel.playHihat(80, false, 0.5);
  const r4 = channel.playNote(48, 0.4, 90, 0.75);
  const voices = [r1, r2, r3, r4];
  assert.equal(channel.getActiveVoiceCount(), 4);
  assert.ok(channel.getCacheSize() > 0);

  // While alive, every source -> gain -> output chain is connected.
  for (const v of voices) {
    assert.deepEqual(v.source.connected, [v.gainNode], 'source feeds its gain');
    assert.deepEqual(v.gainNode.connected, [output], 'gain feeds channel output');
  }

  __advanceTime(1.0);
  channel.stopAll();

  assert.equal(channel.getActiveVoiceCount(), 0, 'no tracked voices remain');

  // stopAll() tears down voices; reset() additionally drops the cache so a
  // new playback session cannot reuse this session's buffers.
  assert.ok(channel.getCacheSize() > 0, 'stopAll alone keeps reusable cache');
  channel.reset();
  assert.equal(channel.getCacheSize(), 0, 'buffer cache cleared on reset');

  // Every source/gain created above must now be fully disconnected.
  for (const v of voices) {
    assert.equal(v.source.connected.length, 0, 'source disconnected after stopAll');
    assert.equal(v.gainNode.connected.length, 0, 'gain disconnected after stopAll');
  }
  // The output itself stays wired to the context destination.
  assert.equal(output.connected.length, 1, 'channel output remains connected to destination');
});

test('reset() is idempotent and safe with no active voices', () => {
  __resetTime();
  const { channel } = makeChannel('15bit');
  assert.doesNotThrow(() => channel.reset());
  assert.equal(channel.getActiveVoiceCount(), 0);
  assert.equal(channel.getCacheSize(), 0);
  // Mode configuration survives the reset.
  assert.equal(channel.getMode(), '15bit');
});

test('natural note end disposes its voice without touching siblings', () => {
  __resetTime();
  const { channel } = makeChannel('15bit');
  const first = channel.playHihat(80, false, 0);
  const second = channel.playKick(100, 0.2);
  assert.equal(channel.getActiveVoiceCount(), 2);
  const firstSource = first.source;
  const firstGain = first.gainNode;

  // Firing the source's onended mimics the audio thread ending the note.
  assert.equal(typeof firstSource.onended, 'function', 'onended handler installed');
  firstSource.onended(new Event('ended'));
  assert.equal(channel.getActiveVoiceCount(), 1, 'ended voice removed');
  assert.equal(firstSource.connected.length, 0, 'ended source disconnected');
  assert.equal(firstGain.connected.length, 0, 'ended gain disconnected');
  assert.equal(second.source.connected.length, 1, 'sibling voice stays connected');

  // A duplicate end event must be a no-op, not a throw: the channel nulls the
  // handler after disposal, so there is simply nothing left to invoke.
  assert.equal(firstSource.onended, null, 'handler cleared after disposal');
});

test('APU creates noise channels with an audible (non-zero) output gain', () => {
  const ctx = new AudioContext();
  const apu = new GameBoyAPU(ctx);
  const n1 = apu.getNoiseChannel('n1');
  const n2 = apu.getNoiseChannel('n2');
  assert.ok(n1, 'n1 present');
  assert.ok(n2, 'n2 present');

  // The noise channel's output node feeds masterGain; its gain must be > 0
  // (regression guard for the old createChannelGain(id, 0) mute).
  const n1Output = n1['outputNode'];
  const n2Output = n2['outputNode'];
  assert.ok(n1Output.gain.value > 0, `n1 gain audible, got ${n1Output.gain.value}`);
  assert.ok(n2Output.gain.value > 0, `n2 gain audible, got ${n2Output.gain.value}`);
});

test('APU.stopAll clears active nodes and resets noise channel sessions', () => {
  __resetTime();
  const ctx = new AudioContext();
  const apu = new GameBoyAPU(ctx);

  apu.scheduleNote({ channel: 'p1', midiNote: 60, startTime: 0.1, duration: 0.2, velocity: 100 });
  apu.scheduleNote({ channel: 'w1', midiNote: 36, startTime: 0.1, duration: 0.3, velocity: 100 });
  apu.scheduleNote({ channel: 'n1', midiNote: 36, startTime: 0.1, duration: 0.15, velocity: 110 });
  apu.scheduleNote({ channel: 'n2', midiNote: 70, startTime: 0.2, duration: 0.08, velocity: 80 });

  assert.equal(apu.getScheduledNoteCount(), 4);
  assert.equal(apu.getNoiseChannel('n1').getActiveVoiceCount(), 1);
  assert.equal(apu.getNoiseChannel('n2').getActiveVoiceCount(), 1);

  __advanceTime(0.5);
  apu.stopAll();

  assert.equal(apu.getScheduledNoteCount(), 0, 'scheduled note counter reset');
  assert.equal(apu.getNoiseChannel('n1').getActiveVoiceCount(), 0);
  assert.equal(apu.getNoiseChannel('n2').getActiveVoiceCount(), 0);
  assert.equal(apu.getNoiseChannel('n1').getCacheSize(), 0, 'n1 cache cleared');
  assert.equal(apu.getNoiseChannel('n2').getCacheSize(), 0, 'n2 cache cleared');

  for (const id of ['p1', 'w1', 'n1', 'n2']) {
    assert.equal(apu.isChannelFree(id), true, `${id} free after stopAll`);
  }
});

test('replay after stop schedules fresh nodes without stacking stopped ones', () => {
  __resetTime();
  const ctx = new AudioContext();
  const apu = new GameBoyAPU(ctx);

  apu.scheduleNote({ channel: 'n1', midiNote: 36, startTime: 0.1, duration: 0.15, velocity: 110 });
  apu.scheduleNote({ channel: 'n1', midiNote: 38, startTime: 0.4, duration: 0.15, velocity: 100 });
  assert.equal(apu.getNoiseChannel('n1').getActiveVoiceCount(), 2);

  apu.stopAll();

  // Second session on the same APU (mirrors playFrom after stop).
  apu.scheduleNote({ channel: 'n1', midiNote: 36, startTime: 1.1, duration: 0.15, velocity: 110 });
  const n1 = apu.getNoiseChannel('n1');
  assert.equal(n1.getActiveVoiceCount(), 1, 'only the new session voice is tracked');
  assert.equal(n1.getCacheSize(), 1, 'fresh cache rebuilt for the new session note');
});

test('onended handler chain disconnects the per-note gain node', () => {
  __resetTime();
  const ctx = new AudioContext();
  const apu = new GameBoyAPU(ctx);
  apu.scheduleNote({ channel: 'n1', midiNote: 36, startTime: 0.1, duration: 0.15, velocity: 110 });
  const n1 = apu.getNoiseChannel('n1');
  assert.equal(n1.getActiveVoiceCount(), 1);

  // The APU wrapped the channel's onended. Firing it must drop the APU's
  // tracked node AND dispose the channel voice (which disconnects gain).
  assert.equal(apu.activeNodes.size, 1);
  flushEnded();
  assert.equal(apu.activeNodes.size, 0, 'APU drops node after natural end');
  assert.equal(n1.getActiveVoiceCount(), 0, 'channel voice disposed after natural end');
});

test('offline renderToBuffer routes drum notes to noise channels with mode applied', async () => {
  __resetTime();
  const midi = buildDrumGrooveMidi({ bars: 4, bpm: 120 });

  const player = new GameBoyPlayer({ autoResume: false });
  const info = player.prepareMIDI(midi);
  assert.ok(info.noteCount > 0, 'notes parsed from test MIDI');

  const noiseAssignments = info.assignments.filter((a) => a.channelId.startsWith('n'));
  assert.ok(noiseAssignments.length > 0, 'drum track assigned to a noise channel');
  for (const a of noiseAssignments) {
    assert.ok(a.noiseMode === '7bit' || a.noiseMode === '15bit',
      `noise mode recorded for ${a.channelId}`);
  }

  const buffer = await player.renderToBuffer(22050, 30);
  assert.ok(buffer, 'render returns an AudioBuffer');
  assert.equal(buffer.numberOfChannels, 2);
  assert.ok(buffer.length > 0);

  // Independently construct the offline APU the same way renderToBuffer does
  // and assert every drum note becomes a tracked, audible offline voice with
  // the assignment's LFSR mode applied.
  const offline = new OfflineAudioContext(2, Math.ceil(30.5 * 22050), 22050);
  const offlineApu = new GameBoyAPU(offline, {});
  for (const a of info.assignments) {
    if (a.channelId.startsWith('n') && a.noiseMode) {
      offlineApu.setNoiseMode(a.channelId, a.noiseMode);
    }
  }
  const drumNotes = player.loadedNotes.filter((n) => n.channel.startsWith('n'));
  assert.ok(drumNotes.length > 0, 'drum notes available for offline scheduling');
  for (const note of drumNotes) offlineApu.scheduleNote(note);

  assert.ok(offline.scheduledSources.length > 0, 'offline context received buffer sources');
  const tracked =
    offlineApu.getNoiseChannel('n1').getActiveVoiceCount() +
    offlineApu.getNoiseChannel('n2').getActiveVoiceCount();
  assert.equal(tracked, drumNotes.length, 'every drum note became a tracked offline noise voice');

  // Noise outputs must be audible offline too.
  for (const id of ['n1', 'n2']) {
    const out = offlineApu.getNoiseChannel(id)['outputNode'];
    assert.ok(out.gain.value > 0, `${id} offline gain audible`);
  }
  // Modes were applied per assignment.
  for (const a of noiseAssignments) {
    assert.equal(
      offlineApu.getNoiseChannel(a.channelId).getMode(),
      a.noiseMode,
      `${a.channelId} mode applied offline`
    );
  }
});

test('rendered 30s WAV contains measurable noise-channel energy (not silent)', async () => {
  __resetTime();
  const midi = buildDrumGrooveMidi({ bars: 4, bpm: 120 });
  const player = new GameBoyPlayer({ autoResume: false });
  player.prepareMIDI(midi);

  const buffer = await player.renderToBuffer(22050, 30);
  assert.ok(buffer);
  const left = buffer.getChannelData(0);
  const rms = Math.sqrt(left.reduce((acc, v) => acc + v * v, 0) / left.length);
  const peak = left.reduce((acc, v) => Math.max(acc, Math.abs(v)), 0);
  const nonzeroSamples = left.filter((v) => v !== 0).length;
  assert.ok(rms > 0, `rendered signal has non-zero RMS (got ${rms})`);
  assert.ok(peak > 0, `rendered signal has non-zero peaks (got ${peak})`);
  assert.ok(nonzeroSamples > 1000,
    `thousands of samples carry signal, got ${nonzeroSamples}`);

  // Prove the energy actually comes through the noise path: render an APU
  // whose noise outputs are forcibly muted and confirm its noise-only render
  // is silent, while the same notes are loud with the fixed gain.
  const length = Math.ceil(2 * 22050);
  const mutedCtx = new OfflineAudioContext(2, length, 22050);
  const mutedApu = new GameBoyAPU(mutedCtx, {});
  mutedApu.getNoiseChannel('n1')['outputNode'].gain.value = 0;
  mutedApu.getNoiseChannel('n2')['outputNode'].gain.value = 0;
  const drumNotes = player.loadedNotes.filter((n) => n.channel.startsWith('n'));
  for (const note of drumNotes) mutedApu.scheduleNote(note);
  const mutedBuffer = await mutedCtx.startRendering();
  const mutedRms = Math.sqrt(
    mutedBuffer.getChannelData(0).reduce((acc, v) => acc + v * v, 0) / length
  );
  assert.equal(mutedRms, 0, 'muted noise channels render silence (sanity check)');

  const audibleCtx = new OfflineAudioContext(2, length, 22050);
  const audibleApu = new GameBoyAPU(audibleCtx, {});
  for (const note of drumNotes) audibleApu.scheduleNote(note);
  const audibleBuffer = await audibleCtx.startRendering();
  const audibleRms = Math.sqrt(
    audibleBuffer.getChannelData(0).reduce((acc, v) => acc + v * v, 0) / length
  );
  assert.ok(audibleRms > 0, `audible noise channels render energy (got ${audibleRms})`);
});

test('full player cycle: prepare -> play -> stop -> replay keeps drums working', async () => {
  __resetTime();
  const midi = buildDrumGrooveMidi({ bars: 2, bpm: 120 });
  const player = new GameBoyPlayer({ autoResume: false });

  player.prepareMIDI(midi);
  const apu = player.getAPU();
  const n1 = apu.getNoiseChannel('n1');
  const n2 = apu.getNoiseChannel('n2');
  const drumNotes = player.loadedNotes.filter((n) => n.channel.startsWith('n'));
  assert.ok(drumNotes.length > 0, 'song contains drum notes');

  player.playFrom(0);
  assert.equal(player.getIsPlaying(), true);

  // Let the 250ms lookahead scheduler run one tick, then capture the exact
  // source nodes belonging to the first session.
  await new Promise((r) => setTimeout(r, 320));
  const firstSessionNodes = new Set(apu.activeNodes);
  assert.ok(firstSessionNodes.size > 0, 'first session scheduled nodes');
  const firstSessionNoiseSources = new Set();
  for (const id of ['n1', 'n2']) {
    for (const voice of apu.getNoiseChannel(id)['activeVoices']) {
      firstSessionNoiseSources.add(voice.source);
    }
  }
  assert.ok(firstSessionNoiseSources.size > 0, 'first session created noise voices');

  player.stop();
  assert.equal(player.getIsPlaying(), false);
  assert.equal(n1.getActiveVoiceCount(), 0, 'n1 fully stopped');
  assert.equal(n2.getActiveVoiceCount(), 0, 'n2 fully stopped');
  assert.equal(n1.getCacheSize(), 0);
  assert.equal(n2.getCacheSize(), 0);
  assert.equal(apu.activeNodes.size, 0, 'no APU nodes survive stop');
  // The first-session sources must be disconnected from the live graph.
  for (const source of firstSessionNoiseSources) {
    assert.equal(source.connected.length, 0, 'old noise source disconnected');
  }

  // Replay from the top: fresh session. None of the old nodes may reappear.
  __advanceTime(0.1);
  player.playFrom(0);
  assert.equal(player.getIsPlaying(), true);
  for (const oldNode of firstSessionNodes) {
    assert.ok(!apu.activeNodes.has(oldNode), 'stopped node is not re-tracked on replay');
  }
  await new Promise((r) => setTimeout(r, 320));
  // The lookahead scheduler should now have scheduled a fresh drum batch.
  const replayVoices = n1.getActiveVoiceCount() + n2.getActiveVoiceCount();
  assert.ok(replayVoices > 0, 'drums are scheduled again on replay');
  for (const id of ['n1', 'n2']) {
    for (const voice of apu.getNoiseChannel(id)['activeVoices']) {
      assert.ok(!firstSessionNoiseSources.has(voice.source),
        'replay voice uses a brand-new source node');
      assert.equal(voice.source.connected.length, 1, 'new source is connected');
    }
  }

  player.stop();
  assert.equal(n1.getActiveVoiceCount(), 0);
  assert.equal(n2.getActiveVoiceCount(), 0);
});

test('playFrom after stop reschedules from the correct song offset', async () => {
  __resetTime();
  const midi = buildDrumGrooveMidi({ bars: 2, bpm: 120 });
  const player = new GameBoyPlayer({ autoResume: false });
  player.prepareMIDI(midi);

  player.playFrom(0);
  await new Promise((r) => setTimeout(r, 60));
  player.stop();

  // Seek into the middle of the song.
  const duration = player.getPlaybackInfo().duration;
  const offset = duration * 0.5;
  player.playFrom(offset);
  assert.equal(player.getIsPlaying(), true);

  // The scheduler index must have skipped notes before the offset. We can
  // observe this indirectly: elapsed time reports near the requested offset.
  await new Promise((r) => setTimeout(r, 60));
  const elapsed = player.getElapsedTime();
  assert.ok(elapsed >= offset - 0.5, `elapsed ${elapsed} resumes near offset ${offset}`);
  player.stop();
});

test('repeated stop/play cycles never accumulate voices, nodes or caches', async () => {
  __resetTime();
  const midi = buildDrumGrooveMidi({ bars: 2, bpm: 120 });
  const player = new GameBoyPlayer({ autoResume: false });
  player.prepareMIDI(midi);
  const apu = player.getAPU();

  for (let cycle = 0; cycle < 5; cycle++) {
    player.playFrom(0);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(player.getIsPlaying(), true);
    player.stop();
    assert.equal(player.getIsPlaying(), false);
    assert.equal(apu.activeNodes.size, 0, `cycle ${cycle}: no active nodes after stop`);
    for (const id of ['n1', 'n2']) {
      const ch = apu.getNoiseChannel(id);
      assert.equal(ch.getActiveVoiceCount(), 0, `cycle ${cycle}: ${id} no voices`);
      assert.equal(ch.getCacheSize(), 0, `cycle ${cycle}: ${id} cache cleared`);
    }
  }
});

test('stopAll twice in a row is safe', () => {
  __resetTime();
  const ctx = new AudioContext();
  const apu = new GameBoyAPU(ctx);
  apu.scheduleNote({ channel: 'n1', midiNote: 36, startTime: 0.1, duration: 0.15, velocity: 110 });
  assert.doesNotThrow(() => {
    apu.stopAll();
    apu.stopAll();
  });
  assert.equal(apu.getNoiseChannel('n1').getActiveVoiceCount(), 0);
});

test('direct drum helper voices are also cleaned up by APU.stopAll', () => {
  __resetTime();
  const ctx = new AudioContext();
  const apu = new GameBoyAPU(ctx);
  const n1 = apu.getNoiseChannel('n1');

  // Voices created directly (bypassing scheduleNote/trackNode) must still be
  // torn down, since stopAll() delegates to NoiseChannel.reset().
  const kick = n1.playKick(110, 0);
  const hat = n1.playHihat(80, false, 0.2);
  assert.equal(n1.getActiveVoiceCount(), 2);

  apu.stopAll();
  assert.equal(n1.getActiveVoiceCount(), 0);
  assert.equal(kick.source.connected.length, 0);
  assert.equal(hat.source.connected.length, 0);
  assert.equal(kick.gainNode.connected.length, 0);
  assert.equal(hat.gainNode.connected.length, 0);
});

test('buffer cache bounds its size and always covers the requested note', () => {
  __resetTime();
  const { channel } = makeChannel('15bit');
  // Force more distinct frequencies than the cache limit (8).
  for (let i = 0; i < 12; i++) {
    channel.playNote(24 + i * 5, 0.1, 100, i * 0.05);
  }
  assert.ok(channel.getCacheSize() <= 8, `cache bounded at 8, got ${channel.getCacheSize()}`);

  // Every scheduled source buffer must still cover its own note window.
  // Re-request the earliest evicted entry: it regenerates and is long enough.
  const regen = channel.playNote(24, 0.1, 100, 1.0);
  assert.ok(regen.source.buffer.duration >= 0.1 + 0.09,
    'regenerated buffer covers note plus tail padding');
});
