import assert from 'assert';

import Loader, { LOAD_CANCELLED } from '../src/Loader';
import ClipState, { CHUNK_SIZE } from '../src/ClipState';
import {
  installAxiosStub,
  resetAxiosStub,
  setResponder,
  getPendingRequests,
  flushRequest,
  makeMp3LikeBuffer,
} from './helpers/axiosStub';
import { delay } from './helpers/playerFactory';

describe('Loader cancellation and cache lifecycle', () => {
  const URL_A = 'https://example.test/track-a.mp3';

  beforeEach(() => {
    installAxiosStub();
  });

  afterEach(() => {
    resetAxiosStub();
  });

  const createLoader = (fileSize = CHUNK_SIZE * 8, url = URL_A) => {
    const clipState = new ClipState(fileSize);
    return { loader: new Loader(CHUNK_SIZE, url, clipState), clipState };
  };

  it('cancels every in-flight chunk request when cancel() is called', async () => {
    // Never auto-respond: requests stay pending until the test decides.
    setResponder(URL_A, () => new Promise(() => {}));

    const { loader } = createLoader();
    loader.buffer();
    await delay(5);

    const before = getPendingRequests(URL_A);
    assert.ok(before.length > 0, 'expected chunk requests to be in flight');

    loader.cancel();
    await delay(5);

    // Every FetchJob was aborted via its AbortController.
    before.forEach((entry) => {
      assert.strictEqual(entry.signal.aborted, true);
    });
    assert.deepStrictEqual(loader._jobs, {});
  });

  it('drops a response that arrives after cancellation (no cache write, no events)', async () => {
    const held = [];
    setResponder(URL_A, (config) => {
      // Hold the response so the test can release it after cancel().
      return new Promise((resolve) => {
        held.push({ config, resolve });
      });
    });

    const { loader, clipState } = createLoader();

    const events = [];
    loader.on('loadprogress', () => events.push('loadprogress'));
    loader.on('loaderror', () => events.push('loaderror'));
    loader.on('load', () => events.push('load'));
    loader.on('canPlayThrough', () => events.push('canPlayThrough'));

    loader.buffer();
    await delay(5);

    const pending = getPendingRequests(URL_A);
    assert.ok(pending.length > 0);

    loader.cancel();

    // Simulate the network/decode finishing late.
    const lateBuffer = makeMp3LikeBuffer(CHUNK_SIZE + 1);
    held.forEach(({ resolve }) => resolve(lateBuffer));
    pending.forEach((entry) => flushRequest(entry, lateBuffer));
    await delay(20);

    // Nothing may have been written into the ClipState cache.
    assert.strictEqual(clipState.chunks.filter(Boolean).length, 0);
    // And no event may have escaped the cancelled loader.
    assert.deepStrictEqual(events, []);
  });

  it('settles a pending buffer() promise with the cancellation sentinel', async () => {
    setResponder(URL_A, () => new Promise(() => {}));

    const { loader } = createLoader();
    const bufferPromise = loader.buffer();
    await delay(5);

    loader.cancel();

    // Cancellation is a normal outcome: the promise resolves (never rejects),
    // so it cannot become an unhandled rejection.
    const result = await bufferPromise;
    assert.strictEqual(result, LOAD_CANCELLED);
  });

  it('starts a new generation after cancel + buffer and ignores stale jobs', async () => {
    const { loader, clipState } = createLoader();

    // First session: hold responses, then cancel.
    const firstGenRequests = [];
    setResponder(URL_A, () => {
      return new Promise((resolve) => firstGenRequests.push({ resolve }));
    });

    // preloadOnly settles on canPlayThrough (a small fixed batch), which keeps
    // the test independent of total file size.
    loader.buffer(true);
    await delay(5);
    const firstGeneration = loader._generation;
    loader.cancel();
    assert.notStrictEqual(loader._generation, firstGeneration);

    // Second session serves data immediately.
    setResponder(URL_A, () => makeMp3LikeBuffer(CHUNK_SIZE + 1));
    const secondBuffer = loader.buffer(true);
    await delay(40);

    // Late responses from the first generation must not enter the cache.
    firstGenRequests.forEach(({ resolve }) => resolve(makeMp3LikeBuffer(CHUNK_SIZE + 1)));
    await delay(10);

    const cachedChunks = clipState.chunks.filter(Boolean);
    assert.ok(cachedChunks.length > 0, 'new generation should populate the cache');
    cachedChunks.forEach((chunk) => {
      assert.ok(Number.isInteger(chunk.index));
    });

    // The new buffer() promise settles normally rather than hanging.
    await Promise.race([
      secondBuffer,
      delay(300).then(() => {
        throw new Error('buffer() promise never settled');
      }),
    ]);
  });

  it('does not emit loader errors for cancelled requests', async () => {
    const { loader } = createLoader();
    const errors = [];
    loader.on('loaderror', (err) => errors.push(err));

    setResponder(URL_A, () => new Promise(() => {}));
    loader.buffer();
    await delay(5);

    loader.cancel();
    await delay(20);

    assert.deepStrictEqual(errors, []);
  });
});
