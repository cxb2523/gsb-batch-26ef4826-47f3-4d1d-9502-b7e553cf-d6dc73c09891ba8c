import CancellableSleep, { SLEEP_CANCELLED } from './utils/CancellableSleep';
import parseMetadata from './utils/parseMetadata';
import EventEmitter from './EventEmitter';
import { debug } from './utils/logger';
import getContext from './getContext';
import FetchJob from './FetchJob';
import { createChunk } from './Chunk';
import {
  FetchStrategy,
  createFetchCursor,
  LOAD_BATCH_SIZE,
  PRELOAD_BATCH_SIZE,
} from './FetchCursor';
import * as Bytes from './utils/bytes';
import useMediaSource from './utils/useMediaSource';
import DecodingError from './DecodingError';
import isFrameHeader from './utils/isFrameHeader';

const DELAY_BETWEEN_FETCHES = 400; // milliseconds

// Sentinel used to settle pending `buffer()` promises when their loading
// session has been cancelled. It is intentionally swallowed by callers
// (Clip/Player) instead of being surfaced as a playback error.
export const LOAD_CANCELLED = Symbol('LOAD_CANCELLED');

export default class Loader extends EventEmitter {
  constructor(chunkSize, url, clipState, audioMetadata = {}) {
    super();
    this._chunkSize = chunkSize;
    this._url = url;
    this._fileSize = clipState.fileSize;
    this._chunks = clipState.chunks;
    this._clipState = clipState;
    this._referenceHeader = audioMetadata.referenceHeader;
    this.metadata = audioMetadata.metadata;
    this._loadStarted = false;
    this._canPlayThrough = false;
    this.context = getContext();
    this.buffered = 0;
    this._chunksDuration = 0;
    this._chunksCount = 0;
    this._jobs = {};
    this._sleep = null;
    this._fetchStrategy =
      clipState.fileSize > Bytes.megabytes(30)
        ? FetchStrategy.LAZY
        : FetchStrategy.GREEDY;
    this._cancelled = false;

    // Loading sessions are numbered. Every `buffer()` call starts a new
    // generation (after a `cancel()`) and every asynchronous callback captures
    // the generation it belongs to. Responses arriving after a cancellation
    // carry a stale generation and are dropped before they can touch the
    // ClipState or emit any event.
    this._generation = 0;
    this._waiters = [];

    this._clipState.on('chunkIndexManuallyChanged', (newIndex) => {
      this.cancel();
      this._initialChunk = newIndex;
      this._canPlayThrough = false;
      this._cursor = createFetchCursor({
        index: newIndex,
        size: this._clipState.totalChunksCount,
        strategy: this._fetchStrategy,
      });
      this.buffer(false, newIndex);
    });
  }

  get audioMetadata() {
    return {
      referenceHeader: this._referenceHeader,
      metadata: this.metadata,
    };
  }

  get averageChunkDuration() {
    return this._chunksCount > 0 ? this._chunksDuration / this._chunksCount : 0;
  }

  cancel() {
    this._cancelled = true;

    // Invalidate every in-flight request belonging to the current generation.
    this._generation += 1;

    this._sleep && this._sleep.cancel();
    Object.keys(this._jobs).forEach((chunkIndex) => {
      this._jobs[chunkIndex].cancel();
      delete this._jobs[chunkIndex];
    });
    this._loadStarted = false;

    // Anything waiting on `buffer()` is released. Cancellation is a normal
    // outcome (a track switch, a pause, a dispose), not an error, so waiters
    // are resolved rather than rejected: this guarantees a cancelled load can
    // never surface as an unhandled rejection even if a caller forgot to
    // attach a handler. The LOAD_CANCELLED sentinel lets callers that care
    // distinguish cancellation from a genuine completion.
    const waiters = this._waiters;
    this._waiters = [];
    waiters.forEach(({ resolve }) => resolve(LOAD_CANCELLED));
  }

  _getRange(chunkIndex) {
    const start = chunkIndex * this._chunkSize + chunkIndex;
    const end = Math.min(this._fileSize, start + this._chunkSize);
    return { start, end };
  }

  buffer(preloadOnly = false, initialChunk = 0) {
    if (!this._loadStarted) {
      this._loadStarted = !preloadOnly;
      this._initialChunk = initialChunk;
      this._canPlayThrough = false;
      this._preloadOnly = preloadOnly;
      // A fresh buffer run starts a brand-new loading session.
      this._cancelled = false;
      this._generation += 1;

      this._cursor = createFetchCursor({
        index: initialChunk,
        size: this._clipState.totalChunksCount,
        strategy: preloadOnly ? FetchStrategy.PRELOAD_ONLY : this._fetchStrategy,
      });

      this._fetchNextChunks();
    }
    return new Promise((resolve, reject) => {
      const ready = preloadOnly ? this._canPlayThrough : this.loaded;
      if (ready) {
        resolve();
      } else {
        this._waiters.push({ resolve, reject, preloadOnly });
      }
    });
  }

  _settleWaiters(eventName) {
    const waiters = this._waiters;
    this._waiters = [];
    waiters.forEach(({ resolve, reject, preloadOnly }) => {
      if (eventName === 'loaderror') {
        reject(this._lastError);
      } else if (eventName === 'load') {
        // A full load implies the preload condition has been met as well.
        resolve();
      } else if (eventName === 'canPlayThrough' && preloadOnly) {
        resolve();
      } else {
        // This waiter is waiting for a different event; keep it pending.
        this._waiters.push({ resolve, reject, preloadOnly });
      }
    });
  }

  _checkCanplaythrough(generation) {
    if (this._cancelled || generation !== this._generation) return;
    if (this._canPlayThrough || !this.length) return;
    let loadedChunksCount = 0;
    const preloadBatchSize = Math.min(
      PRELOAD_BATCH_SIZE,
      this._clipState.totalChunksCount - this._initialChunk
    );
    for (let i = this._initialChunk; i < this._clipState.totalChunksCount; i++) {
      const chunk = this._chunks[i];
      if (!chunk || !chunk.duration) break;
      if (++loadedChunksCount >= preloadBatchSize) {
        this._canPlayThrough = true;
        this._fire('canPlayThrough');
        this._settleWaiters('canPlayThrough');
        debug('Can play through 1');
        break;
      }
    }
  }

  _calculateMetadata(uint8Array) {
    if (
      !this.metadata ||
      !this._referenceHeader ||
      Object.keys(this.metadata).length === 0 ||
      Object.keys(this._referenceHeader).length === 0
    ) {
      for (let i = 0; i < uint8Array.length; i += 1) {
        // determine some facts about this mp3 file from the initial header
        if (
          uint8Array[i] === 0b11111111 &&
          (uint8Array[i + 1] & 0b11110000) === 0b11110000
        ) {
          // http://www.datavoyage.com/mpgscript/mpeghdr.htm
          this._referenceHeader = {
            mpegVersion: uint8Array[i + 1] & 0b00001000,
            mpegLayer: uint8Array[i + 1] & 0b00000110,
            sampleRate: uint8Array[i + 2] & 0b00001100,
            channelMode: uint8Array[i + 3] & 0b11000000,
          };
          this.metadata = parseMetadata(this._referenceHeader);
          // TODO: do the following checks based on arguments to the library?
          if (
            this.metadata.sampleRate === 44100 &&
            this.metadata.channelMode === 'stereo'
          )
            break;
        }
      }
    }
  }

  _createChunk(uint8Array, index, generation) {
    if (!uint8Array || !Number.isInteger(index)) {
      debug('Loader#_createChunk: Invalid arguments. Resolving with null.');
      return Promise.resolve(null);
    }
    this._calculateMetadata(uint8Array);
    const clip = {
      context: this.context,
      metadata: this.metadata,
      _referenceHeader: this._referenceHeader,
    };
    const chunk = createChunk({
      index,
      clip,
      raw: uint8Array,
    });

    if (useMediaSource()) {
      return Promise.resolve(chunk);
    } else {
      return decodeChunk(chunk, clip).then((decodedChunk) => {
        // Decoding is not abortable: make sure a chunk that finished
        // decoding after a cancellation cannot enter the ClipState.
        if (this._cancelled || generation !== this._generation) {
          return null;
        }
        return decodedChunk;
      });
    }
  }

  _onData(chunk, generation) {
    if (this._cancelled || generation !== this._generation) return;

    this._chunks[chunk.index] = chunk;

    if (!this._canPlayThrough) {
      this._checkCanplaythrough(generation);
    }
    if (chunk.raw.length === this._chunkSize + 1 && chunk.duration > 0) {
      this._chunksDuration += chunk.duration;
      this._chunksCount += 1;
    }
  }

  _onProgress(chunkLength, total, generation) {
    if (this._cancelled || generation !== this._generation) return;

    this.buffered += chunkLength;
    this.length = total;
    this._fire('loadprogress', { buffered: this.buffered, total });
  }

  _onLoad(generation) {
    if (this._cancelled || generation !== this._generation) return;

    const firstChunk = this._chunks[this._initialChunk];
    if (firstChunk && !this.loaded) {
      if (!this._canPlayThrough) {
        this._canPlayThrough = true;
        this._fire('canPlayThrough');
        this._settleWaiters('canPlayThrough');
        debug('Can play through 2');
      }
      this.loaded = true;
      this._fire('load');
      this._settleWaiters('load');
    }
  }

  _seekFetchCursor() {
    this._cursor = this._cursor.seek(this._clipState.chunkIndex);
  }

  _fetchNextChunks(generation = this._generation) {
    if (this._cancelled || generation !== this._generation) {
      return Promise.resolve();
    }

    const startTime = Date.now();
    const nextChunks = this._cursor
      .chunks()
      .map((chunkIndex) => this._fetchChunk(chunkIndex, generation));

    if (nextChunks.length === 0) {
      return Promise.resolve();
    }

    this._sleep = new CancellableSleep(
      LOAD_BATCH_SIZE * DELAY_BETWEEN_FETCHES - (Date.now() - startTime)
    );

    return Promise.all(nextChunks)
      .then(() => this._sleep.wait())
      .then(() => this._seekFetchCursor())
      .then(() => this._fetchNextChunks(generation))
      .catch((err) => {
        if (err !== SLEEP_CANCELLED) throw err;
      });
  }

  _fetchChunk(chunkIndex, generation = this._generation) {
    if (this._cancelled || generation !== this._generation) {
      return Promise.resolve();
    }

    if (!!this._clipState.chunks[chunkIndex]) {
      return Promise.resolve();
    }

    const { start, end } = this._getRange(chunkIndex);
    const job = new FetchJob(
      this._url,
      (uint8Array, index) => this._createChunk(uint8Array, index, generation),
      chunkIndex,
      start,
      end
    );
    this._jobs[chunkIndex] = job;
    return job
      .fetch()
      .then((chunk) => {
        // A late response (cancellation raced with the network/decode) must
        // never write back to the cache or emit an event.
        if (this._cancelled || generation !== this._generation || !chunk) {
          if (this._jobs[chunkIndex] === job) {
            delete this._jobs[chunkIndex];
          }
          return Promise.resolve();
        }

        if (this._jobs[chunk.index]) {
          delete this._jobs[chunk.index];
        }

        if (!chunk || !chunk.raw || chunk.raw.length === 0) {
          return Promise.resolve();
        }

        this._onData(chunk, generation);
        this._onProgress(chunk.raw.length, this._fileSize, generation);

        const isLastChunk = chunk.index === this._clipState.totalChunksCount - 1;
        if (isLastChunk) {
          this._onLoad(generation);
        }

        return Promise.resolve();
      })
      .catch((err = {}) => {
        // A cancelled session never reports errors: its requests were
        // deliberately aborted and must not surface as loader errors.
        if (this._cancelled || generation !== this._generation) {
          return Promise.resolve();
        }

        err.url = this._url;
        err.customCode = 'COULD_NOT_LOAD';
        this._lastError = err;
        this._fire('loaderror', err);
        this._settleWaiters('loaderror');
        this._loadStarted = false;
      });
  }
}

const decodeChunk = (chunk, clip) => {
  const { buffer } = chunk.buffer();
  return decodeAudioData(buffer)
    .then(checkDecodedAudio(chunk))
    .catch(attemptDecodeRecovery(chunk, clip));
};

// Compatibility: Safari iOS
// Mobile Safari does not implement the Promise-based AudioContext APIs, so
// we have to wrap the callback-based version ourselves to utilize it.
const decodeAudioData = (buffer) =>
  new Promise((res, rej) => getContext().decodeAudioData(buffer, res, rej));

const checkDecodedAudio = (chunk) => () =>
  chunk.duration > 0
    ? chunk
    : Promise.reject(new DecodingError('Got 0 frames when decoding audio buffer'));

// Compatibility: Safari iOS
// The MP3 decoding capabilities of Webkit are limited compared to other
// browsers. When you attempt to use `decodeAudioData` on any MP3 chunk that is
// not aligned to a frame boundary, the operation fails and calls the error
// callback with a `null` error value. Since our chunks are fixed-size blocks
// that do not respect frame boundaries, this will occur for nearly EVERY
// chunk of audio.
//
// With this in mind, this error handler detects this specific `null` failure
// case and realigns the chunk to the first frame header it is able to decode
// from. Then, during playback, chunks are stitched together in a manner that
// respects this realignment so that we never attempt to decode partial
// or incomplete frames.
const attemptDecodeRecovery = (chunk, clip) => (err) => {
  if (err) {
    return Promise.reject(err);
  }

  for (let i = chunk.byteOffset; i < chunk.raw.length - 1; i++) {
    if (isFrameHeader(chunk.raw, i, clip._referenceHeader)) {
      return decodeChunk(createChunk({ ...chunk, byteOffset: i, clip }), clip);
    }
  }
};
