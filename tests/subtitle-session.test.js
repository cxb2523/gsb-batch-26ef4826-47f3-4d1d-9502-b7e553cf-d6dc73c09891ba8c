import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { loadCommonJs, runScript } from './helpers/load-commonjs.js';

const { createJellyfinApi } = loadCommonJs('src/lib/jellyfin-api.js');
const jellyfinApi = createJellyfinApi({ http: {}, preferences: { get() {} }, log() {} });

// One item in two versions ("4K" and "1080p"), switched by MediaSourceId.
const ITEM = '0123456789abcdef0123456789abcdef';
const streamUrl = (mediaSourceId) =>
  `https://jf.example/Videos/${ITEM}/stream?static=true&ApiKey=K&MediaSourceId=${mediaSourceId}`;

const UHD = streamUrl('uhd');
const HD = streamUrl('hd');

function sidecar(Index, extra = {}) {
  return {
    Type: 'Subtitle',
    IsTextSubtitleStream: true,
    IsExternal: true,
    Language: 'eng',
    Index,
    ...extra,
  };
}

// Each version carries its own external subtitle, as sidecars belong to one
// version's file.
const PLAYBACK_INFO = {
  MediaSources: [
    { Id: 'uhd', MediaStreams: [sidecar(2)] },
    { Id: 'hd', MediaStreams: [sidecar(5)] },
  ],
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

// The manager with the real URL parsing and an mpv that keeps a track list in
// step with sub-add/sub-remove/sid. Every mpv interaction lands in mpvCalls in
// order, so a test can assert the exact sequence the viewer's player saw.
function createSession({ prefs: prefOverrides = {}, tracks = [], ...deps } = {}) {
  const context = vm.createContext({ module: { exports: {} }, setTimeout, clearTimeout });
  runScript('src/lib/media-actions.js', context);

  const prefs = {
    select_preferred_tracks: true,
    preferred_languages: 'en',
    show_notifications: true,
    ...prefOverrides,
  };
  const osd = [];
  const mpvCalls = [];
  const list = tracks.map((track) => ({ ...track }));
  // mpv never reuses a track id, even after sub-remove.
  let nextId = Math.max(0, ...list.map((track) => track.id)) + 1;
  const select = (type, value) => {
    for (const track of list) {
      if (track.type === type) track.selected = String(track.id) === value;
    }
  };
  const mpv = {
    set(name, value) {
      mpvCalls.push(['set', name, value]);
      if (name === 'sid') select('sub', value);
      if (name === 'aid') select('audio', value);
    },
    getString: () => '',
    getFlag: () => false,
    getNative: (name) => (name === 'track-list' ? list.map((track) => ({ ...track })) : null),
    command(name, args) {
      mpvCalls.push(['command', name, ...args]);
      if (name === 'sub-add') {
        // 'auto' adds the track without selecting it.
        assert.equal(args[1], 'auto');
        list.push({
          id: nextId++,
          type: 'sub',
          title: args[2],
          lang: args[3],
          'external-filename': args[0],
        });
      }
      if (name === 'sub-remove') {
        list.splice(
          list.findIndex((track) => track.type === 'sub' && String(track.id) === args[0]),
          1
        );
      }
    },
  };
  const manager = context.module.exports.createMediaActionsManager({
    core: { osd: (text) => osd.push(text), status: {} },
    http: { download: async () => {} },
    utils: { resolvePath: (path) => path.replace('@tmp/', '/tmp/') },
    preferences: { get: (key) => prefs[key] },
    mpv,
    parseJellyfinUrl: jellyfinApi.parseJellyfinUrl,
    isJellyfinUrl: jellyfinApi.isJellyfinUrl,
    fetchPlaybackInfo: async () => PLAYBACK_INFO,
    fetchItemMetadata: async () => ({}),
    log() {},
    ...deps,
  });
  const selectedSub = () => list.find((track) => track.type === 'sub' && track.selected) || null;
  const sidSets = () => mpvCalls.filter(([kind, name]) => kind === 'set' && name === 'sid');
  return { manager, mpv, osd, mpvCalls, tracks: list, selectedSub, sidSets };
}

// A version switch as mpv reports it: the old file ends, then the new one
// loads.
function switchTo(session, url) {
  session.manager.invalidatePendingResults();
  session.manager.updateFromFileUrl(url);
}

test('a download still in flight when the version changes adds nothing and says nothing', async () => {
  const download = deferred();
  const session = createSession({ http: { download: () => download.promise } });

  session.manager.updateFromFileUrl(UHD);
  const pending = session.manager.downloadAllSubtitles('https://jf.example', ITEM, 'K', {
    mediaSourceId: 'uhd',
  });
  await flush();
  switchTo(session, HD);
  download.resolve();
  await pending;

  // No sub-add, no sid/aid change, no success or failure notification.
  assert.deepEqual(session.mpvCalls, []);
  assert.deepEqual(session.osd, []);
});

test('playback info arriving after the version changed starts no downloads', async () => {
  const info = deferred();
  const downloads = [];
  const session = createSession({
    fetchPlaybackInfo: () => info.promise,
    http: {
      download: async (url) => {
        downloads.push(url);
      },
    },
  });

  session.manager.updateFromFileUrl(UHD);
  const pending = session.manager.downloadAllSubtitles('https://jf.example', ITEM, 'K', {
    mediaSourceId: 'uhd',
  });
  switchTo(session, HD);
  info.resolve(PLAYBACK_INFO);
  await pending;

  assert.deepEqual(downloads, []);
  assert.deepEqual(session.mpvCalls, []);
  assert.deepEqual(session.osd, []);
});

test('a download failing after the version changed does not report the failure', async () => {
  const info = deferred();
  const session = createSession({ fetchPlaybackInfo: () => info.promise });

  session.manager.updateFromFileUrl(UHD);
  const pending = session.manager.downloadAllSubtitles('https://jf.example', ITEM, 'K', {
    mediaSourceId: 'uhd',
  });
  switchTo(session, HD);
  info.reject(new Error('offline'));
  await pending;

  assert.deepEqual(session.osd, []);
});

test('a failing download in the session still playing still reports the failure', async () => {
  const session = createSession({
    fetchPlaybackInfo: async () => {
      throw new Error('offline');
    },
  });

  session.manager.updateFromFileUrl(UHD);
  await session.manager.downloadAllSubtitles('https://jf.example', ITEM, 'K', {
    mediaSourceId: 'uhd',
  });

  assert.deepEqual(session.osd, ['Failed to download subtitles']);
});

test('a subtitle the viewer picked while downloads ran is kept', async () => {
  const download = deferred();
  const session = createSession({
    tracks: [
      { id: 1, type: 'audio', lang: 'jpn', title: 'Japanese', selected: true },
      { id: 2, type: 'sub', lang: 'eng', title: 'Signs', forced: true },
      { id: 3, type: 'sub', lang: 'jpn', title: 'Japanese' },
    ],
    http: { download: () => download.promise },
  });

  session.manager.updateFromFileUrl(UHD);
  session.manager.selectPreferredTracks();
  assert.equal(session.selectedSub().id, 2);

  const pending = session.manager.downloadAllSubtitles('https://jf.example', ITEM, 'K', {
    mediaSourceId: 'uhd',
  });
  await flush();
  // The viewer switches to the Japanese subtitle while the download runs.
  session.mpv.set('sid', '3');
  download.resolve();
  await pending;

  // The download belongs to this session, so it is added, but the viewer's
  // choice is not ranked away.
  assert.equal(session.selectedSub().id, 3);
  assert.deepEqual(
    session.mpvCalls.map(([kind, ...rest]) => [kind, rest[0]]),
    [
      ['set', 'sid'],
      ['set', 'sid'],
      ['command', 'sub-add'],
    ]
  );
  assert.deepEqual(
    session.sidSets().map(([, , value]) => value),
    ['2', '3']
  );
  assert.deepEqual(session.osd, ['Loaded external eng subtitle', 'Downloaded 1 subtitle(s)']);
});

test('downloads finishing in the same session are ranked by preferred language', async () => {
  const session = createSession({
    tracks: [
      { id: 1, type: 'audio', lang: 'jpn', title: 'Japanese', selected: true },
      { id: 2, type: 'sub', lang: 'eng', title: 'Signs', forced: true },
    ],
  });

  session.manager.updateFromFileUrl(UHD);
  session.manager.selectPreferredTracks();
  assert.equal(session.selectedSub().id, 2);

  await session.manager.downloadAllSubtitles('https://jf.example', ITEM, 'K', {
    mediaSourceId: 'uhd',
  });

  // The downloaded full English subtitle outranks the signs track.
  assert.equal(session.selectedSub().id, 3);
  assert.match(session.tracks.at(-1)['external-filename'], /_2_eng\.srt$/);
  assert.deepEqual(
    session.mpvCalls.map(([kind, ...rest]) => [kind, rest[0]]),
    [
      ['set', 'sid'],
      ['command', 'sub-add'],
      ['set', 'sid'],
    ]
  );
  assert.deepEqual(
    session.sidSets().map(([, , value]) => value),
    ['2', '3']
  );
  assert.deepEqual(session.osd, ['Loaded external eng subtitle', 'Downloaded 1 subtitle(s)']);
});

test('a manual download finishing after the version changed adds nothing', async () => {
  const download = deferred();
  const session = createSession({ http: { download: () => download.promise } });

  session.manager.updateFromFileUrl(UHD);
  session.manager.manualDownloadSubtitles();
  await flush();
  switchTo(session, HD);
  download.resolve();
  await flush();

  // Only the announcement made when the download was asked for.
  assert.deepEqual(session.osd, ['Downloading subtitles...']);
  assert.deepEqual(session.mpvCalls, []);
});

test('a manual download for the version still playing applies to it', async () => {
  const downloads = [];
  const session = createSession({
    tracks: [{ id: 1, type: 'audio', lang: 'eng', title: 'English', selected: true }],
    http: {
      download: async (url) => {
        downloads.push(url);
      },
    },
  });

  session.manager.updateFromFileUrl(HD);
  session.manager.manualDownloadSubtitles();
  await flush();

  // The sidecar of the version playing is the one downloaded and shown.
  assert.deepEqual(downloads, [
    `https://jf.example/Videos/${ITEM}/hd/Subtitles/5/stream.srt?ApiKey=K`,
  ]);
  assert.equal(session.selectedSub().id, 2);
  assert.match(session.tracks.at(-1)['external-filename'], /_5_eng\.srt$/);
  assert.deepEqual(session.osd, [
    'Downloading subtitles...',
    'Loaded external eng subtitle',
    'Downloaded 1 subtitle(s)',
  ]);
});

test('the session after a version switch downloads and ranks its own subtitles', async () => {
  const first = deferred();
  const downloads = [];
  const session = createSession({
    tracks: [{ id: 1, type: 'audio', lang: 'jpn', title: 'Japanese', selected: true }],
    http: {
      download: (url) => {
        downloads.push(url);
        return url.includes('/uhd/') ? first.promise : Promise.resolve();
      },
    },
  });

  session.manager.updateFromFileUrl(UHD);
  const stale = session.manager.downloadAllSubtitles('https://jf.example', ITEM, 'K', {
    mediaSourceId: 'uhd',
  });
  await flush();
  switchTo(session, HD);
  session.manager.selectPreferredTracks();

  const current = session.manager.downloadAllSubtitles('https://jf.example', ITEM, 'K', {
    mediaSourceId: 'hd',
  });
  first.resolve();
  await Promise.all([stale, current]);

  // Only the new version's subtitle was attached, and it was selected.
  assert.deepEqual(downloads, [
    `https://jf.example/Videos/${ITEM}/uhd/Subtitles/2/stream.srt?ApiKey=K`,
    `https://jf.example/Videos/${ITEM}/hd/Subtitles/5/stream.srt?ApiKey=K`,
  ]);
  assert.equal(session.tracks.length, 2);
  assert.match(session.tracks.at(-1)['external-filename'], /_5_eng\.srt$/);
  assert.equal(session.selectedSub().id, 2);
  assert.deepEqual(session.osd, ['Loaded external eng subtitle', 'Downloaded 1 subtitle(s)']);
});
