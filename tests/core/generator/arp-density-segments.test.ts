import { describe, expect, it } from 'vitest'
import { generateArpeggio } from '../../../src/core/generator/arpeggio.generator'
import { maskArpBarSteps, maskArpSegments } from '../../../src/core/generator/arp-rhythm'
import type { ChordEvent } from '../../../src/core/schemas/chord.schema'
import { STEPS_PER_BAR } from '../../../src/core/schemas/project.schema'

const cChord: ChordEvent = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'C',
  roman: 'I',
  notes: ['C', 'E', 'G'],
  voicing: ['C3', 'E3', 'G3'],
  startBar: 0,
  durationBars: 0.5
}

const gChord: ChordEvent = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'G',
  roman: 'V',
  notes: ['G', 'B', 'D'],
  voicing: ['G3', 'B3', 'D4'],
  startBar: 0.5,
  durationBars: 0.5
}

const base = {
  key: 'C',
  scale: 'major',
  pattern: 'up' as const,
  octaveRange: 1,
  seed: 0,
  range: { startStep: 0, endStep: STEPS_PER_BAR }
}

const G_CHROMAS = new Set([2, 7, 11])

describe('density masking per harmonic segment', () => {
  it.each(['1/16', '1/8', '1/8d', '1/4', '1/4d'] as const)(
    'keeps the new chord sounding when it enters mid-bar at %s rate',
    (rate) => {
      for (const density of [50, 60, 75, 90]) {
        for (let seed = 0; seed < 20; seed++) {
          const notes = generateArpeggio({ ...base, rate, density, seed, chords: [cChord, gChord] })
          const afterSwitch = notes.filter((note) => note.step >= 8)
          const label = `${rate} @ ${density}% seed ${seed}`
          expect(afterSwitch.length, `${label}: no note after the chord change`).toBeGreaterThan(0)
          expect(G_CHROMAS.has(afterSwitch[0].midi % 12), `${label}: entry is not a G chord tone`).toBe(true)
        }
      }
    }
  )

  it('keeps every harmonic segment of a split bar sounding, not just step 0', () => {
    // C owns bar-local 0..7 and G owns 8..15; at 1/8 rate each segment visits four steps.
    const cSeg = [0, 2, 4, 6]
    const gSeg = [8, 10, 12, 14]
    const active = maskArpSegments([cSeg, gSeg], 50, 0, 0)
    expect(active.has(cSeg[0])).toBe(true)
    expect(active.has(gSeg[0])).toBe(true)
    expect(active.size).toBe(4) // 50% of eight visited steps
  })

  it('anchors a mid-bar chord entry even when it lands on a 16th offbeat', () => {
    // Chord change at bar step 1, so the G segment starts on a weak 16th.
    const earlyG: ChordEvent = { ...gChord, startBar: 1 / STEPS_PER_BAR, durationBars: 1 - 1 / STEPS_PER_BAR }
    const earlyC: ChordEvent = { ...cChord, durationBars: 1 / STEPS_PER_BAR }
    const active = maskArpSegments([[0], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]], 50, 0, 0)
    expect(active.has(0)).toBe(true)
    expect(active.has(1)).toBe(true)

    const notes = generateArpeggio({
      ...base,
      rate: '1/16',
      density: 50,
      chords: [earlyC, earlyG]
    })
    const afterEntry = notes.filter((note) => note.step >= 1)
    expect(afterEntry.length).toBeGreaterThan(0)
    expect(G_CHROMAS.has(afterEntry[0].midi % 12)).toBe(true)
  })

  it('matches the legacy single-span mask note-for-note on unsplit bars', () => {
    const visited = [0, 3, 6, 9, 12, 15]
    for (const density of [50, 60, 75, 90]) {
      for (let seed = 0; seed < 10; seed++) {
        expect(maskArpSegments([visited], density, seed, 1)).toEqual(maskArpBarSteps(visited, density, seed, 1))
      }
    }
  })

  it('returns every visited step at 100% density so output is unchanged', () => {
    for (const density of [100, 120, Number.POSITIVE_INFINITY]) {
      const active = maskArpSegments(
        [
          [0, 4, 8, 12],
          [2, 6, 10, 14]
        ],
        density,
        0,
        0
      )
      expect(active).toEqual(new Set([0, 4, 8, 12, 2, 6, 10, 14]))
    }
  })

  it('masks the visited phase of a range that starts off the rate grid', () => {
    // Rate 1/8d from step 3 visits bar-local {3,6,9,12,15} in bar 0 and {2,5,8,...} later;
    // the mask must judge exactly those positions and keep at least one per bar.
    for (let seed = 0; seed < 30; seed++) {
      const startStep = 3
      const notes = generateArpeggio({
        ...base,
        rate: '1/8d',
        density: 50,
        seed,
        range: { startStep, endStep: startStep + 4 * STEPS_PER_BAR },
        chords: [{ ...cChord, durationBars: 4 }]
      })
      const bars = new Set(notes.map((note) => Math.floor(note.step / STEPS_PER_BAR)))
      expect(
        [...bars].sort((a, b) => a - b),
        `seed ${seed}`
      ).toEqual([0, 1, 2, 3, 4])
      for (const note of notes) {
        expect((note.step - startStep) % 3, `seed ${seed}: step ${note.step} is off the visited grid`).toBe(0)
      }
    }
  })

  it('reproduces identical notes for the same seed after the segment change', () => {
    for (const density of [50, 75]) {
      const options = { ...base, rate: '1/8d' as const, density, seed: 123, chords: [cChord, gChord] }
      expect(generateArpeggio(options)).toEqual(generateArpeggio(options))
    }
  })
})
