// Shared construction helpers for Player/ProtonPlayer tests.

import Player from '../../src/Player';
import ProtonPlayer from '../../src/ProtonPlayer';
import noop from '../../src/utils/noop';
import { getSilenceURL, getRawSilenceBuffer } from '../../src/utils/silence';
import { setResponder } from './axiosStub';

export const defaultCallbacks = () => ({
  onError: noop,
  onNextTrack: noop,
  onPlaybackEnded: noop,
  onPlaybackProgress: noop,
  onPreviousTrack: noop,
  onTrackChanged: noop,
  onReady: noop,
  onVolumeChanged: noop,
});

export function createPlayer(overrides = {}) {
  // The constructor immediately buffers a silence Clip from a blob: URL.
  // Serve the real embedded silence bytes so the readiness Loader can finish.
  const silenceURL = getSilenceURL();
  setResponder(silenceURL, () => getRawSilenceBuffer());

  const player = new Player({
    ...defaultCallbacks(),
    browserName: 'chrome',
    osName: 'windows',
    volume: 1,
    ...overrides,
  });

  // The constructor kicks off a silence Loader whose readiness flips `ready`.
  // With the axios stub installed, silence is served from a blob: URL. Give the
  // microtask queue a chance to settle.
  return markReady(player);
}

// The silence preload resolves on the next tick(s); wait until `player.ready`.
export function markReady(player, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    if (player.ready) {
      resolve(player);
      return;
    }
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (player.ready) {
        clearInterval(timer);
        resolve(player);
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error('Player did not become ready in time'));
      }
    }, 5);
  });
}

export function createProtonPlayer() {
  return new ProtonPlayer({ volume: 1 });
}

export const track = (url, fileSize, extra = {}) => ({
  url,
  fileSize,
  initialPosition: 0,
  lastAllowedPosition: 1,
  ...extra,
});

// Resolve after the given number of milliseconds.
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Flush microtasks and a couple of timer ticks so promise chains / setTimeout
// retries inside Loader and Clip have a chance to run.
export const flushTimers = (ticks = 3) =>
  Array.from({ length: ticks }).reduce((p) => p.then(() => delay(1)), Promise.resolve());
