import { AudioEngine } from "./audio-engine.js";
import { AVEngine } from "./av-engine.js";
import { CHANNEL, errorText } from "./shared.js";

const notify = () => {
  void chrome.runtime.sendMessage({ channel: CHANNEL, target: "worker", type: "ENGINE_CHANGED" }).catch(() => {});
};
const audioEngine = new AudioEngine({
  mediaDevices: navigator.mediaDevices,
  createContext: () => new AudioContext({ latencyHint: "playback" }),
  onChange: notify,
});
const avEngine = new AVEngine({ mediaDevices: navigator.mediaDevices, onChange: notify });
// The engine chosen by the most recent START, so its terminal state (notice,
// error) remains visible even after its session object has been cleared.
let engine = audioEngine;

const owningEngine = () => (engine.session ? engine
  : [avEngine, audioEngine].find(item => item.session) || engine);
// Every terminal release from both engines; awaiting this guarantees that a
// document is never destroyed while tracks/encoders are still shutting down.
const cleanupAll = () => Promise.all([audioEngine.cleanupPromise, avEngine.cleanupPromise]);

// A command carries the session the worker observed. If a newer session has
// replaced it, only drain the old cleanup; never touch the new session.
async function stopEngine(sessionId, reason) {
  const owner = owningEngine();
  const current = owner.snapshot().sessionId;
  if (sessionId && current && current !== sessionId) { await cleanupAll(); return; }
  await owner.stop(reason);
}

async function interruptEngine(sessionId, reason) {
  const owner = owningEngine();
  const current = owner.snapshot().sessionId;
  if (sessionId && current && current !== sessionId) { await cleanupAll(); return; }
  if (!owner.session) { await cleanupAll(); return; }
  await owner.fail(owner.session, "interrupted", reason);
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.channel !== CHANNEL || message.target !== "offscreen") return;
  let operation;
  try {
    if (["DELAY", "QUALITY"].includes(message.type) && message.sessionId &&
        (engine !== avEngine || !engine.session || engine.state.sessionId !== message.sessionId)) throw new Error("播放已结束。");
    switch (message.type) {
      case "STATE": operation = owningEngine().snapshot(); break;
      case "CLEANUP": operation = cleanupAll(); break;
      case "START":
        if (!engine.snapshot().active) engine = message.data.mode === "av" ? avEngine : audioEngine;
        operation = engine.start(message.data); break;
      case "STOP": operation = stopEngine(message.sessionId, message.reason); break;
      case "DELAY": operation = engine.setDelay(message.delay); break;
      case "QUALITY": operation = avEngine.setQuality(message.quality); break;
      case "REGION": operation = engine instanceof AVEngine ? engine.setRegion(message) : engine.snapshot(); break;
      case "INTERRUPT": operation = interruptEngine(message.sessionId, message.reason); break;
      default: return;
    }
    Promise.resolve(operation).then(() => respond({ ok: true, state: owningEngine().snapshot() }),
      error => respond({ ok: false, error: errorText(error) }));
  } catch (error) { respond({ ok: false, error: errorText(error) }); }
  return true;
});

// Cleanup fallback if the document is explicitly closed or extension reloaded.
window.addEventListener("pagehide", () => {
  void audioEngine.stop();
  void avEngine.stop();
});
