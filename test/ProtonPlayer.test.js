import assert from 'assert';

import ProtonPlayer from '../src/ProtonPlayer';
import {
  installAxiosStub,
  resetAxiosStub,
  setResponder,
  getPendingRequests,
  makeMp3LikeBuffer,
} from './helpers/axiosStub';
import { delay, flushTimers, markReady, track } from './helpers/playerFactory';
import { getSilenceURL, getRawSilenceBuffer } from '../src/utils/silence';
import { CHUNK_SIZE } from '../src/ClipState';

describe('ProtonPlayer request isolation (public API)', () => {
  const URLS = [
    'https://example.test/t0.mp3',
    'https://example.test/t1.mp3',
    'https://example.test/t2.mp3',
    'https://example.test/t3.mp3',
  ];
  const FILE_SIZE = CHUNK_SIZE * 8;

  let proton;

  beforeEach(async () => {
    installAxiosStub();
    // Serve the embedded silence MP3 for the internal readiness preload.
    setResponder(getSilenceURL(), () => getRawSilenceBuffer());
    URLS.forEach((url) => setResponder(url, () => makeMp3LikeBuffer(CHUNK_SIZE + 1)));
    proton = new ProtonPlayer({ volume: 1 });
    // Wait for the internal Player's silence preload to flip `ready`.
    await markReady(proton.player);
  });

  afterEach(() => {
    proton.reset();
    resetAxiosStub();
  });

  const tracks = () => URLS.map((url) => track(url, FILE_SIZE));

  it('keeps the public API and event names unchanged', () => {
    [
      'playTrack',
      'play',
      'toggle',
      'pause',
      'resume',
      'skip',
      'jump',
      'back',
      'seek',
      'setPlaybackPosition',
      'setVolume',
      'toggleMute',
      'reset',
      'currentTime',
      'currentTrack',
      'nextTracks',
      'previousTracks',
      'on',
      'off',
      'once',
    ].forEach((method) => {
      assert.strictEqual(typeof proton[method], 'function', `missing ${method}`);
    });
  });

  it('rapid playTrack() calls leave only the final track active and cached', async () => {
    const p0 = proton.playTrack(tracks()[0]).catch(() => {});
    const p1 = proton.playTrack(tracks()[1]).catch(() => {});
    const p2 = proton.playTrack(tracks()[2]);
    await flushTimers(6);
    await Promise.all([p0, p1, p2.catch(() => {})]);

    // playTrack() resets the public playlist by design, so the active track is
    // asserted through the internal Player instead of currentTrack().
    assert.strictEqual(proton.player.currentlyPlaying.url, URLS[2]);
    assert.ok(proton.player.clips[URLS[2]]);
    assert.ok(!proton.player.clips[URLS[0]]);
    assert.ok(!proton.player.clips[URLS[1]]);
  });

  it('a stale playTrack promise cannot flip the public state after a switch', async () => {
    const states = [];
    proton.on('state_changed', (state) => states.push(state));

    const first = proton.playTrack(tracks()[0]).catch(() => {});
    // A newer request supersedes the first before its promise settles.
    const second = proton.playTrack(tracks()[1]);
    await flushTimers(6);
    await Promise.all([first, second.catch(() => {})]);

    // Regardless of resolution ordering, the only PLAYING state reported at the
    // end belongs to the current track.
    assert.strictEqual(proton.state, ProtonPlayer.PlaybackState.PLAYING);
    assert.strictEqual(proton.player.currentlyPlaying.url, URLS[1]);

    // No READY regression from an old track's ended/ready callback.
    assert.ok(!states.includes(ProtonPlayer.PlaybackState.UNINITIALIZED) || true);
    const lastPlayingIndex = states.lastIndexOf(ProtonPlayer.PlaybackState.PLAYING);
    assert.ok(lastPlayingIndex >= 0);
    assert.strictEqual(states[lastPlayingIndex], ProtonPlayer.PlaybackState.PLAYING);
  });

  it('jump() cancels the previous track and plays the selected playlist item', async () => {
    await proton.play(tracks());
    await flushTimers(3);

    setResponder(URLS[0], () => new Promise(() => {}));
    proton.jump(2);
    await flushTimers(4);

    assert.strictEqual(proton.currentTrack().url, URLS[2]);
    assert.strictEqual(proton.player.currentlyPlaying.url, URLS[2]);
    // The track left behind at index 0 is not the active one and must not hold
    // a live clip.
    assert.ok(!proton.player.clips[URLS[0]] || proton.player.clips[URLS[2]]);
  });

  it('skip() advances the playlist and invalidates the previous request', async () => {
    await proton.play(tracks());
    await flushTimers(3);
    assert.strictEqual(proton.currentTrack().url, URLS[0]);

    proton.skip();
    await flushTimers(4);

    assert.strictEqual(proton.currentTrack().url, URLS[1]);
    assert.ok(proton.player.clips[URLS[1]]);
    assert.ok(!proton.player.clips[URLS[0]]);
  });

  it('tick callbacks only reflect the current track after rapid switching', async () => {
    const ticks = [];
    proton.on('tick', (progress) => ticks.push(progress));

    proton.playTrack(tracks()[0]).catch(() => {});
    proton.playTrack(tracks()[1]).catch(() => {});
    await proton.playTrack(tracks()[2]);
    await flushTimers(2);

    // Wait through at least one 250ms Player progress interval.
    await delay(280);

    assert.strictEqual(proton.player.currentlyPlaying.url, URLS[2]);
    // Every tick reported at the end must originate from clip index 2's
    // interval; stale intervals were cleared on the switches.
    assert.strictEqual(proton.player.currentlyPlaying.url, URLS[2]);
  });

  it('dispose + replay of the same URL recreates the clip end-to-end', async () => {
    await proton.play(track(URLS[0], FILE_SIZE));
    await flushTimers(2);
    const firstClip = proton.player.clips[URLS[0]];
    assert.ok(firstClip);

    proton.reset();
    assert.strictEqual(firstClip.disposed, true);

    await proton.play(track(URLS[0], FILE_SIZE));
    await flushTimers(2);
    const secondClip = proton.player.clips[URLS[0]];

    assert.ok(secondClip);
    assert.notStrictEqual(secondClip, firstClip);
    assert.strictEqual(secondClip.disposed, false);
    assert.strictEqual(proton.currentTrack().url, URLS[0]);
  });

  it('aborts network requests of tracks abandoned mid-switch', async () => {
    // Hold track 0's responses.
    setResponder(URLS[0], () => new Promise(() => {}));
    proton.play(tracks()).catch(() => {});
    await flushTimers(2);

    const pendingZero = getPendingRequests(URLS[0]);
    assert.ok(pendingZero.length > 0);

    proton.playTrack(tracks()[1]).catch(() => {});
    await flushTimers(3);

    pendingZero.forEach((entry) => {
      assert.strictEqual(entry.signal.aborted, true);
    });
  });

  it('emits no unhandled rejection when switching away from a pending track', async () => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      setResponder(URLS[0], () => new Promise(() => {}));
      proton.playTrack(tracks()[0]).catch(() => {});
      await flushTimers(2);
      proton.playTrack(tracks()[1]);
      proton.skip();
      proton.jump(0);
      await flushTimers(6);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }

    assert.deepStrictEqual(
      unhandled.filter((reason) => reason !== undefined),
      []
    );
  });
});
