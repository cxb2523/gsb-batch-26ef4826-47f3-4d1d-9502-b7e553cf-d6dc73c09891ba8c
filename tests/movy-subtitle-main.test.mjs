import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createMovySubtitle } = require('../electron/movy-subtitle.cjs');
const { createOnlineSubtitles } = require('../electron/movy-subtitle-online.cjs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cf-subtest-'));
}

function srt(text) {
  return '1\n00:00:00,000 --> 00:00:10,000\n' + text + '\n';
}

function makeSub({ dir, fetchCounts = new Map() } = {}) {
  const fetchTextImpl = async (url) => {
    fetchCounts.set(url, (fetchCounts.get(url) || 0) + 1);
    // 同一 URL 返回的是“该 URL 唯一”的内容；若缓存正确隔离，不同上下文应各自请求一次。
    return srt('cue-for:' + url);
  };
  return {
    instance: createMovySubtitle({ userDataDir: dir, fetchTextImpl, ipcMain: null }),
    fetchCounts,
  };
}

test('主进程 cueCache：同一 URL 在不同播放上下文分别缓存，不互相命中', async () => {
  const dir = tempDir();
  const { instance, fetchCounts } = makeSub({ dir });
  try {
    const url = 'https://cdn.example.com/shared/zh.vtt';
    const movieA = { tmdbId: 501, mediaType: 'movie', title: 'Movie A' };
    const movieB = { tmdbId: 502, mediaType: 'movie', title: 'Movie B' };

    const a1 = await instance.fetchCues({ url, lang: 'zho', context: movieA });
    assert.equal(a1.ok, true);
    assert.equal(a1.cached, 'network');

    const b1 = await instance.fetchCues({ url, lang: 'zho', context: movieB });
    assert.equal(b1.ok, true);
    assert.equal(b1.cached, 'network', '不同影片不应命中别人的缓存');

    const a2 = await instance.fetchCues({ url, lang: 'zho', context: movieA });
    assert.equal(a2.cached, 'memory', '同一上下文重请求命中内存缓存');
    const b2 = await instance.fetchCues({ url, lang: 'zho', context: movieB });
    assert.equal(b2.cached, 'memory');

    assert.equal(fetchCounts.get(url), 2, '每个上下文各网络拉取一次');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('主进程 cueCache：不同集之间独立（同 URL 也不复用）', async () => {
  const dir = tempDir();
  const { instance, fetchCounts } = makeSub({ dir });
  try {
    const url = 'https://cdn.example.com/show/shared-track.vtt';
    const ep1 = { tmdbId: 601, mediaType: 'tv', seasonId: 1, episodeId: 1, title: 'Show' };
    const ep2 = { tmdbId: 601, mediaType: 'tv', seasonId: 1, episodeId: 2, title: 'Show' };

    await instance.fetchCues({ url, context: ep1 });
    await instance.fetchCues({ url, context: ep2 });
    assert.equal(fetchCounts.get(url), 2, '不同集未复用同一份 cue');

    const again = await instance.fetchCues({ url, context: ep1 });
    assert.equal(again.cached, 'memory');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('主进程磁盘缓存：按上下文隔离，重启后也不跨影片命中', async () => {
  const dir = tempDir();
  const url = 'https://cdn.example.com/disk/shared.vtt';
  const movieA = { tmdbId: 701, mediaType: 'movie', title: 'Movie A' };
  const movieB = { tmdbId: 702, mediaType: 'movie', title: 'Movie B' };
  try {
    const first = makeSub({ dir });
    await first.instance.fetchCues({ url, context: movieA });
    await first.instance.fetchCues({ url, context: movieB });

    // 新的实例（模拟应用重启），内存缓存为空，只有磁盘缓存
    const second = makeSub({ dir });
    const a = await second.instance.fetchCues({ url, context: movieA });
    const b = await second.instance.fetchCues({ url, context: movieB });
    assert.equal(a.cached, 'disk', '影片 A 命中自己的磁盘缓存');
    assert.equal(b.cached, 'disk', '影片 B 命中自己的磁盘缓存');
    assert.equal(second.fetchCounts.get(url), undefined, '不再发起网络请求');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('主进程缓存：缺少 context 时退化为按 URL（向后兼容）', async () => {
  const dir = tempDir();
  const { instance, fetchCounts } = makeSub({ dir });
  try {
    const url = 'https://cdn.example.com/plain/zh.vtt';
    await instance.fetchCues({ url });
    const second = await instance.fetchCues({ url });
    assert.equal(second.cached, 'memory');
    assert.equal(fetchCounts.get(url), 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('在线搜索缓存：不同影片/不同集不跨上下文命中', async () => {
  let calls = 0;
  const fakeSubf2m = async () => { calls += 1; return [{ source: 'subf2m', slug: 'x', lang: 'chinese', label: '中文', path: '/p/' + calls }]; };
  const online = createOnlineSubtitles({ log: () => {}, subf2mSearch: fakeSubf2m, bilibiliSearch: async () => [] });

  const movieA = { tmdbId: 801, mediaType: 'movie', title: 'Movie A' };
  const movieB = { tmdbId: 802, mediaType: 'movie', title: 'Movie B' };
  const ep1 = { tmdbId: 803, mediaType: 'tv', seasonId: 1, episodeId: 1, title: 'Show' };
  const ep2 = { tmdbId: 803, mediaType: 'tv', seasonId: 1, episodeId: 2, title: 'Show' };

  const a1 = await online.search(movieA);
  assert.equal(a1.cached, undefined);
  assert.equal(calls, 1);

  const b1 = await online.search(movieB);
  assert.equal(b1.cached, undefined, '不同影片不命中缓存');
  assert.equal(calls, 2);

  const e1 = await online.search(ep1);
  assert.equal(e1.cached, undefined, '不同集不命中缓存');
  assert.equal(calls, 3);

  const e2 = await online.search(ep2);
  assert.equal(e2.cached, undefined, '同剧不同集不命中缓存');
  assert.equal(calls, 4);

  const a2 = await online.search(movieA);
  assert.equal(a2.cached, true, '同一上下文二次搜索命中缓存');
  assert.equal(calls, 4);
});

test('在线搜索缓存：上下文身份包含集号，避免同一剧集互相污染', async () => {
  let calls = 0;
  const online = createOnlineSubtitles({
    log: () => {},
    subf2mSearch: async (context) => { calls += 1; return [{ source: 'subf2m', slug: 's', lang: 'chinese', label: '中文', path: '/p/' + calls, episode: context.episodeId }]; },
    bilibiliSearch: async () => [],
  });
  const ep1 = { tmdbId: 900, mediaType: 'tv', seasonId: 2, episodeId: 1, title: 'Show', year: '2024' };
  const ep2 = { ...ep1, episodeId: 2 };
  const r1 = await online.search(ep1);
  const r2 = await online.search(ep2);
  assert.equal(r1.tracks[0].path, '/p/1');
  assert.equal(r2.tracks[0].path, '/p/2');
  assert.equal(calls, 2);
});

test('在线搜索缓存：season/seasonId 与 episode/episodeId 别名视为同一上下文', async () => {
  let calls = 0;
  const online = createOnlineSubtitles({
    log: () => {},
    subf2mSearch: async () => { calls += 1; return [{ source: 'subf2m', slug: 's', lang: 'chinese', label: '中文', path: '/p/1' }]; },
    bilibiliSearch: async () => [],
  });
  const a = await online.search({ tmdbId: 1000, mediaType: 'tv', seasonId: 3, episodeId: 4, title: 'Show', year: '2024' });
  const b = await online.search({ tmdbId: 1000, mediaType: 'tv', season: 3, episode: 4, title: 'Show', year: '2024' });
  assert.equal(a.cached, undefined);
  assert.equal(b.cached, true, '别名写法应命中同一份上下文缓存');
  assert.equal(calls, 1);
});

test('主进程 cue 缓存：season/episode 别名同样映射到同一上下文', async () => {
  const dir = tempDir();
  const { instance, fetchCounts } = makeSub({ dir });
  try {
    const url = 'https://cdn.example.com/alias/zh.vtt';
    await instance.fetchCues({ url, context: { tmdbId: 1100, mediaType: 'tv', seasonId: 1, episodeId: 2, title: 'S' } });
    const second = await instance.fetchCues({ url, context: { tmdbId: 1100, mediaType: 'tv', season: 1, episode: 2, title: 'S' } });
    assert.equal(second.cached, 'memory');
    assert.equal(fetchCounts.get(url), 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
