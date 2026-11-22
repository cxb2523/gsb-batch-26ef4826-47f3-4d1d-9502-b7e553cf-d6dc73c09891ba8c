// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Arnold Wender / Wender Media
/* ──────────────────────────────────────────────────────────
   Tests for the unified, invalidatable Strudel/superdough
   takeover state (src/lib/audio/strudel-tap.ts).

   The analyser and the recorder tap must resolve from the same
   running context and the same output node; invalidation
   (recording start/stop, engine switch, re-evaluation, context
   close/replace) must retire every old node; resolution must be
   single-flight so concurrent callers cannot stack connections.
   ────────────────────────────────────────────────────────── */

import { describe, it, expect, vi, beforeEach } from 'vitest'

/* ── Hand-rolled Web Audio fakes ─────────────────────────── */

interface FakeNode {
  context: FakeContext
  connect: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
}

interface FakeContext {
  state: 'running' | 'suspended' | 'closed'
  sampleRate: number
  createAnalyser: ReturnType<typeof vi.fn>
}

function createFakeNode(context: FakeContext): FakeNode {
  return {
    context,
    connect: vi.fn(),
    disconnect: vi.fn(),
  }
}

function createFakeContext(state: FakeContext['state'] = 'running'): FakeContext {
  return {
    state,
    sampleRate: 48000,
    createAnalyser: vi.fn(() => createFakeNode(ctxRef.value!)),
  }
}

/* createAnalyser's fake needs the context it belongs to; resolved lazily. */
const ctxRef: { value: FakeContext | null } = { value: null }

/* ── Controllable @strudel/webaudio mock ─────────────────── */

const sdState = vi.hoisted(() => ({
  audioContext: null as unknown,
  controller: null as { output: { destinationGain: unknown } } | null,
  getAudioContextCalls: 0,
}))

/* Gate on which the async mock-factory blocks. Armed by the generation-race
 * test so a resolution can be held in flight across an invalidation; left
 * resolved everywhere else. */
const mockGate = vi.hoisted(() => {
  const gate: { promise: Promise<void>; resolveGate: () => void; arm: () => void } = {
    promise: Promise.resolve(),
    resolveGate: () => {},
    arm: () => {
      gate.promise = new Promise<void>((resolve) => {
        gate.resolveGate = resolve
      })
    },
  }
  return gate
})

vi.mock('@strudel/webaudio', async () => {
  await mockGate.promise
  return {
    getAudioContext: () => {
      sdState.getAudioContextCalls++
      return sdState.audioContext
    },
    setAudioContext: vi.fn(),
    getSuperdoughAudioController: () => sdState.controller,
  }
})

/* The fallback master analyser must be a distinct node so fallback swaps are
 * observable. */
const masterAnalyser = createFakeNode(
  /* context is only read for identity checks in tests; a closed-context
   * fallback scenario is covered explicitly below. */
  { state: 'running', sampleRate: 44100, createAnalyser: vi.fn() } as FakeContext,
)
vi.mock('./context', () => ({
  getMasterAnalyser: () => masterAnalyser,
}))

/** Point the mock superdough at a fresh running context + output node. */
function seedSuperdough(): { context: FakeContext; output: FakeNode } {
  const context = createFakeContext('running')
  ctxRef.value = context
  const output = createFakeNode(context)
  sdState.audioContext = context
  sdState.controller = { output: { destinationGain: output } }
  return { context, output }
}

/** Fresh module state per test — the takeover caches singletons. */
async function freshTap() {
  vi.resetModules()
  /* Release any gate a previous test armed; safe to call when already open. */
  mockGate.resolveGate()
  sdState.audioContext = null
  sdState.controller = null
  sdState.getAudioContextCalls = 0
  ctxRef.value = null
  return import('./strudel-tap')
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('strudel-tap unified takeover', () => {
  it('resolves analyser and output node from the same running context and node', async () => {
    const tap = await freshTap()
    const { context, output } = seedSuperdough()

    const analyser = await tap.getStrudelAnalyser()
    const outputNode = await tap.getStrudelOutputNode()

    expect(outputNode).toBe(output)
    expect(analyser).not.toBeNull()
    /* The analyser hangs off the exact output node the recorder gets. */
    expect(output.connect).toHaveBeenCalledWith(analyser)
    expect((analyser as unknown as FakeNode).context).toBe(context)
  })

  it('single-flights concurrent resolution into one analyser and one connection', async () => {
    const tap = await freshTap()
    const { output } = seedSuperdough()

    const [a1, a2, a3] = await Promise.all([
      tap.getStrudelAnalyser(),
      tap.getStrudelAnalyser(),
      tap.getStrudelOutputNode(),
    ])

    expect(a1).toBe(a2)
    /* Exactly one analyser created, exactly one analyser edge connected. */
    expect((sdState.audioContext as FakeContext).createAnalyser).toHaveBeenCalledTimes(1)
    const connectCalls = output.connect.mock.calls.filter(([target]) => target === a1)
    expect(connectCalls).toHaveLength(1)
    expect(a3).toBe(output)
  })

  it('falls back to the master analyser while superdough is unavailable', async () => {
    const tap = await freshTap()
    /* No context/controller seeded. */
    expect(await tap.getStrudelAnalyser()).toBe(masterAnalyser)
    expect(await tap.getStrudelOutputNode()).toBeNull()
  })

  it('falls back while the superdough context is suspended and never connects', async () => {
    const tap = await freshTap()
    const context = createFakeContext('suspended')
    ctxRef.value = context
    const output = createFakeNode(context)
    sdState.audioContext = context
    sdState.controller = { output: { destinationGain: output } }

    expect(await tap.getStrudelAnalyser()).toBe(masterAnalyser)
    expect(output.connect).not.toHaveBeenCalled()
    expect(context.createAnalyser).not.toHaveBeenCalled()
  })

  it('resetStrudelTap retires the old analyser and forces a fresh resolution', async () => {
    const tap = await freshTap()
    const first = seedSuperdough()

    const oldAnalyser = await tap.getStrudelAnalyser()
    expect(oldAnalyser).not.toBeNull()

    tap.resetStrudelTap()

    /* The old analyser edge was disconnected during teardown. */
    expect(first.output.disconnect).toHaveBeenCalledWith(oldAnalyser)

    const newAnalyser = await tap.getStrudelAnalyser()
    expect(newAnalyser).not.toBe(oldAnalyser)
    expect(first.context.createAnalyser).toHaveBeenCalledTimes(2)
  })

  it('replaces the state when the output node changes (re-evaluation) without leaking edges', async () => {
    const tap = await freshTap()
    const { context, output: oldOutput } = seedSuperdough()

    const oldAnalyser = await tap.getStrudelAnalyser()

    /* superdough rebuilds its output chain (as it does after evaluate). */
    const newOutput = createFakeNode(context)
    sdState.controller = { output: { destinationGain: newOutput } }
    tap.resetStrudelTap()

    const newAnalyser = await tap.getStrudelAnalyser()
    expect(newAnalyser).not.toBe(oldAnalyser)

    /* Old chain fully torn down: analyser edge removed from the old node. */
    expect(oldOutput.disconnect).toHaveBeenCalledWith(oldAnalyser)
    /* New chain wired exactly once. */
    expect(newOutput.connect).toHaveBeenCalledTimes(1)
    expect(newOutput.connect).toHaveBeenCalledWith(newAnalyser)
    /* Still one analyser per state, no stacked analysers. */
    expect(context.createAnalyser).toHaveBeenCalledTimes(2)
  })

  it('never returns an analyser whose context was closed', async () => {
    const tap = await freshTap()
    const { context } = seedSuperdough()

    const oldAnalyser = await tap.getStrudelAnalyser()
    expect(oldAnalyser).not.toBeNull()

    /* Context is closed (and not replaced yet, e.g. dispose in flight). */
    context.state = 'closed'
    tap.resetStrudelTap()

    /* Resolve returns null because no running superdough context exists, and
     * the stale analyser is not the thing being returned. */
    expect(await tap.getStrudelAnalyser()).toBe(masterAnalyser)

    /* A replacement context then resolves cleanly to a new analyser. */
    const replacement = seedSuperdough()
    tap.resetStrudelTap()
    const nextAnalyser = await tap.getStrudelAnalyser()
    expect(nextAnalyser).not.toBe(oldAnalyser)
    expect((nextAnalyser as unknown as FakeNode).context).toBe(replacement.context)
  })

  it('release disconnects only the recorder edge and leaves the analyser connected', async () => {
    const tap = await freshTap()
    const { output } = seedSuperdough()
    const destination = createFakeNode(output.context)

    const node = await tap.acquireStrudelRecorderTap(destination)
    expect(node).toBe(output)
    const analyser = await tap.getStrudelAnalyser()

    tap.releaseStrudelRecorderTap(destination)

    expect(output.disconnect).toHaveBeenCalledWith(destination)
    /* The analyser edge must survive — visualization keeps updating. */
    expect(output.disconnect).not.toHaveBeenCalledWith(analyser)
    expect(await tap.getStrudelAnalyser()).toBe(analyser)
  })

  it('two acquire/release recording cycles never stack duplicate connections', async () => {
    const tap = await freshTap()
    const { output } = seedSuperdough()
    const destination = createFakeNode(output.context)

    for (let cycle = 0; cycle < 2; cycle++) {
      await tap.acquireStrudelRecorderTap(destination)
      tap.releaseStrudelRecorderTap(destination)
    }

    const connectEdges = output.connect.mock.calls.filter(
      ([target]) => target === destination,
    )
    const disconnectEdges = output.disconnect.mock.calls.filter(
      ([target]) => target === destination,
    )
    expect(connectEdges).toHaveLength(2)
    expect(disconnectEdges).toHaveLength(2)

    /* After the final release nothing is connected for the recorder anymore. */
    tap.resetStrudelTap()
    const analyser = await tap.getStrudelAnalyser()
    const analyserConnects = output.connect.mock.calls.filter(
      ([target]) => target === analyser,
    )
    expect(analyserConnects).toHaveLength(1)
  })

  it('connects a concurrently acquired destination exactly once (single-flight)', async () => {
    const tap = await freshTap()
    const { output } = seedSuperdough()
    const destination = createFakeNode(output.context)

    /* All three acquisitions race the same in-flight resolution. */
    const nodes = await Promise.all([
      tap.acquireStrudelRecorderTap(destination),
      tap.acquireStrudelRecorderTap(destination),
      tap.acquireStrudelRecorderTap(destination),
    ])

    expect(nodes.every((n) => n === output)).toBe(true)
    const edges = output.connect.mock.calls.filter(([target]) => target === destination)
    expect(edges).toHaveLength(1)
  })

  it('re-routes an in-progress recording across a reset without leaking the old edge', async () => {
    const tap = await freshTap()
    const { context, output: oldOutput } = seedSuperdough()
    const destination = createFakeNode(context)

    await tap.acquireStrudelRecorderTap(destination)
    expect(oldOutput.connect).toHaveBeenCalledWith(destination)

    /* Re-evaluation rebuilds superdough's chain while the take is running. */
    const newOutput = createFakeNode(context)
    sdState.controller = { output: { destinationGain: newOutput } }
    tap.resetStrudelTap()

    /* Flush the eager re-resolution kicked off by resetStrudelTap(). */
    await tap.getStrudelAnalyser()
    expect(newOutput.connect).toHaveBeenCalledWith(destination)
    /* ...and the old edge was removed, not left dangling. */
    expect(oldOutput.disconnect).toHaveBeenCalledWith(destination)

    /* Releasing after the swap tears down the new edge only. */
    tap.releaseStrudelRecorderTap(destination)
    expect(newOutput.disconnect).toHaveBeenCalledWith(destination)
  })

  it('discards a resolution whose generation was invalidated while in flight', async () => {
    /* Re-arm the mock gate so the dynamic import inside resolveTap stays
     * pending until this test releases it. */
    mockGate.arm()
    const tap = await freshTap()
    const { output } = seedSuperdough()

    /* Start a resolution, then invalidate while it is still blocked. */
    const pending = tap.getStrudelAnalyser()
    /* One microtask to enter the async function and block at the import. */
    await Promise.resolve()
    tap.resetStrudelTap()

    mockGate.resolveGate()
    const stale = await pending

    /* The stale resolution published nothing: no analyser was connected and
     * the call falls back to the shared master analyser. */
    expect(stale).toBe(masterAnalyser)
    expect(output.connect).not.toHaveBeenCalled()

    /* A later, fresh resolution builds and caches a valid state. */
    const fresh = await tap.getStrudelAnalyser()
    expect(fresh).not.toBeNull()
    expect(fresh).not.toBe(masterAnalyser)
  })

  it('keeps a not-yet-ready recorder registered and connects it once the chain appears', async () => {
    const tap = await freshTap()
    /* superdough has not initialised: nothing to tap yet. */
    const destination = createFakeNode(
      createFakeContext('running'),
    )

    expect(await tap.acquireStrudelRecorderTap(destination)).toBeNull()

    /* The chain now comes up (first note played) and an evaluation fires the
     * standard invalidation/re-resolution. */
    const { output } = seedSuperdough()
    tap.resetStrudelTap()
    await tap.getStrudelAnalyser()

    /* The still-registered destination was joined automatically, once. */
    const edges = output.connect.mock.calls.filter(([target]) => target === destination)
    expect(edges).toHaveLength(1)

    tap.releaseStrudelRecorderTap(destination)
    expect(output.disconnect).toHaveBeenCalledWith(destination)
  })

  it('acquiring after a reset reconnects to the replacement output node', async () => {
    const tap = await freshTap()
    const { context, output: oldOutput } = seedSuperdough()
    const destination = createFakeNode(context)

    await tap.acquireStrudelRecorderTap(destination)
    tap.releaseStrudelRecorderTap(destination)
    expect(oldOutput.disconnect).toHaveBeenCalledWith(destination)
    const connectsBeforeSwap = oldOutput.connect.mock.calls.filter(
      ([target]) => target === destination,
    ).length

    const newOutput = createFakeNode(context)
    sdState.controller = { output: { destinationGain: newOutput } }
    tap.resetStrudelTap()

    const node = await tap.acquireStrudelRecorderTap(destination)
    expect(node).toBe(newOutput)
    expect(newOutput.connect).toHaveBeenCalledWith(destination)
    /* The dead node gained no new recorder edges after the swap. */
    const connectsAfterSwap = oldOutput.connect.mock.calls.filter(
      ([target]) => target === destination,
    ).length
    expect(connectsAfterSwap).toBe(connectsBeforeSwap)
  })
})
