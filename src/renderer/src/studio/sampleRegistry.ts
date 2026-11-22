/**
 * Lifecycle and concurrency for drum-pad samples, kept out of React state
 * (decoded audio is far too large for the store).
 *
 * Three guarantees live here:
 *
 * 1. Last selection wins per pad. Every load for a pad takes a generation
 *    token; an earlier request that resolves after a newer one is discarded —
 *    it neither changes what the pad plays nor surfaces a failure toast.
 * 2. One decode per path. Pads that share a sample path share its in-flight
 *    request and, once decoded, its cached buffer. A successful decode stays
 *    cached for the session; a failed one never poisons the cache.
 * 3. No orphaned caches. Each path's reference count covers the pads that
 *    point at it in the committed kit plus every selection still decoding.
 *    When a pad changes or a kit is switched, paths whose count drops to zero
 *    are dropped from the engine, so removed samples never hold a buffer and
 *    old kits leave nothing behind.
 *
 * While a sample has not finished decoding, the engine keeps playing the pad's
 * synthesized model (see StudioEngine.resolveDrumBuffers) — that fallback is
 * why a user-initiated load commits to the store only after its decode
 * succeeds. A winning pad load holds its reference across that hand-off and
 * the caller transfers it to the kit with `syncReferences`, so a valid buffer
 * is never evicted between the decode landing and the kit commit.
 */
import { studio } from './engine'
import type { DrumVoiceId } from './types'

/** Re-exported so the Node verification bundle can drive the same engine instance. */
export const studioEngine = studio

export type SampleLoadOutcome = { ok: true } | { ok: false; reason: 'missing' }

export interface SampleFileReader {
  /** Read and decode a path, throwing when the file is missing or undecodable. */
  decodePath(path: string): Promise<AudioBuffer>
}

/** Paths whose decoded audio is already registered with the engine. */
const decodedBuffers = new Map<string, AudioBuffer>()
/** One shared decode per path, so a path used by several pads is read once. */
const inflight = new Map<string, Promise<AudioBuffer>>()
/** Latest selection token per pad — older tokens must never take effect. */
const padGenerations = new Map<DrumVoiceId, number>()
/** Live references per path: committed kit occurrences plus in-flight claims. */
const refCounts = new Map<string, number>()

let reader: SampleFileReader | null = null

export function initSampleRegistry(fileReader: SampleFileReader): void {
  reader = fileReader
}

function addReference(path: string): void {
  refCounts.set(path, (refCounts.get(path) ?? 0) + 1)
}

function releaseReference(path: string): void {
  const count = refCounts.get(path) ?? 0
  if (count <= 1) refCounts.delete(path)
  else refCounts.set(path, count - 1)
}

/** The set of paths that currently hold at least one live reference. */
function referencedPaths(): Set<string> {
  return new Set(refCounts.keys())
}

function decodeShared(path: string): Promise<AudioBuffer> {
  const cached = decodedBuffers.get(path)
  if (cached) return Promise.resolve(cached)
  const pending = inflight.get(path)
  if (pending) return pending
  const promise = (async () => {
    if (!reader) throw new Error('sample registry not initialized')
    try {
      const buffer = await reader.decodePath(path)
      decodedBuffers.set(path, buffer)
      return buffer
    } finally {
      inflight.delete(path)
    }
  })()
  inflight.set(path, promise)
  return promise
}

/** Drop session-cached buffers nobody references and reconcile the engine. */
function prune(): void {
  for (const path of [...decodedBuffers.keys()]) {
    if (!refCounts.has(path)) decodedBuffers.delete(path)
  }
  studio.pruneDrumSamples(referencedPaths())
}

/**
 * Load `path` onto pad `id`. Resolves with the outcome only when this call is
 * still the pad's latest selection; superseded calls stay pending forever and
 * never produce a toast or an engine change. A failure never commits the pad:
 * it keeps (or falls back to) its built-in synthesized sound.
 *
 * On success the caller still owns one reference (the in-flight claim); it is
 * transferred to the kit by the next `syncReferences` after the kit commits.
 */
export function loadPadSample(id: DrumVoiceId, path: string): Promise<SampleLoadOutcome> {
  const generation = (padGenerations.get(id) ?? 0) + 1
  padGenerations.set(id, generation)
  // Hold a reference for the whole decode so a concurrent kit switch cannot
  // evict the buffer before this selection settles and its kit commit lands.
  addReference(path)
  return (async () => {
    let buffer: AudioBuffer
    try {
      buffer = await decodeShared(path)
    } catch {
      releaseReference(path)
      prune()
      // A superseded call must stay silent — no toast, no pad change.
      if (padGenerations.get(id) !== generation) return new Promise<SampleLoadOutcome>(() => {})
      return { ok: false, reason: 'missing' }
    }
    if (padGenerations.get(id) !== generation) {
      // A newer selection won. Drop this claim; the shared buffer survives only
      // if the kit or another in-flight selection still references the path.
      releaseReference(path)
      prune()
      return new Promise<SampleLoadOutcome>(() => {})
    }
    studio.setDrumSample(path, buffer)
    // Keep the claim: the caller commits the pad to the kit immediately after
    // this resolves, and syncReferences then recounts it as a kit reference.
    return { ok: true }
  })()
}

/**
 * Release the in-flight claim a pad load took, once its result has been
 * committed (or discarded), then reconcile both caches.
 */
export function releasePadClaim(path: string): void {
  releaseReference(path)
  prune()
}

/**
 * Background (kit-level) load. The pad already points at `path` in the kit, so
 * it plays its synthesized model until the decode lands; the buffer registers
 * itself when ready. Returns false when the file cannot be read, in which case
 * the pad simply keeps the built-in sound.
 */
export async function preloadSample(path: string): Promise<boolean> {
  addReference(path)
  try {
    const buffer = await decodeShared(path)
    studio.setDrumSample(path, buffer)
    return true
  } catch {
    return false
  } finally {
    releaseReference(path)
    prune()
  }
}

/** A new selection is starting on this pad; its previous in-flight load is dead. */
export function invalidatePad(id: DrumVoiceId): void {
  padGenerations.set(id, (padGenerations.get(id) ?? 0) + 1)
}

/**
 * Recalculate references after the kit changed (a pad was reassigned or
 * cleared, or the whole kit was switched). `kitPaths` carries one entry per
 * pad occurrence; in-flight decodes keep their own claims. The recount is the
 * authoritative retained set handed to the engine, so anything at zero is
 * evicted there even if an earlier bookkeeping step missed it.
 */
export function syncReferences(kitPaths: readonly string[]): void {
  refCounts.clear()
  for (const path of kitPaths) addReference(path)
  // In-flight decodes hold their own references for their whole lifetime.
  for (const path of inflight.keys()) addReference(path)
  prune()
}

/** Test/reset hook: forget caches and references. Pad generations are kept —
 * monotonicity is what makes stale-request detection sound. */
export function resetSampleRegistry(): void {
  decodedBuffers.clear()
  inflight.clear()
  refCounts.clear()
  studio.pruneDrumSamples(new Set())
}
