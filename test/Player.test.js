import assert from 'assert';

import {
  installAxiosStub,
  resetAxiosStub,
  setResponder,
  getPendingRequests,
  flushRequest,
  makeMp3LikeBuffer,
} from './helpers/axiosStub';
import {
  createPlayer,
  markReady,
  track,
  delay,
  flushTimers,
} from './helpers/playerFactory';
import { CHUNK_SIZE } from '../src/ClipState';

describe('Player playback request lifecycle', () => {
  const URL_A = 'https://example.test/a.mp3';
  const URL_B = 'https://example.test/b.mp3';
  const URL_C = 'https://example.test/c.mp3';
  const FILE_SIZE = CHUNK_SIZE * 8;

  let player;

  beforeEach(async () => {
    installAxiosStub();
    // Silence loader and all tracks resolve immediately with valid-looking
    // MP3 bytes.
    setResponder(URL_A, () => makeMp3LikeBuffer(CHUNK_SIZE + 1));
    setResponder(URL_B, () => makeMp3LikeBuffer(CHUNK_SIZE + 1));
    setResponder(URL_C, () => makeMp3LikeBuffer(CHUNK_SIZE + 1));

    player = await createPlayer();
    assert.strictEqual(player.ready, true);
  });

  afterEach(() => {
    player.disposeAll();
    resetAxiosStub();
  });

  describe('rapid sequential track switching', () => {
    it('cancels and disposes the old clip when a new playTrack starts', async () => {
      const first = player.playTrack(track(URL_A, FILE_SIZE));
      await flushTimers(2);

      const clipA = player.clips[URL_A];
      assert.ok(clipA, 'clip A should be cached while playing');

      // Immediately switch to B, then C before either settles.
      const second = player.playTrack(track(URL_B, FILE_SIZE));
      const third = player.playTrack(track(URL_C, FILE_SIZE));
      await flushTimers(5);

      await Promise.all([first.catch(() => {}), second.catch(() => {}), third]);

      // Only the current track's clip remains cached and alive.
      assert.ok(player.clips[URL_C], 'clip C should remain');
      assert.ok(!player.clips[URL_A], 'clip A must be removed from the cache');
      assert.ok(!player.clips[URL_B], 'clip B must be removed from the cache');
      assert.strictEqual(clipA.disposed, true, 'clip A must be disposed');

      assert.strictEqual(player.currentlyPlaying.url, URL_C);
      assert.strictEqual(player.currentlyPlaying.clip, player.clips[URL_C]);
    });

    it('only the latest request drives playback progress callbacks', async () => {
      const play = (url) =>
        player.playTrack(
          track(url, FILE_SIZE, {
            onBufferChange: () => {},
            onBufferProgress: () => {},
          })
        );

      // The Player-level progress callback is shared. Track which clip the
      // interval reads by asserting the current clip after switches settle.
      await play(URL_A).catch(() => {});
      await play(URL_B).catch(() => {});
      await play(URL_C);
      await flushTimers(2);

      // Wait through at least one 250ms progress interval.
      await delay(280);

      assert.strictEqual(player.currentlyPlaying.url, URL_C);
      // The interval must reference clip C only; stale intervals were cleared.
      const intervalClip = player.currentlyPlaying.clip;
      assert.strictEqual(intervalClip.url, URL_C);
      assert.strictEqual(intervalClip.disposed, false);
    });

    it('old clip bufferchange/loadprogress/ended events cannot affect the new track', async () => {
      const eventsAfterSwitch = [];
      let switched = false;

      await player
        .playTrack(
          track(URL_A, FILE_SIZE, {
            onBufferChange: (buffering) => {
              if (switched) {
                eventsAfterSwitch.push({ url: URL_A, type: 'bufferchange', buffering });
              }
            },
            onBufferProgress: () => {
              if (switched) {
                eventsAfterSwitch.push({ url: URL_A, type: 'loadprogress' });
              }
            },
          })
        )
        .catch(() => {});

      const clipA = player.clips[URL_A];

      await player.playTrack(
        track(URL_B, FILE_SIZE, {
          onBufferChange: () => {},
          onBufferProgress: () => {},
        })
      );
      await flushTimers(3);
      switched = true;

      assert.strictEqual(clipA.disposed, true);

      // Reaching the disposed clip from outside and firing its events must be
      // a no-op for the Player-facing callbacks.
      clipA._fire('bufferchange', true);
      clipA._fire('loadprogress', { initialPosition: 0, progress: 0.9 });
      clipA.playbackEnded();
      clipA._fire('ended');
      await flushTimers(2);

      // No event may arrive from A after the switch (its listeners were
      // removed on stop/dispose and the Clip is silent).
      assert.deepStrictEqual(
        eventsAfterSwitch,
        [],
        'no stale events should be observed for the old track'
      );
      assert.strictEqual(player.currentlyPlaying.url, URL_B);
    });

    it('cancels in-flight chunk requests of the superseded track', async () => {
      // Hold A's requests open so they are definitely in flight at switch.
      setResponder(URL_A, () => new Promise(() => {}));

      player.playTrack(track(URL_A, FILE_SIZE)).catch(() => {});
      await flushTimers(2);

      const requestsA = getPendingRequests(URL_A);
      assert.ok(requestsA.length > 0, 'track A requests should be in flight');

      setResponder(URL_A, () => makeMp3LikeBuffer(CHUNK_SIZE + 1));
      await player.playTrack(track(URL_B, FILE_SIZE));
      await flushTimers(3);

      requestsA.forEach((entry) => {
        assert.strictEqual(
          entry.signal.aborted,
          true,
          'every old-track request must be aborted'
        );
      });
    });
  });

  describe('late responses after cancellation', () => {
    it('never writes a late chunk of the old URL into the new playback state', async () => {
      const heldA = [];
      setResponder(URL_A, () => {
        return new Promise((resolve) => {
          heldA.push(resolve);
        });
      });

      player.playTrack(track(URL_A, FILE_SIZE)).catch(() => {});
      await flushTimers(2);
      const pendingA = getPendingRequests(URL_A);
      assert.ok(pendingA.length > 0);
      const clipStateA = player.clips[URL_A]._clipState;

      await player.playTrack(track(URL_B, FILE_SIZE));
      await flushTimers(2);

      // A's network responses now arrive, late.
      const lateBytes = makeMp3LikeBuffer(CHUNK_SIZE + 1);
      heldA.forEach((resolve) => resolve(lateBytes));
      pendingA.forEach((entry) => flushRequest(entry, lateBytes));
      await flushTimers(5);

      // The old ClipState must remain empty; late data was dropped.
      assert.strictEqual(
        clipStateA.chunks.filter(Boolean).length,
        0,
        'late chunks must not populate the old ClipState'
      );
      assert.strictEqual(player.currentlyPlaying.url, URL_B);
    });
  });

  describe('dispose then replay the same URL', () => {
    it('recreates the Clip instead of returning the disposed instance', async () => {
      await player.playTrack(track(URL_A, FILE_SIZE));
      const firstClip = player.clips[URL_A];
      assert.ok(firstClip);

      player._dispose(URL_A);
      assert.strictEqual(firstClip.disposed, true);
      assert.ok(!player.clips[URL_A]);

      await player.playTrack(track(URL_A, FILE_SIZE));
      const secondClip = player.clips[URL_A];

      assert.ok(secondClip, 'a new clip must be created on replay');
      assert.notStrictEqual(
        secondClip,
        firstClip,
        'the disposed instance must not be resurrected'
      );
      assert.strictEqual(secondClip.disposed, false);
      assert.strictEqual(player.currentlyPlaying.clip, secondClip);
    });

    it('_getClip never returns a disposed instance', async () => {
      await player.playTrack(track(URL_A, FILE_SIZE));
      const disposedClip = player.clips[URL_A];
      player._dispose(URL_A);

      // Simulate a stale cache reference being present: force the key back and
      // confirm _getClip still refuses to hand out the released instance.
      player.clips[URL_A] = disposedClip;
      const fresh = player._getClip(URL_A, FILE_SIZE);

      assert.notStrictEqual(fresh, disposedClip);
      assert.strictEqual(fresh.disposed, false);
    });

    it('a preload cancelled by a switch does not poison a later replay', async () => {
      // Preload A, then switch to B before A finishes: A's preload must be
      // cancelled and its clip disposed.
      setResponder(URL_A, () => new Promise(() => {}));
      player.playNext(track(URL_A, FILE_SIZE));
      await flushTimers(2);
      const preloadedA = player.clips[URL_A];
      assert.ok(preloadedA);

      await player.playTrack(track(URL_B, FILE_SIZE));
      await flushTimers(2);
      assert.strictEqual(preloadedA.disposed, true);
      assert.ok(!player.clips[URL_A]);

      // Replaying A builds a fresh clip whose requests succeed.
      setResponder(URL_A, () => makeMp3LikeBuffer(CHUNK_SIZE + 1));
      await player.playTrack(track(URL_A, FILE_SIZE));
      assert.ok(player.clips[URL_A]);
      assert.notStrictEqual(player.clips[URL_A], preloadedA);
      assert.strictEqual(player.currentlyPlaying.url, URL_A);
    });
  });

  describe('generation gating', () => {
    it('bumping the generation invalidates previously wired callbacks', async () => {
      const callbacks = {
        onBufferChange: () => {},
        onBufferProgress: () => {},
      };

      await player.playTrack(track(URL_A, FILE_SIZE, callbacks));
      const clipA = player.clips[URL_A];
      const generationA = player.currentlyPlaying.generation;

      await player.playTrack(track(URL_B, FILE_SIZE, callbacks));
      assert.notStrictEqual(player._playbackGeneration, generationA);

      // Simulate the old clip's 'ended' firing late. The Player generation
      // gate must prevent it from advancing playback or ending the session.
      clipA._fire('ended');
      clipA.playbackEnded();

      // After a progress interval the current request must still be B.
      await delay(260);
      assert.strictEqual(player.currentlyPlaying.url, URL_B);
      assert.strictEqual(player.nextTrack, null);
    });

    it('clears the progress interval of every superseded request', async () => {
      const originalSetInterval = global.setInterval;
      const originalClearInterval = global.clearInterval;
      const active = new Set();

      global.setInterval = (fn, ms) => {
        const id = originalSetInterval(fn, ms);
        active.add(id);
        return id;
      };
      global.clearInterval = (id) => {
        active.delete(id);
        originalClearInterval(id);
      };

      try {
        await player.playTrack(track(URL_A, FILE_SIZE));
        await player.playTrack(track(URL_B, FILE_SIZE));
        await player.playTrack(track(URL_C, FILE_SIZE));
        await flushTimers(2);

        // Exactly one playback interval (the current request's) may remain.
        assert.strictEqual(
          active.size,
          1,
          `expected a single live interval, found ${active.size}`
        );
      } finally {
        global.setInterval = originalSetInterval;
        global.clearInterval = originalClearInterval;
      }
    });

    it('a stale ended event cannot trigger onPlaybackEnded for the new track', async () => {
      let playbackEndedCount = 0;
      const local = await createPlayer({
        onPlaybackEnded: () => {
          playbackEndedCount += 1;
        },
      });

      await local.playTrack(track(URL_A, FILE_SIZE));
      const clipA = local.clips[URL_A];

      await local.playTrack(track(URL_B, FILE_SIZE));
      await flushTimers(2);

      // The old clip ending late must not end the new playback session.
      clipA._fire('ended');
      clipA.playbackEnded();
      await flushTimers(2);

      assert.strictEqual(playbackEndedCount, 0);
      assert.strictEqual(local.currentlyPlaying.url, URL_B);

      local.disposeAll();
    });

    it('seeking past the end advances to the queued track under a new generation', async () => {
      const advanced = [];
      const local = await createPlayer({
        onNextTrack: (current, next) => advanced.push([current?.url, next?.url]),
      });

      // Play A with B queued.
      local.playNext(track(URL_B, FILE_SIZE));
      await local.playTrack(track(URL_A, FILE_SIZE));
      await flushTimers(2);

      const generationBefore = local._playbackGeneration;
      const clipA = local.clips[URL_A];

      // Force the seek computation past the end so the Player transitions to B.
      Object.defineProperty(clipA, 'currentTime', {
        configurable: true,
        value: 0,
      });
      Object.defineProperty(clipA, 'duration', {
        configurable: true,
        value: 1,
      });
      // The switch owns the returned promise; the released clip A is never
      // repositioned.
      await assert.doesNotReject(() => local.seek(5));
      await flushTimers(3);

      assert.notStrictEqual(local._playbackGeneration, generationBefore);
      assert.strictEqual(local.currentlyPlaying.url, URL_B);
      assert.strictEqual(clipA.disposed, true);
      assert.deepStrictEqual(advanced, [[URL_A, URL_B]]);

      local.disposeAll();
    });
  });
});
