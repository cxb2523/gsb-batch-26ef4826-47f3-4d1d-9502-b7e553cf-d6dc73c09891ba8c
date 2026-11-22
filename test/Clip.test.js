import assert from 'assert';

import Clip from '../src/Clip';
import { CHUNK_SIZE } from '../src/ClipState';
import {
  installAxiosStub,
  resetAxiosStub,
  setResponder,
  getPendingRequests,
  makeMp3LikeBuffer,
} from './helpers/axiosStub';
import { delay } from './helpers/playerFactory';

describe('Clip disposal lifecycle', () => {
  const URL_A = 'https://example.test/clip-a.mp3';
  const FILE_SIZE = CHUNK_SIZE * 8;

  const silenceChunks = [];

  const createClip = (url = URL_A) =>
    new Clip({
      url,
      fileSize: FILE_SIZE,
      initialPosition: 0,
      lastAllowedPosition: 1,
      silenceChunks,
      volume: 1,
      osName: 'windows',
      browserName: 'chrome',
      useMediaSource: false,
    });

  beforeEach(() => {
    installAxiosStub();
    setResponder(URL_A, () => makeMp3LikeBuffer(CHUNK_SIZE + 1));
  });

  afterEach(() => {
    resetAxiosStub();
  });

  it('marks itself disposed and goes silent after dispose()', async () => {
    const clip = createClip();
    const events = [];
    ['loadprogress', 'bufferchange', 'ended', 'load', 'loaderror'].forEach((name) =>
      clip.on(name, () => events.push(name))
    );

    clip.preBuffer().catch(() => {});
    await delay(20);

    clip.dispose();
    assert.strictEqual(clip.disposed, true);

    // Re-registering a listener after disposal still cannot receive events
    // because the disposed Clip suppresses every emission.
    clip.on('loadprogress', () => events.push('late-listener'));
    clip._fire('loadprogress', { buffered: 1, total: 1 });
    clip._fire('ended');
    clip._fire('bufferchange', true);

    await delay(10);
    assert.ok(!events.includes('late-listener'));
    assert.ok(!events.includes('ended'));
    assert.ok(!events.includes('bufferchange'));
  });

  it('cancels the in-flight loader requests when disposed', async () => {
    setResponder(URL_A, () => new Promise(() => {}));

    const clip = createClip();
    clip.preBuffer().catch(() => {});
    await delay(5);

    const pending = getPendingRequests(URL_A);
    assert.ok(pending.length > 0);

    clip.dispose();
    await delay(5);

    pending.forEach((entry) => {
      assert.strictEqual(entry.signal.aborted, true);
    });
  });

  it('rejects play/resume/setCurrentPosition after disposal', async () => {
    const clip = createClip();
    clip.dispose();

    await assert.rejects(() => clip.play());
    await assert.rejects(() => clip.resume());
    await assert.rejects(() => clip.setCurrentPosition(0.5));
    await assert.rejects(() => clip.preBuffer());
    await assert.rejects(() => clip.buffer());
  });

  it('is idempotent: disposing twice does not throw', () => {
    const clip = createClip();
    clip.dispose();
    assert.doesNotThrow(() => clip.dispose());
    assert.strictEqual(clip.disposed, true);
  });

  it('does not emit ended after disposal even when playbackEnded() is called', () => {
    const clip = createClip();
    let endedCount = 0;
    clip.on('ended', () => {
      endedCount += 1;
    });

    clip.dispose();
    clip.playbackEnded();

    assert.strictEqual(endedCount, 0);
  });

  it('cancels the initial-chunk loader when a non-zero-position clip is disposed', async () => {
    setResponder(URL_A, () => new Promise(() => {}));

    const clip = new Clip({
      url: URL_A,
      fileSize: FILE_SIZE,
      initialPosition: 0.25,
      lastAllowedPosition: 1,
      silenceChunks,
      volume: 1,
      osName: 'windows',
      browserName: 'chrome',
      useMediaSource: false,
    });

    await delay(5);
    assert.ok(clip._initialChunkLoader, 'expected an initial-chunk loader');

    const pending = getPendingRequests(URL_A);
    assert.ok(pending.length > 0);

    clip.dispose();
    assert.strictEqual(clip._initialChunkLoader, null);
    pending.forEach((entry) => {
      assert.strictEqual(entry.signal.aborted, true);
    });
  });
});
