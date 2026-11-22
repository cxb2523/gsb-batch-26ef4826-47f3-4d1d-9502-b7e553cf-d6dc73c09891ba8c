import { computed, getCurrentInstance, onMounted, onUnmounted, ref, watch } from 'vue'
import RecordPlugin from 'wavesurfer.js/dist/plugins/record.js'
import type { Ref } from 'vue'
import type WaveSurfer from 'wavesurfer.js'
import type { RecordPluginOptions } from 'wavesurfer.js/dist/plugins/record'
import { useWaveSurferPlugin, useWaveSurferPluginStandalone } from '../core/useWaveSurferPlugin'
import type { RecorderStatus, RecordingController } from '../types'

export interface UseWaveSurferRecorderOptions {
  waveSurfer: Ref<WaveSurfer | null>
  recordPluginOptions?: RecordPluginOptions
}

export interface UseWaveSurferRecorderStandaloneOptions {
  containerRef: Ref<HTMLElement | null>
  options: any
  recordPluginOptions?: RecordPluginOptions
}

interface PendingStop {
  promise: Promise<Blob>
  resolve: (blob: Blob) => void
  /** Stop request belongs to this recording generation. */
  generation: number
  /** `true` once `plugin.stopRecording()` has been called for this request. */
  performed: boolean
  settled: boolean
  timeoutId: ReturnType<typeof setTimeout> | null
}

/**
 * How long a stop waits for the plugin's `record-end` before settling with an
 * empty blob. The real `MediaRecorder` emits `record-end` within a few
 * milliseconds; this only guards against a plugin that never emits it.
 */
const DEFAULT_RECORD_END_TIMEOUT = 1000

export interface RecordingLogicOptions {
  /** Milliseconds to wait for `record-end` before resolving with an empty blob. */
  recordEndTimeout?: number
}

const createEmptyBlob = (): Blob => new Blob([], { type: 'audio/webm' })

/**
 * Whether the plugin currently holds an active media recorder.
 * `null` means the plugin does not expose enough information to tell.
 */
const getPluginActivity = (plugin: any): boolean | null => {
  if (!plugin) return false
  if (typeof plugin.isActive === 'function') return Boolean(plugin.isActive())
  if (typeof plugin.isRecording === 'function' || typeof plugin.isPaused === 'function') {
    return Boolean(plugin.isRecording?.() || plugin.isPaused?.())
  }
  return null
}

const formatRecordingTime = (time: number): string => {
  // time will be in milliseconds, convert it to mm:ss format
  return [
    Math.floor((time % 3600000) / 60000), // minutes
    Math.floor((time % 60000) / 1000) // seconds
  ]
    .map((v) => (v < 10 ? '0' + v : v))
    .join(':')
}

/**
 * Shared recording state machine used by both `useWaveSurferRecorder` and
 * `useWaveSurferRecorderStandalone`.
 *
 * Actions map to a single `RecorderStatus`:
 * - `startRecording` from `idle` begins a new recording
 * - `startRecording` from `paused` resumes the open recording (it never
 *   restarts and therefore never discards the audio captured so far)
 * - `pauseRecording` toggles between `recording` and `paused`
 * - `stopRecording` always settles: it resolves with the blob of this
 *   recording, or with an empty blob when there is nothing to stop
 */
export const createRecordingLogic = (
  waveSurferRecorder: Ref<any>,
  { recordEndTimeout = DEFAULT_RECORD_END_TIMEOUT }: RecordingLogicOptions = {}
): RecordingController => {
  const status = ref<RecorderStatus>('idle')
  const recordingTime = ref<number>(0)

  // Every start of a new recording bumps the generation. Stops are queued per
  // generation so a stop still waiting for `record-end` can never consume the
  // blob of a recording that was started afterwards.
  let generation = 0
  let startInFlight: Promise<void> | null = null
  const pendingStops: PendingStop[] = []
  // A stop that timed out may still receive its `record-end` later. Those late
  // events must be swallowed so they are never delivered to the stop of a
  // recording started afterwards.
  let orphanRecordEnds = 0

  let attachedPlugin: any = null
  const cleanups: Array<() => void> = []

  const isRecording = computed<boolean>(() => status.value === 'recording')
  const isPaused = computed<boolean>(() => status.value === 'paused')
  // `true` when the primary action is "pause" (a recording is running),
  // `false` when it is "resume" (nothing running or currently paused).
  const isPauseResume = computed<boolean>(() => status.value === 'recording')
  const currentTime = computed<string>(() => formatRecordingTime(recordingTime.value))

  const resetToIdle = () => {
    status.value = 'idle'
    recordingTime.value = 0
  }

  const settleStop = (pending: PendingStop, blob: Blob) => {
    if (pending.settled) return
    pending.settled = true
    if (pending.timeoutId !== null) {
      clearTimeout(pending.timeoutId)
      pending.timeoutId = null
    }
    const index = pendingStops.indexOf(pending)
    if (index !== -1) pendingStops.splice(index, 1)
    pending.resolve(blob)
  }

  const settleAllStops = (blob: Blob) => {
    for (const pending of [...pendingStops]) {
      settleStop(pending, blob)
    }
  }

  const findPendingStop = (forGeneration: number) =>
    pendingStops.find((pending) => pending.generation === forGeneration && !pending.settled)

  const detachListeners = () => {
    while (cleanups.length) {
      const unsubscribe = cleanups.pop()
      try {
        unsubscribe?.()
      } catch {
        // the plugin may already be destroyed
      }
    }
    attachedPlugin = null
    // Late events of the previous plugin instance are meaningless now.
    orphanRecordEnds = 0
  }

  // Listeners are registered exactly once per plugin instance. Repeated calls
  // to `startRecording` never touch the subscriptions, so they cannot stack.
  const attachListeners = (plugin: any) => {
    if (plugin === attachedPlugin) return
    detachListeners()
    if (!plugin) return
    attachedPlugin = plugin

    const subscribe = (event: string, listener: (...args: any[]) => void) => {
      if (typeof plugin.on !== 'function') return
      const unsubscribe = plugin.on(event, listener)
      if (typeof unsubscribe === 'function') {
        cleanups.push(unsubscribe)
      }
    }

    subscribe('record-progress', (time: number) => {
      // While paused the timer stops; guarding here also keeps `currentTime`
      // frozen if a stray progress event is emitted.
      if (status.value !== 'recording') return
      if (typeof time === 'number' && Number.isFinite(time)) {
        recordingTime.value = Math.max(0, time)
      }
    })

    subscribe('record-start', () => {
      // A `record-start` that arrives after the user asked to stop (for
      // example the microphone permission resolves late) must not resurrect
      // the recording; the queued stop is about to run.
      if (findPendingStop(generation)) return
      status.value = 'recording'
    })

    subscribe('record-pause', () => {
      status.value = 'paused'
    })

    subscribe('record-resume', () => {
      status.value = 'recording'
    })

    subscribe('record-end', (blob?: Blob) => {
      if (orphanRecordEnds > 0) {
        // Belongs to a stop that already settled by timeout.
        orphanRecordEnds -= 1
        return
      }
      // `record-end` events arrive in the order the recorders were stopped, so
      // the oldest waiting stop gets this blob.
      const pending = pendingStops[0]
      if (pending) {
        settleStop(pending, blob || createEmptyBlob())
        return
      }
      // A stray `record-end` (the plugin stopped on its own) must not disturb
      // a recording that is already running again.
      if (status.value !== 'idle' && getPluginActivity(plugin) !== true) {
        resetToIdle()
      }
    })

    // Adopt a plugin that is already recording when we attach to it.
    if (typeof plugin.isPaused === 'function' && plugin.isPaused()) {
      status.value = 'paused'
    } else if (typeof plugin.isRecording === 'function' && plugin.isRecording()) {
      status.value = 'recording'
    }
  }

  // Re-attach when the plugin instance itself is replaced. A replaced plugin
  // can no longer emit `record-end` for stops that were waiting on it.
  const stopAdopting = watch(
    waveSurferRecorder,
    (plugin) => {
      if (plugin === attachedPlugin) return
      if (attachedPlugin && pendingStops.length) {
        settleAllStops(createEmptyBlob())
      }
      attachListeners(plugin)
    },
    { immediate: true, flush: 'sync' }
  )

  const startRecording = (): Promise<void> => {
    const plugin = waveSurferRecorder.value
    if (!plugin || status.value === 'recording') return Promise.resolve()

    // A paused recorder is resumed; calling startRecording again would start
    // over and drop everything captured before the pause.
    if (status.value === 'paused' || (typeof plugin.isPaused === 'function' && plugin.isPaused())) {
      status.value = 'recording'
      try {
        return Promise.resolve(plugin.resumeRecording?.())
      } catch {
        status.value = 'paused'
        return Promise.resolve()
      }
    }

    // Deferred stops (requested while `startRecording` was still resolving)
    // belong to the previous recording. Starting over means there is nothing
    // left for them to stop, so settle them instead of letting them kill this
    // new recording.
    for (const pending of [...pendingStops]) {
      if (!pending.performed) settleStop(pending, createEmptyBlob())
    }

    generation += 1
    // Late `record-end` events of the previous generation are ignored from now
    // on (a new recorder owns the event stream), so a stop that timed out can
    // no longer swallow the blob of this recording.
    orphanRecordEnds = 0
    recordingTime.value = 0
    status.value = 'recording'
    attachListeners(plugin)

    const startPromise = (async () => {
      try {
        await Promise.resolve(plugin.startRecording?.())
      } catch {
        // Starting can fail (for example a denied microphone permission).
        // Roll the state machine back and settle every stop that may already
        // be waiting for an event that will never arrive.
        if (status.value === 'recording') {
          resetToIdle()
        }
        settleAllStops(createEmptyBlob())
      }
    })()

    startInFlight = startPromise
    void startPromise.then(() => {
      if (startInFlight === startPromise) {
        startInFlight = null
      }
    })
    return startPromise
  }

  const pauseRecording = (): void => {
    const plugin = waveSurferRecorder.value
    if (!plugin) return

    if (status.value === 'paused') {
      status.value = 'recording'
      try {
        plugin.resumeRecording?.()
      } catch {
        status.value = 'paused'
      }
      return
    }

    if (status.value === 'recording') {
      try {
        plugin.pauseRecording?.()
        status.value = 'paused'
      } catch {
        // the plugin refused to pause, keep the current state
      }
    }
  }

  const stopRecording = (): Promise<Blob> => {
    // A second stop for the same recording shares the first one's result.
    const existing = findPendingStop(generation)
    if (existing) return existing.promise

    const plugin = waveSurferRecorder.value
    if (!plugin) {
      resetToIdle()
      return Promise.resolve(createEmptyBlob())
    }

    const activity = getPluginActivity(plugin)
    if (status.value === 'idle' && activity !== true) {
      // Nothing is being recorded: settle immediately instead of waiting for
      // a `record-end` event that will never come.
      return Promise.resolve(createEmptyBlob())
    }

    let resolveStop!: (blob: Blob) => void
    const promise = new Promise<Blob>((resolve) => {
      resolveStop = resolve
    })
    const pending: PendingStop = {
      promise,
      resolve: resolveStop,
      generation,
      performed: false,
      settled: false,
      timeoutId: null
    }
    pendingStops.push(pending)

    // The state machine moves to idle right away; the blob is still delivered
    // asynchronously when the plugin emits `record-end`.
    resetToIdle()

    pending.timeoutId = setTimeout(() => {
      pending.timeoutId = null
      // The plugin never reported the end of the recording. Settle so callers
      // are not left waiting forever. If the event does show up later it will
      // be ignored (see `orphanRecordEnds`) instead of feeding the next stop.
      orphanRecordEnds += 1
      settleStop(pending, createEmptyBlob())
    }, recordEndTimeout)

    const performStop = () => {
      if (pending.settled) return
      pending.performed = true
      status.value = 'idle'
      recordingTime.value = 0
      try {
        plugin.stopRecording?.()
      } catch {
        settleStop(pending, createEmptyBlob())
      }
    }

    if (activity === false && !startInFlight) {
      // The plugin explicitly reports no active recorder, so no `record-end`
      // will be emitted for it. Settle instead of hanging forever.
      performStop()
      settleStop(pending, createEmptyBlob())
    } else if (startInFlight) {
      // `startRecording` is still resolving (it awaits microphone access).
      // Stop once it settles so the recorder cannot keep running after the
      // user already pressed stop.
      void startInFlight.then(performStop, () => settleStop(pending, createEmptyBlob()))
    } else {
      performStop()
    }

    return promise
  }

  // Lifecycle hooks are optional so the state machine stays usable outside of
  // a component (for example in tests).
  if (getCurrentInstance()) {
    onUnmounted(() => {
      stopAdopting()
      detachListeners()
      // Never leave an awaited stop hanging because the component went away.
      settleAllStops(createEmptyBlob())
    })
  }

  return {
    currentTime,
    startRecording,
    stopRecording,
    pauseRecording,
    isRecording,
    isPaused,
    isPauseResume
  }
}

// Plugin with existing WaveSurfer instance
export const useWaveSurferRecorder = ({
  waveSurfer,
  recordPluginOptions = {}
}: UseWaveSurferRecorderOptions) => {
  const { pluginInstance: waveSurferRecorder, createPlugin } = useWaveSurferPlugin<RecordPlugin>(
    RecordPlugin,
    {
      renderRecordedAudio: false,
      ...recordPluginOptions
    }
  )

  const recordingLogic = createRecordingLogic(waveSurferRecorder)

  let registeredFor: WaveSurfer | null = null
  const ensurePlugin = () => {
    const instance = waveSurfer.value
    if (!instance || registeredFor === instance) return
    registeredFor = instance
    createPlugin(instance)
  }

  // Register as soon as a WaveSurfer instance is available (also covers being
  // fed an already-created one) and make sure later replacements register too.
  watch(waveSurfer, ensurePlugin, { immediate: true, flush: 'sync' })
  if (getCurrentInstance()) {
    onMounted(ensurePlugin)
  }

  return {
    waveSurferRecorder,
    ...recordingLogic
  }
}

// Standalone version that creates its own WaveSurfer instance
export const useWaveSurferRecorderStandalone = ({
  containerRef,
  options,
  recordPluginOptions = {}
}: UseWaveSurferRecorderStandaloneOptions) => {
  const { waveSurfer, pluginInstance: waveSurferRecorder } = useWaveSurferPluginStandalone<RecordPlugin>(
    RecordPlugin,
    {
      containerRef,
      options,
      pluginOptions: {
        renderRecordedAudio: false,
        ...recordPluginOptions
      }
    }
  )

  const recordingLogic = createRecordingLogic(waveSurferRecorder)

  return {
    waveSurfer,
    waveSurferRecorder,
    ...recordingLogic
  }
}
