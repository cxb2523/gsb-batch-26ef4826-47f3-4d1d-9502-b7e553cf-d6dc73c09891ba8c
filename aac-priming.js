import { withTimeout } from "./shared.js";

// WebCodecs exposes no AAC encoder-delay field. Measure the combined priming
// seen by a decoder of our raw AAC access units, without touching any device.
export async function measureAacPriming(config, signal) {
  const packetFrames = 1024, impulseFrame = packetFrames * 4;
  let decodedFrames = 0, peak = 0, peakFrame = 0, rejectCodec;
  const failure = new Promise((_, reject) => { rejectCodec = reject; });
  const decoder = new AudioDecoder({ error: rejectCodec, output(frame) {
    try {
      const samples = new Float32Array(frame.numberOfFrames);
      frame.copyTo(samples, { format: "f32-planar", planeIndex: 0 });
      for (let i = 0; i < samples.length; i++) {
        if (Math.abs(samples[i]) > peak) { peak = Math.abs(samples[i]); peakFrame = decodedFrames + i; }
      }
      decodedFrames += frame.numberOfFrames;
    } catch (error) { rejectCodec(error); } finally { frame.close(); }
  } });
  const cancel = () => rejectCodec(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  let encoder;
  try {
    encoder = new AudioEncoder({ error: rejectCodec, output(chunk, meta) {
      try {
        if (decoder.state === "unconfigured") decoder.configure(meta.decoderConfig);
        decoder.decode(chunk);
      } catch (error) { rejectCodec(error); }
    } });
    encoder.configure(config);
    for (let i = 0; i < 16; i++) {
      const data = new Float32Array(packetFrames * config.numberOfChannels);
      if (i === 4) for (let ch = 0; ch < config.numberOfChannels; ch++) data[ch * packetFrames] = 0.9;
      const frame = new AudioData({ format: "f32-planar", data, numberOfFrames: packetFrames,
        numberOfChannels: config.numberOfChannels, sampleRate: config.sampleRate, timestamp: Math.round(i * packetFrames * 1e6 / config.sampleRate) });
      try { encoder.encode(frame); } finally { frame.close(); }
    }
    await withTimeout(Promise.race([failure, encoder.flush().then(() => decoder.flush())]), 4000);
    const lead = peakFrame - impulseFrame;
    if (peak < 0.05 || lead < 0 || lead > 8192) throw new Error("无法测量 AAC 启动延迟，请重新启动。");
    return lead;
  } finally {
    signal.removeEventListener("abort", cancel);
    if (encoder && encoder.state !== "closed") encoder.close();
    if (decoder.state !== "closed") decoder.close();
  }
}
