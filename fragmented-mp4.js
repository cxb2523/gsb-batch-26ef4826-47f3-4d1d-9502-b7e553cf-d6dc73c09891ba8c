// ISO BMFF for one baseline AVC track (decode order = presentation order) and
// one AAC-LC track. Every media offset is relative to its own moof.
const text = value => new TextEncoder().encode(value);
const zeros = length => new Uint8Array(length);
const u16 = value => Uint8Array.of(value >>> 8, value);
const u32 = value => Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value);

function join(parts) {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function box(type, ...parts) {
  return join([u32(8 + parts.reduce((size, part) => size + part.length, 0)), text(type), ...parts]);
}
function full(type, version, flags, ...parts) {
  return box(type, u32(version * 0x1000000 + flags), ...parts);
}

const matrix = join([u32(65536), zeros(12), u32(65536), zeros(12), u32(0x40000000)]);
const videoId = 1, audioId = 2;
export const VIDEO_RATE = 1000000;

function descriptor(tag, ...parts) {
  const data = join(parts);
  if (data.length >= 128) throw new Error("AAC 配置长度超出支持范围。");
  return join([Uint8Array.of(tag, data.length), data]);
}
function track(id, width, height, description, rate, channels) {
  const video = id === videoId;
  const header = full("tkhd", 0, 7, zeros(8), u32(id), zeros(16), u16(0), u16(0),
    u16(video ? 0 : 256), u16(0), matrix, u32(width * 65536), u32(height * 65536));
  const mdhd = full("mdhd", 0, 0, zeros(8), u32(video ? VIDEO_RATE : rate), u32(0), u16(0x55c4), u16(0));
  const handler = full("hdlr", 0, 0, zeros(4), text(video ? "vide" : "soun"), zeros(12), text(video ? "Video\0" : "Audio\0"));
  const sampleHeader = join([zeros(6), u16(1)]);
  let entry;
  if (video) {
    entry = box("avc1", sampleHeader, zeros(16), u16(width), u16(height), u32(72 * 65536), u32(72 * 65536),
      zeros(4), u16(1), zeros(32), u16(24), u16(0xffff), box("avcC", description));
  } else {
    const decoder = descriptor(4, Uint8Array.of(0x40, 0x15), zeros(3), u32(128000), u32(128000), descriptor(5, description));
    const es = descriptor(3, u16(id), Uint8Array.of(0), decoder, descriptor(6, Uint8Array.of(2)));
    entry = box("mp4a", sampleHeader, zeros(8), u16(channels), u16(16), zeros(4), u32(rate * 65536), full("esds", 0, 0, es));
  }
  const table = box("stbl", full("stsd", 0, 0, u32(1), entry), full("stts", 0, 0, u32(0)),
    full("stsc", 0, 0, u32(0)), full("stsz", 0, 0, zeros(8)), full("stco", 0, 0, u32(0)));
  const data = box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1)));
  const minf = box("minf", video ? full("vmhd", 0, 1, zeros(8)) : full("smhd", 0, 0, zeros(4)), data, table);
  return box("trak", header, box("mdia", mdhd, handler, minf));
}
export function initSegment(width, height, avc, aac, rate, channels) {
  const movie = full("mvhd", 0, 0, zeros(8), u32(1000), u32(0), u32(65536), u16(256), zeros(10), matrix, zeros(24), u32(3));
  const defaults = id => full("trex", 0, 0, u32(id), u32(1), zeros(12));
  return join([box("ftyp", text("iso6"), u32(1), text("iso6isommp41")),
    box("moov", movie, track(videoId, width, height, avc), track(audioId, 0, 0, aac, rate, channels),
      box("mvex", defaults(videoId), defaults(audioId)))]).buffer;
}
function trackRun(id, samples, dataOffset) {
  const first = samples[0].time;
  // Version 1 tfdt is 64-bit. One-microsecond video ticks exceed 32 bits in ~72 minutes.
  const decodeTime = full("tfdt", 1, 0, u32(Math.floor(first / 2 ** 32)), u32(first));
  const entries = new Uint8Array(samples.length * 12);
  const view = new DataView(entries.buffer);
  samples.forEach((s, i) => {
    view.setUint32(i * 12, s.duration);
    view.setUint32(i * 12 + 4, s.data.length);
    view.setUint32(i * 12 + 8, s.key ? 0x02000000 : 0x01010000);
  });
  return box("traf", full("tfhd", 0, 0x020000, u32(id)), decodeTime,
    full("trun", 0, 0x701, u32(samples.length), u32(dataOffset), entries));
}
export function mediaSegment(sequence, video, audio) {
  const header = full("mfhd", 0, 0, u32(sequence));
  const videoBytes = video.reduce((n, s) => n + s.data.length, 0);
  const makeHeader = offset => box("moof", header, trackRun(videoId, video, offset),
    ...(audio.length ? [trackRun(audioId, audio, offset + videoBytes)] : []));
  const offset = makeHeader(0).length + 8;
  const payload = [...video, ...audio].map(s => s.data);
  const size = payload.reduce((n, data) => n + data.length, 8);
  return join([makeHeader(offset), u32(size), text("mdat"), ...payload]).buffer;
}
