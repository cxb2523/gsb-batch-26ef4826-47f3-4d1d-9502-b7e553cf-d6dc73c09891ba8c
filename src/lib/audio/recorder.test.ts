// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Arnold Wender / Wender Media
/* ──────────────────────────────────────────────────────────
   Tests for AudioRecorder — verifies the recorder routes the
   superdough tap through the shared takeover state, tears down
   only its own edges, and never stacks connections across
   repeated start/stop cycles or start/stop races.
   ────────────────────────────────────────────────────────── */

import { describe, it, expect, vi, beforeEach } from 'vitest'

/* ── Web Audio fakes ─────────────────────────────────────── */

function createFakeNode() {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
  }
}

const masterGain = createFakeNode()
const fakeStream = { id: 'fake-stream' }
const fakeDestination = {
  ...createFakeNode(),
  stream: fakeStream,
}
const fakeContext = {
  createMediaStreamDestination: vi.fn(() => fakeDestination),
}

vi.mock('./context', () => ({
  getSharedContext: () => fakeContext,
  getMasterGain: () => masterGain,
}))

/* ── Takeover-state mock ─────────────────────────────────── */

const tapState = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
}))

vi.mock('./strudel-tap', () => ({
  acquireStrudelRecorderTap: (...args: unknown[]) => tapState.acquire(...args),
  releaseStrudelRecorderTap: (...args: unknown[]) => tapState.release(...args),
}))

/* ── MediaRecorder fake (jsdom does not provide one) ─────── */

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []
  state: 'inactive' | 'recording' = 'inactive'
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: ((e: unknown) => void) | null = null

  constructor(
    public stream: unknown,
    public options?: unknown,
  ) {
    FakeMediaRecorder.instances.push(this)
  }

  start(_timeslice?: number) {
    this.state = 'recording'
  }

  stop() {
    this.state = 'inactive'
    this.onstop?.()
  }
}

describe('AudioRecorder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    FakeMediaRecorder.instances.length = 0
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    /* Default: the takeover resolves to a superdough output node. */
    tapState.acquire.mockResolvedValue(createFakeNode())
  })

  async function makeRecorder() {
    vi.resetModules()
    /* resetModules wiped the mock binding — re-seed it. */
    tapState.acquire.mockResolvedValue(createFakeNode())
    const mod = await import('./recorder')
    return new mod.AudioRecorder()
  }

  it('connects masterGain and acquires the shared tap on start, releasing both on stop', async () => {
    const recorder = await makeRecorder()
    recorder.start()

    expect(fakeContext.createMediaStreamDestination).toHaveBeenCalledTimes(1)
    expect(masterGain.connect).toHaveBeenCalledWith(fakeDestination)
    expect(tapState.acquire).toHaveBeenCalledWith(fakeDestination)

    await recorder.stop()

    expect(masterGain.disconnect).toHaveBeenCalledWith(fakeDestination)
    /* Only the recorder's own destination is released — the analyser edge is
     * owned by the takeover state and untouched. */
    expect(tapState.release).toHaveBeenCalledWith(fakeDestination)
  })

  it('ignores a second start() while recording (no duplicate destination/connections)', async () => {
    const recorder = await makeRecorder()
    recorder.start()
    recorder.start()
    recorder.start()

    expect(fakeContext.createMediaStreamDestination).toHaveBeenCalledTimes(1)
    expect(masterGain.connect).toHaveBeenCalledTimes(1)
    expect(tapState.acquire).toHaveBeenCalledTimes(1)
  })

  it('releases the destination when stop wins the race against tap resolution', async () => {
    const recorder = await makeRecorder()
    /* Resolution never settles before stop(). */
    let resolveTap: (node: unknown) => void = () => {}
    tapState.acquire.mockReturnValue(
      new Promise((resolve) => {
        resolveTap = resolve
      }),
    )

    recorder.start()
    await recorder.stop()

    /* cleanup() releases the still-pending edge immediately. */
    expect(tapState.release).toHaveBeenCalledWith(fakeDestination)
    const releasesAtStop = tapState.release.mock.calls.length

    /* The stale resolution then settles to a real node — the recorder
     * releases it again instead of keeping an edge nobody will ever clean up.
     * Both releases target only this recorder's own destination. */
    resolveTap(createFakeNode())
    await Promise.resolve()
    expect(tapState.release).toHaveBeenCalledTimes(releasesAtStop + 1)
    expect(tapState.release).toHaveBeenLastCalledWith(fakeDestination)
  })

  it('keeps the tap registered when superdough is not ready until a reset joins it', async () => {
    const recorder = await makeRecorder()
    /* First acquisition finds no superdough chain yet. */
    tapState.acquire.mockResolvedValueOnce(null)

    recorder.start()
    await Promise.resolve()

    /* Not ready must NOT unregister the destination — the masterGain tap
     * keeps recording and the takeover can still route Strudel in later. */
    expect(tapState.release).not.toHaveBeenCalled()
    expect(masterGain.connect).toHaveBeenCalledWith(fakeDestination)

    await recorder.stop()
    expect(tapState.release).toHaveBeenCalledWith(fakeDestination)
  })

  it('two full start/stop cycles acquire and release symmetrically with no leftover edge', async () => {
    const recorder = await makeRecorder()

    for (let cycle = 0; cycle < 2; cycle++) {
      recorder.start()
      /* Let the fire-and-forget acquisition settle. */
      await Promise.resolve()
      await recorder.stop()
    }

    expect(tapState.acquire).toHaveBeenCalledTimes(2)
    expect(tapState.release).toHaveBeenCalledTimes(2)
    expect(masterGain.connect).toHaveBeenCalledTimes(2)
    expect(masterGain.disconnect).toHaveBeenCalledTimes(2)
  })

  it('rejects stop() when nothing is recording without touching the takeover', async () => {
    const recorder = await makeRecorder()
    await expect(recorder.stop()).rejects.toThrow('Not recording')
    expect(tapState.release).not.toHaveBeenCalled()
  })

  it('keeps recording the master bus when superdough is not available', async () => {
    const recorder = await makeRecorder()
    tapState.acquire.mockResolvedValue(null)

    recorder.start()
    await Promise.resolve()

    expect(masterGain.connect).toHaveBeenCalledWith(fakeDestination)
    expect(FakeMediaRecorder.instances).toHaveLength(1)
    expect(FakeMediaRecorder.instances[0].stream).toBe(fakeStream)
  })
})
