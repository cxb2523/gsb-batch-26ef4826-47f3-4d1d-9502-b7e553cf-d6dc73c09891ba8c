/**
 * Run with `npm test`. Plain assertions, no framework; bundled with esbuild and
 * run in Node. Covers the drum-sample link from selection to sound:
 *
 *  - normal replacement and shared-path caching
 *  - concurrent loads on one pad: the last selection wins, stale requests
 *    neither apply nor toast, stale failures stay silent
 *  - kit switching / clearing: unreferenced samples leave the cache, referenced
 *    ones stay, and pads without a decoded sample fall back to synthesis
 *
 * AudioBuffer/AudioContext are minimal fakes — no real audio graph needed.
 */
import { StudioEngine, studio } from './engine'
import {
  initSampleRegistry,
  invalidatePad,
  loadPadSample,
  preloadSample,
  releasePadClaim,
  resetSampleRegistry,
  syncReferences,
  type SampleFileReader
} from './sampleRegistry'
import type { DrumVoiceId } from './types'

let checks = 0
function check(condition: boolean, message: string): void {
  checks += 1
  if (!condition) throw new Error(`check ${checks} failed: ${message}`)
}

const microtasks = (): Promise<void> => Promise.resolve().then(() => undefined)
/** Resolve every pending microtask chain (awaits) several times over. */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await microtasks()
}
/** Fails the test if `promise` settles — superseded loads must hang forever. */
async function assertPending(promise: Promise<unknown>, label: string): Promise<void> {
  let settled = false
  promise.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  await flush()
  check(!settled, `${label}: superseded request must never settle`)}

// ---------- Fakes ----------

function fakeBuffer(marker: number): AudioBuffer {
  const length = 128
  const data = new Float32Array(length).fill(marker)
  return {
    length,
    duration: length / 48000,
    numberOfChannels: 1,
    sampleRate: 48000,
    getChannelData: () => data,
    copyFromChannel: () => undefined,
    copyToChannel: () => undefined
  } as unknown as AudioBuffer
}

class ControlledReader implements SampleFileReader {
  readonly calls: string[] = []
  /** Paths that reject (missing/corrupt files); everything else resolves. */
  failing = new Set<string>()
  private readonly gates = new Map<string, { resolve: (b: AudioBuffer) => void; promise: Promise<AudioBuffer> }>()

  decodePath(path: string): Promise<AudioBuffer> {
    this.calls.push(path)
    if (this.failing.has(path)) return Promise.reject(new Error(`missing ${path}`))
    let gate = this.gates.get(path)
    if (!gate) {
      let resolve!: (b: AudioBuffer) => void
      const promise = new Promise<AudioBuffer>((r) => {
        resolve = r
      })
      gate = { resolve, promise }
      this.gates.set(path, gate)
    }
    return gate.promise
  }

  /** Release the decode for `path`; repeated readers of one path share it. */
  release(path: string, marker = 0.5): void {
    this.gates.get(path)?.resolve(fakeBuffer(marker))
  }
}

interface FakeNode {
  connect: (destination: unknown) => unknown
  disconnect: () => void
}

function fakeNode(): FakeNode & Record<string, unknown> {
  const node: FakeNode & Record<string, unknown> = {
    connect: (destination: unknown) => destination,
    disconnect: () => undefined
  }
  node.gain = { value: 1, setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined, setTargetAtTime: () => undefined }
  node.pan = { value: 0 }
  node.playbackRate = { value: 1 }
  node.frequency = { value: 0, setTargetAtTime: () => undefined }
  node.gainNode = node.gain
  node.threshold = node.gain
  node.ratio = node.gain
  node.knee = node.gain
  node.attack = node.gain
  node.release = node.gain
  node.oversample = 'none'
  node.curve = null
  node.buffer = null
  return node
}

function fakeContext(): AudioContext {
  const ctx = {
    sampleRate: 48000,
    currentTime: 0,
    createBuffer: (channels: number, length: number, sampleRate: number) =>
      fakeBufferView(channels, length, sampleRate),
    createGain: () => fakeNode(),
    createStereoPanner: () => fakeNode(),
    createBiquadFilter: () => fakeNode(),
    createWaveShaper: () => fakeNode(),
    createDynamicsCompressor: () => fakeNode(),
    createConvolver: () => fakeNode(),
    createDelay: () => fakeNode(),
    createBufferSource: () => ({ ...fakeNode(), start: () => undefined, stop: () => undefined, onended: null }),
    createOscillator: () => ({ ...fakeNode(), start: () => undefined, stop: () => undefined })
  }
  return ctx as unknown as AudioContext
}

function fakeBufferView(channels: number, length: number, sampleRate: number): AudioBuffer {
  const channelData = Array.from({ length: channels }, () => new Float32Array(length))
  return {
    length,
    duration: length / sampleRate,
    numberOfChannels: channels,
    sampleRate,
    getChannelData: (index: number) => channelData[index],
    copyFromChannel: () => undefined,
    copyToChannel: () => undefined
  } as unknown as AudioBuffer
}

/** Engine internals the tests assert on (same module, just not public API). */
interface EngineInternals {
  drumSamples: Map<string, unknown>
  drumBuffers: Map<DrumVoiceId, AudioBuffer>
  drumBufferSamples: Map<DrumVoiceId, boolean>
  drumBufferSignatures: Map<DrumVoiceId, string>
}

function internals(engine: StudioEngine): EngineInternals {
  return engine as unknown as EngineInternals
}

/**
 * The registry drives the shared `studio` singleton. Give it a fake audio
 * context once and reset its kit/caches between blocks.
 */
;(studio as unknown as { ctx: AudioContext }).ctx = fakeContext()

function resetEngine(): void {
  const state = internals(studio)
  state.drumSamples.clear()
  state.drumBuffers.clear()
  state.drumBufferSamples.clear()
  state.drumBufferSignatures.clear()
  studio.setKit(kitWith({}))
  resetSampleRegistry()
}

const KICK = 'kick' as DrumVoiceId
const SNARE = 'snare' as DrumVoiceId
const HAT = 'hat' as DrumVoiceId
const A = 'C:/samples/a.wav'
const B = 'C:/samples/b.wav'
const C = 'C:/samples/c.wav'

function kitWith(samples: Partial<Record<DrumVoiceId, string>>): import('./types').DrumKit {
  const voices = {} as import('./types').DrumKit['voices']
  for (const id of ['kick', 'snare', 'clap', 'hat', 'openhat', 'perc', 'crash', 'bass808'] as DrumVoiceId[]) {
    const path = samples[id]
    voices[id] = {
      model: '808',
      sample: path ? { path, name: path.split('/').pop()! } : null,
      tune: 0,
      decay: 1,
      tone: 0.5,
      drive: 0,
      level: 0.8,
      pan: 0,
      reverb: 0.1
    }
  }
  return { name: 'test', description: '', voices, punch: 0.4, crunch: 0.15, room: 0.12 }
}

// ---------- Registry: normal replacement ----------

{
  resetEngine()
  const reader = new ControlledReader()
  initSampleRegistry(reader)
  // The pad is committed to the kit (as actions.ts does right after a load resolves).
  studio.setKit(kitWith({ kick: A }))
  syncReferences([A])

  const load = loadPadSample(KICK, A)
  await flush()
  check(reader.calls.filter((p) => p === A).length === 1, 'replacement: decode starts once')
  reader.release(A)
  const outcome = await load
  check(outcome.ok === true, 'replacement: valid sample loads')
  check(internals(studio).drumSamples.has(A), 'replacement: engine holds the decoded sample')
}

// A shared path is decoded once, even when two pads load it concurrently.
{
  resetEngine()
  const reader = new ControlledReader()
  initSampleRegistry(reader)
  studio.setKit(kitWith({ kick: A, snare: A }))
  syncReferences([A, A])

  const first = loadPadSample(KICK, A)
  const second = loadPadSample(SNARE, A)
  await flush()
  check(reader.calls.filter((p) => p === A).length === 1, 'shared path: only one decode for two pads')
  reader.release(A, 0.7)
  const [r1, r2] = await Promise.all([first, second])
  check(r1.ok && r2.ok, 'shared path: both pads get the sample')
  const stored = internals(studio).drumSamples
  check(stored.size === 1 && stored.has(A), 'shared path: one cache entry serves both pads')
}

// A cached success is not decoded again on a later load.
{
  resetEngine()
  const reader = new ControlledReader()
  initSampleRegistry(reader)
  studio.setKit(kitWith({ kick: A }))
  syncReferences([A])

  const first = loadPadSample(KICK, A)
  await flush()
  reader.release(A)
  await first
  // A third pad now points at the same already-cached path.
  studio.setKit(kitWith({ kick: A, hat: A }))
  syncReferences([A, A])
  const again = loadPadSample(HAT, A)
  await flush()
  check(reader.calls.filter((p) => p === A).length === 1, 'cache: a reused path is not re-decoded')
  check((await again).ok === true, 'cache: later pad resolves from the cached buffer')
  check(internals(studio).drumSamples.has(A), 'cache: engine keeps the shared buffer')
}

// ---------- Registry: concurrent race on one pad ----------

{
  resetEngine()
  const reader = new ControlledReader()
  initSampleRegistry(reader)
  studio.setKit(kitWith({ kick: B }))
  syncReferences([B])

  const older = loadPadSample(KICK, A)
  const newer = loadPadSample(KICK, B)
  await flush()
  // The first (slower) decode finishes last — the classic out-of-order return.
  reader.release(B, 0.2)
  const outcomeB = await newer
  check(outcomeB.ok === true, 'race: last selection loads')
  reader.release(A, 0.9)
  await assertPending(older, 'race: earlier selection')
  check(!internals(studio).drumSamples.has(A), 'race: late first decode never registers its buffer')
  check(internals(studio).drumSamples.has(B), 'race: engine plays the last-selected sample')
}

// An earlier request that FAILS after being superseded must stay silent.
{
  resetEngine()
  const reader = new ControlledReader()
  reader.failing.add(A)
  initSampleRegistry(reader)
  studio.setKit(kitWith({ kick: B }))
  syncReferences([B])

  const older = loadPadSample(KICK, A)
  const newer = loadPadSample(KICK, B)
  await flush()
  reader.release(B)
  check((await newer).ok === true, 'stale failure: last selection still succeeds')
  await assertPending(older, 'stale failure')
}

// A current (not superseded) failure reports back so the caller can toast once.
{
  resetEngine()
  const reader = new ControlledReader()
  reader.failing.add(A)
  initSampleRegistry(reader)

  const outcome = await loadPadSample(KICK, A)
  check(outcome.ok === false && outcome.reason === 'missing', 'failure: current selection reports missing')
}

// A failed decode never poisons the cache: the next attempt reads the file again.
{
  resetEngine()
  const reader = new ControlledReader()
  reader.failing.add(A)
  initSampleRegistry(reader)

  check((await loadPadSample(KICK, A)).ok === false, 'retry: first attempt fails')
  reader.failing.delete(A)
  const retry = loadPadSample(KICK, A)
  await flush()
  check(reader.calls.filter((p) => p === A).length === 2, 'retry: failure is not cached as a permanent result')
  reader.release(A)
  check((await retry).ok === true, 'retry: the sample loads once the file exists')
}

// Clearing a pad cancels its in-flight selection: no commit, no failure toast.
{
  resetEngine()
  const reader = new ControlledReader()
  reader.failing.add(A)
  initSampleRegistry(reader)

  const load = loadPadSample(KICK, A)
  invalidatePad(KICK)
  await flush()
  await assertPending(load, 'clear')
  check(internals(studio).drumSamples.size === 0, 'clear: cancelled failure leaves nothing in the cache')
}

// ---------- Registry: kit switching and reference lifecycle ----------

// Switching to a kit without the sample releases its cache.
{
  resetEngine()
  const reader = new ControlledReader()
  initSampleRegistry(reader)
  studio.setKit(kitWith({ kick: A }))
  syncReferences([A])

  const load = preloadSample(A)
  await flush()
  reader.release(A)
  check(await load, 'kit switch: preload succeeds')
  check(internals(studio).drumSamples.has(A), 'kit switch: sample cached while referenced')

  studio.setKit(kitWith({}))
  syncReferences([])
  check(!internals(studio).drumSamples.has(A), 'kit switch: unreferenced sample is evicted')
}

// A sample used by both kits survives the switch (still referenced).
{
  resetEngine()
  const reader = new ControlledReader()
  initSampleRegistry(reader)
  studio.setKit(kitWith({ kick: A, snare: B }))
  syncReferences([A, B])

  const pending = Promise.all([preloadSample(A), preloadSample(B)])
  await flush()
  reader.release(A, 0.3)
  reader.release(B, 0.4)
  const [a, b] = await pending
  check(a && b, 'shared across kits: both preload')
  studio.setKit(kitWith({ hat: A }))
  syncReferences([A])
  check(internals(studio).drumSamples.has(A), 'shared across kits: still-referenced sample stays')
  check(!internals(studio).drumSamples.has(B), 'shared across kits: dropped sample is evicted')
}

// A decode still in flight when the kit switches away is released once it lands.
{
  resetEngine()
  const reader = new ControlledReader()
  initSampleRegistry(reader)
  studio.setKit(kitWith({ kick: A }))
  syncReferences([A])

  const load = preloadSample(A)
  await flush()
  studio.setKit(kitWith({ kick: C }))
  syncReferences([C])
  reader.release(A)
  check(await load, 'in-flight: the decode itself still completes')
  await flush()
  check(!internals(studio).drumSamples.has(A), 'in-flight: late buffer is evicted, not orphaned')
}

// A pad load in flight during a kit switch keeps its claim until it settles.
{
  resetEngine()
  const reader = new ControlledReader()
  initSampleRegistry(reader)
  studio.setKit(kitWith({}))
  syncReferences([])

  const load = loadPadSample(KICK, A)
  await flush()
  // A kit switch (and its reference reconciliation) happens while the user's
  // selection is still decoding; the in-flight pad's claim must survive it.
  studio.setKit(kitWith({ kick: C }))
  syncReferences([C])
  reader.release(A)
  check((await load).ok === true, 'pad in flight: selection survives a concurrent prune')
  check(internals(studio).drumSamples.has(A), 'pad in flight: buffer is registered, not evicted early')
  // The caller now commits the pad and transfers the claim to the kit.
  studio.setKit(kitWith({ kick: A }))
  syncReferences([A])
  releasePadClaim(A)
  check(internals(studio).drumSamples.has(A), 'pad in flight: buffer stays after the claim transfers to the kit')
}

// ---------- Engine: fallback to synthesis while undecoded ----------

{
  resetEngine()
  const engineState = internals(studio)
  studio.setKit(kitWith({ kick: A }))
  // No sample registered for A: the kick must render its synthesized model.
  check(engineState.drumBuffers.has(KICK), 'fallback: pad has a playable buffer before decoding')
  check(engineState.drumBufferSamples.get(KICK) === false, 'fallback: buffer is the synthesized model')
  check(engineState.drumBufferSignatures.get(KICK)?.startsWith('synth:') === true, 'fallback: signature marks synthesis')
}

// Once the decoded sample arrives the same pad switches to it without a kit change.
{
  resetEngine()
  const engineState = internals(studio)
  studio.setKit(kitWith({ kick: A }))
  const synthBuffer = engineState.drumBuffers.get(KICK)

  const sample = fakeBuffer(0.42)
  studio.setDrumSample(A, sample)
  check(engineState.drumBufferSamples.get(KICK) === true, 'arrival: pad now plays a sample buffer')
  check(engineState.drumBuffers.get(KICK) !== synthBuffer, 'arrival: buffer changed from synth to sample')
  check(engineState.drumBufferSignatures.get(KICK) === `sample:${A}`, 'arrival: signature marks the sample')
}

// Forgetting a registered sample sends its pad back to synthesis.
{
  resetEngine()
  const engineState = internals(studio)
  studio.setKit(kitWith({ kick: A, snare: B }))
  studio.setDrumSample(A, fakeBuffer(0.3))
  studio.setDrumSample(B, fakeBuffer(0.4))
  check(engineState.drumBufferSamples.get(KICK) === true, 'removal: pad starts on its sample')

  studio.setDrumSample(A, null)
  check(engineState.drumBufferSamples.get(KICK) === false, 'removal: pad falls back to synthesis')
  check(engineState.drumBufferSamples.get(SNARE) === true, 'removal: other pads keep their samples')
  check(!engineState.drumSamples.has(A), 'removal: engine cache entry is gone')
}

// A sample decoded for an old kit is pruned once no reference (kit pad or
// in-flight selection) covers it — the registry drives the engine recount.
{
  resetEngine()
  const reader = new ControlledReader()
  initSampleRegistry(reader)
  const engineState = internals(studio)
  studio.setKit(kitWith({ kick: A }))
  syncReferences([A])
  const load = preloadSample(A)
  await flush()
  reader.release(A)
  await load
  check(engineState.drumSamples.has(A), 'orphan: old kit sample is cached while referenced')

  // The kit moves to B; the next reference reconciliation drops A everywhere.
  studio.setKit(kitWith({ kick: B }))
  syncReferences([B])
  check(!engineState.drumSamples.has(A), 'orphan: stale sample is pruned at the kit boundary')
  check(engineState.drumBufferSamples.get(KICK) === false, 'orphan: pad stays on synthesis')
}

// Clearing a sample restores the pad's saved synth parameters. This mirrors
// clearDrumSample in actions.ts (invalidatePad + updateDrumVoice with the
// sample's stored synth snapshot), which cannot run headless itself.
{
  const saved = { tune: -7, decay: 1.6, tone: 0.25, drive: 0.4 }
  const sampled = kitWith({ kick: A })
  sampled.voices.kick = { ...sampled.voices.kick, tune: 0, decay: 1, tone: 0.5, drive: 0, sample: { path: A, name: 'a.wav', synth: saved } }

  // The clear transformation: stored synth snapshot wins, sample is dropped.
  const cleared = { ...sampled.voices.kick, ...sampled.voices.kick.sample?.synth, sample: null }
  check(cleared.sample === null, 'synth restore: sample reference is removed')
  check(cleared.tune === saved.tune && cleared.decay === saved.decay, 'synth restore: tune/decay come back')
  check(cleared.tone === saved.tone && cleared.drive === saved.drive, 'synth restore: tone/drive come back')

  // invalidatePad bumps the generation so any in-flight load for this pad is dead.
  invalidatePad(KICK)
  const stale = loadPadSample(KICK, A)
  invalidatePad(KICK)
  await flush()
  await assertPending(stale, 'synth restore: in-flight load is cancelled')
}

// The full clear sequence (as clearDrumSample drives it): a committed sample is
// released purely by the kit recount once the pad no longer points at it.
{
  resetEngine()
  const reader = new ControlledReader()
  initSampleRegistry(reader)
  studio.setKit(kitWith({ kick: A, snare: B }))
  syncReferences([A, B])
  const loads = Promise.all([preloadSample(A), preloadSample(B)])
  await flush()
  reader.release(A, 0.1)
  reader.release(B, 0.2)
  await loads
  check(internals(studio).drumSamples.has(A), 'clear: sample present before clearing')

  // The pad drops its sample; the next kit push recounts without A.
  studio.setKit(kitWith({ snare: B }))
  syncReferences([B])
  check(!internals(studio).drumSamples.has(A), 'clear: removed sample leaves the engine cache')
  check(internals(studio).drumSamples.has(B), 'clear: the other pad sample is untouched')
  check(internals(studio).drumBufferSamples.get(KICK) === false, 'clear: cleared pad is back on synthesis')
}

console.log(`samples: ${checks} checks passed`)
