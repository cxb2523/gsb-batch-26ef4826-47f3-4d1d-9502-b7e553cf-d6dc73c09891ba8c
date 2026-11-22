import { AV_CHANNEL, CHANNEL, MAX_DELAY } from "./shared.js";
import { AVPlayback } from "./av-playback.js";
import { VIDEO_PRESETS, videoMime } from "./video-options.js";

const $ = id => document.getElementById(id);
const sessionId = location.hash.slice(1);
const channel = new BroadcastChannel(AV_CHANNEL(sessionId));
let configured = false;
let lastReport = 0;
let ended = false;
let previewing = false;
let format = {}, fps = null, sampleTime = performance.now(), sampleFrames = 0;
const playback = new AVPlayback($("video"), {
  onStatus: state => {
    const now = performance.now();
    const quality = $("video").getVideoPlaybackQuality();
    const displayed = quality.totalVideoFrames - quality.droppedVideoFrames;
    if ($("video").paused || !playback.started) { sampleTime = now; sampleFrames = displayed; fps = null; }
    else if (now - sampleTime >= 3000) {
      fps = Math.max(0, (displayed - sampleFrames) * 1000 / (now - sampleTime));
      sampleTime = now; sampleFrames = displayed;
    }
    $("play").hidden = !state.blocked;
    const buffering = state.bufferRemaining > 0.05;
    const pausing = state.pauseRemaining > 0.05;
    $("overlay").hidden = !buffering && !pausing && !state.blocked && state.phase === "running";
    $("status").textContent = state.notice || (pausing ? `正在增加延迟，约 ${state.pauseRemaining.toFixed(1)} 秒后恢复音画`
      : buffering ? `正在缓存音画，约 ${state.bufferRemaining.toFixed(1)} 秒后开始播放` : "正在等待音画数据…");
    const width = $("video").videoWidth || format.width, height = $("video").videoHeight || format.height;
    $("detail").textContent = `缓冲位置差 ${state.actualDelay?.toFixed(1) ?? "—"} 秒 · 输出 ${width || "—"}×${height || "—"} · 实测 ${fps?.toFixed(1) ?? "—"}fps`;
    if (now - lastReport > 500) { lastReport = now; channel.postMessage({ type: "STATUS", ...state,
      outputFps: fps, outputWidth: width, outputHeight: height }); }
  },
  onError: error => { $("quick-controls").hidden = true; $("overlay").hidden = false; $("status").textContent = error; channel.postMessage({ type: "ERROR", error }); },
});

const stepButtons = document.querySelectorAll("button[data-step]");
function showDelay(value) {
  const seconds = value.toFixed(1);
  $("delay-value").textContent = seconds;
  $("delay-toggle").setAttribute("aria-label", `目标延迟 ${seconds} 秒，延迟与画质设置`);
  $("delay-slider").value = value;
  $("delay-slider").setAttribute("aria-valuetext", `${seconds} 秒`);
  for (const button of stepButtons) button.disabled = Number(button.dataset.step) < 0 ? value === 0 : value === MAX_DELAY;
}

function showQuality(quality) {
  format.quality = quality;
  $("quality").value = quality;
  const region = format.region === "tab" ? "整个标签页" : format.region === "manual" ? "手动区域" : "播放器区域";
  $("title").textContent = `${format.tabTitle} · ${region} · ${VIDEO_PRESETS[quality].label}`;
}

async function send(type, options) {
  $("control-error").hidden = true;
  try {
    const reply = await chrome.runtime.sendMessage({ channel: CHANNEL, target: "worker", type, sessionId, ...options });
    if (!reply?.ok) throw new Error(reply?.error || "设置未保存，请重试。");
    return true;
  } catch (error) {
    $("control-error").textContent = error.message;
    $("control-error").hidden = false;
    if (!previewing) showDelay(playback.delay);
    return false;
  }
}

for (const button of stepButtons) button.addEventListener("click", () => {
  void send("DELAY", { step: Number(button.dataset.step) });
});
function setPanel(open) {
  $("quick-settings").hidden = !open;
  $("delay-toggle").setAttribute("aria-expanded", String(open));
  if (open) $("delay-slider").focus();
}
$("delay-toggle").addEventListener("click", () => setPanel($("quick-settings").hidden));
document.addEventListener("fullscreenchange", () => {
  setPanel(false);
  const container = document.fullscreenElement === $("stage") ? $("stage") : $("viewer-footer");
  container.append($("quick-controls"));
});
document.addEventListener("pointerdown", event => {
  if (!$("quick-controls").contains(event.target)) setPanel(false);
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !$("quick-settings").hidden) {
    event.preventDefault();
    setPanel(false);
    $("delay-toggle").focus();
  }
});
$("delay-slider").addEventListener("input", event => {
  showDelay(event.target.valueAsNumber);
});
$("delay-slider").addEventListener("pointerdown", () => { previewing = true; });
window.addEventListener("pointerup", () => { previewing = false; });
$("delay-slider").addEventListener("change", event => {
  previewing = false;
  void send("DELAY", { delay: event.target.valueAsNumber });
});
$("delay-slider").addEventListener("pointercancel", () => {
  previewing = false;
  showDelay(playback.delay);
});
for (const [key, preset] of Object.entries(VIDEO_PRESETS)) {
  const option = new Option(preset.label, key);
  option.disabled = !MediaSource.isTypeSupported(videoMime(preset));
  $("quality").add(option);
}
$("quality").addEventListener("change", async event => {
  const quality = event.target.value;
  $("quality").disabled = true;
  const changed = await send("QUALITY", { quality });
  $("quality").disabled = false;
  if (!changed) $("quality").value = format.quality;
});

channel.onmessage = async ({ data }) => {
  if (ended) return;
  if (data.type === "CONFIG" && !configured) {
    configured = true;
    format = data;
    playback.maxQueuedBytes = Math.max(16 * 1024 * 1024, Math.min(32 * 1024 * 1024, data.maxQueuedBytes || 0));
    clearInterval(hello);
    showQuality(data.quality);
    showDelay(data.delay);
    try {
      await playback.configure(data.mime, data.delay);
      if (playback.closed) return;
      $("quick-controls").hidden = false;
      channel.postMessage({ type: "READY" });
    } catch (error) { playback.fail(error.message); }
  }
  if (data.type === "CHUNK") {
    playback.append(data.bytes, data.sequence, data.mime);
    if (!playback.closed) channel.postMessage({ type: "RECEIVED", sequence: data.sequence });
  }
  if (data.type === "STARTED" || data.type === "CLOCK") playback.origin = data.origin;
  if (data.type === "DELAY") {
    lastReport = 0;
    playback.setDelay(data.delay);
    if (!previewing) showDelay(data.delay);
  }
  if (data.type === "QUALITY") {
    playback.maxQueuedBytes = data.maxQueuedBytes;
    showQuality(data.quality);
  }
  if (data.type === "STOP") {
    ended = true;
    $("quick-controls").hidden = true;
    playback.close();
    channel.postMessage({ type: "RELEASED" });
    $("overlay").hidden = false;
    $("play").hidden = true;
    $("status").textContent = "已停止音画延迟，网页恢复原声。";
  }
};
const hello = setInterval(() => channel.postMessage({ type: "HELLO" }), 500);
channel.postMessage({ type: "HELLO" });
$("play").addEventListener("click", () => { void playback.play(true); });
$("fullscreen").addEventListener("click", async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await $("stage").requestFullscreen(); }
  catch (error) { $("overlay").hidden = false; $("status").textContent = `无法进入全屏：${error.message}`; }
});
window.addEventListener("pagehide", () => {
  clearInterval(hello);
  playback.close();
  channel.postMessage({ type: "CLOSED" });
  channel.close();
});
