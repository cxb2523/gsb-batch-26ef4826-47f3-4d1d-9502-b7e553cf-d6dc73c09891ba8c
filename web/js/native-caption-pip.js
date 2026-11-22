/** Native subtitles: send the timeline once, then synchronize the native clock. */
import { trackCfg } from './trackcfg.js';
import { pipLines } from './video-pip.js';
import { randomId, toast } from './util.js';
import { mediaControl } from './media-controls.js';
import { createPipSession } from './pip-session.js';

export function setupNativeCaptionPip({ bridge, media, engine, onStateChange, pipSession = createPipSession() }) {
  let session = '', sequence = 0, active = false, opening = false, closing = false;
  let disposed = false, stalled = false, lastSent = -Infinity, lastTimeline = '';
  let inFlight = false, queued = null, originalDisablePip = false;
  // Active means the native window is attached. Permission/startup requests are only busy.
  const isActive = () => active;
  const hasSession = () => active || opening || closing;
  const isBusy = () => opening || closing;
  const state = () => ({ session, sequence: ++sequence,
    nativeAudioSession: media.nativeSession || '',
    position: Number(media.currentTime) || 0,
    duration: Number.isFinite(media.duration) ? media.duration : engine.track?.duration || 0,
    rate: media.playbackRate || 1, paused: media.paused || media.ended || stalled,
    playing: !media.paused && !media.ended,
    captionSize: trackCfg.video.captionSize, showTranslation: document.documentElement.dataset.tr !== '0' });
  const timeline = () => (engine.track?.sentences || []).map((sentence, i) => ({
    start: engine.track.sStart[i], ...pipLines(sentence, true),
  }));

  function clear() {
    media.disablePictureInPicture = originalDisablePip;
    session = ''; active = opening = closing = false; queued = null; lastTimeline = '';
    pipSession.release('captions');
    onStateChange?.();
  }

  async function send() {
    if (inFlight || !queued) return;
    const next = queued; queued = null; inFlight = true;
    try { await bridge.update(next); }
    catch (error) {
      if (next.session === session && next.sentences) lastTimeline = '';
      console.warn('[caption-pip] 字幕同步失败', error);
    }
    finally { inFlight = false; if (queued) void send(); }
  }

  function sync(force = false, content = false) {
    if (!hasSession() || closing || disposed) return;
    const now = performance.now();
    if (!force && now - lastSent < 500) return;
    lastSent = now;
    const next = state();
    if (content || !lastTimeline) {
      const sentences = timeline(), signature = JSON.stringify(sentences);
      if (signature !== lastTimeline) { next.sentences = sentences; lastTimeline = signature; }
    }
    // Keep the latest clock but do not discard a queued translation/timeline update.
    if (queued?.sentences && !next.sentences) next.sentences = queued.sentences;
    queued = next; void send();
  }

  async function open() {
    if (disposed || hasSession()) return;
    session = randomId(); sequence = 0; opening = true;
    const current = session;
    originalDisablePip = !!media.disablePictureInPicture;
    media.disablePictureInPicture = true;
    onStateChange?.();
    // 互斥会话: 空闲时同步拿下 (启动请求不离开时序); 被视频小窗占用时先等它真正退出。
    const grant = pipSession.tryClaim('captions') || await pipSession.acquire('captions');
    if (session !== current || disposed || closing) {
      if (grant === true) pipSession.release('captions');
      return;
    }
    if (grant !== true) {
      // 没抢到会话: 回滚本次启动, 对方的状态保持原样。
      clear();
      throw grant === 'busy'
        ? Object.assign(new Error('字幕小窗正在切换，请稍后重试'), { code: 'PIP_BUSY' })
        : new Error('请先关闭正在播放的小窗，再开启字幕小窗');
    }
    const sentences = timeline(); lastTimeline = JSON.stringify(sentences);
    try {
      await bridge.open({ ...state(), sentences });
      if (session !== current || disposed || closing) {
        await bridge.close({ session: current }); return;
      }
      active = true; opening = false; sync(true, true); onStateChange?.();
    } catch (error) {
      if (session !== current || closing || disposed) return;
      // Native failure may arrive before its stop animation finishes. Wait for cleanup
      // before offering a retry. The UI maps the preserved error code to actionable guidance.
      closing = true;
      onStateChange?.();
      try {
        await bridge.close({ session: current });
        if (session === current) clear();
      } catch {
        if (session === current) {
          closing = false; opening = false; onStateChange?.();
        }
      }
      throw error;
    }
  }

  async function close() {
    if (!hasSession()) return true;
    const current = session;
    closing = true;
    queued = null;
    onStateChange?.();
    try {
      await bridge.close({ session: current });
      if (session === current) clear(); return true;
    } catch (error) {
      if (session === current) { closing = false; onStateChange?.(); }
      toast('无法关闭字幕小窗，请使用系统小窗的关闭按钮'); return false;
    }
  }

  window.addEventListener('native-caption-pip', ({ detail }) => {
    if (!session || detail.session !== session) return;
    if (detail.action) {
      if (active && !closing && !disposed) mediaControl(media, engine, detail.action);
      return;
    }
    if (!detail.active) {
      // During startup the open promise owns failure/cancellation so its error stays visible.
      if (opening && !closing && !disposed) return;
      clear();
    }
    else if (!disposed) {
      active = true;
      if (typeof detail.closing === 'boolean') closing = detail.closing;
      if (!closing) opening = false;
      onStateChange?.();
    }
  });
  for (const event of ['timeupdate', 'play', 'playing', 'pause', 'ended', 'waiting', 'seeking', 'seeked', 'ratechange']) {
    media.addEventListener(event, () => {
      if (event === 'waiting' || event === 'seeking') stalled = true;
      if (event === 'playing' || event === 'seeked' || event === 'ended') stalled = false;
      sync(event !== 'timeupdate');
    });
  }
  const observer = new MutationObserver(() => sync(true, true));
  const observe = () => observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-tr'] });
  observe();
  document.addEventListener('visibilitychange', () => sync(true));
  window.addEventListener('pagehide', () => { disposed = true; observer.disconnect(); void close(); });
  window.addEventListener('pageshow', () => { disposed = false; observe(); });
  pipSession.register('captions', { isBusy, close });
  return { open, close, refresh: () => sync(true, true), isActive, hasSession, isBusy };
}
