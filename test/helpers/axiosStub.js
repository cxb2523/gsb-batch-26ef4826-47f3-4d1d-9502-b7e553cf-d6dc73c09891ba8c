// Deterministic in-memory HTTP layer for tests.
//
// Replaces the axios transport with an adapter that never touches the network.
// Tests queue controllable responses per URL and can choose when each pending
// request resolves ("late response" scenarios); aborting the request's
// AbortController makes the adapter reject with the real axios.CanceledError,
// exactly as a browser would.

import axios, { CanceledError } from 'axios';

// One entry per queued request:
// { url, config, signal, resolveEntry, rejectEntry }
const pending = [];

// Per-URL response factories. A factory receives the request config (which
// carries the range header) and returns either an ArrayBuffer or a Promise of
// one for delayed resolution.
const responders = new Map();

let originalAdapter;

export function installAxiosStub() {
  originalAdapter = axios.defaults.adapter;

  axios.defaults.adapter = (config) => {
    const signal = config.signal;
    const entry = { url: config.url, config, signal };

    const promise = new Promise((resolve, reject) => {
      entry.resolveEntry = (data) => {
        if (signal && signal.aborted) {
          reject(new CanceledError('canceled'));
          return;
        }
        resolve({
          data,
          status: 206,
          statusText: 'Partial Content',
          headers: {},
          config,
        });
      };
      entry.rejectEntry = reject;

      if (signal) {
        signal.addEventListener('abort', () => {
          reject(new CanceledError('canceled'));
        });
      }
    });

    pending.push(entry);

    const responder = responders.get(config.url);
    if (responder) {
      Promise.resolve()
        .then(() => responder(config))
        .then((data) => {
          if (!data) return;
          if (signal && signal.aborted) return;
          entry.resolveEntry(data);
        })
        .catch((err) => entry.rejectEntry(err));
    }

    return promise;
  };

  return { pending, responders };
}

export function resetAxiosStub() {
  pending.length = 0;
  responders.clear();
  if (originalAdapter !== undefined) {
    axios.defaults.adapter = originalAdapter;
  }
}

// Register the bytes served for a URL. `handler(config)` returns an
// ArrayBuffer (or a Promise of one for delayed responses).
export function setResponder(url, handler) {
  responders.set(url, handler);
}

export function getPendingRequests(url) {
  return pending.filter((entry) => entry.url === url);
}

export function getAllPendingRequests() {
  return pending.slice();
}

// Manually resolve a pending request. Used to simulate a response that arrives
// *after* the Loader/Clip has been cancelled: the production code must drop it
// rather than write it into the cache.
export function flushRequest(entry, data) {
  entry.resolveEntry(data);
}

// Deterministic ArrayBuffer filled with a repeated byte.
export function makeBuffer(size, fill = 0xff) {
  const buffer = new ArrayBuffer(size);
  new Uint8Array(buffer).fill(fill);
  return buffer;
}

// Prefix the buffer with an MP3 frame sync word (0xFF 0xFB) plus a minimal
// MPEG1 Layer III header so durationForAudioBuffer counts a frame and the
// chunk reports a non-zero duration.
export function makeMp3LikeBuffer(size) {
  const buffer = makeBuffer(size, 0x00);
  const view = new Uint8Array(buffer);
  view[0] = 0xff;
  view[1] = 0xfb;
  view[2] = 0x70; // MPEG1, Layer III, 64 kbps
  view[3] = 0x04; // 44.1 kHz, no padding
  return buffer;
}
