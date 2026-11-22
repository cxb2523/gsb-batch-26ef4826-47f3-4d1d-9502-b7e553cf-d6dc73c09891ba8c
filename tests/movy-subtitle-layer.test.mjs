import test from 'node:test';
import assert from 'node:assert/strict';

import { initMovySubtitle } from '../src/movy-subtitle-layer.js';
import { FakeDocument, createFakeStorage, createFakeWindow } from './helpers/fake-dom.mjs';

const PLAYCTX_KEY = 'cineflow:movy-playctx:v1';

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function flush(rounds = 14) {
  let chain = Promise.resolve();
  for (let i = 0; i < rounds; i += 1) chain = chain.then(() => new Promise((res) => setImmediate(res)));
  return chain;
}

function buildHarness({ api = {}, storage } = {}) {
  const doc = new FakeDocument();
  const modal = doc.register('playerModal', doc.createElement('div'));
  modal.className = 'player-modal is-open';
  doc.register('playerStage', doc.createElement('div'));
  const actions = doc.createElement('div');
  actions.className = 'player-actions';
  modal.appendChild(actions);
  const video = doc.register('resourcePlayer', doc.createElement('video'));
  video.currentTime = 0;
  video.src = '';

  const win = createFakeWindow({ storage: storage || createFakeStorage(), document: doc });
  win.cineflowMovy = {
    subCues: api.subCues || (async () => ({ ok: false, cues: [] })),
    subOnlineLoad: api.subOnlineLoad || (async () => ({ ok: false, cues: [] })),
    subDiscover: api.subDiscover || (async () => ({ ok: false, tracks: [] })),
    subOnline: api.subOnline || (async () => ({ ok: false, tracks: [] })),
    subParse: api.subParse || (async () => ({ ok: false, cues: [] })),
    subTranslate: async () => ({ ok: true, map: {} }),
    sources: api.sources || (async () => ({ subtitles: [] })),
  };

  const previousWindow = globalThis.window;
  const previousMutationObserver = globalThis.MutationObserver;
  globalThis.window = win;
  globalThis.MutationObserver = class { observe() {} disconnect() {} };

  const hooks = {};
  const dispose = initMovySubtitle({ document: doc, testHooks: hooks });

  const context = {
    at: Date.now(),
    provider: 'Miami',
    streamUrl: 'https://cdn.example.com/movie-1/master.m3u8',
    mediaType: 'movie',
    tmdbId: 101,
    title: 'Movie One',
    year: '2024',
    seasonId: 0,
    episodeId: 0,
    subtitles: [],
  };

  function setContext(next) {
    win.localStorage.setItem(PLAYCTX_KEY, JSON.stringify({ at: Date.now(), ...next }));
  }

  function teardown() {
    dispose();
    win._clearAll();
    globalThis.window = previousWindow;
    globalThis.MutationObserver = previousMutationObserver;
  }

  return { doc, win, video, hooks, context, setContext, teardown };
}

function srt(text, start, end) {
  return [{ s: start, e: end, t: text }];
}

test('正常切轨：手动选择新字幕后显示新字幕内容', async () => {
  const cuesA = srt('old-cue-A', 0, 10);
  const cuesB = srt('new-cue-B', 0, 10);
  const h = buildHarness({
    api: {
      subCues: async ({ url }) => ({ ok: true, cues: url.includes('b') ? cuesB : cuesA }),
    },
  });
  try {
    h.setContext(h.context);
    h.hooks.openFor(h.context);
    await flush();

    h.hooks.openFor({ ...h.context, subtitles: [
      { url: 'https://cdn.example.com/a.vtt', lang: 'eng' },
      { url: 'https://cdn.example.com/b.vtt', lang: 'eng' },
    ] });
    await flush();
    assert.equal(h.hooks.state().cues[0].t, 'old-cue-A', '默认选中第一条轨道');

    await h.hooks.chooseTrack('https://cdn.example.com/b.vtt');
    await flush();
    const state = h.hooks.state();
    assert.equal(state.activeTrack.url, 'https://cdn.example.com/b.vtt');
    assert.equal(state.cues[0].t, 'new-cue-B');
    assert.equal(state.displayed, 'new-cue-B', '新字幕已渲染到画面上');
  } finally { h.teardown(); }
});

test('切集：旧影片晚到的字幕请求不覆盖新状态', async () => {
  const pending = deferred();
  const newCues = srt('episode-2-cue', 0, 10);
  const h = buildHarness({
    api: {
      subCues: async ({ url }) => {
        if (url.includes('ep1')) return pending.promise;
        return { ok: true, cues: newCues };
      },
      subDiscover: async () => ({ ok: false, tracks: [] }),
      subOnline: async () => ({ ok: false, tracks: [] }),
    },
  });
  try {
    const ep1 = { ...h.context, tmdbId: 202, title: 'Show', mediaType: 'tv', seasonId: 1, episodeId: 1,
      streamUrl: 'https://cdn.example.com/show/s01e01/master.m3u8',
      subtitles: [{ url: 'https://cdn.example.com/show/s01e01/ep1.zh.vtt', lang: 'zho' }] };
    h.setContext(ep1);
    h.hooks.openFor(ep1);
    await flush(3);
    assert.equal(h.hooks.state().cues.length, 0, '第一集字幕仍在加载');

    const ep2 = { ...ep1, episodeId: 2, streamUrl: 'https://cdn.example.com/show/s01e02/master.m3u8',
      subtitles: [{ url: 'https://cdn.example.com/show/s01e02/ep2.zh.vtt', lang: 'zho' }] };
    h.setContext(ep2);
    h.hooks.openFor(ep2);
    await flush();
    assert.equal(h.hooks.state().cues[0].t, 'episode-2-cue');

    // 第一集的请求现在才返回
    pending.resolve({ ok: true, cues: srt('stale-episode-1-cue', 0, 10) });
    await flush();
    const state = h.hooks.state();
    assert.equal(state.cues[0].t, 'episode-2-cue', '过期结果被丢弃');
    assert.equal(state.activeTrack.url, 'https://cdn.example.com/show/s01e02/ep2.zh.vtt');
  } finally { h.teardown(); }
});

test('本地拖入字幕：在途的在线搜索结果不会覆盖本地字幕', async () => {
  const pendingOnline = deferred();
  const localCues = srt('local-dropped-cue', 0, 10);
  const h = buildHarness({
    api: {
      subDiscover: async () => ({ ok: false, tracks: [] }),
      sources: async () => ({ subtitles: [] }),
      subOnline: async () => pendingOnline.promise,
      subOnlineLoad: async () => ({ ok: true, cues: srt('stale-online-cue', 0, 10) }),
      subCues: async () => ({ ok: false, cues: [] }),
    },
  });
  try {
    h.setContext(h.context);
    h.hooks.openFor(h.context);
    await flush();

    // 触发自动在线搜索（当前没有字幕轨）
    assert.equal(h.hooks.state().onlineBusy, true, '在线搜索已发起');

    await h.hooks.applyLocalCues(localCues, 'my.srt');
    await flush();
    assert.equal(h.hooks.state().cues[0].t, 'local-dropped-cue');
    assert.equal(h.hooks.state().activeTrack.label, 'my.srt');

    // 在线搜索晚到
    pendingOnline.resolve({ ok: true, tracks: [
      { source: 'subf2m', lang: 'chinese', label: '中文', path: '/p/1' },
    ] });
    await flush();
    const state = h.hooks.state();
    assert.equal(state.cues[0].t, 'local-dropped-cue', '本地字幕保持生效');
    assert.equal(state.activeTrack.label, 'my.srt');
    assert.equal(state.onlineTracks.length, 0, '过期在线结果未落地');
    assert.equal(state.onlineBusy, false);
  } finally { h.teardown(); }
});

test('在线搜索晚到：切换影片后结果不得写入 onlineTracks 或覆盖 activeTrack', async () => {
  const pending = deferred();
  const h = buildHarness({
    api: {
      subDiscover: async () => ({ ok: false, tracks: [] }),
      sources: async () => ({ subtitles: [] }),
      subOnline: async () => pending.promise,
      subCues: async () => ({ ok: true, cues: srt('movie-2-track-cue', 0, 10) }),
      subOnlineLoad: async () => ({ ok: true, cues: srt('stale-online', 0, 10) }),
    },
  });
  try {
    const movie1 = { ...h.context, tmdbId: 301, title: 'Movie One' };
    h.setContext(movie1);
    h.hooks.openFor(movie1);
    await flush();

    const movie2 = { ...h.context, tmdbId: 302, title: 'Movie Two',
      streamUrl: 'https://cdn.example.com/movie-2/master.m3u8',
      subtitles: [{ url: 'https://cdn.example.com/movie-2/zh.vtt', lang: 'zho' }] };
    h.setContext(movie2);
    h.hooks.openFor(movie2);
    await flush();
    assert.equal(h.hooks.state().cues[0].t, 'movie-2-track-cue');

    pending.resolve({ ok: true, tracks: [
      { source: 'subf2m', lang: 'chinese', label: '中文', path: '/p/1' },
    ] });
    await flush();
    const state = h.hooks.state();
    assert.equal(state.onlineTracks.length, 0, '旧影片的在线搜索结果未落地');
    assert.equal(state.activeTrack.url, 'https://cdn.example.com/movie-2/zh.vtt');
    assert.equal(state.cues[0].t, 'movie-2-track-cue');
  } finally { h.teardown(); }
});

test('自动发现晚到：切换影片后不得写入 tracks', async () => {
  const pendingDiscover = deferred();
  const movie2Cues = srt('movie-2-cue', 0, 10);
  const h = buildHarness({
    api: {
      subDiscover: async ({ streamUrl }) => {
        if (streamUrl.includes('movie-1')) return pendingDiscover.promise;
        return { ok: true, tracks: [{ url: 'https://cdn.example.com/movie-2/zh.vtt', lang: 'zho' }] };
      },
      subCues: async ({ url }) => (url.includes('movie-2') ? { ok: true, cues: movie2Cues } : { ok: true, cues: srt('stale', 0, 10) }),
      subOnline: async () => ({ ok: false, tracks: [] }),
    },
  });
  try {
    const movie1 = { ...h.context, tmdbId: 401, title: 'Movie One', streamUrl: 'https://cdn.example.com/movie-1/master.m3u8' };
    h.setContext(movie1);
    h.hooks.openFor(movie1);
    await flush(2);

    const movie2 = { ...h.context, tmdbId: 402, title: 'Movie Two', streamUrl: 'https://cdn.example.com/movie-2/master.m3u8' };
    h.setContext(movie2);
    h.hooks.openFor(movie2);
    await flush();
    assert.equal(h.hooks.state().cues[0].t, 'movie-2-cue');

    pendingDiscover.resolve({ ok: true, tracks: [{ url: 'https://cdn.example.com/movie-1/zh.vtt', lang: 'zho' }] });
    await flush();
    const state = h.hooks.state();
    assert.equal(state.cues[0].t, 'movie-2-cue');
    assert.equal(state.activeTrack.url, 'https://cdn.example.com/movie-2/zh.vtt', '旧发现结果未替换轨道');
  } finally { h.teardown(); }
});

test('手动切轨会让在途的自动发现失效', async () => {
  const pendingDiscover = deferred();
  const h = buildHarness({
    api: {
      subDiscover: async () => pendingDiscover.promise,
      subCues: async ({ url }) => ({ ok: true, cues: srt('user-picked:' + url, 0, 10) }),
      subOnline: async () => ({ ok: false, tracks: [] }),
    },
  });
  try {
    h.setContext(h.context);
    h.hooks.openFor(h.context); // 无线索轨 -> 触发 discover
    await flush(2);
    assert.equal(h.hooks.state().tracks.length, 0);

    // 用户在发现返回前手动拖入（本地字幕走同一无效化路径）
    await h.hooks.applyLocalCues(srt('user-local', 0, 10), 'user.srt');
    await flush();

    pendingDiscover.resolve({ ok: true, tracks: [{ url: 'https://cdn.example.com/late.vtt', lang: 'zho' }] });
    await flush();
    const state = h.hooks.state();
    assert.equal(state.cues[0].t, 'user-local');
    assert.equal(state.activeTrack.label, 'user.srt');
    assert.ok(state.tracks.every((item) => item.label !== 'late'), '旧发现未写入 tracks');
  } finally { h.teardown(); }
});

test('关闭字幕后，在途加载结果不得重新显示字幕', async () => {
  const pending = deferred();
  const h = buildHarness({
    api: {
      subCues: async ({ url }) => (url.includes('slow') ? pending.promise : { ok: true, cues: srt('fast', 0, 10) }),
      subOnline: async () => ({ ok: false, tracks: [] }),
    },
  });
  try {
    h.setContext(h.context);
    h.hooks.openFor({ ...h.context, subtitles: [{ url: 'https://cdn.example.com/slow.vtt', lang: 'zho' }] });
    await flush(2);
    h.hooks.chooseTrack(''); // 用户关闭字幕（内部走 user 选择）
    await flush();
    pending.resolve({ ok: true, cues: srt('late-cue', 0, 10) });
    await flush();
    const state = h.hooks.state();
    assert.equal(state.activeTrack, null);
    assert.equal(state.cues.length, 0);
    assert.equal(state.displayed, '');
  } finally { h.teardown(); }
});

test('本地字幕重新选中：不再把 local: 当作 URL 请求，cues 直接复用', async () => {
  const requested = [];
  const h = buildHarness({
    api: {
      subCues: async ({ url }) => { requested.push(url); return { ok: true, cues: srt('remote-cue', 0, 10) }; },
      subOnline: async () => ({ ok: false, tracks: [] }),
    },
  });
  try {
    h.setContext(h.context);
    h.hooks.openFor(h.context);
    await flush();
    await h.hooks.applyLocalCues(srt('local-cue', 0, 10), 'mine.srt');
    await flush();
    assert.equal(h.hooks.state().cues[0].t, 'local-cue');

    // 再显式选中一次本地轨道
    await h.hooks.chooseTrack('local:mine.srt');
    await flush();
    const state = h.hooks.state();
    assert.equal(state.cues[0].t, 'local-cue');
    assert.equal(state.activeTrack.url, 'local:mine.srt');
    assert.ok(requested.every((url) => !url.startsWith('local:')), '未对 local: 发起网络请求');
    assert.equal(requested.length, 0, '本地轨道不触发远程加载');
  } finally { h.teardown(); }
});

test('翻译持续失败不会形成无限重试（不会卡死字幕层）', async () => {
  let fetchCalls = 0;
  const h2 = buildHarness({
    api: {
      subCues: async () => ({ ok: true, cues: srt('english cue text', 0, 10) }),
      subOnline: async () => ({ ok: false, tracks: [] }),
      subTranslate: async () => ({ ok: false, map: {} }),
    },
  });
  try {
    h2.win.fetch = async () => { fetchCalls += 1; return { ok: false, status: 500, json: async () => ({}) }; };
    // 打开 AI 双语，并让翻译必然失败
    h2.win.localStorage.setItem('cineflow:movy-sub:v1', JSON.stringify({ ai: true, aiTouched: true, size: 1, offset: 0, bottom: 9, trackUrl: '' }));
    h2.setContext(h2.context);
    h2.hooks.openFor({ ...h2.context, subtitles: [{ url: 'https://cdn.example.com/en.vtt', lang: 'eng' }] });
    // 给足时间让失败重试链推进；若存在无限重试，这里会卡死而不是返回
    await flush(30);
    const afterFirst = fetchCalls;
    await flush(30);
    assert.ok(fetchCalls - afterFirst <= 2, '失败后不再持续重试，实际新增 ' + (fetchCalls - afterFirst));
    assert.ok(fetchCalls <= 4, '翻译只尝试有限次，实际 ' + fetchCalls);
    assert.equal(h2.hooks.state().cues[0].t, 'english cue text');
  } finally { h2.teardown(); }
});

test('用户点“搜在线”后，旧的自动发现结果不再覆盖用户选择', async () => {
  const pendingDiscover = deferred();
  const h = buildHarness({
    api: {
      subDiscover: async () => pendingDiscover.promise,
      sources: async () => ({ subtitles: [] }),
      subOnline: async () => ({ ok: true, tracks: [
        { source: 'subf2m', lang: 'chinese', label: '中文', path: '/p/9' },
      ] }),
      subOnlineLoad: async () => ({ ok: true, cues: srt('online-picked', 0, 10) }),
    },
  });
  try {
    h.setContext(h.context);
    h.hooks.openFor(h.context); // 无线索轨 -> 自动 discover 在途
    await flush(2);

    // 用户主动搜索在线字幕
    h.hooks.searchOnline(h.context);
    await flush();
    assert.equal(h.hooks.state().activeTrack.label, '中文', '在线字幕已被选中');
    assert.equal(h.hooks.state().cues[0].t, 'online-picked');

    // 自动发现此时才返回
    pendingDiscover.resolve({ ok: true, tracks: [{ url: 'https://cdn.example.com/late-discover.vtt', lang: 'zho' }] });
    await flush();
    const state = h.hooks.state();
    assert.equal(state.activeTrack.label, '中文', '旧自动发现未覆盖用户选择');
    assert.equal(state.cues[0].t, 'online-picked');
    assert.ok(state.tracks.every((item) => item.url !== 'https://cdn.example.com/late-discover.vtt'));
  } finally { h.teardown(); }
});
