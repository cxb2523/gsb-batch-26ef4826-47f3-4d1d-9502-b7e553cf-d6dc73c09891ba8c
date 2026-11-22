import test from 'node:test';
import assert from 'node:assert/strict';
import { AVEncoder, CaptureClock } from '../av-encoder.js';
import { initSegment, mediaSegment } from '../fragmented-mp4.js';
import { VIDEO_PRESETS } from '../video-options.js';

function boxes(bytes, from = 0, end = bytes.length) {
  const list = [];
  for (let pos = from; pos < end;) {
    const size = bytes.readUInt32BE(pos);
    assert.ok(size >= 8 && pos + size <= end);
    list.push({ type: bytes.toString('ascii', pos + 4, pos + 8), pos, size });
    pos += size;
  }
  return list;
}
const children = (bytes, box) => boxes(bytes, box.pos + 8, box.pos + box.size);

test('fragments use moof-relative offsets and 64-bit track-local times after three hours', () => {
  const v = { time: 10800 * 1e6, duration: 16683, key: true, data: Uint8Array.of(11, 22) };
  const a = { time: 10800 * 48000, duration: 1024, key: true, data: Uint8Array.of(33, 44, 55) };
  const bytes = Buffer.from(mediaSegment(43001, [v], [a]));
  const [moof, mdat] = boxes(bytes);
  assert.equal(moof.type, 'moof'); assert.equal(mdat.type, 'mdat');
  const [mfhd, ...tracks] = children(bytes, moof);
  assert.equal(bytes.readUInt32BE(mfhd.pos + 12), 43001);
  for (const [i, sample] of [v, a].entries()) {
    const [tfhd, tfdt, trun] = children(bytes, tracks[i]);
    assert.equal(bytes.readUInt32BE(tfhd.pos + 8), 0x020000);
    assert.equal(bytes[tfdt.pos + 8], 1);
    assert.equal(bytes.readBigUInt64BE(tfdt.pos + 12), BigInt(sample.time));
    const offset = bytes.readUInt32BE(trun.pos + 16);
    assert.equal(offset, mdat.pos + 8 + (i ? v.data.length : 0));
    assert.deepEqual([...bytes.subarray(offset, offset + sample.data.length)], [...sample.data]);
    assert.equal(bytes.readUInt32BE(trun.pos + 20), sample.duration);
  }
  const init = Buffer.from(initSegment(1920, 1080, Uint8Array.of(1), Uint8Array.of(0x12,0x10), 44100, 2));
  assert.deepEqual(boxes(init).map(b => b.type), ['ftyp', 'moov']);
});

test('audio sample clock aligns video through three hours of oscillator skew and unrelated track origins', () => {
  const clock = new CaptureClock(), rate = 44100, origin = 801234000000, delayUs = 20000;
  for (let i = 0; i < 10800 * 100; i++) {
    // The device delivers 441 samples per block at an actual rate 100 ppm fast.
    const wall = 2000000 + Math.round(i * 10000 / 1.0001);
    const media = clock.observeAudio(wall, 441, rate, wall + delayUs);
    if (i % 2 === 0) {
      const pts = clock.videoTime(origin + wall, wall + 2000);
      assert.ok(Math.abs(pts - media - 2000) <= 1);
    }
  }
  assert.throws(() => clock.observeAudio(40e9, 441, rate, 40e9), /时间戳/);
});

test('sample queues release bytes as complete fragments are sent, and never accumulate a missing track', () => {
  const output = [];
  const encoder = new AVEncoder({ preset: VIDEO_PRESETS['720p30'], maxBytes: 4096, onBytes: b => output.push(Buffer.from(b)) });
  Object.assign(encoder, { size: { width: 640, height: 360 }, rate: 48000, channels: 2 });
  const chunk = (timestamp, type) => ({ timestamp, type, byteLength: 8, copyTo: buf => buf.fill(1) });
  for (let i = 0; i < 100; i++) {
    encoder.output('video', chunk(Math.round(i * 1e6 / 50), i % 50 ? 'delta' : 'key'), i ? {} : { decoderConfig: { description: Uint8Array.of(1) } });
    encoder.output('audio', chunk(i * 21333, 'key'), i ? {} : { decoderConfig: { description: Uint8Array.of(0x11,0x90) } });
  }
  assert.ok(output.length >= 8);
  assert.equal(output[0].toString('ascii', 4, 8), 'ftyp');
  assert.ok(output.slice(1).every(bytes => bytes.toString('ascii', 4, 8) === 'moof'));
  assert.equal(encoder.bytes, 8 * (encoder.samples.video.length + encoder.samples.audio.length));
  assert.throws(() => {
    for (let i = 100; i < 1000; i++) encoder.output('audio', chunk(i * 21333, 'key'), {});
  }, /积压/);
});

test('crop uses the source frame timestamp and visible rectangle, scales in the encoder and closes the view', async () => {
  const originalFrame = globalThis.VideoFrame, originalEncoder = globalThis.VideoEncoder;
  const preset = VIDEO_PRESETS['720p30'];
  const geometry = { rect: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, sourceWidth: 1920, sourceHeight: 1080 };
  let input, config, key, closed = 0;
  globalThis.VideoEncoder = { isConfigSupported: async () => ({ supported: true }) };
  globalThis.VideoFrame = class { constructor(frame, options) { this.options = options; } close() { closed++; } };
  try {
    const encoder = new AVEncoder({ preset, geometry, onFormat() {} });
    encoder.videoLead = 0;
    encoder.clock.videoTime = t => t;
    encoder.video = { configure: c => { config = c; }, encode: (f, o) => { input = f; key = o.keyFrame; }, encodeQueueSize: 0 };
    await encoder.encodeVideo({ timestamp: 200000, codedWidth: 1920, codedHeight: 1080 });
    assert.deepEqual(input.options.visibleRect, { x: 192, y: 108, width: 1536, height: 864 });
    assert.equal(input.options.timestamp, 200000); assert.equal(closed, 1); assert.ok(key);
    assert.equal(config.width,1280); assert.equal(config.height,720);
  } finally { globalThis.VideoFrame = originalFrame; globalThis.VideoEncoder = originalEncoder; }
});

test('quality changes split fragments on keyframes and keep both track timelines continuous', () => {
  const packets = [];
  const encoder = new AVEncoder({ preset: VIDEO_PRESETS['720p30'], maxBytes: 4096,
    onBytes: (bytes, mime) => packets.push({ bytes: Buffer.from(bytes), mime }) });
  Object.assign(encoder, { size: { width: 1280, height: 720 }, rate: 48000, channels: 2 });
  const chunk = (timestamp, key) => ({ timestamp, type: key ? 'key' : 'delta', byteLength: 1, copyTo: b => b.fill(1) });
  const config = id => ({ decoderConfig: { description: Uint8Array.of(id) } });
  // Video runs ahead of audio. Two transitions are already queued when the
  // muxer gets its first chance to write out the original format.
  for (let i = 0; i < 60; i++) {
    const change = i === 7 || i === 8;
    if (change) {
      encoder.encodingPreset = VIDEO_PRESETS[i === 7 ? '1080p60' : '720p30'];
      encoder.size = { width: encoder.encodingPreset.width, height: encoder.encodingPreset.height };
      encoder.needsVideoInit = true;
    }
    encoder.output('video', chunk(i * 16000, !i || change), !i || change ? config(i + 1) : {});
  }
  for (let i = 0; i < 50; i++) encoder.output('audio', chunk(0, true), i ? {} : config(42));
  const formats = [], firstVideoTimes = [];
  const nextTime = [0, 0];
  let expectKey = false;
  for (const { bytes, mime } of packets) {
    if (mime) {
      formats.push(mime);
      expectKey = true;
      continue;
    }
    const [, ...tracks] = children(bytes, boxes(bytes)[0]);
    for (const [index, track] of tracks.entries()) {
      const [, tfdt, trun] = children(bytes, track);
      const start = Number(bytes.readBigUInt64BE(tfdt.pos + 12));
      assert.equal(start, nextTime[index]);
      if (index === 0 && expectKey) {
        firstVideoTimes.push(start);
        assert.equal(bytes.readUInt32BE(trun.pos + 28), 0x02000000);
        expectKey = false;
      }
      const count = bytes.readUInt32BE(trun.pos + 12);
      for (let i = 0; i < count; i++) nextTime[index] += bytes.readUInt32BE(trun.pos + 20 + i * 12);
    }
  }
  assert.deepEqual(firstVideoTimes, [0, 112000, 128000]);
  assert.deepEqual(formats.map(mime => mime.includes('42002a')), [false, true, false]);
  assert.ok(nextTime[0] > 500000 && nextTime[1] > 24000);
});
