import {
  CDGPlayer,
  HEIGHT,
  WIDTH,
  type CdgRenderContext,
} from '@cxing/media-parser-cdg';
import { createScopedLogger } from '@cxing/logger';
import {
  createLoader,
  type CdgLoader,
  LoaderError,
  type LoadedTrack,
  type LoadedTrackMediaKind,
  type LoaderInput,
  type LoaderOptions,
  loadInWorker,
} from '@cxing/media-loader';
import { createRenderer, type CdgRenderer } from './renderer.js';
import {
  createAudioEngine,
  type CdgAudioEngine,
  type PlayerAudioEngineMode,
} from './audio-engine.js';
import {
  MAX_PITCH_SEMITONES,
  MAX_SEEK_PERCENT,
  MAX_TEMPO,
  MAX_VOLUME,
  MIN_PITCH_SEMITONES,
  MIN_SEEK_PERCENT,
  MIN_TEMPO,
  MIN_VOLUME,
} from './utils/player.constants.js';
import {
  asMilliseconds,
  canElementPlayMimeType,
  clamp,
  createInitialState,
} from './utils/player.functions.js';

/** Playback lifecycle states for high-level player consumers. */
export type PlayerStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'error';

/** Snapshot of externally observable player state. */
export interface PlayerState {
  status: PlayerStatus;
  trackId: string | null;
  currentTimeMs: number;
  durationMs: number;
  volume: number;
  playbackRate: number;
  pitchSemitones: number;
}

/** Input options for load requests. */
export interface PlayerLoadOptions {
  input: LoaderInput;
  loaderOptions?: LoaderOptions;
  autoplay?: boolean;
}

/** Construction options for CdgPlayer runtime wrapper. */
export interface CdgPlayerOptions {
  canvas: HTMLCanvasElement;
  audio: HTMLAudioElement;
  video?: HTMLVideoElement;
  loader?: CdgLoader;
  debug?: boolean;
  renderMode?: 'auto' | 'main-thread' | 'worker';
  loadTransport?: 'auto' | 'main-thread' | 'worker';
  audioEngineMode?: PlayerAudioEngineMode;
}

/** Event detail payload for `statechange` events. */
export interface PlayerStateChangeDetail {
  previous: PlayerState;
  next: PlayerState;
}

type CdgCorePlayerAsyncLoad = CDGPlayer & {
  loadAsync?: (args: {
    data: Uint8Array;
    chunkPackets?: number;
    shouldAbort?: () => boolean;
  }) => Promise<CDGPlayer>;
};

/**
 * High-level karaoke player that orchestrates loading and audio playback.
 * CDG rendering/synchronization are enabled only when the loaded track includes
 * a graphics stream.
 */
export class CdgPlayer extends EventTarget {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly audio: HTMLAudioElement;
  private readonly video: HTMLVideoElement | null;
  private readonly loader: CdgLoader;
  private readonly ownsLoader: boolean;
  private readonly logger: ReturnType<typeof createScopedLogger>;
  private readonly debug: boolean;
  private readonly loadTransport: 'auto' | 'main-thread' | 'worker';
  private readonly cdgPlayer: CDGPlayer;
  private readonly renderer: CdgRenderer;
  private readonly audioEngineMode: PlayerAudioEngineMode;
  private readonly audioEnginesByMedia = new Map<
    HTMLMediaElement,
    CdgAudioEngine
  >();

  private audioEngine: CdgAudioEngine;
  private activeMedia: HTMLMediaElement;
  private activeMediaKind: LoadedTrackMediaKind = 'audio';

  private state: PlayerState = createInitialState();
  /** Object URL currently committed to the active media element. */
  private currentObjectUrl: string | null = null;
  /** Object URL created by an in-flight load that has not committed yet. */
  private pendingObjectUrl: string | null = null;
  private hasGraphicsTrack = false;

  /**
   * Monotonic token identifying the most recent load request. Any async work
   * started by an older request is discarded once this value moves on.
   */
  private loadGeneration = 0;
  private disposed = false;
  /** Callbacks that resolve in-flight media waits when their load is superseded. */
  private readonly staleLoadWaiters = new Set<() => void>();

  /**
   * Creates a player bound to canvas/audio elements and optional strategy overrides.
   */
  constructor({
    canvas,
    audio,
    video,
    loader,
    debug = false,
    renderMode = 'auto',
    loadTransport = 'auto',
    audioEngineMode = 'auto',
  }: CdgPlayerOptions) {
    super();
    this.canvas = canvas;
    this.audio = audio;
    this.video = video ?? null;
    this.debug = debug;
    this.logger = createScopedLogger({ scope: 'cdg-player', debug });
    this.loader = loader ?? createLoader({ debug });
    this.ownsLoader = !loader;
    this.loadTransport = loadTransport;
    this.audioEngineMode = audioEngineMode;
    this.activeMedia = this.audio;

    this.canvas.width = WIDTH;
    this.canvas.height = HEIGHT;

    const resolvedContext = this.canvas.getContext('2d');
    if (!resolvedContext) {
      throw new Error('Unable to create 2D context for karaoke player canvas.');
    }

    this.ctx = resolvedContext;
    this.ctx.imageSmoothingEnabled = false;

    this.renderer = createRenderer({
      mode: renderMode,
      canvas: this.canvas,
      ctx: this.ctx,
    });

    this.audioEngine = createAudioEngine({
      media: this.activeMedia,
      mode: audioEngineMode,
      debug,
    });
    this.audioEnginesByMedia.set(this.activeMedia, this.audioEngine);

    this.cdgPlayer = new CDGPlayer({
      afterRender: (renderContext: CdgRenderContext) => {
        this.renderer.render({ renderContext });
      },
    });

    this.audio.preload = 'auto';
    if (this.video) {
      this.video.preload = 'auto';
      this.video.controls = false;
      this.video.playsInline = true;
    }

    this.bindMediaListeners({ media: this.activeMedia });
  }

  /**
   * Returns immutable player state snapshot.
   */
  getState(): Readonly<PlayerState> {
    return this.state;
  }

  /**
   * Loads track assets and prepares playback for either karaoke (audio+graphics)
   * or audio-only content.
   *
   * Last request wins: when a newer `load` supersedes this one before it
   * commits, the stale result resolves with its `LoadedTrack` but is otherwise
   * discarded — no state change, no media rebinding, no `error` event.
   */
  async load({
    input,
    loaderOptions,
    autoplay = false,
  }: PlayerLoadOptions): Promise<LoadedTrack> {
    // Latest request wins: any async work from an earlier generation is
    // discarded when it completes.
    const generation = this.beginLoadGeneration();
    if (!this.disposed) {
      this.applyState({ status: 'loading' });
    }
    this.logger.debug({
      message: 'load:start',
      generation,
      inputKind: input.kind,
      loadTransport: this.loadTransport,
      autoplay,
    });

    try {
      const useWorkerLoader = this.shouldUseWorkerLoader();
      this.logger.debug({
        message: 'load:transport-selected',
        useWorkerLoader,
        loadTransport: this.loadTransport,
      });
      let loadedTrack: LoadedTrack;
      const effectiveLoaderOptions: LoaderOptions = {
        ...(loaderOptions ?? {}),
        debug: loaderOptions?.debug ?? this.debug,
      };

      if (useWorkerLoader) {
        try {
          loadedTrack = await loadInWorker({
            input,
            options: effectiveLoaderOptions,
          });
          this.logger.debug({
            message: 'load:worker-success',
            trackId: loadedTrack.trackId,
            sourceSummary: loadedTrack.sourceSummary,
          });
        } catch (errorValue: unknown) {
          this.logger.debug({ message: 'load:worker-error', errorValue });
          if (!this.shouldFallbackToMainThreadLoad({ errorValue })) {
            throw errorValue;
          }

          this.logger.debug({ message: 'load:fallback-main-thread' });

          loadedTrack = await this.loader.load({
            input,
            options: effectiveLoaderOptions,
          });
          this.logger.debug({
            message: 'load:main-thread-success-after-fallback',
            trackId: loadedTrack.trackId,
            sourceSummary: loadedTrack.sourceSummary,
          });
        }
      } else {
        loadedTrack = await this.loader.load({
          input,
          options: effectiveLoaderOptions,
        });
        this.logger.debug({
          message: 'load:main-thread-success',
          trackId: loadedTrack.trackId,
          sourceSummary: loadedTrack.sourceSummary,
        });
      }

      if (!this.isLoadCurrent({ generation })) {
        this.logger.debug({
          message: 'load:stale-result-discarded',
          generation,
          activeGeneration: this.loadGeneration,
          trackId: loadedTrack.trackId,
        });
        return loadedTrack;
      }

      const attached = await this.attachLoadedTrack({
        loadedTrack,
        generation,
      });
      if (!attached || !this.isLoadCurrent({ generation })) {
        this.logger.debug({
          message: 'load:stale-result-discarded',
          generation,
          activeGeneration: this.loadGeneration,
          trackId: loadedTrack.trackId,
          disposed: this.disposed,
        });
        return loadedTrack;
      }

      this.applyState({
        status: 'ready',
        trackId: loadedTrack.trackId,
      });

      if (autoplay && this.isLoadCurrent({ generation })) {
        await this.play();
      }

      this.logger.debug({
        message: 'load:ready',
        trackId: loadedTrack.trackId,
      });

      return loadedTrack;
    } catch (errorValue: unknown) {
      if (!this.isLoadCurrent({ generation })) {
        // A superseded/disposed load must not poison the active request.
        this.logger.debug({
          message: 'load:stale-error-ignored',
          generation,
          activeGeneration: this.loadGeneration,
          errorValue,
        });
        throw errorValue;
      }

      this.logger.error({ message: 'load:error', errorValue });
      this.applyState({ status: 'error' });
      this.dispatchEvent(new CustomEvent('error', { detail: { errorValue } }));
      throw errorValue;
    }
  }

  /**
   * Starts media playback and, when graphics exist, advances CDG frame playback.
   */
  async play(): Promise<void> {
    const generation = this.loadGeneration;
    this.logger.debug({
      message: 'play:called',
      currentTime: this.activeMedia.currentTime,
      paused: this.activeMedia.paused,
      readyState: this.activeMedia.readyState,
      src: this.activeMedia.src,
      media: this.activeMedia,
    });
    try {
      await this.audioEngine.play();
      this.logger.debug({
        message: 'play:resolved',
        currentTime: this.activeMedia.currentTime,
        paused: this.activeMedia.paused,
        readyState: this.activeMedia.readyState,
        src: this.activeMedia.src,
        media: this.activeMedia,
      });
    } catch (err) {
      this.logger.debug({ message: 'play:error', errorValue: err });
    }

    // A load may have started while playback was being requested; in that case
    // the newer request owns the observable state.
    if (!this.isLoadCurrent({ generation })) {
      return;
    }

    if (this.hasGraphicsTrack) {
      this.cdgPlayer.play();
    }
    this.applyState({ status: 'playing' });
  }

  /**
   * Pauses media playback and, when graphics exist, pauses CDG frame playback.
   */
  pause(): void {
    this.audioEngine.pause();
    if (this.hasGraphicsTrack) {
      this.cdgPlayer.stop();
    }

    if (this.state.status !== 'error') {
      this.applyState({ status: 'paused' });
    }
  }

  /**
   * Stops playback and rewinds to beginning.
   */
  stop(): void {
    this.pause();
    this.audioEngine.stop();
    if (this.hasGraphicsTrack) {
      this.cdgPlayer.reset().render();
    }
    this.applyState({
      status: this.state.trackId ? 'ready' : 'idle',
      currentTimeMs: 0,
    });
  }

  /**
   * Seeks by percentage of track duration and re-syncs CDG timing when graphics
   * are present.
   */
  seek({ percentage }: { percentage: number }): void {
    if (
      !Number.isFinite(this.activeMedia.duration) ||
      this.activeMedia.duration <= 0
    ) {
      return;
    }

    const clampedPercentage = clamp({
      value: percentage,
      min: MIN_SEEK_PERCENT,
      max: MAX_SEEK_PERCENT,
    });
    const targetSeconds = (clampedPercentage / 100) * this.activeMedia.duration;
    this.activeMedia.currentTime = targetSeconds;
    if (this.hasGraphicsTrack) {
      this.cdgPlayer.sync({ ms: asMilliseconds({ seconds: targetSeconds }) });
    }
    this.applyState({
      currentTimeMs: asMilliseconds({ seconds: targetSeconds }),
    });
  }

  /**
   * Sets playback output volume.
   */
  setVolume({ value }: { value: number }): void {
    const nextVolume = clamp({
      value,
      min: MIN_VOLUME,
      max: MAX_VOLUME,
    });
    this.audioEngine.setVolume({ value: nextVolume });
    this.applyState({ volume: nextVolume });
  }

  /**
   * Backward-compatible alias for tempo adjustment.
   */
  setPlaybackRate({ value }: { value: number }): void {
    this.setTempo({ value });
  }

  /**
   * Sets tempo multiplier.
   */
  setTempo({ value }: { value: number }): void {
    const nextTempo = clamp({
      value,
      min: MIN_TEMPO,
      max: MAX_TEMPO,
    });
    this.audioEngine.setTempo({ value: nextTempo });
    this.applyState({ playbackRate: nextTempo });
  }

  /**
   * Sets key shift in semitones.
   */
  setPitchSemitones({ value }: { value: number }): void {
    const nextPitchSemitones = Math.round(
      clamp({
        value,
        min: MIN_PITCH_SEMITONES,
        max: MAX_PITCH_SEMITONES,
      }),
    );
    this.audioEngine.setPitchSemitones({ value: nextPitchSemitones });
    this.applyState({ pitchSemitones: nextPitchSemitones });
  }

  /**
   * Releases player resources and event listeners.
   */
  dispose(): void {
    this.logger.debug({ message: 'dispose:start' });
    this.disposed = true;
    // Supersede every in-flight load so late results cannot bind media or
    // emit state notifications after teardown.
    this.invalidatePendingLoads();
    this.stop();
    this.unbindMediaListeners({ media: this.activeMedia });
    this.releaseObjectUrl();

    if (this.ownsLoader) {
      this.logger.debug({ message: 'dispose:loader' });
      this.loader.dispose();
    }

    this.logger.debug({ message: 'dispose:renderer' });
    this.renderer.dispose();
    this.logger.debug({ message: 'dispose:audioEngine' });
    for (const engine of new Set(this.audioEnginesByMedia.values())) {
      engine.dispose();
    }
    this.audioEnginesByMedia.clear();
    this.logger.debug({ message: 'dispose:done' });
  }

  /**
   * Marks a new load generation and wakes any media waits owned by older loads.
   */
  private beginLoadGeneration(): number {
    this.loadGeneration += 1;
    this.invalidatePendingLoads();
    return this.loadGeneration;
  }

  /**
   * Releases waiters that are blocked on media readiness for superseded loads.
   */
  private invalidatePendingLoads(): void {
    if (this.staleLoadWaiters.size === 0) {
      return;
    }

    const waiters = [...this.staleLoadWaiters];
    this.staleLoadWaiters.clear();
    for (const waiter of waiters) {
      waiter();
    }
  }

  private isLoadCurrent({ generation }: { generation: number }): boolean {
    return !this.disposed && generation === this.loadGeneration;
  }

  private async attachLoadedTrack({
    loadedTrack,
    generation,
  }: {
    loadedTrack: LoadedTrack;
    generation: number;
  }): Promise<boolean> {
    const resolvedMediaKind: LoadedTrackMediaKind =
      loadedTrack.mediaKind ?? 'audio';
    const resolvedMediaMimeType =
      loadedTrack.mediaMimeType ?? loadedTrack.audioMimeType;

    if (!this.isLoadCurrent({ generation })) {
      return false;
    }

    const nextMedia = this.resolveMediaElementForTrack({ loadedTrack });

    if (
      resolvedMediaKind === 'video' &&
      !canElementPlayMimeType({
        media: nextMedia,
        mimeType: resolvedMediaMimeType,
      })
    ) {
      throw new Error(
        `This browser cannot play ${resolvedMediaKind} format ${resolvedMediaMimeType}.`,
      );
    }

    const hasGraphicsTrack =
      loadedTrack.hasGraphics && loadedTrack.cdgBytes !== null;

    this.logger.debug({
      message: 'attach:start',
      trackId: loadedTrack.trackId,
      generation,
      mediaKind: resolvedMediaKind,
      mediaMimeType: resolvedMediaMimeType,
      hasGraphics: hasGraphicsTrack,
      cdgBytes: loadedTrack.cdgBytes?.byteLength ?? 0,
      audioBytes: loadedTrack.audioBuffer.byteLength,
    });

    const mediaBlob = new Blob([loadedTrack.audioBuffer], {
      type: resolvedMediaMimeType,
    });

    // The outgoing URL stays alive (and keeps playing) until the new track is
    // fully committed, so a superseded or failing load never strands it.
    const previousObjectUrl = this.currentObjectUrl;
    const previousMediaSrc = nextMedia.getAttribute('src');
    const objectUrl = URL.createObjectURL(mediaBlob);
    this.pendingObjectUrl = objectUrl;

    const discardPending = (): void => {
      this.releaseRejectedObjectUrl({
        url: objectUrl,
        previousUrl: previousObjectUrl,
        media: nextMedia,
        previousMediaSrc,
      });
    };

    if (!this.isLoadCurrent({ generation })) {
      discardPending();
      return false;
    }

    nextMedia.pause();
    nextMedia.src = objectUrl;
    nextMedia.load();

    if (resolvedMediaKind === 'video') {
      let ready: boolean;
      try {
        ready = await this.waitForMediaCanPlay({
          media: nextMedia,
          mediaKind: resolvedMediaKind,
        });
      } catch (errorValue) {
        discardPending();
        throw errorValue;
      }

      if (!ready) {
        discardPending();
        return false;
      }
    }

    // Graphics are parsed last: the async parse polls the generation and bails
    // out without touching the live instruction stream if superseded.
    if (hasGraphicsTrack && loadedTrack.cdgBytes) {
      const corePlayer = this.cdgPlayer as CdgCorePlayerAsyncLoad;
      if (typeof corePlayer.loadAsync === 'function') {
        this.logger.debug({ message: 'attach:core-loadAsync' });
        await corePlayer.loadAsync({
          data: loadedTrack.cdgBytes,
          shouldAbort: () => !this.isLoadCurrent({ generation }),
        });
      } else {
        this.logger.debug({ message: 'attach:core-load-sync' });
        this.cdgPlayer.load({ data: loadedTrack.cdgBytes });
      }
    }

    if (!this.isLoadCurrent({ generation })) {
      this.logger.debug({
        message: 'attach:stale-aborted',
        generation,
        activeGeneration: this.loadGeneration,
        disposed: this.disposed,
      });
      discardPending();
      return false;
    }

    // Past this point the load is committed; only now may observable state move.
    this.pendingObjectUrl = null;
    this.currentObjectUrl = objectUrl;
    this.activeMediaKind = resolvedMediaKind;
    this.hasGraphicsTrack = hasGraphicsTrack;

    if (this.activeMedia !== nextMedia) {
      this.unbindMediaListeners({ media: this.activeMedia });
      this.activeMedia.pause();
      this.activeMedia = nextMedia;

      const cachedEngine = this.audioEnginesByMedia.get(this.activeMedia);
      if (cachedEngine) {
        this.audioEngine = cachedEngine;
        this.logger.debug({
          message: 'audioEngine:reused',
          mode: this.audioEngine.mode,
          media: this.activeMedia,
        });
      } else {
        this.logger.debug({
          message: 'audioEngine:create',
          media: this.activeMedia,
        });
        this.audioEngine = createAudioEngine({
          media: this.activeMedia,
          mode: this.audioEngineMode,
          debug: this.debug,
        });
        this.audioEnginesByMedia.set(this.activeMedia, this.audioEngine);
        this.logger.debug({
          message: 'audioEngine:created',
          mode: this.audioEngine.mode,
          media: this.activeMedia,
        });
      }

      this.logger.debug({
        message: 'attachLoadedTrack:active-media-switched',
        src: this.activeMedia.src,
        paused: this.activeMedia.paused,
        readyState: this.activeMedia.readyState,
        media: this.activeMedia,
      });

      this.bindMediaListeners({ media: this.activeMedia });
      this.logger.debug({
        message: 'bindMediaListeners',
        media: this.activeMedia,
      });
    }

    // Only ever one stage element should carry a source. Clear the element that
    // is not driving this track so a stale URL/stream cannot keep decoding.
    if (resolvedMediaKind === 'video') {
      this.deactivateMediaElement({ media: this.audio });
    } else {
      this.deactivateMediaElement({ media: this.video });
    }

    // Re-apply user-facing settings to the engine that is now in charge. A new
    // track must not inherit the previous media element's volume/rate/key.
    this.applyCurrentAudioSettings();

    this.cdgPlayer.reset().render();

    // The new track is fully bound; the outgoing URL is now safe to revoke.
    if (previousObjectUrl && previousObjectUrl !== objectUrl) {
      this.revokeObjectUrl({ url: previousObjectUrl });
    }

    this.logger.debug({
      message: 'attach:media-bound',
      mediaKind: this.activeMediaKind,
      objectUrl: this.currentObjectUrl,
    });

    return true;
  }

  /**
   * Applies the persisted player controls to the currently active audio engine.
   */
  private applyCurrentAudioSettings(): void {
    this.audioEngine.setVolume({ value: this.state.volume });
    this.audioEngine.setTempo({ value: this.state.playbackRate });
    this.audioEngine.setPitchSemitones({ value: this.state.pitchSemitones });
  }

  /**
   * Pauses a media element and drops its source so it stops decoding.
   */
  private deactivateMediaElement({
    media,
  }: {
    media: HTMLMediaElement | null;
  }): void {
    if (!media) {
      return;
    }

    media.pause();
    media.removeAttribute('src');
    media.load();
  }

  /**
   * Revokes an object URL produced by a load that never became active and
   * restores the media element's previous source, so the committed track stays
   * playable. Also clears the pending-URL slot when it still points at `url`.
   */
  private releaseRejectedObjectUrl({
    url,
    previousUrl,
    media,
    previousMediaSrc,
  }: {
    url: string;
    previousUrl: string | null;
    media: HTMLMediaElement;
    previousMediaSrc: string | null;
  }): void {
    if (this.pendingObjectUrl === url) {
      this.pendingObjectUrl = null;
    }

    const boundUrl = media.getAttribute('src');
    if (boundUrl === url || media.src === url) {
      // Only restore a source that is still the committed URL; anything else
      // (a stale or already-revoked URL) is cleared rather than re-bound.
      if (
        previousMediaSrc &&
        previousUrl &&
        previousMediaSrc === previousUrl &&
        !this.disposed
      ) {
        media.src = previousMediaSrc;
        media.load();
      } else {
        media.pause();
        media.removeAttribute('src');
        media.load();
      }
    }

    this.revokeObjectUrl({ url });

    // Nothing survives teardown: drop the previously committed URL too.
    if (this.disposed && previousUrl) {
      this.revokeObjectUrl({ url: previousUrl });
      if (this.currentObjectUrl === previousUrl) {
        this.currentObjectUrl = null;
      }
    }

    this.logger.debug({
      message: 'attach:rejected-object-url-released',
      objectUrl: url,
      committedUrl: this.currentObjectUrl,
      previousUrl,
    });
  }

  /**
   * Revokes an object URL. Revoking an already-revoked URL is a no-op, so no
   * bookkeeping set is needed and no URL reference is retained beyond use.
   */
  private revokeObjectUrl({ url }: { url: string }): void {
    URL.revokeObjectURL(url);
  }

  private releaseObjectUrl(): void {
    if (this.pendingObjectUrl) {
      this.revokeObjectUrl({ url: this.pendingObjectUrl });
      this.pendingObjectUrl = null;
    }

    if (!this.currentObjectUrl) {
      return;
    }

    this.revokeObjectUrl({ url: this.currentObjectUrl });
    this.currentObjectUrl = null;
  }

  private resolveMediaElementForTrack({
    loadedTrack,
  }: {
    loadedTrack: LoadedTrack;
  }): HTMLMediaElement {
    const resolvedMediaKind: LoadedTrackMediaKind =
      loadedTrack.mediaKind ?? 'audio';

    if (resolvedMediaKind === 'video') {
      if (!this.video) {
        throw new Error(
          'Loaded video media but no video element was provided to the player.',
        );
      }

      return this.video;
    }

    return this.audio;
  }

  private async waitForMediaCanPlay({
    media,
    mediaKind,
  }: {
    media: HTMLMediaElement;
    mediaKind: LoadedTrackMediaKind;
  }): Promise<boolean> {
    if (mediaKind === 'video' && media instanceof HTMLVideoElement) {
      const metadataReady = await this.waitForVideoMetadata({
        video: media,
      });
      if (!metadataReady) {
        return false;
      }

      if (media.videoWidth <= 0 || media.videoHeight <= 0) {
        throw new Error('Video track could not be decoded by this browser.');
      }
    }

    if (media.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      return true;
    }

    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const finish = ({ ready }: { ready: boolean }): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(ready);
      };

      const onCanPlay = (): void => {
        finish({ ready: true });
      };

      const onError = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(new Error(`Unable to load ${mediaKind} media in this browser.`));
      };

      const cleanup = (): void => {
        this.staleLoadWaiters.delete(onAborted);
        media.removeEventListener('canplay', onCanPlay);
        media.removeEventListener('error', onError);
      };

      // Superseded loads unblock immediately instead of hanging on media that
      // will never be the active source.
      const onAborted = (): void => {
        finish({ ready: false });
      };

      this.staleLoadWaiters.add(onAborted);
      media.addEventListener('canplay', onCanPlay, { once: true });
      media.addEventListener('error', onError, { once: true });
    });
  }

  private async waitForVideoMetadata({
    video,
  }: {
    video: HTMLVideoElement;
  }): Promise<boolean> {
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      return true;
    }

    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const finish = ({ ready }: { ready: boolean }): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(ready);
      };

      const onLoadedMetadata = (): void => {
        finish({ ready: true });
      };

      const onError = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(new Error('Unable to read video metadata in this browser.'));
      };

      const cleanup = (): void => {
        this.staleLoadWaiters.delete(onAborted);
        video.removeEventListener('loadedmetadata', onLoadedMetadata);
        video.removeEventListener('error', onError);
      };

      const onAborted = (): void => {
        finish({ ready: false });
      };

      this.staleLoadWaiters.add(onAborted);
      video.addEventListener('loadedmetadata', onLoadedMetadata, {
        once: true,
      });
      video.addEventListener('error', onError, { once: true });
    });
  }

  private bindMediaListeners({ media }: { media: HTMLMediaElement }): void {
    this.logger.debug({ message: 'bindMediaListeners', media });
    media.addEventListener('timeupdate', this.handleTimeUpdate);
    media.addEventListener('play', this.handlePlay);
    media.addEventListener('pause', this.handlePause);
    media.addEventListener('ended', this.handleEnded);
    this.logger.debug({
      message: 'bindMediaListeners:attached',
      listeners: ['timeupdate', 'play', 'pause', 'ended'],
      media,
    });
  }

  private unbindMediaListeners({ media }: { media: HTMLMediaElement }): void {
    this.logger.debug({ message: 'unbindMediaListeners', media });
    media.removeEventListener('timeupdate', this.handleTimeUpdate);
    media.removeEventListener('play', this.handlePlay);
    media.removeEventListener('pause', this.handlePause);
    media.removeEventListener('ended', this.handleEnded);
    this.logger.debug({
      message: 'unbindMediaListeners:detached',
      listeners: ['timeupdate', 'play', 'pause', 'ended'],
      media,
    });
  }

  private shouldUseWorkerLoader(): boolean {
    if (this.loadTransport === 'main-thread') {
      return false;
    }

    if (this.loadTransport === 'worker') {
      return true;
    }

    if (!this.ownsLoader) {
      return false;
    }

    return typeof Worker === 'function';
  }

  private shouldFallbackToMainThreadLoad({
    errorValue,
  }: {
    errorValue: unknown;
  }): boolean {
    if (this.loadTransport !== 'auto' || !this.ownsLoader) {
      return false;
    }

    if (!(errorValue instanceof LoaderError)) {
      return true;
    }

    const loaderError = errorValue as LoaderError;
    return loaderError.code === 'INTERNAL' || loaderError.code === 'ABORTED';
  }

  private applyState(nextStatePatch: Partial<PlayerState>): void {
    if (this.disposed) {
      // Once torn down, no further state notifications may escape.
      return;
    }

    const previous = this.state;
    const next = { ...previous, ...nextStatePatch };
    this.state = next;

    // `statechange` is the primary external state notification contract.
    this.dispatchEvent(
      new CustomEvent<PlayerStateChangeDetail>('statechange', {
        detail: {
          previous,
          next,
        },
      }),
    );
  }

  private handleTimeUpdate = (): void => {
    if (this.shouldIgnoreMediaEvents()) {
      return;
    }
    const timeMs = asMilliseconds({ seconds: this.activeMedia.currentTime });
    const durationMs = asMilliseconds({ seconds: this.activeMedia.duration });
    // Audio timeline is always tracked; CDG sync is only needed when graphics exist.
    if (this.hasGraphicsTrack) {
      this.cdgPlayer.sync({ ms: timeMs });
    }
    this.applyState({ currentTimeMs: timeMs, durationMs });
  };

  private handlePlay = (): void => {
    if (this.shouldIgnoreMediaEvents()) {
      return;
    }
    this.logger.debug({
      message: 'handlePlay',
      currentTime: this.activeMedia.currentTime,
      media: this.activeMedia,
    });
    if (this.hasGraphicsTrack) {
      this.cdgPlayer.play();
    }
    this.applyState({ status: 'playing' });
  };

  private handlePause = (): void => {
    if (this.shouldIgnoreMediaEvents()) {
      return;
    }
    this.logger.debug({
      message: 'handlePause',
      currentTime: this.activeMedia.currentTime,
      media: this.activeMedia,
    });
    if (this.hasGraphicsTrack) {
      this.cdgPlayer.stop();
    }
    if (this.state.status !== 'error' && this.state.status !== 'idle') {
      this.applyState({ status: 'paused' });
    }
  };

  private handleEnded = (): void => {
    if (this.shouldIgnoreMediaEvents()) {
      return;
    }
    this.logger.debug({
      message: 'handleEnded',
      currentTime: this.activeMedia.currentTime,
      media: this.activeMedia,
    });
    if (this.hasGraphicsTrack) {
      this.cdgPlayer.stop();
    }
    this.applyState({ status: 'ready', currentTimeMs: 0 });
  };

  /**
   * Media element events raised while a load is rebinding sources (or after
   * teardown) describe lifecycle bookkeeping, not user playback intent.
   */
  private shouldIgnoreMediaEvents(): boolean {
    return this.disposed || this.state.status === 'loading';
  }
}

/**
 * Factory helper for constructing a CdgPlayer from named options.
 */
export const createPlayer = ({
  options,
}: {
  options: CdgPlayerOptions;
}): CdgPlayer => new CdgPlayer(options);
