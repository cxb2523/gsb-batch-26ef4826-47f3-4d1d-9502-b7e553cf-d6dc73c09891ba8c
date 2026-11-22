/* SPDX-License-Identifier: MIT
   Copyright (c) 2026 Arnold Wender / Wender Media
   ──────────────────────────────────────────────────────────
   AudioRecorder — captures master gain output via MediaRecorder
   and exports as WebM (opus) for download.
   Uses MediaStreamAudioDestinationNode to tap the signal chain.
   ────────────────────────────────────────────────────────── */

import { getSharedContext, getMasterGain } from './context'
import {
  acquireStrudelRecorderTap,
  releaseStrudelRecorderTap,
} from './strudel-tap'

/** Records audio from the master gain node and exports as WebM download. */
export class AudioRecorder {
  private mediaRecorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private stream: MediaStream | null = null
  private destination: MediaStreamAudioDestinationNode | null = null

  /** The most recent finished take, kept so Export Audio has something to write. */
  private lastTake: Blob | null = null

  /**
   * Start recording — taps master gain into a MediaStreamDestination.
   *
   * Strudel is tapped through the shared takeover state in strudel-tap. The
   * tap is guaranteed to come from the same running AudioContext and the same
   * superdough output node as the visualizer analyser, so a take captures
   * exactly what is heard. superdough's controller only exists once a note has
   * played; if it is not up yet the recording still captures Tone.js and
   * WebAudio, and an invalidation/re-resolution joins it in as soon as it
   * appears. Re-evaluation while recording re-routes the edge via the same
   * state instead of stacking a second connection.
   */
  start(): void {
    /* A second start() would orphan the previous destination (its edges would
     * never be disconnected) and create duplicate connections. */
    if (this.mediaRecorder) return

    const ctx = getSharedContext()
    this.destination = ctx.createMediaStreamDestination()
    getMasterGain().connect(this.destination)

    /* Fire-and-forget: the takeover resolves asynchronously because
     * @strudel/webaudio is dynamically imported and its controller initialises
     * lazily. When it is not ready yet the destination stays REGISTERED: the
     * next invalidation/re-resolution connects it as soon as the chain exists,
     * so a take that started before the first note still captures Strudel.
     * A stop() that wins the race (or a second start) unregisters it instead. */
    const destination = this.destination
    void acquireStrudelRecorderTap(destination)
      .then((node) => {
        /* Stale destination: stop() ran first or another start() replaced it.
         * null is not stale — the registration must survive until ready. */
        if (node && this.destination !== destination) {
          releaseStrudelRecorderTap(destination)
        }
      })
      .catch(() => {
        /* Strudel unavailable — the masterGain tap still records, and the
         * registration remains so a later re-resolution can still join. */
      })

    this.stream = this.destination.stream

    this.chunks = []
    this.mediaRecorder = new MediaRecorder(this.stream, {
      mimeType: 'audio/webm;codecs=opus',
    })

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data)
    }

    /* Collect data every 100ms for near-real-time chunk availability */
    this.mediaRecorder.start(100)
  }

  /** Stop recording and return the audio blob */
  stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      if (!this.mediaRecorder) {
        reject(new Error('Not recording'))
        return
      }

      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: 'audio/webm' })
        this.lastTake = blob
        this.cleanup()
        resolve(blob)
      }

      this.mediaRecorder.onerror = (event) => {
        this.cleanup()
        reject(new Error(`MediaRecorder error: ${event instanceof ErrorEvent ? event.message : 'unknown'}`))
      }

      this.mediaRecorder.stop()
    })
  }

  /** Stop recording and trigger a browser download */
  async stopAndDownload(filename = 'recording'): Promise<void> {
    const blob = await this.stop()
    const url = URL.createObjectURL(blob)

    /* Programmatic anchor click to trigger download dialog */
    const a = document.createElement('a')
    a.href = url
    a.download = `${filename}.webm`
    a.click()
    URL.revokeObjectURL(url)
  }

  /** Whether the recorder is currently capturing audio */
  isRecording(): boolean {
    return this.mediaRecorder?.state === 'recording'
  }

  /**
   * Disconnect destination and release all references.
   *
   * Only the edges THIS recording created are removed: the masterGain edge and
   * the recorder's own superdough edge. The visualization analyser taps the
   * same superdough output node and is owned by the takeover state, so it is
   * left connected and keeps drawing after the take ends.
   */
  private cleanup(): void {
    if (this.destination) {
      try {
        getMasterGain().disconnect(this.destination)
      } catch {
        /* Already disconnected — safe to ignore */
      }
      /* Removes exactly this destination's edge from the current output node
       * and unregisters it so a re-evaluation can never reconnect it. */
      releaseStrudelRecorderTap(this.destination)
    }
    this.mediaRecorder = null
    this.destination = null
    this.stream = null
    this.chunks = []
  }

  /** The last finished take, or null if nothing has been recorded this session. */
  getLastTake(): Blob | null {
    return this.lastTake
  }
}

/* Singleton recorder instance — one recorder per app */
let recorderInstance: AudioRecorder | null = null

export function getRecorder(): AudioRecorder {
  if (!recorderInstance) recorderInstance = new AudioRecorder()
  return recorderInstance
}

/**
 * Export the last finished take as a WAV through the Electron main process.
 *
 * The Export Audio menu item and toolbar button previously only explained
 * themselves, because until recording actually captured Strudel there was
 * nothing to export but silence.
 *
 * Decoding happens HERE, not in main: the IPC handler takes raw float32 PCM, and
 * shipping a WebM container across the bridge would put a demuxer in the
 * privileged process.
 *
 * Returns null when there is no take or when not running under Electron.
 */
export async function exportLastTakeAsWav(): Promise<
  { path: string } | { error: string } | null
> {
  const take = getRecorder().getLastTake()
  if (!take) return null

  const api = (window as unknown as {
    electronAPI?: {
      exportWav?: (
        buffer: ArrayBuffer,
        sampleRate: number,
        channels: number,
      ) => Promise<{ path: string } | { error: string } | null>
    }
  }).electronAPI
  if (!api?.exportWav) return null

  const ctx = getSharedContext()
  const decoded = await ctx.decodeAudioData(await take.arrayBuffer())

  /* Interleave into the shape encodeWav expects, capped at stereo — the IPC
     handler rejects anything wider. */
  const channels = Math.min(2, decoded.numberOfChannels)
  const frames = decoded.length
  const interleaved = new Float32Array(frames * channels)
  for (let c = 0; c < channels; c++) {
    const data = decoded.getChannelData(c)
    for (let i = 0; i < frames; i++) interleaved[i * channels + c] = data[i]
  }

  return (await api.exportWav(interleaved.buffer, decoded.sampleRate, channels)) ?? null
}
