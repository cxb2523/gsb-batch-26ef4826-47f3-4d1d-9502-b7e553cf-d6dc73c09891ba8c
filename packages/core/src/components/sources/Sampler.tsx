import React, { useEffect, useState, useRef, ReactNode, useImperativeHandle } from 'react';
import { useAudioContext } from '../../context/AudioContext';
import { ModStreamRef } from '../../types/ModStream';
import { useControlledState } from '../../hooks/useControlledState';
import { samplerWorklets } from '../../worklets';

const samplerWorkletLoaders = new WeakMap<AudioContext, Promise<void>>();
const samplerWorkletUrls = new WeakMap<AudioContext, string>();

const loadSamplerWorklets = (audioContext: AudioContext) => {
  let loader = samplerWorkletLoaders.get(audioContext);
  if (!loader) {
    const blob = new Blob([samplerWorklets], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    samplerWorkletUrls.set(audioContext, url);
    loader = audioContext.audioWorklet.addModule(url).then(() => {
      const loadedUrl = samplerWorkletUrls.get(audioContext);
      if (loadedUrl) {
        URL.revokeObjectURL(loadedUrl);
        samplerWorkletUrls.delete(audioContext);
      }
    }).catch((err) => {
      const loadedUrl = samplerWorkletUrls.get(audioContext);
      if (loadedUrl) {
        URL.revokeObjectURL(loadedUrl);
        samplerWorkletUrls.delete(audioContext);
      }
      samplerWorkletLoaders.delete(audioContext);
      throw err;
    });
    samplerWorkletLoaders.set(audioContext, loader);
  }
  return loader;
};

export type PlaybackMode = 'one-shot' | 'gate' | 'loop';

interface SamplingSession {
  id: number;
  src: string;
  element: HTMLAudioElement;
  sourceNode: MediaElementAudioSourceNode;
  listeners: Array<{ type: string; handler: EventListener }>;
  /** True once play() has been requested and before a pause/ended/error event. */
  playRequested: boolean;
  disposed: boolean;
}

export interface SamplerHandle {
  trigger: () => void;
  stop: () => void;
  loadFile: (file: File) => void;
  getState: () => {
    src: string;
    fileName: string;
    gain: number;
    playbackMode: PlaybackMode;
    startTime: number;
    endTime: number;
    pitch: number;
    isPlaying: boolean;
    isReady: boolean;
    currentTime: number;
    duration: number;
    error: string | null;
  };
}

export interface SamplerRenderProps {
  src: string;
  setSrc: (src: string) => void;
  fileName: string;
  setFileName: (name: string) => void;
  loadFile: (file: File) => void;
  gain: number;
  setGain: (value: number) => void;
  playbackMode: PlaybackMode;
  setPlaybackMode: (value: PlaybackMode) => void;
  startTime: number;
  setStartTime: (value: number) => void;
  endTime: number;
  setEndTime: (value: number) => void;
  pitch: number;
  setPitch: (value: number) => void;
  isPlaying: boolean;
  trigger: () => void;
  stop: () => void;
  currentTime: number;
  duration: number;
  sampleRate: number;
  isActive: boolean;
  isReady: boolean;
  error: string | null;
}

export interface SamplerProps {
  output: ModStreamRef;
  /** Gate/trigger input - rising edge triggers playback */
  gate?: ModStreamRef;
  /** Pitch CV input - modulates playback rate in semitones */
  pitchCv?: ModStreamRef;
  label?: string;
  enabled?: boolean;
  // Controlled props
  src?: string;
  onSrcChange?: (src: string) => void;
  fileName?: string;
  onFileNameChange?: (name: string) => void;
  gain?: number;
  onGainChange?: (gain: number) => void;
  /** Playback mode: 'one-shot' plays once, 'gate' plays while gate is high, 'loop' loops while gate is high */
  playbackMode?: PlaybackMode;
  onPlaybackModeChange?: (mode: PlaybackMode) => void;
  /** Start time in seconds for sample region */
  startTime?: number;
  onStartTimeChange?: (time: number) => void;
  /** End time in seconds for sample region (0 = end of file) */
  endTime?: number;
  onEndTimeChange?: (time: number) => void;
  /** Base pitch offset in octaves */
  pitch?: number;
  onPitchChange?: (pitch: number) => void;
  // Event callbacks
  onPlayingChange?: (isPlaying: boolean) => void;
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  onError?: (error: string | null) => void;
  onEnd?: () => void;
  // Render props
  children?: (props: SamplerRenderProps) => ReactNode;
}

export const Sampler = React.forwardRef<SamplerHandle, SamplerProps>(({
  output,
  gate: gateInput,
  pitchCv,
  label = 'sampler',
  enabled = true,
  src: controlledSrc,
  onSrcChange,
  fileName: controlledFileName,
  onFileNameChange,
  gain: controlledGain,
  onGainChange,
  playbackMode: controlledPlaybackMode,
  onPlaybackModeChange,
  startTime: controlledStartTime,
  onStartTimeChange,
  endTime: controlledEndTime,
  onEndTimeChange,
  pitch: controlledPitch,
  onPitchChange,
  onPlayingChange,
  onTimeUpdate,
  onError,
  onEnd,
  children,
}, ref) => {
  const audioContext = useAudioContext();
  const [src, setSrc] = useControlledState(controlledSrc, '', onSrcChange);
  const [fileName, setFileName] = useControlledState(controlledFileName, '', onFileNameChange);
  const [gain, setGain] = useControlledState(controlledGain, 1.0, onGainChange);
  const [playbackMode, setPlaybackMode] = useControlledState<PlaybackMode>(
    controlledPlaybackMode,
    'one-shot',
    onPlaybackModeChange
  );
  const [startTime, setStartTime] = useControlledState(controlledStartTime, 0, onStartTimeChange);
  const [endTime, setEndTime] = useControlledState(controlledEndTime, 0, onEndTimeChange);
  const [pitch, setPitch] = useControlledState(controlledPitch, 0.0, onPitchChange);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isWorkletReady, setIsWorkletReady] = useState(false);

  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const pitchCvNodeRef = useRef<AudioWorkletNode | null>(null);
  const gateNodeRef = useRef<AudioWorkletNode | null>(null);
  const pitchCvValueRef = useRef(0);
  const gateStateRef = useRef(false);
  const pitchRef = useRef(pitch);
  const gainRef = useRef(gain);
  const enabledRef = useRef(enabled);
  const playbackModeRef = useRef<PlaybackMode>(playbackMode);
  const startTimeRef = useRef(startTime);
  const endTimeRef = useRef(endTime);
  const durationRef = useRef(0);
  const pendingAutoplayRef = useRef(false);
  const unlockListenerRef = useRef<(() => void) | null>(null);
  const stopTimeoutRef = useRef<number | null>(null);
  const playRetryRef = useRef<number | null>(null);
  const onEndRef = useRef(onEnd);

  // Session bookkeeping. Every src change increments the id; async work (timers,
  // event handlers, worklet callbacks) checks ownership before touching audio.
  const sessionIdRef = useRef(0);
  const activeSessionRef = useRef<SamplingSession | null>(null);
  // Blob URLs created by this component (via loadFile) and blob URLs that are
  // currently used by a live session. A URL is revoked only when it was created
  // here and no live session (including a brand new one) still uses it.
  const createdBlobUrlsRef = useRef<Set<string>>(new Set());
  const liveBlobUrlsRef = useRef<Set<string>>(new Set());

  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
  const FADE_IN_TIME = 0.001;
  const FADE_OUT_TIME = 0.045;

  useEffect(() => {
    onEndRef.current = onEnd;
  }, [onEnd]);

  const cancelGainAutomation = (param: AudioParam, now: number) => {
    const withHold = param as AudioParam & { cancelAndHoldAtTime?: (time: number) => void };
    if (typeof withHold.cancelAndHoldAtTime === 'function') {
      try {
        withHold.cancelAndHoldAtTime(now);
        return;
      } catch {
        // Fall through to cancelScheduledValues
      }
    }
    param.cancelScheduledValues(now);
  };

  const restoreGain = () => {
    if (!audioContext || !gainNodeRef.current) return;
    const now = audioContext.currentTime;
    const param = gainNodeRef.current.gain;
    cancelGainAutomation(param, now);
    param.setValueAtTime(gainRef.current, now);
  };

  const fadeGainTo = (target: number, fadeTime: number) => {
    if (!audioContext || !gainNodeRef.current) return;
    const now = audioContext.currentTime;
    const param = gainNodeRef.current.gain;
    cancelGainAutomation(param, now);
    param.setValueAtTime(param.value, now);
    param.setTargetAtTime(target, now, Math.max(0.001, fadeTime / 3));
  };

  const fadeIn = () => {
    fadeGainTo(gainRef.current, FADE_IN_TIME);
  };

  const clearPlaybackTimers = () => {
    if (stopTimeoutRef.current !== null) {
      clearTimeout(stopTimeoutRef.current);
      stopTimeoutRef.current = null;
    }
    if (playRetryRef.current !== null) {
      clearTimeout(playRetryRef.current);
      playRetryRef.current = null;
    }
  };

  const resetPlaybackState = () => {
    durationRef.current = 0;
    setIsReady(false);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setError(null);
  };

  const releaseSessionBlobUrl = (url: string) => {
    if (!url.startsWith('blob:')) return;
    // Defer so a session created for the same URL in the same commit can claim
    // it first. Only URLs created by this component are ever revoked.
    queueMicrotask(() => {
      if (liveBlobUrlsRef.current.has(url)) return;
      if (!createdBlobUrlsRef.current.has(url)) return;
      createdBlobUrlsRef.current.delete(url);
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    });
  };

  const teardownSession = () => {
    const session = activeSessionRef.current;
    if (!session) return;
    activeSessionRef.current = null;
    session.disposed = true;
    const hadStopFade = stopTimeoutRef.current !== null;
    clearPlaybackTimers();

    session.listeners.forEach(({ type, handler }) => {
      try {
        session.element.removeEventListener(type, handler);
      } catch {
        // ignore
      }
    });
    try {
      session.element.pause();
    } catch {
      // ignore
    }
    try {
      if (typeof session.element.removeAttribute === 'function') {
        session.element.removeAttribute('src');
      } else {
        session.element.src = '';
      }
    } catch {
      // ignore
    }
    try {
      session.element.load();
    } catch {
      // ignore
    }
    try {
      session.sourceNode.disconnect();
    } catch {
      // Already disconnected
    }

    if (audioElementRef.current === session.element) {
      audioElementRef.current = null;
    }
    if (sourceNodeRef.current === session.sourceNode) {
      sourceNodeRef.current = null;
    }
    if (session.src.startsWith('blob:')) {
      liveBlobUrlsRef.current.delete(session.src);
      releaseSessionBlobUrl(session.src);
    }

    // A fade-out from this session must not leave the (shared) gain node at 0
    // or leak into the next session.
    if (hadStopFade) {
      restoreGain();
    }
  };

  const stopWithFade = (resetToStart: boolean) => {
    const session = activeSessionRef.current;
    if (!session) return;
    if (!audioContext || !gainNodeRef.current) {
      session.element.pause();
      if (resetToStart) seekToStart();
      return;
    }
    if (stopTimeoutRef.current !== null) {
      clearTimeout(stopTimeoutRef.current);
      stopTimeoutRef.current = null;
    }
    fadeGainTo(0, FADE_OUT_TIME);
    stopTimeoutRef.current = window.setTimeout(() => {
      stopTimeoutRef.current = null;
      // If the source changed while fading, this callback belongs to an old
      // session and must not pause or rewind the new element.
      if (activeSessionRef.current !== session || session.disposed) return;
      session.element.pause();
      session.playRequested = false;
      if (resetToStart) seekToStart();
      // Converge on the *current* gain setting rather than the one captured
      // when stop() was called.
      restoreGain();
    }, FADE_OUT_TIME * 1000);
  };

  const ensureUserGesturePlayback = () => {
    if (unlockListenerRef.current) return;
    const onUnlock = async () => {
      unlockListenerRef.current = null;
      window.removeEventListener('pointerdown', onUnlock);
      window.removeEventListener('keydown', onUnlock);
      if (!pendingAutoplayRef.current) return;
      pendingAutoplayRef.current = false;
      if (!audioContext) return;
      try {
        await audioContext.resume();
      } catch {
        return;
      }
      const mode = playbackModeRef.current;
      if ((mode === 'gate' || mode === 'loop') && !gateStateRef.current) return;
      if (!activeSessionRef.current) return;
      void triggerPlayback();
    };
    unlockListenerRef.current = onUnlock;
    window.addEventListener('pointerdown', onUnlock);
    window.addEventListener('keydown', onUnlock);
  };

  const handleAutoplayBlocked = () => {
    pendingAutoplayRef.current = true;
    setError(null);
    ensureUserGesturePlayback();
  };

  const isAutoplayError = (err: unknown) => {
    if (pendingAutoplayRef.current) return true;
    if (audioContext && audioContext.state !== 'running') return true;
    if ((err as Error)?.name === 'NotAllowedError') return true;
    const message = typeof (err as Error)?.message === 'string' ? (err as Error).message.toLowerCase() : '';
    return message.includes('user interaction') || message.includes('gesture') || message.includes('notallowed');
  };

  const isAbortPlayError = (err: unknown) => (err as Error)?.name === 'AbortError';

  /**
   * Effective playback region. An explicit end that is not greater than the
   * start is treated as "no end boundary" so playback keeps working instead of
   * spinning on an impossible loop.
   */
  const getEffectiveRegion = () => {
    const dur = Number.isFinite(durationRef.current) ? Math.max(0, durationRef.current) : 0;
    if (dur <= 0) return { start: 0, end: 0 };
    const rawStart = Number.isFinite(startTimeRef.current) ? startTimeRef.current : 0;
    const start = clamp(rawStart, 0, dur);
    const rawEnd = Number.isFinite(endTimeRef.current) && endTimeRef.current > 0
      ? endTimeRef.current
      : dur;
    let end = clamp(rawEnd, 0, dur);
    if (end <= start) {
      // Invalid region (end <= start): fall back to playing to the end of the
      // file instead of looping over a zero/negative span.
      end = dur > start ? dur : start;
    }
    return { start, end };
  };

  const updatePlaybackRate = () => {
    if (!audioElementRef.current) return;
    const cvValue = Number.isFinite(pitchCvValueRef.current) ? pitchCvValueRef.current : 0;
    const semitones = clamp(cvValue, -24, 24);
    const baseOctaves = Number.isFinite(pitchRef.current) ? pitchRef.current : 0;
    const targetRate = Math.pow(2, baseOctaves + semitones / 12);
    const rate = clamp(targetRate, 0.25, 4);
    const element = audioElementRef.current;
    try {
      element.playbackRate = rate;
      element.defaultPlaybackRate = rate;
    } catch (err) {
      const errorName = (err as Error | null)?.name;
      if (errorName !== 'NotSupportedError') {
        throw err;
      }
    }
    if ('preservesPitch' in element) {
      element.preservesPitch = false;
    }
    if ('mozPreservesPitch' in element) {
      (element as unknown as { mozPreservesPitch: boolean }).mozPreservesPitch = false;
    }
    if ('webkitPreservesPitch' in element) {
      (element as unknown as { webkitPreservesPitch: boolean }).webkitPreservesPitch = false;
    }
  };

  const seekToStart = () => {
    if (!audioElementRef.current) return;
    audioElementRef.current.currentTime = getEffectiveRegion().start;
  };

  const stopAtStart = () => {
    if (!audioElementRef.current) return;
    stopWithFade(true);
  };

  const play = async () => {
    const session = activeSessionRef.current;
    if (!session || !audioContext) return;
    if (stopTimeoutRef.current !== null) {
      clearTimeout(stopTimeoutRef.current);
      stopTimeoutRef.current = null;
    }
    // A new play request supersedes any queued abort retry.
    if (playRetryRef.current !== null) {
      clearTimeout(playRetryRef.current);
      playRetryRef.current = null;
    }
    fadeIn();
    if (audioContext.state !== 'running') {
      try {
        await audioContext.resume();
      } catch {
        handleAutoplayBlocked();
        return;
      }
    }
    if (activeSessionRef.current !== session || session.disposed) return;
    const isRunning = audioContext.state === 'running';
    if (!isRunning) {
      handleAutoplayBlocked();
      return;
    }
    if (session.element.currentTime < getEffectiveRegion().start) {
      seekToStart();
    }
    session.playRequested = true;
    session.element.play().catch((err) => {
      if (activeSessionRef.current !== session || session.disposed) return;
      session.playRequested = false;
      if (isAutoplayError(err)) {
        handleAutoplayBlocked();
        return;
      }
      if (isAbortPlayError(err)) {
        if (playRetryRef.current !== null) {
          return;
        }
        playRetryRef.current = window.setTimeout(() => {
          playRetryRef.current = null;
          // The retry belongs to the session that scheduled it.
          if (activeSessionRef.current !== session || session.disposed) return;
          session.playRequested = true;
          session.element.play().catch((retryErr) => {
            if (activeSessionRef.current !== session || session.disposed) return;
            session.playRequested = false;
            if (isAutoplayError(retryErr)) {
              handleAutoplayBlocked();
              return;
            }
            if (isAbortPlayError(retryErr)) {
              return;
            }
            setError('Playback failed. User interaction may be required.');
          });
        }, 0);
        return;
      }
      setError('Playback failed. User interaction may be required.');
    });
  };

  const triggerPlayback = async () => {
    const session = activeSessionRef.current;
    if (!session || !enabledRef.current) return;
    if (stopTimeoutRef.current !== null) {
      clearTimeout(stopTimeoutRef.current);
      stopTimeoutRef.current = null;
    }
    if (audioContext && audioContext.state !== 'running') {
      handleAutoplayBlocked();
      return;
    }
    seekToStart();
    await play();
  };

  // In gate/loop mode, a freshly loaded sample should resume only when the
  // gate is actually high (e.g. after a src swap under a held gate).
  const maybeAutoplayIfGateAllows = (session: SamplingSession) => {
    if (activeSessionRef.current !== session || session.disposed) return;
    if (!enabledRef.current) return;
    const mode = playbackModeRef.current;
    if (mode !== 'gate' && mode !== 'loop') return;
    if (!gateStateRef.current) return;
    if (session.playRequested || !session.element.paused) return;
    void triggerPlayback();
  };

  useEffect(() => {
    pitchRef.current = pitch;
    updatePlaybackRate();
  }, [pitch]);

  useEffect(() => {
    startTimeRef.current = startTime;
  }, [startTime]);

  useEffect(() => {
    endTimeRef.current = endTime;
  }, [endTime]);

  useEffect(() => {
    gainRef.current = gain;
  }, [gain]);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  // Create output gain once (stable connection for Monitor)
  useEffect(() => {
    if (!audioContext) return;

    const gainNode = audioContext.createGain();
    gainNode.gain.value = gainRef.current;
    gainNodeRef.current = gainNode;

    // Set output ref with stable gain node
    output.current = {
      audioNode: gainNode,
      gain: gainNode,
      context: audioContext,
      metadata: {
        label,
        sourceType: 'sampler',
      },
    };

    return () => {
      gainNode.disconnect();
      output.current = null;
      gainNodeRef.current = null;
    };
  }, [audioContext, label]);

  // Each src change is a brand new playback session.
  useEffect(() => {
    sessionIdRef.current += 1;
    const sessionId = sessionIdRef.current;

    // Cancel anything the previous session left behind (fade/retry timers,
    // audio element listeners, loop watcher via isPlaying reset below).
    if (activeSessionRef.current) {
      teardownSession();
    }
    clearPlaybackTimers();
    resetPlaybackState();

    if (!audioContext || !gainNodeRef.current || !src) {
      audioElementRef.current = null;
      sourceNodeRef.current = null;
      return;
    }

    const currentSrc = src;
    let audioElement: HTMLAudioElement;
    try {
      audioElement = new Audio();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audio');
      return;
    }

    audioElement.loop = false;
    if (!currentSrc.startsWith('blob:') && !currentSrc.startsWith('data:')) {
      audioElement.crossOrigin = 'anonymous';
    }
    audioElement.preload = 'auto';
    audioElement.src = currentSrc;

    audioElementRef.current = audioElement;
    updatePlaybackRate();

    let sourceNode: MediaElementAudioSourceNode;
    try {
      sourceNode = audioContext.createMediaElementSource(audioElement);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audio');
      audioElementRef.current = null;
      return;
    }
    sourceNodeRef.current = sourceNode;
    sourceNode.connect(gainNodeRef.current);
    if (currentSrc.startsWith('blob:')) {
      liveBlobUrlsRef.current.add(currentSrc);
    }

    const session: SamplingSession = {
      id: sessionId,
      src: currentSrc,
      element: audioElement,
      sourceNode,
      listeners: [],
      playRequested: false,
      disposed: false,
    };
    activeSessionRef.current = session;

    // A new session starts from the configured gain, never from a value left
    // behind by a previous fade.
    restoreGain();

    const isSessionActive = () => activeSessionRef.current === session && !session.disposed;

    const addListener = (type: string, handler: EventListener) => {
      audioElement.addEventListener(type, handler);
      session.listeners.push({ type, handler });
    };

    addListener('loadedmetadata', () => {
      if (!isSessionActive()) return;
      const nextDuration = Number.isFinite(audioElement.duration) ? audioElement.duration : 0;
      durationRef.current = nextDuration;
      setDuration(nextDuration);
      maybeAutoplayIfGateAllows(session);
    });

    addListener('canplaythrough', () => {
      if (!isSessionActive()) return;
      setIsReady(true);
      maybeAutoplayIfGateAllows(session);
    });

    addListener('timeupdate', () => {
      if (!isSessionActive()) return;
      const { start, end } = getEffectiveRegion();
      const current = audioElement.currentTime;
      if (end > start && current >= end) {
        if (playbackModeRef.current === 'loop') {
          audioElement.currentTime = start;
          if (!audioElement.paused) {
            audioElement.play().catch((err) => {
              if (!isSessionActive()) return;
              if (isAutoplayError(err)) {
                handleAutoplayBlocked();
                return;
              }
              if (isAbortPlayError(err)) {
                return;
              }
              setError('Playback failed. User interaction may be required.');
            });
          }
        } else {
          audioElement.pause();
          audioElement.currentTime = start;
          setIsPlaying(false);
          onEndRef.current?.();
        }
      } else if (current < start) {
        audioElement.currentTime = start;
      }
      setCurrentTime(audioElement.currentTime);
    });

    addListener('play', () => {
      if (!isSessionActive()) return;
      setIsPlaying(true);
    });
    addListener('pause', () => {
      if (!isSessionActive()) return;
      session.playRequested = false;
      setIsPlaying(false);
    });
    addListener('ended', () => {
      if (!isSessionActive()) return;
      session.playRequested = false;
      setIsPlaying(false);
      onEndRef.current?.();
    });
    addListener('error', () => {
      if (!isSessionActive()) return;
      setError('Failed to load audio file');
      setIsReady(false);
    });

    return () => {
      // Only tear down our own session; a newer one may already be active if
      // effects were re-ordered by a parent re-render.
      if (activeSessionRef.current === session) {
        teardownSession();
      } else if (liveBlobUrlsRef.current.has(session.src) && session.src.startsWith('blob:')) {
        liveBlobUrlsRef.current.delete(session.src);
        releaseSessionBlobUrl(session.src);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioContext, src]);

  // Keep gain automation in step with the gain setting. While a stop fade is
  // pending we leave the scheduled fade alone; it converges in its own callback.
  useEffect(() => {
    if (!gainNodeRef.current) return;
    if (stopTimeoutRef.current !== null) return;
    if (!audioContext) return;
    const now = audioContext.currentTime;
    const param = gainNodeRef.current.gain;
    cancelGainAutomation(param, now);
    param.setValueAtTime(gain, now);
  }, [gain, audioContext]);

  // Clamp playback position to the region when start/end changes.
  useEffect(() => {
    const element = audioElementRef.current;
    if (!element || !duration) return;
    const { start, end } = getEffectiveRegion();
    if (end <= start) return;
    if (element.currentTime < start || element.currentTime > end) {
      element.currentTime = start;
    }
  }, [startTime, endTime, duration]);

  // Load file from File object. Revocation of the previous blob URL is left to
  // the session teardown so a URL still in use is never pulled out from under
  // the active session.
  const loadFile = (file: File) => {
    const adopt = (url: string) => {
      if (url.startsWith('blob:')) {
        createdBlobUrlsRef.current.add(url);
      }
      setFileName(file.name);
      setSrc(url);
    };

    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      if (result) {
        adopt(result);
      }
    };
    reader.onerror = () => {
      try {
        adopt(URL.createObjectURL(file));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load audio file');
      }
    };
    reader.readAsDataURL(file);
  };

  // Cleanup any pending unlock listeners
  useEffect(() => {
    return () => {
      if (unlockListenerRef.current) {
        window.removeEventListener('pointerdown', unlockListenerRef.current);
        window.removeEventListener('keydown', unlockListenerRef.current);
        unlockListenerRef.current = null;
      }
    };
  }, []);

  // Unmount: release every blob URL this component created.
  useEffect(() => {
    const created = createdBlobUrlsRef.current;
    const live = liveBlobUrlsRef.current;
    return () => {
      created.forEach((url) => {
        if (live.has(url)) return;
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      });
      created.clear();
      live.clear();
    };
  }, []);

  // Tighter loop watcher for short regions. Scoped to a single session so a
  // source swap cancels it, and re-created whenever the region changes.
  useEffect(() => {
    if (!isPlaying || playbackMode !== 'loop') return;
    const session = activeSessionRef.current;
    if (!session) return;
    const interval = window.setInterval(() => {
      if (activeSessionRef.current !== session || session.disposed) return;
      const element = session.element;
      const { start, end } = getEffectiveRegion();
      if (end > start && element.currentTime >= end) {
        element.currentTime = start;
        if (!element.paused) {
          element.play().catch((err) => {
            if (activeSessionRef.current !== session || session.disposed) return;
            if (isAutoplayError(err)) {
              handleAutoplayBlocked();
              return;
            }
            if (isAbortPlayError(err)) {
              return;
            }
            setError('Playback failed. User interaction may be required.');
          });
        }
      } else if (element.currentTime < start) {
        element.currentTime = start;
      }
    }, 10);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, playbackMode, startTime, endTime, duration, src]);

  // Set up CV/gate worklets
  useEffect(() => {
    if (!audioContext) return;
    let cancelled = false;

    loadSamplerWorklets(audioContext).then(() => {
      if (cancelled) return;

      if (!gateNodeRef.current) {
        const gateNode = new AudioWorkletNode(audioContext, 'sampler-gate-detector', {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          channelCount: 1,
        });
        gateNode.port.onmessage = (event) => {
          if (!enabledRef.current) return;
          const mode = playbackModeRef.current;
          if (event.data?.type === 'gate-on') {
            gateStateRef.current = true;
            // Gate high starts (or retriggers) playback in every mode; in
            // gate/loop the state is what keeps the sample running.
            void triggerPlayback();
          }
          if (event.data?.type === 'gate-off') {
            gateStateRef.current = false;
            // One-shot samples must keep playing through a falling edge.
            if (mode === 'gate' || mode === 'loop') {
              stopAtStart();
            }
          }
        };
        gateNodeRef.current = gateNode;
      }

      if (!pitchCvNodeRef.current) {
        const pitchNode = new AudioWorkletNode(audioContext, 'sampler-cv-follower', {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          channelCount: 1,
        });
        pitchNode.port.onmessage = (event) => {
          if (event.data?.type !== 'cv') return;
          pitchCvValueRef.current = event.data.value;
          updatePlaybackRate();
        };
        pitchCvNodeRef.current = pitchNode;
      }
      setIsWorkletReady(true);
    }).catch((err) => {
      if (cancelled) return;
      console.error('Failed to load Sampler worklets', err);
    });

    return () => {
      cancelled = true;
      if (gateNodeRef.current) {
        if (gateNodeRef.current.port) {
          gateNodeRef.current.port.onmessage = null;
        }
        try { gateNodeRef.current.disconnect(); } catch { /* ignore */ }
        gateNodeRef.current = null;
      }
      if (pitchCvNodeRef.current) {
        if (pitchCvNodeRef.current.port) {
          pitchCvNodeRef.current.port.onmessage = null;
        }
        try { pitchCvNodeRef.current.disconnect(); } catch { /* ignore */ }
        pitchCvNodeRef.current = null;
      }
      setIsWorkletReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioContext]);

  // Mode changes take effect immediately rather than waiting for the next gate
  // edge: gated modes stop when the gate is low, resume when it is high, and
  // one-shot never interrupts an in-flight sample.
  useEffect(() => {
    playbackModeRef.current = playbackMode;
    const session = activeSessionRef.current;
    if (!session || session.disposed) return;
    if (!enabledRef.current) return;
    if (playbackMode === 'one-shot') return;

    if (gateStateRef.current) {
      if (session.element.paused && !session.playRequested) {
        void triggerPlayback();
      }
    } else if (!session.element.paused || session.playRequested) {
      stopAtStart();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbackMode]);

  const gateKey = gateInput?.current?.audioNode ? String(gateInput.current.audioNode) : 'null';
  useEffect(() => {
    if (!gateInput?.current || !gateNodeRef.current || !isWorkletReady) return;
    const inGain = gateInput.current.gain;
    const listener = gateNodeRef.current;
    inGain.connect(listener);
    return () => {
      try { inGain.disconnect(listener); } catch { /* ignore */ }
    };
  }, [gateKey, isWorkletReady]);

  const pitchCvKey = pitchCv?.current?.audioNode ? String(pitchCv.current.audioNode) : 'null';
  useEffect(() => {
    if (!pitchCv?.current || !pitchCvNodeRef.current || !isWorkletReady) return;
    const inGain = pitchCv.current.gain;
    const listener = pitchCvNodeRef.current;
    inGain.connect(listener);
    return () => {
      try { inGain.disconnect(listener); } catch { /* ignore */ }
      pitchCvValueRef.current = 0;
      updatePlaybackRate();
    };
  }, [pitchCvKey, isWorkletReady]);

  const stop = () => {
    stopWithFade(true);
  };

  const triggerCommand = async () => {
    if (playbackMode === 'gate' || playbackMode === 'loop') {
      gateStateRef.current = true;
    }
    await triggerPlayback();
  };

  // Expose imperative handle
  useImperativeHandle(ref, () => ({
    trigger: triggerCommand,
    stop,
    loadFile,
    getState: () => ({
      src,
      fileName,
      gain,
      playbackMode,
      startTime,
      endTime,
      pitch,
      isPlaying,
      isReady,
      currentTime,
      duration,
      error
    }),
  }), [src, fileName, gain, playbackMode, startTime, endTime, pitch, isPlaying, isReady, currentTime, duration, error]);

  // Event callback effects
  useEffect(() => {
    onPlayingChange?.(isPlaying);
  }, [isPlaying, onPlayingChange]);

  useEffect(() => {
    onTimeUpdate?.(currentTime, duration);
  }, [currentTime, duration, onTimeUpdate]);

  useEffect(() => {
    onError?.(error);
  }, [error, onError]);

  if (error) {
    console.warn(`Sampler error: ${error}`);
  }

  // Render children with state
  if (children) {
    return <>{children({
      src,
      setSrc,
      fileName,
      setFileName,
      loadFile,
      gain,
      setGain,
      playbackMode,
      setPlaybackMode,
      startTime,
      setStartTime,
      endTime,
      setEndTime,
      pitch,
      setPitch,
      isPlaying,
      trigger: triggerCommand,
      stop,
      currentTime,
      duration,
      sampleRate: audioContext?.sampleRate ?? 44100,
      isActive: !!output.current,
      isReady,
      error,
    })}</>;
  }

  return null;
});

Sampler.displayName = 'Sampler';
