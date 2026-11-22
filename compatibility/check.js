function render(id, checks) {
  const list = document.getElementById(id);
  for (const [label, status] of checks) {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const value = document.createElement("dd");
    term.textContent = label;
    value.textContent = status;
    if (status === "支持" || status === "预计支持") value.className = "ok";
    if (status === "不支持" || status === "预计不支持") value.className = "missing";
    row.append(term, value);
    list.append(row);
  }
}

async function supportsFormat(level, fps) {
  if (!globalThis.VideoEncoder || !globalThis.AudioEncoder || !globalThis.AudioDecoder || !globalThis.MediaSource || !globalThis.MediaStreamTrackProcessor) return false;
  try {
    const codec = "avc1.4200" + level;
    const [video, audio, decode] = await Promise.all([
      VideoEncoder.isConfigSupported({ codec, width: 1920, height: 1080, framerate: fps, bitrate: 8000000, latencyMode: "realtime", avc: { format: "avc" } }),
      AudioEncoder.isConfigSupported({ codec: "mp4a.40.2", sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 }),
      AudioDecoder.isConfigSupported({ codec: "mp4a.40.2", sampleRate: 48000, numberOfChannels: 2, description: Uint8Array.of(0x11, 0x90) }),
    ]);
    return video.supported && audio.supported && decode.supported && MediaSource.isTypeSupported(`video/mp4;codecs=${codec},mp4a.40.2`);
  } catch { return false; }
}

// Use product brands where available. A generic Chromium signature alone
// cannot identify which extension APIs a derivative browser ships.
function browserInfo(nav) {
  const ua = nav.userAgent;
  if (nav.userAgentData?.mobile || /Android|iPhone|iPad|iPod|Mobile/i.test(ua)
      || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1)) {
    return { name: "移动浏览器", mobile: true };
  }
  const brands = nav.userAgentData?.brands || [];
  const brand = brands.find(b => b.brand === "Microsoft Edge" || b.brand === "Google Chrome");
  if (brand) return { name: brand.brand, version: parseInt(brand.version, 10), chromiumDesktop: true };
  const edge = ua.match(/Edg\/(\d+)/);
  if (edge) return { name: "Microsoft Edge", version: Number(edge[1]), chromiumDesktop: true };
  const chrome = ua.match(/Chrome\/(\d+)/);
  if (chrome) return { name: "Chromium 内核浏览器", version: Number(chrome[1]) };
  const firefox = ua.match(/Firefox\/(\d+)/);
  if (firefox) return { name: "Firefox", version: Number(firefox[1]) };
  const safari = ua.match(/Version\/(\d+(?:\.\d+)?).*Safari\//);
  if (safari) return { name: "Safari", version: parseFloat(safari[1]) };
  return { name: "当前浏览器" };
}

const browser = browserInfo(navigator);
let minimums = [];
if (browser.chromiumDesktop) minimums = [88, 116, 109];
if (browser.name === "Firefox") minimums = [109, Infinity, Infinity];
if (browser.name === "Safari") minimums = [15.4, Infinity, Infinity];
const labels = ["Manifest V3 扩展", "标签页采集 · tabCapture 转交后台", "后台文档 · offscreen"];
const framework = labels.map((label, i) => {
  if (!minimums.length) return [label, "无法确认"];
  return [label, browser.version >= minimums[i] ? "预计支持" : "预计不支持"];
});
render("extension-results", framework);

async function reportMedia() {
  const media = [
    ["纯音频延迟 · Web Audio", typeof globalThis.AudioContext?.prototype.createDelay === "function"],
    ["播放器区域裁剪", !!globalThis.MediaStreamTrackProcessor && !!globalThis.VideoFrame],
    ["MP4 录制与播放 · 720p / 1080p30", await supportsFormat("28", 30)],
    ["MP4 录制与播放 · 1080p60", await supportsFormat("2a", 60)],
  ];
  render("media-results", media.map(([label, supported]) => [label, supported ? "支持" : "不支持"]));

  const name = [browser.name, browser.version].filter(Boolean).join(" ");
  let summary;
  if (browser.mobile) summary = "本插件面向桌面浏览器，请在电脑上打开此页。";
  else if (framework.some(([, status]) => status === "预计不支持")) summary = "当前版本预计缺少插件所需的扩展能力。";
  else if (!minimums.length) summary = "扩展框架支持情况待确认，音视频检测结果见下方。";
  else if (media.every(([, supported]) => supported)) summary = "预计可使用纯音频和音画延迟。";
  else summary = "部分音视频能力不可用，详见下方。";
  document.getElementById("summary").textContent = name + " · " + summary;
}
void reportMedia();
