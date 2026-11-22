import { type WaveSurferOptions } from 'wavesurfer.js'
import type { ComputedRef, Ref } from 'vue'
import type { useWaveSurferInstance } from '../core/useWaveSurferInstance'
import type { useWaveSurferState } from '../core/useWaveSurferState'
import type { RecordPluginOptions } from 'wavesurfer.js/dist/plugins/record'
import type { ZoomPluginOptions } from 'wavesurfer.js/dist/plugins/zoom'
import type { TimelinePluginOptions } from 'wavesurfer.js/dist/plugins/timeline'
import type { HoverPluginOptions } from 'wavesurfer.js/dist/plugins/hover'
import type { SpectrogramPluginOptions } from 'wavesurfer.js/dist/plugins/spectrogram'
import type { EnvelopePluginOptions } from 'wavesurfer.js/dist/plugins/envelope'
import type { MinimapPluginOptions } from 'wavesurfer.js/dist/plugins/minimap'

export type PartialWaveSurferOptions = Partial<Omit<WaveSurferOptions, 'container'>>

export type WaveSurferIns = {
  containerRef: Ref<HTMLElement | null>
  options: PartialWaveSurferOptions
}

export type UseWaveSurfer = ReturnType<typeof useWaveSurferInstance> &
  ReturnType<typeof useWaveSurferState>

export type Plugins = {
  regions: any
  timeline: TimelinePluginOptions
  zoom: ZoomPluginOptions
  minimap: MinimapPluginOptions
  envelope: EnvelopePluginOptions
  spectrogram: SpectrogramPluginOptions
  hover: HoverPluginOptions
}

export type UseWaveSurferRecorder = WaveSurferIns & {
  recordPluginOptions?: RecordPluginOptions
}

/**
 * High level recorder state.
 * - `idle`: nothing is captured, the next start begins a new recording
 * - `recording`: audio is being captured
 * - `paused`: a recording is open but no audio is being captured
 */
export type RecorderStatus = 'idle' | 'recording' | 'paused'

export interface RecordingController {
  /** Recording duration formatted as `mm:ss`, frozen while paused. */
  currentTime: ComputedRef<string>
  isRecording: ComputedRef<boolean>
  isPaused: ComputedRef<boolean>
  /** `true` when the primary action is pause, `false` when it is resume. */
  isPauseResume: ComputedRef<boolean>
  /** Start a recording, or resume the paused one. */
  startRecording: () => Promise<void>
  /** Pause the running recording, or resume the paused one. */
  pauseRecording: () => void
  /** Stop the recording and resolve with the blob of this recording. */
  stopRecording: () => Promise<Blob>
}
