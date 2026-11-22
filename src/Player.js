import Clip from './Clip';
import ClipState from './ClipState';
import Loader from './Loader';
import ProtonPlayerError from './ProtonPlayerError';
import canUseMediaSource from './utils/canUseMediaSource';
import { debug, error, warn } from './utils/logger';
import noop from './utils/noop';
import { getSilenceURL } from './utils/silence';

export default class Player {
  constructor({
    // Triggered whenever an error occurs.
    onError,

    // Triggered when the Player automatically transitions to the queued track.
    onNextTrack,

    // Triggered when there is no more queued audio to play.
    onPlaybackEnded,

    // Triggered every ~250ms while audio is playing.
    onPlaybackProgress,

    // Triggered whenever the Player seeks to the previous track.
    onPreviousTrack,

    // Triggered whenever a new track begins playing.
    onTrackChanged,

    // Triggered once when the Player is ready to begin playing audio.
    onReady,

    // Triggered whenever the volume is changed or the player is muted.
    onVolumeChanged,

    browserName,
    osName,
    volume,
  }) {
    this.browserName = browserName;
    this.osName = osName;
    this.volume = volume;
    // Only has a value when the Player is muted.
    this.previousVolume = null;

    this.onError = onError;
    this.onNextTrack = onNextTrack;
    this.onPlaybackEnded = onPlaybackEnded;
    this.onPlaybackProgress = onPlaybackProgress;
    this.onPreviousTrack = onPreviousTrack;
    this.onTrackChanged = onTrackChanged;
    this.onReady = onReady;
    this.onVolumeChanged = onVolumeChanged;
    this.ready = false;

    // Database of cached audio data and track metadata.
    this.clips = {};

    this.currentlyPlaying = null;
    this.nextTrack = null;

    // Monotonically increasing token identifying the current playback
    // request. Every new playTrack/play/jump/skip invalidates the previous
    // generation: callbacks (clip events, progress interval, late promises)
    // capture the generation they were created with and become no-ops once a
    // newer request has started. This guarantees that only the current track
    // can ever mutate Player state or surface buffer/progress/ended events.
    this._playbackGeneration = 0;

    const silenceChunkSize = 64 * 64;
    this.silenceClipState = new ClipState(silenceChunkSize);

    if (canUseMediaSource()) {
      const audioElement = document.createElement('audio');
      audioElement.autoplay = false;

      document.body.appendChild(audioElement);

      // These element-level events are asynchronous and can arrive after a
      // track switch. Each one is gated on the request that owns the *current*
      // clip so a stale waiting/canplay/ended event from the previous audio
      // pipeline can never alter the new track's buffer state.
      const withCurrentRequest = (handler) => () => {
        const current = this.currentlyPlaying;
        if (!current || this._isStale(current.generation)) return;
        handler(current);
      };

      audioElement.addEventListener(
        'ended',
        withCurrentRequest((current) => current.clip?.playbackEnded())
      );

      audioElement.addEventListener(
        'waiting',
        withCurrentRequest((current) => current.onBufferChange(true))
      );

      ['canplay', 'canplaythrough', 'playing'].forEach((eventName) => {
        audioElement.addEventListener(
          eventName,
          withCurrentRequest((current) => current.onBufferChange(false))
        );
      });
    }

    const silenceLoader = new Loader(
      silenceChunkSize,
      getSilenceURL(),
      this.silenceClipState
    );
    silenceLoader.on('loaderror', (err) => {
      this.ready = false;
      this.onError(err);
    });
    silenceLoader.on('load', () => {
      this.ready = true;
      this.onReady();
    });
    silenceLoader.buffer();
  }

  reset() {
    this.currentlyPlaying = null;
    this.nextTrack = null;

    // Any in-flight callbacks belonging to the previous session must be
    // invalidated before the clips are torn down.
    this._playbackGeneration += 1;
    this._clearIntervals();

    this.disposeAll();
  }

  // Cancels all preloading/chunk requests and releases every Clip except the
  // one matching `keepUrl` (if any). Used when a brand-new playback request
  // starts: the previous track's request chain must be fully cancelled while a
  // freshly preloaded Clip for the new track may be kept.
  _stopAndDisposeExcept(keepUrl = null) {
    this._playbackGeneration += 1;
    this._clearIntervals();

    Object.keys(this.clips).forEach((url) => {
      if (url === keepUrl) return;
      this._dispose(url);
    });
  }

  playNext(track) {
    if (!track) return;

    // Recreate rather than resurrect: if a Clip for this URL already exists
    // (e.g. a stale preload), release it first so the new preload starts from
    // a clean ClipState with no partially downloaded chunks.
    this._dispose(track.url);

    this.nextTrack = track;
    this.preLoad(
      track.url,
      track.fileSize,
      track.initialPosition,
      track.lastAllowedPosition
    );
  }

  preLoad(url, fileSize, initialPosition = 0, lastAllowedPosition = 1) {
    // TODO: allow preloading on iOS by making preloading more efficient (aka: load and process 1 chunk at a time when preloading)
    if (this.osName === 'ios') {
      return Promise.resolve();
    }

    try {
      return this._getClip(
        url,
        fileSize,
        initialPosition,
        lastAllowedPosition
      ).preBuffer();
    } catch (err) {
      this.onError(err);
      return Promise.reject(err);
    }
  }

  playTrack(track) {
    if (!track) return;

    const currentTrack = this.currentlyPlaying?.track || { url: null };

    if (track.url === currentTrack.url) {
      return this.resume();
    } else {
      const playPromise = this.__DEPRECATED__playTrack(track, track);
      this.onTrackChanged(currentTrack, track);
      return playPromise;
    }
  }

  __DEPRECATED__playTrack(
    {
      url,
      fileSize,
      onBufferChange = noop,
      onBufferProgress = noop,
      initialPosition = 0,
      lastAllowedPosition = 1,
      audioMetadata = {},
      fromSetPlaybackPosition = false,
    },
    track = null
  ) {
    if (!this.ready) {
      const message = 'Player not ready';
      warn(message);
      return Promise.reject(message);
    }

    if (
      this.currentlyPlaying &&
      this.currentlyPlaying.clip &&
      this.currentlyPlaying.url === url &&
      fromSetPlaybackPosition === false
    ) {
      debug('ProtonPlayer#play -> resume');
      return this.currentlyPlaying.clip.resume() || Promise.resolve();
    }

    onBufferProgress(0, 0);
    this.onPlaybackProgress(initialPosition);

    // Invalidate every previous request BEFORE wiring up the new one. This
    // bumps the playback generation, clears stale progress intervals, stops
    // playback and cancels in-flight chunk/preload requests, then disposes
    // every Clip except a preloaded one for the URL we are about to play.
    // Doing this first means the generation captured below is already the
    // current one, so the new request's own callbacks can never be treated as
    // stale.
    this._stopAndDisposeExcept(url);

    // This token uniquely identifies the new playback request. Every
    // asynchronous callback below closes over it and bails out once a newer
    // request has bumped the generation.
    const generation = this._playbackGeneration;

    try {
      const clip = this._getClip(
        url,
        fileSize,
        initialPosition,
        lastAllowedPosition,
        audioMetadata
      );

      this.currentlyPlaying = {
        track,
        clip,
        url,
        fileSize,
        onBufferChange,
        onBufferProgress,
        lastAllowedPosition,
        lastReportedProgress: initialPosition,
        generation,
      };

      clip.offAll();

      clip.on('loadprogress', ({ initialPosition, progress }) => {
        if (this._isStale(generation)) return;
        onBufferProgress(initialPosition, progress);
      });

      clip.once('ended', () => {
        if (this._isStale(generation)) return;

        if (this.nextTrack) {
          let nextTrack = this.nextTrack;
          let currentTrack = this.currentlyPlaying?.track;
          this.nextTrack = null;

          this.playTrack(nextTrack);
          this.onNextTrack(currentTrack, nextTrack);
        } else {
          this.stopAll();
          this.onPlaybackEnded();
        }
        this.onPlaybackProgress(1);
      });

      clip.on('bufferchange', (isBuffering) => {
        if (this._isStale(generation)) return;
        onBufferChange(isBuffering);
      });

      this._playbackPositionInterval = setInterval(() => {
        // The progress interval belongs to the request that created it: after
        // a switch it must never report the old track's position.
        if (this._isStale(generation)) return;

        const { duration, currentTime } = clip;
        if (duration === 0 || duration < currentTime) return;
        let progress = currentTime / duration;

        if (progress < 0) {
          progress = 0;
        } else if (progress > 1) {
          progress = 1; // Prevent playback progress from exceeding 1 (100%)
        }

        if (!this.currentlyPlaying) {
          return;
        }

        this.currentlyPlaying.lastReportedProgress = progress;
        this.onPlaybackProgress(progress);
      }, 250);

      return clip.play() || Promise.resolve();
    } catch (err) {
      this.onError(err);
      return Promise.reject(err.toString());
    }
  }

  // A request is stale as soon as a newer playback request has started (or the
  // Player was reset). Stale requests must not touch state or emit events.
  _isStale(generation) {
    return generation !== this._playbackGeneration;
  }

  _getClip(
    url,
    fileSize,
    initialPosition = 0,
    lastAllowedPosition = 1,
    audioMetadata = {}
  ) {
    if (typeof url !== 'string') {
      throw new ProtonPlayerError('Invalid URL');
    }

    if (typeof fileSize !== 'number') {
      throw new ProtonPlayerError('Invalid file size');
    }

    if (this.clips[url]) {
      // A released Clip must never be resurrected. Recreate it so that the
      // same URL always gets a fresh ClipState, Loader and chunk cache after
      // a dispose/replay cycle.
      if (this.clips[url].disposed) {
        delete this.clips[url];
      } else {
        return this.clips[url];
      }
    }

    const clip = new Clip({
      url,
      fileSize,
      initialPosition,
      lastAllowedPosition,
      audioMetadata,
      silenceChunks: this.silenceClipState.chunks,
      volume: this.volume,
      osName: this.osName,
      browserName: this.browserName,
      useMediaSource: canUseMediaSource(),
    });

    clip.on('loaderror', (err) => {
      error('Clip failed to load', err);
    });

    clip.on('playbackerror', (err) => {
      error('Something went wrong during playback', err);
    });

    this.clips[url] = clip;
    return clip;
  }

  stopAll() {
    this.currentlyPlaying = null;
    this._clearIntervals();

    // Stop playback and cancel in-flight requests for every Clip, but keep the
    // instances themselves in the cache. Actual release happens through
    // `_dispose`/`disposeAll`; the new playback flow additionally calls
    // `_stopAndDisposeExcept` so stale Clips cannot be reused.
    Object.keys(this.clips).forEach((k) => {
      this.clips[k].offAll();
      this.clips[k].stop();
    });
  }

  resume() {
    return this.currentlyPlaying?.clip?.resume() || Promise.reject();
  }

  pause() {
    this.currentlyPlaying?.clip?.pause();
    return Promise.resolve();
  }

  setVolume(volume = 1) {
    this.volume = volume;
    Object.keys(this.clips).forEach((k) => {
      this.clips[k].volume = this.volume;
    });
    this.onVolumeChanged(this.volume);
  }

  mute() {
    this.previousVolume = this.volume;
    this.setVolume(0);
  }

  unmute() {
    this.setVolume(this.previousVolume);
    this.previousVolume = null;
  }

  isMuted() {
    return Boolean(this.previousVolume);
  }

  currentTime() {
    if (!this.currentlyPlaying) return null;

    return this.currentlyPlaying.clip.currentTime;
  }

  seek(seconds) {
    if (!this.currentlyPlaying) return Promise.reject();

    const clip = this.currentlyPlaying.clip;
    const currentTrack = this.currentlyPlaying.track;
    const newPosition = (clip.currentTime + seconds) / clip.duration;

    if (newPosition < 0) {
      // Seeking before the start switches to the previous track. The current
      // clip is stopped by that request, so there is nothing left to reposition.
      this.stopAll();
      this.onPreviousTrack();
      return Promise.resolve();
    } else if (newPosition >= 1 && this.nextTrack) {
      const nextTrack = this.nextTrack;
      this.nextTrack = null;

      // playTrack disposes the current clip and starts a fresh request for the
      // queued track; repositioning the released clip afterwards would be
      // invalid, so the switch owns the result.
      const switchPromise = this.playTrack(nextTrack);
      this.onNextTrack(currentTrack, nextTrack);
      return switchPromise || Promise.resolve();
    }

    return clip.setCurrentPosition(newPosition);
  }

  setPlaybackPosition(percent, newLastAllowedPosition = null) {
    if (!this.currentlyPlaying || percent > 1) {
      return Promise.resolve();
    }

    this.currentlyPlaying.lastReportedProgress = percent;

    const {
      url,
      fileSize,
      onBufferChange,
      onBufferProgress,
      onPlaybackProgress,
      onPlaybackEnded,
      lastAllowedPosition,
    } = this.currentlyPlaying;

    newLastAllowedPosition = newLastAllowedPosition || lastAllowedPosition;

    const clip = this.clips[url];

    if (clip) {
      return (
        clip.setCurrentPosition(percent, newLastAllowedPosition) || Promise.resolve()
      );
    }

    const audioMetadata = clip?.audioMetadata;

    this._dispose(url);

    return this.playTrack({
      url,
      fileSize,
      onBufferChange,
      onBufferProgress,
      onPlaybackProgress,
      onPlaybackEnded,
      audioMetadata,
      initialPosition: percent,
      lastAllowedPosition: newLastAllowedPosition,
      fromSetPlaybackPosition: true,
    });
  }

  _dispose(url) {
    if (url && this.currentlyPlaying?.url === url) {
      this.currentlyPlaying = null;
      // Releasing the active Clip ends its request chain: any callback that
      // was queued before this point must be considered stale.
      this._playbackGeneration += 1;
      this._clearIntervals();
    }

    if (!this.clips[url]) return;

    // Remove every listener before disposing so no late event can escape the
    // Clip during teardown.
    this.clips[url].offAll();
    this.clips[url].dispose();
    delete this.clips[url];
  }

  disposeAll(urls = []) {
    // A full teardown invalidates every request that was ever started on this
    // Player.
    this._playbackGeneration += 1;
    this._clearIntervals();
    Object.keys(this.clips).forEach((k) => this._dispose(k));
  }

  _clearIntervals() {
    clearInterval(this._playbackPositionInterval);
  }
}
