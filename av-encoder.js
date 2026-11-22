import { VIDEO_RATE, initSegment, mediaSegment } from "./fragmented-mp4.js";
import { measureAacPriming } from "./aac-priming.js";
import { cropPixels, outputSize, encoderConfig, videoMime } from "./video-options.js";

// Audio samples are the master clock. Anchor each processor's possibly
// unrelated timestamp origin once. Map video capture times to the audio sample
// clock as it advances, including small differences in device clock rates.
export class CaptureClock {
  audioFrames = 0;
  observeAudio(timestamp, frames, rate, now) {
    // Chromium exposes audio capture time relative to this document in
    // recent versions. Older processors can expose a track-local epoch.
    this.audioStart ??= { timestamp, now: Math.abs(timestamp - now) < 500000 ? timestamp : now };
    const elapsed = timestamp - this.audioStart.timestamp;
    const sampleTime = Math.round(this.audioFrames * VIDEO_RATE / rate);
    const correction = sampleTime - elapsed;
    if (this.correction !== undefined && Math.abs(correction - this.correction) > 250000) {
      throw new Error("采集音频时间戳发生跳变，已停止以免音画失步。");
    }
    this.correction = correction;
    this.audioFrames += frames;
    return sampleTime;
  }
  videoTime(timestamp, now) {
    this.videoStart ??= { timestamp, now };
    if (!this.audioStart) return null;
    return Math.round(timestamp - this.videoStart.timestamp + this.videoStart.now - this.audioStart.now + this.correction);
  }
}

export class AVEncoder {
  constructor({ preset, geometry, maxBytes, onBytes, onFormat, onClock, onError }) {
    Object.assign(this, { preset, geometry, maxBytes, onBytes, onFormat, onClock, onError });
    this.clock = new CaptureClock();
    this.abort = new AbortController();
    this.samples = { video: [], audio: [] };
    this.descriptions = {};
    this.readers = [];
    this.tasks = [];
    this.bytes = 0;
    this.sequence = 0;
    this.audioSamples = 0;
    this.keyTime = -Infinity;
    this.videoTime = -1;
    this.needsVideoInit = true;
  }

  async start(videoTrack, audioTrack, rate, channels) {
    if (!globalThis.VideoEncoder || !globalThis.AudioEncoder || !globalThis.AudioDecoder || !globalThis.MediaStreamTrackProcessor) {
      throw new Error("音画模式需要 WebCodecs 视频和音频编码支持，请更新浏览器或使用纯音频模式。");
    }
    this.rate = rate;
    this.channels = channels;
    const audioConfig = { codec: "mp4a.40.2", sampleRate: rate, numberOfChannels: channels, bitrate: 128000 };
    if (!(await AudioEncoder.isConfigSupported(audioConfig)).supported) throw new Error("此浏览器不支持 WebCodecs AAC 编码，可使用纯音频模式。");
    if (this.closed) return;
    this.calibration = measureAacPriming(audioConfig, this.abort.signal);
    const priming = await this.calibration;
    if (this.closed) return;
    this.videoLead = Math.round(priming * VIDEO_RATE / rate);
    const callbacks = type => ({ output: (chunk, meta) => {
      if (!this.closed) {
        try { this.output(type, chunk, meta); } catch (error) { this.onError(error); }
      }
    }, error: error => { if (!this.closed) this.onError(error); } });
    this.audio = new AudioEncoder(callbacks("audio"));
    this.audio.configure(audioConfig);
    this.video = new VideoEncoder(callbacks("video"));
    this.read(audioTrack, frame => this.encodeAudio(frame), 64);
    this.read(videoTrack, frame => this.encodeVideo(frame), 1);
  }

  read(track, encode, maxBufferSize) {
    const reader = new MediaStreamTrackProcessor({ track, maxBufferSize }).readable.getReader();
    this.readers.push(reader);
    const task = (async () => {
      while (!this.closed) {
        const { done, value } = await reader.read();
        if (done) { if (!this.closed) throw new Error("音画采集轨道已结束。"); break; }
        try { if (!this.closed) await encode(value); } finally { value.close(); }
      }
    })().catch(error => { if (!this.closed) this.onError(error); });
    this.tasks.push(task);
  }

  encodeAudio(frame) {
    if (frame.sampleRate !== this.rate || frame.numberOfChannels !== this.channels) throw new Error("采集音频格式发生变化，请重新启动。");
    if (this.audio.encodeQueueSize > 100) throw new Error("音频编码持续积压，请重新启动。");
    const now = performance.now();
    const time = this.clock.observeAudio(frame.timestamp, frame.numberOfFrames, this.rate, now * 1000);
    if (this.lastClock === undefined || time - this.lastClock >= VIDEO_RATE) {
      const origin = performance.timeOrigin + (this.clock.audioStart.now - this.clock.correction - this.videoLead) / 1000;
      this.onClock(origin, this.lastClock === undefined);
      this.lastClock = time;
    }
    this.audio.encode(frame);
  }

  async encodeVideo(frame) {
    const captureTime = this.clock.videoTime(frame.timestamp, performance.now() * 1000);
    if (captureTime === null || captureTime < 0 || this.video.encodeQueueSize > 4) return;
    const time = captureTime + this.videoLead;
    if (time <= this.videoTime) return;
    const rect = this.geometry ? cropPixels(frame, this.geometry) : frame.visibleRect;
    const preset = this.preset;
    if (this.encodingPreset !== preset) {
      const size = outputSize(rect, preset, this.geometry && this.geometry.sourceWidth / this.geometry.sourceHeight);
      const config = encoderConfig(preset, size);
      if (!(await VideoEncoder.isConfigSupported(config)).supported) throw new Error("此浏览器不支持所选画质的 WebCodecs H.264 编码。");
      // Deliver old callbacks before associating output with the new format.
      if (!this.closed && this.encodingPreset) await this.video.flush();
      if (this.closed) return;
      this.video.configure(config);
      this.encodingPreset = preset;
      this.size = size;
      this.keyTime = -Infinity;
      this.formatKey = null;
      this.needsVideoInit = true;
    }
    const formatKey = [rect.width, rect.height, frame.codedWidth, frame.codedHeight].join("/");
    if (this.formatKey !== formatKey) {
      this.formatKey = formatKey;
      this.onFormat({ ...this.size, cropWidth: rect.width, cropHeight: rect.height,
        captureWidth: frame.codedWidth, captureHeight: frame.codedHeight });
    }
    const keyFrame = time - this.keyTime >= VIDEO_RATE;
    const input = new VideoFrame(frame, { visibleRect: rect, timestamp: time });
    try { this.video.encode(input, { keyFrame }); } finally { input.close(); }
    this.videoTime = time;
    if (keyFrame) this.keyTime = time;
  }

  output(type, chunk, metadata) {
    const video = type === "video";
    let format;
    const description = metadata?.decoderConfig?.description;
    if (description) {
      const data = new Uint8Array(description);
      const old = this.descriptions[type];
      if (old && (old.length !== data.length || old.some((v, i) => v !== data[i]))) {
        if (!video) throw new Error("音频编码格式已改变，请重新启动。");
        this.needsVideoInit = true;
      }
      this.descriptions[type] = data;
    }
    if (video && this.needsVideoInit) {
      if (chunk.type !== "key" || !this.descriptions.video) throw new Error("新画质缺少可解码的起始帧。");
      format = { ...this.size, description: this.descriptions.video, mime: videoMime(this.encodingPreset || this.preset) };
      this.needsVideoInit = false;
    }
    // AAC-LC access units contain 1024 samples. Rounding a duration in
    // microseconds once per packet would accumulate error over a race.
    const time = video ? chunk.timestamp : this.audioSamples;
    if (!video) this.audioSamples += 1024;
    const queue = this.samples[type];
    if (video && queue.length) {
      const last = queue.at(-1);
      last.duration = time - last.time;
      if (last.duration <= 0 || last.duration > VIDEO_RATE * 8) throw new Error("视频时间戳中断，请重新启动。");
    }
    this.bytes += chunk.byteLength;
    if (this.bytes > this.maxBytes || queue.length >= 800) throw new Error("等待音画编码数据超时或积压过多，请重新启动。");
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    queue.push({ data, time, key: !video || chunk.type === "key", duration: video ? 0 : 1024, format });
    this.pump();
  }

  pump() {
    const { video, audio } = this.samples;
    if (!this.descriptions.audio) return;
    // Keep the first frame of the next fragment for the exact duration of the
    // last video frame. A fragment may start with a delta frame within a GOP.
    const split = video.findIndex((s, i) => i > 0 && (s.format || s.time - video[0].time >= VIDEO_RATE / 4));
    if (split < 1 || !audio.length) return;
    const boundary = video[split].time * this.rate / VIDEO_RATE;
    const cut = audio.findIndex(s => s.time >= boundary);
    if (cut < 0) return;
    // Very short intervals between switches may contain no AAC packet.
    const pictures = video.splice(0, split), sounds = audio.splice(0, cut);
    for (const s of pictures) this.bytes -= s.data.length;
    for (const s of sounds) this.bytes -= s.data.length;
    const format = pictures[0].format;
    if (format) this.onBytes(initSegment(format.width, format.height, format.description, this.descriptions.audio, this.rate, this.channels), format.mime);
    this.onBytes(mediaSegment(++this.sequence, pictures, sounds));
  }

  async close() {
    this.closed = true;
    this.abort.abort();
    for (const encoder of [this.audio, this.video]) {
      if (encoder && encoder.state !== "closed") encoder.close();
    }
    await Promise.allSettled(this.readers.map(reader => reader.cancel()));
    await Promise.allSettled([...this.tasks, this.calibration]);
    this.samples = { video: [], audio: [] };
  }
}
