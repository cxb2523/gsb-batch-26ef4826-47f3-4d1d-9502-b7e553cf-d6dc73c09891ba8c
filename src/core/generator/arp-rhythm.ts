import { createRng } from './rng'

/**
 * Calculates note velocity based on metric position in the bar and accent intensity.
 * The control continuously scales metric dynamic spread around a baseline (92):
 * 0% yields uniform machine-like velocity (92) for robotic synth lines;
 * 100% produces maximum metric articulation with authoritative downbeats (118) and subtle ghost notes (71).
 */
export function calculateArpVelocity(stepInBar: number, accentAmount: number): number {
  const normAccent = Math.max(0, Math.min(100, accentAmount)) / 100
  const BASE_VELOCITY = 92

  // Metric weighting heuristic:
  // Beat 1: Strong downbeat (+1.0)
  // Beat 3: Medium downbeat (+0.5)
  // Beats 2 & 4: Backbeat (+0.2)
  // 8th-note offbeats: Neutral (0.0)
  // 16th-note offbeats: Ghost notes (-0.8)
  let metricWeight = -0.8
  if (stepInBar === 0) metricWeight = 1.0
  else if (stepInBar === 8) metricWeight = 0.5
  else if (stepInBar === 4 || stepInBar === 12) metricWeight = 0.2
  else if (stepInBar % 2 === 0) metricWeight = 0.0

  // At accentAmount === 0, spread is 0 (flat velocity 92).
  // At accentAmount === 100, maxSpread is 26 (Beat 1 = 118, Ghost Note = 71).
  const maxSpread = 26 * normAccent
  const rawVelocity = Math.round(BASE_VELOCITY + metricWeight * maxSpread)
  return Math.max(40, Math.min(127, rawVelocity))
}

function shuffleSteps(steps: readonly number[], rng: () => number): number[] {
  const result = [...steps]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const temp = result[i]
    result[i] = result[j]
    result[j] = temp
  }
  return result
}

/**
 * Drops `dropCount` steps from one already-filtered segment, weakest metric positions first,
 * using the same tier priority the bar mask has always used. Callers exclude any anchor step
 * before calling, so a harmonic segment can never lose its onset, no matter its metric position
 * (a chord may enter on an offbeat).
 *
 * Priority tiers (from lowest to highest retention priority):
 * - Tier 4 (Lowest priority, dropped first): 16th-note offbeats (steps 1, 3, 5, 7, 9, 11, 13, 15)
 * - Tier 3: 8th-note offbeats (steps 2, 6, 10, 14)
 * - Tier 2: Beats 2 & 4 (steps 4, 12)
 * - Tier 1: Beat 3 (step 8)
 * - Tier 0 (Highest priority, NEVER dropped): step 0 / the segment anchor
 */
function dropSegmentSteps(steps: readonly number[], dropCount: number, rng: () => number): Set<number> {
  const tier4 = steps.filter((s) => s % 2 !== 0) // 16th offbeats: 1, 3, 5, 7, 9, 11, 13, 15
  const tier3 = steps.filter((s) => s % 4 === 2) // 8th offbeats: 2, 6, 10, 14
  const tier2 = steps.filter((s) => s === 4 || s === 12) // Beats 2 & 4
  const tier1 = steps.filter((s) => s === 8) // Beat 3
  // Tier 0 is step 0 / the anchor and never reaches this function.

  const dropped = new Set<number>()
  let remainingToDrop = Math.max(0, dropCount)

  for (const tier of [tier4, tier3, tier2, tier1]) {
    if (remainingToDrop <= 0) break
    if (tier.length === 0) continue

    if (tier.length <= remainingToDrop) {
      for (const step of tier) {
        dropped.add(step)
      }
      remainingToDrop -= tier.length
    } else {
      const shuffled = shuffleSteps(tier, rng)
      for (let i = 0; i < remainingToDrop; i++) {
        dropped.add(shuffled[i])
      }
      remainingToDrop = 0
    }
  }

  return dropped
}

/**
 * Metric rest masking over one or more harmonic segments of a bar.
 *
 * `segments` are the bar-local steps the generator actually visits, split at chord changes and
 * ordered chronologically. Density is applied per segment instead of per fixed bar, so a chord
 * that enters mid-bar keeps a sounding onset: each segment keeps at least its first visited step
 * (even when the density budget would otherwise round it away) and thins only its own remaining
 * steps by metric priority.
 *
 * Why per segment: harmonic onsets are structural, not metric. A chord change is not tied to a
 * bar line, so judging it against a fixed bar's weak/strong grid could drop the new chord's entry
 * as an offbeat and leave the root unheard. Budgeting each segment on its own visited steps also
 * keeps the mask aligned with the exact positions that play, so a work range that starts off the
 * rate grid is never phase-shifted against the global grid.
 *
 * For a bar that is not split (single chord, or the synthetic per-bar fallback) this reduces to
 * one segment, and when that segment starts on bar-local step 0 — the common case — it reproduces
 * the legacy `maskArpBarSteps` result exactly, so existing seeds stay note-for-note identical. An
 * off-grid range anchors its first *visited* step instead of step 0, which is what keeps its
 * opening note sounding. At density 100 every visited step is returned, so output is unchanged.
 */
export function maskArpSegments(
  segments: readonly (readonly number[])[],
  density: number,
  seed: number,
  bar: number
): Set<number> {
  const active = new Set<number>()
  const barSeed = (seed ^ Math.imul(bar + 1, 0x9e3779b9)) >>> 0
  const normDensity = Math.max(50, Math.min(100, density))

  segments.forEach((steps, index) => {
    if (steps.length === 0) return
    if (normDensity >= 100) {
      for (const step of steps) active.add(step)
      return
    }

    // Density is per segment, but never below one sounding onset per harmonic segment.
    const activeCount = Math.max(1, Math.min(steps.length, Math.round(steps.length * (normDensity / 100))))
    if (activeCount >= steps.length) {
      for (const step of steps) active.add(step)
      return
    }

    // Why: the first segment keeps the historical bar seed, so an unsplit bar (and the first
    // harmony of a split bar) masks exactly as before; later segments get a deterministic offset.
    const segmentSeed = index === 0 ? barSeed : (barSeed ^ Math.imul(index + 1, 0x85ebca6b)) >>> 0
    // The segment's first visited step is Tier 0 and is excluded from every drop tier.
    const droppable = steps.filter((step) => step !== steps[0])
    const dropped = dropSegmentSteps(droppable, steps.length - activeCount, createRng(segmentSeed))
    for (const step of steps) {
      if (!dropped.has(step)) active.add(step)
    }
  })

  return active
}

/**
 * Masking for a single fixed musical span (legacy bar-level entry point).
 *
 * `barSteps` are the bar-local positions the caller actually plays. Masking follows this visited
 * phase instead of the global rate grid, so work ranges that start mid-grid keep sounding; at
 * least one visited step per non-empty span always survives.
 */
export function maskArpBarSteps(barSteps: readonly number[], density: number, seed: number, bar: number): Set<number> {
  return maskArpSegments([barSteps], density, seed, bar)
}
