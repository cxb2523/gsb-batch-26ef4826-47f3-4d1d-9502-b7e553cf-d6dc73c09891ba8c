import { AV_CHANNEL, idleState, normalizeDelay, errorText, withTimeout } from "./shared.js";
import { VIDEO_PRESETS, videoOptions, captureSize, queueBudget, encoderConfig, videoMime } from "./video-options.js";
import { AVEncoder } from "./av-encoder.js";

const stopTracks = stream => stream.getTracks().forEach(track => track.stop());
const maxPresetFps = Math.max(...Object.values(VIDEO_PRESETS).map(preset => preset.fps));
function applyVideoPreset(track, size, fps) {
  return track.applyConstraints({ width: { ideal: size.width, max: size.width },
    height: { ideal: size.height, max: size.height }, frameRate: { min: fps, max: fps } });
}

// Owns capture/encoding only. The visible extension page is the sole A/V output.
export class AVEngine {
  constructor({ mediaDevices, onChange = () => {} }) {
    this.mediaDevices = mediaDevices;
    this.onChange = onChange;
    this.state = idleState();
    this.session = null;
    this.cleanupPromise = Promise.resolve();
    // Invalidates state writes from a stop/fail that finishes after a new
    // session has been started. Each session's cleanup only touches its own
    // resources, never the engine's current state or channel.
    this.generation = 0;
  }
  emit() { this.onChange(this.snapshot()); }
  // A closed or closing BroadcastChannel throws on postMessage. Session writes
  // are also fenced so a released session can never signal a new one.
  post(session, message) {
    if (session.closing) return;
    try { session.channel.postMessage(message); } catch { /* channel already closed */ }
  }
  snapshot() {
    const elapsed = (performance.now() - (this.session?.reportedAt || performance.now())) / 1000;
    const paused = this.state.active && this.session?.context && this.session.context.state !== "running";
    return { ...this.state, contextState: this.session?.context?.state || (this.session ? "not-used" : "closed"),
      ...(paused ? { phase: "interrupted", notice: "音画模式音频处理暂停，正在恢复。" } : {}),
      pauseRemaining: Math.max(0, (this.state.pauseRemaining || 0) - elapsed) };
  }
  // Session-scoped channel handling. Late messages from a released session
  // are dropped because every write is fenced on this.session === session.
  attachChannel(session, config, ready) {
    session.channel.onmessage = ({ data }) => {
      // Viewer-driven ending: the viewer silenced itself on pagehide without
      // waiting for our STOP. Release this session only, and unblock any stop
      // already waiting on its bounded acknowledgement.
      if (data.type === "CLOSED") {
        session.viewerGone = true;
        session.released?.();
        void this.fail(session, "interrupted", "延迟播放页已关闭，采集已释放，网页恢复原声。");
        return;
      }
      if (data.type === "RELEASED") { session.released?.(); return; }
      if (this.session !== session) return;
      if (data.type === "HELLO" && session.configReady) this.post(session, config());
      if (data.type === "RECEIVED" && session.unacknowledged.has(data.sequence)) {
        session.inFlightBytes -= session.unacknowledged.get(data.sequence);
        session.unacknowledged.delete(data.sequence);
      }
      if (data.type === "READY") { session.lastHeartbeat = performance.now(); ready(); }
      if (data.type === "STATUS") {
        session.lastHeartbeat = session.reportedAt = performance.now();
        const { phase, bufferRemaining, pauseRemaining, actualDelay, bufferedSeconds, notice, blocked, outputFps, outputWidth, outputHeight } = data;
        const changed = phase !== this.state.phase || blocked !== this.state.blocked;
        Object.assign(this.state, { phase, bufferRemaining, pauseRemaining, actualDelay, bufferedSeconds, notice, blocked, outputFps, outputWidth, outputHeight });
        if (changed) this.emit(); // Status transitions only; no worker heartbeat.
      }
      if (data.type === "ERROR") void this.fail(session, "error", data.error);
    };
  }
  async start({ streamId, tabId, tabTitle, sessionId, delay, viewerTabId, quality, region, geometry }) {
    if (this.session) return this.snapshot();
    ++this.generation; // A new start supersedes any older cleanup's state write.
    const session = { stream: null, encoder: null, channel: new BroadcastChannel(AV_CHANNEL(sessionId)),
      context: null, audioSource: null, audioDestination: null, recovering: false,
      timer: null, reportedAt: performance.now(), lastHeartbeat: performance.now(), sequence: 0,
      unacknowledged: new Map(), inFlightBytes: 0, listeners: [],
      viewerGone: false, releasePromise: null };
    this.session = session;
    const options = videoOptions({ quality, region });
    const preset = VIDEO_PRESETS[options.quality];
    const budget = queueBudget(preset.bitrate);
    session.budget = budget;
    this.state = { ...idleState(normalizeDelay(delay)), ...options, mode: "av", active: true, phase: "capturing",
      tabId, tabTitle, sessionId, viewerTabId, startedAt: Date.now(), bufferRemaining: delay,
      actualDelay: null, bufferedSeconds: 0, contextState: "not-used" };
    const config = () => ({ type: "CONFIG", mime: this.state.mime, delay: this.state.delay, tabTitle, quality: this.state.quality,
      region: options.region, width: this.state.width, height: this.state.height, targetFps: this.state.targetFps, maxQueuedBytes: session.budget.playback });
    this.emit();
    let ready;
    const consumerReady = new Promise(resolve => { ready = resolve; });
    session.consumerReady = ready;
    this.attachChannel(session, config, ready);
    try {
      if (options.region !== "tab" && !geometry?.rect) throw new Error("播放器区域定位失败，请重新启动或手动框选。");
      const size = captureSize(preset, geometry);
      const stream = await withTimeout(this.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
        video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId,
          maxWidth: size.width, maxHeight: size.height, minFrameRate: preset.fps, maxFrameRate: maxPresetFps } },
      }), 12000, stopTracks);
      if (this.session !== session) { stopTracks(stream); return this.snapshot(); }
      session.stream = stream;
      if (!stream.getAudioTracks().length || !stream.getVideoTracks().length) throw new Error("采集流缺少音轨或画面，请重新启动。");
      let audioTrack = stream.getAudioTracks()[0];
      let { sampleRate, channelCount } = audioTrack.getSettings();
      // Feed supported native formats straight to AAC. Use Web Audio to
      // resample/downmix unusual capture formats without a speaker connection.
      if (![44100, 48000].includes(sampleRate) || ![1, 2].includes(channelCount)) {
        const context = session.context = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
        await withTimeout(context.resume(), 4000);
        if (this.session !== session) return this.snapshot();
        if (context.state !== "running") throw new Error("音画音频处理无法启动，请重新启动。");
        session.audioSource = context.createMediaStreamSource(stream);
        session.audioDestination = context.createMediaStreamDestination();
        session.audioSource.connect(session.audioDestination);
        audioTrack = session.audioDestination.stream.getAudioTracks()[0];
        sampleRate = 48000;
        channelCount = 2;
      }
      this.state.sampleRate = sampleRate;
      const videoTrack = stream.getVideoTracks()[0];
      // Reserve the capture source's frame-rate ceiling once. The current
      // track constraint controls delivery and can be raised without recapture.
      if (preset.fps < maxPresetFps) await applyVideoPreset(videoTrack, size, preset.fps);
      if (this.session !== session) return this.snapshot();
      const settings = videoTrack.getSettings();
      Object.assign(this.state, { captureWidth: settings.width, captureHeight: settings.height,
        sourceWidth: geometry?.sourceWidth, sourceHeight: geometry?.sourceHeight,
        frameRate: settings.frameRate, targetFps: preset.fps, videoBitrate: preset.bitrate, mime: videoMime(preset) });
      session.encoder = new AVEncoder({ preset, geometry: options.region === "tab" ? null : geometry, maxBytes: budget.pending,
        onFormat: format => { if (this.session === session) Object.assign(this.state, format); },
        onClock: (origin, first) => this.post(session, { type: first ? "STARTED" : "CLOCK", origin }),
        onBytes: (bytes, mime) => {
          if (this.session !== session || session.closing) return;
          session.lastFragment = performance.now();
          session.inFlightBytes += bytes.byteLength;
          if (session.inFlightBytes > session.budget.pending) throw new Error("播放页接收编码数据过慢，请重新启动或降低画质。");
          session.unacknowledged.set(session.sequence, bytes.byteLength);
          session.encodedBytes += bytes.byteLength;
          this.state.encodedMbps = session.encodedBytes * 8 / 1_000_000 / Math.max(0.1, (performance.now() - session.recordingAt) / 1000);
          this.post(session, { type: "CHUNK", sequence: session.sequence++, bytes, mime });
        },
        onError: error => void this.fail(session, "error", `音画编码失败：${errorText(error)}`) });
      for (const track of stream.getTracks()) {
        const ended = () => void this.fail(session, "interrupted", "标签页音画采集已结束。请回到直播网页重新启动。");
        track.addEventListener("ended", ended);
        session.listeners.push(() => track.removeEventListener("ended", ended));
      }
      session.configReady = true;
      this.post(session, config());
      await withTimeout(consumerReady, 8000);
      if (this.session !== session) return this.snapshot();
      session.lastFragment = session.recordingAt = performance.now();
      session.encodedBytes = 0;
      await session.encoder.start(videoTrack, audioTrack, sampleRate, channelCount);
      if (this.session !== session) return this.snapshot();
      session.timer = setInterval(() => {
        if (performance.now() - session.lastFragment > 15000) {
          void this.fail(session, "error", "长时间未收到完整的音画分片，已停止采集。");
          return;
        }
        if (session.context && session.context.state !== "running") void this.recover(session);
        // Hidden silent tabs can have timers batched once per minute by Chrome.
        // Closing a viewer is handled immediately via CLOSED/tabs.onRemoved.
        if (performance.now() - session.lastHeartbeat > 120000) {
          void this.fail(session, "error", "延迟播放页长时间无响应，已停止采集。请重新启动。");
        }
      }, 3000);
      return this.snapshot();
    } catch (error) { await this.fail(session, "error", errorText(error)); return this.snapshot(); }
  }
  setDelay(value) {
    this.state.delay = normalizeDelay(value);
    if (this.session) this.post(this.session, { type: "DELAY", delay: this.state.delay });
    this.emit();
    return this.snapshot();
  }
  async setQuality(quality) {
    const session = this.session;
    if (!session?.encoder || !Object.hasOwn(VIDEO_PRESETS, quality)) throw new Error("当前无法切换到所选画质。");
    if (quality === this.state.quality) return;
    const preset = VIDEO_PRESETS[quality];
    if (!(await VideoEncoder.isConfigSupported(encoderConfig(preset, preset))).supported) throw new Error("此设备不支持所选画质。");
    const videoTrack = session.stream.getVideoTracks()[0];
    const size = captureSize(preset, session.encoder.geometry);
    try { await applyVideoPreset(videoTrack, size, preset.fps); }
    catch { throw new Error("当前采集不支持所选画质。"); }
    if (this.session !== session) throw new Error("播放已结束。");
    session.encoder.preset = preset;
    // Older, higher-bitrate fragments can still be waiting at each stage.
    const budget = queueBudget(preset.bitrate);
    session.budget.pending = Math.max(session.budget.pending, budget.pending);
    session.budget.playback = Math.max(session.budget.playback, budget.playback);
    session.encoder.maxBytes = session.budget.pending;
    Object.assign(this.state, { quality, mime: videoMime(preset), targetFps: preset.fps, videoBitrate: preset.bitrate,
      frameRate: videoTrack.getSettings().frameRate });
    this.post(session, { type: "QUALITY", quality, maxQueuedBytes: session.budget.playback });
  }
  async setRegion({ sessionId, geometry, error }) {
    const session = this.session;
    if (!session || this.state.sessionId !== sessionId) return this.snapshot();
    if (error || !geometry?.rect) await this.fail(session, "interrupted", error || "播放器区域已丢失，请重新启动。");
    else {
      if (session.encoder) session.encoder.geometry = geometry;
      Object.assign(this.state, { sourceWidth: geometry.sourceWidth, sourceHeight: geometry.sourceHeight });
    }
    return this.snapshot();
  }
  async release(session) {
    if (!session) return;
    // Concurrent end paths (viewer CLOSED, worker STOP, track ended) share one
    // idempotent release: the first caller owns the work, the rest await it.
    if (session.releasePromise) return session.releasePromise;
    session.closing = true;
    session.releasePromise = this.performRelease(session);
    return session.releasePromise;
  }
  async performRelease(session) {
    clearInterval(session.timer);
    session.timer = null;
    session.listeners.forEach(remove => remove());
    session.listeners = [];
    // 1) Silence our delayed output first. A closed viewer has already done
    //    this on pagehide; otherwise wait (bounded) for its acknowledgement
    //    before Chrome can restore the source audio.
    if (!session.viewerGone) {
      const released = new Promise(resolve => { session.released = resolve; });
      // Not routed through post(): closing is already set and this STOP is the
      // very message that silences the viewer before tracks are stopped.
      try { session.channel.postMessage({ type: "STOP" }); } catch { /* viewer channel already gone */ }
      await withTimeout(released, 1000).catch(() => {});
    }
    // 2) Stop capture tracks, then close the encoder and audio processing.
    //    Every step is independently bounded so one stuck resource cannot
    //    block the rest.
    try { if (session.stream) stopTracks(session.stream); } catch { /* already stopped */ }
    let encoderStopped;
    try { encoderStopped = session.encoder?.close(); } catch { /* encoder already closed */ }
    await withTimeout(encoderStopped, 2000).catch(() => {});
    try { session.audioDestination?.stream.getTracks().forEach(track => track.stop()); } catch { /* already stopped */ }
    try { session.audioSource?.disconnect(); } catch { /* context may already be closed */ }
    if (session.context && session.context.state !== "closed") {
      await withTimeout(session.context.close(), 2000).catch(() => {});
    }
    // 3) Only then close the communication channel.
    try { session.channel.close(); } catch { /* already closed */ }
  }
  async recover(session) {
    if (this.session !== session || session.recovering || session.closing) return;
    session.recovering = true;
    this.emit();
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await withTimeout(session.context.resume(), 2000); } catch { /* bounded recovery */ }
      if (this.session !== session) return;
      if (session.context.state === "running") { session.recovering = false; this.emit(); return; }
    }
    await this.fail(session, "error", "音画音频处理暂停后无法恢复，请重新启动。");
  }
  async fail(session, phase, error) {
    if (!session || this.session !== session) return;
    this.session = null; // Cancel pending capture/consumer initialization too.
    ++this.generation; // Fence late status writes from the released session.
    this.state = { ...this.state, active: false, phase, error, notice: "", bufferRemaining: 0, pauseRemaining: 0 };
    // Unblock a start() still waiting for the consumer so its response (and
    // the worker's STOP) does not stall for the full readiness timeout.
    session.consumerReady?.();
    // A viewer CLOSED event can race with the worker's STOP command. Keep the
    // release promise after clearing session so STOP still waits for tracks,
    // encoder and AudioContext cleanup before the document is destroyed.
    const cleanup = this.cleanupPromise = this.release(session);
    this.emit();
    await cleanup;
  }
  async stop(reason = "") {
    const session = this.session;
    this.session = null;
    if (session) {
      session.consumerReady?.();
      this.cleanupPromise = this.release(session);
    }
    const token = ++this.generation;
    const cleanup = this.cleanupPromise;
    await cleanup;
    // A new session may have started while the old one was releasing. Its
    // state and channel must not be overwritten by this stale stop.
    if (this.session || this.generation !== token) return this.snapshot();
    this.state = { ...idleState(this.state.delay), mode: "av", tabId: this.state.tabId, tabTitle: this.state.tabTitle, notice: reason };
    this.emit();
    return this.snapshot();
  }
}
