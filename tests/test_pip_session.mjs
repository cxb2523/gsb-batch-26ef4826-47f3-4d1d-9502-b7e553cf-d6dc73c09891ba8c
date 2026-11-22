import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { createPipSession } from '../web/js/pip-session.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const { outputFiles } = await build({ stdin: { contents: `
  export { setupVideo } from './web/js/video-player.js';
  export { initTrackCfg, trackCfg, setVideoCfg } from './web/js/trackcfg.js';`, resolveDir: root },
  bundle: true, write: false, format: 'iife', globalName: 'PipSessionTest' });
const html = await readFile(new URL('../web/player.html', import.meta.url), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));

// ------------------------------------------------------------ 互斥会话本身 (无 DOM)

test('the session holds one owner and closes it before switching', async () => {
  const session = createPipSession();
  const order = [];
  session.register('video', { isBusy: () => false, close: async () => { order.push('close-video'); return true; } });
  session.register('captions', { isBusy: () => false, close: async () => { order.push('close-captions'); return true; } });
  assert.equal(await session.acquire('video'), true);
  assert.equal(session.owner(), 'video');
  assert.equal(await session.acquire('captions'), true);
  assert.deepEqual(order, ['close-video']);
  assert.equal(session.owner(), 'captions');
  session.release('captions');
  assert.equal(session.owner(), '');
});

test('a busy holder rejects the other side without any close attempt', async () => {
  const session = createPipSession();
  let closes = 0;
  session.register('captions', { isBusy: () => true, close: async () => { closes++; return true; } });
  assert.equal(await session.acquire('captions'), true);
  assert.equal(await session.acquire('video'), 'busy');
  assert.equal(closes, 0);
  assert.equal(session.owner(), 'captions');
});

test('a failed close keeps the owner and rejects the requester', async () => {
  const session = createPipSession();
  session.register('video', { isBusy: () => false, close: async () => false });
  assert.equal(await session.acquire('video'), true);
  assert.equal(await session.acquire('captions'), false);
  assert.equal(session.owner(), 'video');
  session.register('video', { isBusy: () => false, close: async () => true });
  assert.equal(await session.acquire('captions'), true);
  assert.equal(session.owner(), 'captions');
});

test('concurrent acquires are serialized and never hold the session together', async () => {
  const session = createPipSession();
  const held = new Set();
  session.register('video', { isBusy: () => false, close: async () => true });
  session.register('captions', { isBusy: () => false, close: async () => true });
  const changes = [];
  session.onChange((owner) => { assert.equal(held.has(owner), false); held.add(owner); changes.push(owner); });
  const results = await Promise.all([session.acquire('video'), session.acquire('captions')]);
  assert.deepEqual([...results].sort(), [true, true].sort());
  assert.equal(session.owner(), 'captions');
  assert.ok(changes.every((owner, i) => i === 0 || owner !== changes[i - 1]));
});

test('a stale system-event claim is dropped by its guard and closes nothing', async () => {
  const session = createPipSession();
  session.register('captions', { isBusy: () => false,
    close: async () => { throw new Error('must not be closed by a stale claim'); } });
  assert.equal(await session.acquire('captions'), true);
  assert.equal(await session.acquire('video', () => false), false);
  assert.equal(session.owner(), 'captions');
});

// ------------------------------------------------------------ 两条路径共用会话 (jsdom)

function harness(t, { platform = 'ios', bridgeOverrides = {} } = {}) {
  const dom = new JSDOM(html, { url: 'https://localhost/player.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, doc = w.document, calls = [];
  t.after(() => { w.dispatchEvent(new w.Event('pagehide')); w.close(); });
  w.console.warn = () => {};
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  w.screen.orientation = { unlock() {} };
  w.ResizeObserver = class { observe() {} disconnect() {} };
  Object.defineProperty(w.HTMLMediaElement.prototype, 'paused', { configurable: true, get() { return this._paused !== false; } });
  w.HTMLMediaElement.prototype.play = function () {
    if (this.paused) { this._paused = false; this.dispatchEvent(new w.Event('play')); }
    return Promise.resolve();
  };
  w.HTMLMediaElement.prototype.pause = function () {
    if (!this.paused) { this._paused = true; this.dispatchEvent(new w.Event('pause')); }
  };
  const bridge = {
    open: async (value) => { calls.push(['open', value]); },
    update: async (value) => { calls.push(['update', value]); },
    close: async (value) => { calls.push(['close', value]); }, ...bridgeOverrides,
  };
  w.LinguaNative = { platform, captionPip: bridge };
  w.eval(outputFiles[0].text);
  const api = w.PipSessionTest, app = doc.getElementById('app'), media = doc.getElementById('video');
  Object.defineProperties(media, { readyState: { configurable: true, value: 2 }, duration: { value: 30 },
    videoWidth: { value: 1280 }, videoHeight: { value: 720 } });
  const track = { S: 2, sStart: [0, 10], sEnd: [10, 30], title: 'Lesson',
    sentences: [{ text: 'First sentence.', translation: '第一句。' }, { text: 'Second sentence.', translation: '第二句。' }],
    lang: 'en', langName: '英语', space: true, features: ['tr'],
    layerOrder: [], layers: {}, supports: () => false };
  const engine = { track, reader: { activeS: 0 }, seek: (time) => { media.currentTime = time; } };
  api.initTrackCfg('lesson', 'en'); doc.documentElement.dataset.tr = '1';
  media.src = 'blob:lesson'; media.currentTime = 12;
  app.classList.add('has-video');
  const videoPlayer = api.setupVideo({ video: media, app, engine,
    toggle: () => { if (media.paused) media.play(); else media.pause(); },
    onLayout() {}, overlayOpen: () => false, openSettings() {} });
  return { w, doc, api, app, media, track, engine, videoPlayer,
    pip: videoPlayer.pip, audioPip: videoPlayer.audioPip, session: videoPlayer.pipSession, calls, bridge };
}

/** 假 Document PiP: 每次请求给一个新的 jsdom 窗口, 记录请求时字幕浮层是否还开着。 */
function fakeDocumentPip(t, h) {
  const wins = [], captionsActiveAtRequest = [];
  t.after(() => { for (const win of wins) { try { win.close(); } catch { /* 已关闭 */ } } });
  h.w.documentPictureInPicture = {
    async requestWindow() {
      captionsActiveAtRequest.push(h.audioPip.isActive());
      const pip = new JSDOM('<!doctype html><html><head></head><body></body></html>',
        { url: 'https://localhost/pip.html' });
      wins.push(pip.window);
      return pip.window;
    },
  };
  return { wins, captionsActiveAtRequest };
}

test('video pip and native captions open mutually exclusively in both directions', async (t) => {
  const h = harness(t, { platform: 'ios' });
  const fake = fakeDocumentPip(t, h);
  await h.audioPip.toggle();
  assert.equal(h.audioPip.isActive(), true);
  assert.equal(h.session.owner(), 'captions');
  // 字幕浮层开着时开视频小窗: 先等浮层真正退出, 再请求系统窗口
  await h.pip.toggle();
  assert.equal(h.audioPip.isActive(), false);
  assert.equal(h.pip.isActive(), true);
  assert.deepEqual(fake.captionsActiveAtRequest, [false]);
  assert.ok(h.calls.some(([name]) => name === 'close'));
  assert.equal(h.session.owner(), 'video');
  assert.equal(h.doc.getElementById('btnVideoPip').getAttribute('aria-pressed'), 'true');
  assert.equal(h.doc.getElementById('btnAudioPip').getAttribute('aria-pressed'), 'false');
  assert.equal(h.doc.getElementById('videoPipNote').hidden, false);
  // 反过来: 视频小窗开着时开字幕浮层, 系统小窗被关掉
  await h.audioPip.toggle();
  assert.equal(h.pip.isActive(), false);
  assert.equal(h.audioPip.isActive(), true);
  assert.equal(h.session.owner(), 'captions');
  assert.equal(h.doc.getElementById('btnAudioPip').getAttribute('aria-pressed'), 'true');
  assert.equal(h.doc.getElementById('btnVideoPip').getAttribute('aria-pressed'), 'false');
  assert.equal(h.doc.getElementById('videoPipNote').hidden, false);
});

test('video pip is rejected with a retry hint while the caption window is starting', async (t) => {
  let grant;
  const h = harness(t, { platform: 'android', bridgeOverrides: {
    open: () => new Promise((resolve) => { grant = resolve; }),
  } });
  const fake = fakeDocumentPip(t, h);
  const opening = h.audioPip.toggle();
  await flush();
  assert.equal(h.audioPip.isBusy(), true);
  assert.equal(h.session.owner(), 'captions');
  await h.pip.toggle();
  assert.equal(fake.wins.length, 0);          // 没有并发打开第二个系统窗口
  assert.equal(h.pip.isActive(), false);
  assert.equal(h.session.owner(), 'captions');
  assert.match(h.doc.getElementById('toast').textContent, /稍后重试/);
  assert.equal(h.doc.getElementById('btnVideoPip').getAttribute('aria-pressed'), 'false');
  grant(); await opening;
  assert.equal(h.audioPip.isActive(), true);
  // 启动完成后切换照常互斥
  await h.pip.toggle();
  assert.equal(fake.wins.length, 1);
  assert.equal(h.audioPip.isActive(), false);
  assert.equal(h.pip.isActive(), true);
});

test('a failed caption close rolls back: owner unchanged, requester never lit', async (t) => {
  const h = harness(t, { platform: 'ios' });
  const fake = fakeDocumentPip(t, h);
  await h.audioPip.toggle();
  assert.equal(h.audioPip.isActive(), true);
  h.bridge.close = async () => { throw new Error('system window busy'); };
  await h.pip.toggle();
  assert.equal(fake.wins.length, 0);
  assert.equal(h.audioPip.isActive(), true);   // 不能被误标成已关闭
  assert.equal(h.pip.isActive(), false);
  assert.equal(h.session.owner(), 'captions');
  assert.equal(h.doc.getElementById('btnAudioPip').getAttribute('aria-pressed'), 'true');
  assert.equal(h.doc.getElementById('btnVideoPip').getAttribute('aria-pressed'), 'false');
  // 关闭恢复后再次请求: 等浮层真正退出才开视频小窗
  h.bridge.close = async (value) => { h.calls.push(['close', value]); };
  await h.pip.toggle();
  assert.equal(fake.wins.length, 1);
  assert.deepEqual(fake.captionsActiveAtRequest, [false]);
  assert.equal(h.audioPip.isActive(), false);
  assert.equal(h.pip.isActive(), true);
  assert.equal(h.session.owner(), 'video');
});

test('closing the Document PiP window directly resets the shared session', async (t) => {
  const h = harness(t, { platform: 'ios' });
  const fake = fakeDocumentPip(t, h);
  await h.pip.toggle();
  assert.equal(h.pip.isActive(), true);
  assert.equal(h.session.owner(), 'video');
  const pipWin = fake.wins[0];
  pipWin.dispatchEvent(new pipWin.Event('pagehide'));   // 用户直接关掉系统小窗
  assert.equal(h.pip.isActive(), false);
  assert.equal(h.session.owner(), '');
  assert.equal(h.doc.getElementById('btnVideoPip').getAttribute('aria-pressed'), 'false');
  // 字幕浮层按钮立即可用
  await h.audioPip.toggle();
  assert.equal(h.audioPip.isActive(), true);
  assert.equal(h.session.owner(), 'captions');
});

test('classic video PiP system events join the same mutual-exclusion session', async (t) => {
  const h = harness(t, { platform: 'ios' });
  // 假经典 PiP: 标准 requestPictureInPicture 路径 + 合成字幕轨
  const cueTrack = { mode: 'disabled', cues: [],
    addCue(cue) { this.cues.push(cue); }, removeCue() {} };
  h.media.addTextTrack = () => cueTrack;
  h.w.VTTCue = class { constructor(start, end, text) { Object.assign(this, { start, end, text }); } };
  let pipElement = null;
  Object.defineProperty(h.doc, 'pictureInPictureElement', { configurable: true, get: () => pipElement });
  h.doc.exitPictureInPicture = async () => {
    pipElement = null; h.media.dispatchEvent(new h.w.Event('leavepictureinpicture'));
  };
  await h.audioPip.toggle();
  assert.equal(h.audioPip.isActive(), true);
  // 系统自己进了 PiP (用户上滑回桌面): 字幕浮层被请出去, 合成字幕轨打开
  pipElement = h.media;
  h.media.dispatchEvent(new h.w.Event('enterpictureinpicture'));
  await flush(); await flush();
  assert.equal(h.pip.isActive(), true);
  assert.equal(h.audioPip.isActive(), false);
  assert.equal(h.session.owner(), 'video');
  assert.equal(cueTrack.mode, 'showing');
  assert.ok(h.calls.some(([name]) => name === 'close'));
  // 系统退出: 会话复位, 字幕轨关掉, 字幕浮层可再开
  pipElement = null;
  h.media.dispatchEvent(new h.w.Event('leavepictureinpicture'));
  assert.equal(h.pip.isActive(), false);
  assert.equal(h.session.owner(), '');
  assert.equal(cueTrack.mode, 'disabled');
  await h.audioPip.toggle();
  assert.equal(h.audioPip.isActive(), true);
  assert.equal(h.session.owner(), 'captions');
});
