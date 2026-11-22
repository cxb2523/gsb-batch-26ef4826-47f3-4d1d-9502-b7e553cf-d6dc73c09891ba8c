import { afterEach, describe, expect, it, vi } from 'vitest'
import { SpriteLayer, SPRITE_FLIP_X, SPRITE_FLIP_Y } from '../spriteLayer'
import type { PickSource } from '../spritePick'

afterEach(() => vi.restoreAllMocks())

/**
 * A fake mutable canvas whose pixels the test can repaint between picks. `readAtlasMask`
 * draws it onto a scratch canvas and calls `getImageData`, so we mock `document.createElement`
 * to hand back a 2D context serving this source's current pixels. No real image resource is used.
 */
class FakePixelSource {
  readonly width: number
  readonly height: number
  /** Current RGBA pixels; `paint()` replaces them. */
  pixels: Uint8ClampedArray
  /** When true, reading pixels throws (e.g. a cross-origin / unreadable canvas). */
  unreadable = false
  /** Count of successful alpha-mask reads performed against this source. */
  reads = 0
  /** Count of read attempts (including failures) so retry behaviour can be observed. */
  attempts = 0

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.pixels = new Uint8ClampedArray(width * height * 4)
  }

  /** Repaint: run `fn(x, y, px)` over every pixel to set its RGBA values. */
  paint(fn: (x: number, y: number, px: Uint8ClampedArray, i: number) => void): this {
    const { width: w, height: h, pixels: px } = this
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) fn(x, y, px, (y * w + x) * 4)
    return this
  }

  /** Fully opaque source. */
  opaque(): this {
    return this.paint((_x, _y, px, i) => {
      px[i + 3] = 255
    })
  }

  /** Fully transparent source. */
  transparent(): this {
    return this.paint((_x, _y, px, i) => {
      px[i + 3] = 0
    })
  }

  /** Opaque only in the left half. */
  leftHalfOpaque(): this {
    const w = this.width
    return this.paint((x, _y, px, i) => {
      px[i + 3] = x < w / 2 ? 255 : 0
    })
  }

  /** Opaque only in the right half. */
  rightHalfOpaque(): this {
    const w = this.width
    return this.paint((x, _y, px, i) => {
      px[i + 3] = x >= w / 2 ? 255 : 0
    })
  }

  asSource(): PickSource {
    return this as unknown as PickSource
  }
}

/**
 * Route every scratch-canvas 2D context created by `readAtlasMask` at the registered fake
 * sources. `readAtlasMask` draws the requested source then reads it back on the same context,
 * so the source handed to `drawImage` identifies which pixels `getImageData` must serve.
 */
function mockCanvasPixels(active: { current: FakePixelSource[] }) {
  const createElement = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const el = createElement(tag)
    if (tag === 'canvas') {
      let drawn: FakePixelSource | null = null
      Object.defineProperty(el, 'getContext', {
        configurable: true,
        value: () => ({
          drawImage(src: unknown) {
            const found = active.current.find((s) => s.asSource() === src)
            if (!found) throw new Error('drawImage from an unregistered pixel source')
            drawn = found
          },
          getImageData(_x: number, _y: number, w: number, h: number) {
            const found = drawn ?? active.current.find((s) => s.width === w && s.height === h)
            drawn = null
            if (!found) throw new Error('getImageData for an unregistered pixel source')
            found.attempts++
            if (found.unreadable) throw new Error('canvas is tainted')
            found.reads++
            return { data: found.pixels }
          },
        }),
      })
    }
    return el
  })
}

describe('SpriteLayer picking stays consistent with repainted atlas canvases', () => {
  it('markAtlasDirty makes the next pick use the repainted pixels (alpha test)', () => {
    const src = new FakePixelSource(16, 16).leftHalfOpaque()
    const active = { current: [src] }
    mockCanvasPixels(active)

    const layer = new SpriteLayer({ image: src.asSource() as HTMLCanvasElement, anchorX: 0, anchorY: 0 })
    layer.add(0, 0, 16, 16, 0, 1)
    const firstReads = src.reads

    // Left half opaque, right half transparent: only the left side hits above the threshold.
    expect(layer.pickIndex(4, 8, { alpha: 10 })).toBe(0)
    expect(layer.pickIndex(12, 8, { alpha: 10 })).toBe(-1)
    expect(src.reads).toBe(firstReads + 1)

    // Repaint in place (same canvas object, pixels swapped under it): without markAtlasDirty
    // the cached mask would still describe the old painting.
    src.rightHalfOpaque()
    layer.markAtlasDirty()
    expect(layer.pickIndex(4, 8, { alpha: 10 })).toBe(-1)
    expect(layer.pickIndex(12, 8, { alpha: 10 })).toBe(0)
    expect(src.reads).toBe(firstReads + 2) // exactly one re-read for the first pick after dirty

    // And it is cached again afterwards: repeated picks do not re-read.
    layer.pickIndex(12, 8, { alpha: 10 })
    layer.pickIndex(4, 8, { alpha: 10 })
    expect(src.reads).toBe(firstReads + 2)
  })

  it('markAtlasDirty refreshes cached opaque bounds, not only the alpha mask', () => {
    const src = new FakePixelSource(16, 16).leftHalfOpaque()
    mockCanvasPixels({ current: [src] })

    const layer = new SpriteLayer({
      image: src.asSource() as HTMLCanvasElement,
      hit: 'opaque',
      anchorX: 0,
      anchorY: 0,
    })
    layer.add(0, 0, 16, 16, 0, 1)

    // Opaque bounds = left half: the right half is not hittable even though it is inside the quad.
    expect(layer.pickIndex(4, 8)).toBe(0)
    expect(layer.pickIndex(12, 8)).toBe(-1)

    src.rightHalfOpaque()
    layer.markAtlasDirty()
    expect(layer.pickIndex(4, 8)).toBe(-1)
    expect(layer.pickIndex(12, 8)).toBe(0)

    // A fully transparent repaint makes the whole frame unhittable; an opaque one restores it.
    src.transparent()
    layer.markAtlasDirty()
    expect(layer.pickIndex(8, 8)).toBe(-1)
    src.opaque()
    layer.markAtlasDirty()
    expect(layer.pickIndex(8, 8)).toBe(0)
  })

  it('masks stay per-atlas: two atlases sharing one canvas keep independent versions', () => {
    const shared = new FakePixelSource(16, 16).opaque()
    mockCanvasPixels({ current: [shared] })

    const canvas = shared.asSource() as HTMLCanvasElement
    const layer = new SpriteLayer({
      atlases: [
        { image: canvas, frameWidth: 16, frameHeight: 16 },
        { image: canvas, frameWidth: 16, frameHeight: 16 },
      ],
      anchorX: 0,
      anchorY: 0,
    })
    layer.add(0, 0, 16, 16, 0, 10) // slot 0 -> atlas 0
    layer.add(100, 0, 16, 16, 0, 20)
    layer.atlas[1] = 1 // slot 1 -> atlas 1

    // Both atlases read their own mask from the shared canvas.
    expect(layer.pickIndex(8, 8, { alpha: 10 })).toBe(0)
    expect(layer.pickIndex(108, 8, { alpha: 10 })).toBe(1)
    const readsAfterWarmup = shared.reads
    expect(readsAfterWarmup).toBe(2)

    // Repaint once, dirty only atlas 0: atlas 1 must keep hitting (its cached pixels are still
    // valid for it) while atlas 0 re-reads and starts missing on the transparent half.
    shared.leftHalfOpaque()
    layer.markAtlasDirty(0)
    expect(layer.pickIndex(12, 8, { alpha: 10 })).toBe(-1) // atlas 0: fresh mask, right half transparent
    expect(layer.pickIndex(108, 8, { alpha: 10 })).toBe(1) // atlas 1: untouched mask still fully opaque
    expect(shared.reads).toBe(readsAfterWarmup + 1)

    // Dirtying atlas 1 separately re-reads it and brings it in line.
    layer.markAtlasDirty(1)
    expect(layer.pickIndex(108, 8, { alpha: 10 })).toBe(-1)
    expect(layer.pickIndex(104, 8, { alpha: 10 })).toBe(1)
    expect(shared.reads).toBe(readsAfterWarmup + 2)
  })

  it('replacing an atlas image source invalidates its mask without touching other atlases', () => {
    const a = new FakePixelSource(16, 16).leftHalfOpaque()
    const b = new FakePixelSource(16, 16).rightHalfOpaque()
    mockCanvasPixels({ current: [a, b] })

    const layer = new SpriteLayer({
      atlases: [
        { image: a.asSource() as HTMLCanvasElement, frameWidth: 16, frameHeight: 16 },
        { image: a.asSource() as HTMLCanvasElement, frameWidth: 16, frameHeight: 16 },
      ],
      anchorX: 0,
      anchorY: 0,
    })
    layer.add(0, 0, 16, 16, 0, 10)
    layer.add(100, 0, 16, 16, 0, 20)
    layer.atlas[1] = 1

    expect(layer.pickIndex(4, 8, { alpha: 10 })).toBe(0)
    expect(layer.pickIndex(12, 8, { alpha: 10 })).toBe(-1)
    expect(layer.pickIndex(104, 8, { alpha: 10 })).toBe(1) // atlas 1 also on the left-half source
    expect(layer.pickIndex(112, 8, { alpha: 10 })).toBe(-1)

    // Swap only atlas 1 to the right-half source (no markAtlasDirty: the source object changed).
    layer.atlases[1].image = b.asSource() as HTMLCanvasElement
    expect(layer.pickIndex(112, 8, { alpha: 10 })).toBe(1)
    expect(layer.pickIndex(104, 8, { alpha: 10 })).toBe(-1)
    // Atlas 0's mask is untouched and still describes source a.
    expect(layer.pickIndex(4, 8, { alpha: 10 })).toBe(0)
    expect(layer.pickIndex(12, 8, { alpha: 10 })).toBe(-1)
  })

  it('an unreadable / not-yet-loaded source is retried every pick instead of caching the failure', () => {
    const src = new FakePixelSource(16, 16).opaque()
    src.unreadable = true
    mockCanvasPixels({ current: [src] })

    const layer = new SpriteLayer({ image: src.asSource() as HTMLCanvasElement, anchorX: 0, anchorY: 0 })
    layer.add(0, 0, 16, 16, 0, 1)

    // Pixels cannot be read: the alpha test degrades to "hittable" and nothing is cached.
    expect(layer.pickIndex(8, 8, { alpha: 10 })).toBe(0)
    expect(src.attempts).toBe(1)
    expect(src.reads).toBe(0)
    layer.pickIndex(8, 8, { alpha: 10 })
    expect(src.attempts).toBe(2) // retried, not served from a cached miss
    expect(src.reads).toBe(0)

    // Once readable, the next pick gets real pixels and caches them.
    src.unreadable = false
    src.transparent()
    expect(layer.pickIndex(8, 8, { alpha: 10 })).toBe(-1)
    expect(src.reads).toBe(1)
    layer.pickIndex(8, 8, { alpha: 10 })
    expect(src.attempts).toBe(3)
    expect(src.reads).toBe(1) // cached success
  })

  it('a zero-size (not loaded) source starts reading pixels once it gains dimensions', () => {
    const src = new FakePixelSource(16, 16).opaque()
    // Start "not loaded": no dimensions yet, so readAtlasMask must bail before touching pixels.
    Object.defineProperty(src, 'width', { configurable: true, value: 0 })
    Object.defineProperty(src, 'height', { configurable: true, value: 0 })
    mockCanvasPixels({ current: [src] })

    const layer = new SpriteLayer({ image: src.asSource() as HTMLCanvasElement, anchorX: 0, anchorY: 0 })
    layer.add(0, 0, 16, 16, 0, 1)

    expect(layer.pickIndex(8, 8, { alpha: 10 })).toBe(0) // unloaded: treated as hittable, nothing cached
    expect(src.reads).toBe(0) // readAtlasMask bails before getImageData for a zero-size source

    // "Load completes": the same source object now reports real dimensions and pixels.
    Object.defineProperty(src, 'width', { configurable: true, value: 16 })
    Object.defineProperty(src, 'height', { configurable: true, value: 16 })
    expect(layer.pickIndex(8, 8, { alpha: 10 })).toBe(0)
    expect(src.reads).toBe(1)

    // After the load, a transparent repaint is respected through the normal dirty path.
    src.transparent()
    layer.markAtlasDirty()
    expect(layer.pickIndex(8, 8, { alpha: 10 })).toBe(-1)
  })

  it('invalidateHitMasks still force-clears every cache (including without markAtlasDirty)', () => {
    const a = new FakePixelSource(16, 16).opaque()
    const b = new FakePixelSource(16, 16).opaque()
    mockCanvasPixels({ current: [a, b] })

    const layer = new SpriteLayer({
      atlases: [
        { image: a.asSource() as HTMLCanvasElement, frameWidth: 16, frameHeight: 16 },
        { image: b.asSource() as HTMLCanvasElement, frameWidth: 16, frameHeight: 16 },
      ],
      anchorX: 0,
      anchorY: 0,
    })
    layer.add(0, 0, 16, 16, 0, 10)
    layer.add(100, 0, 16, 16, 0, 20)
    layer.atlas[1] = 1
    layer.pickIndex(8, 8, { alpha: 10 })
    layer.pickIndex(108, 8, { alpha: 10 })
    expect(a.reads).toBe(1)
    expect(b.reads).toBe(1)

    // Repaint the canvases directly and force-clear instead of bumping imageVersion.
    a.transparent()
    b.transparent()
    layer.invalidateHitMasks()
    expect(layer.pickIndex(8, 8, { alpha: 10 })).toBe(-1)
    expect(layer.pickIndex(108, 8, { alpha: 10 })).toBe(-1)
    expect(a.reads).toBe(2)
    expect(b.reads).toBe(2)

    // The public API still exists and is callable when nothing was cached.
    layer.invalidateHitMasks()
    expect(() => layer.invalidateHitMasks()).not.toThrow()
  })

  it('cache invalidation does not change hit rules: draw order, flips, anchors and the alpha threshold', () => {
    // 16x16 source: opaque texels only in the top-left 8x8.
    const src = new FakePixelSource(16, 16).paint((x, y, px, i) => {
      px[i + 3] = x < 8 && y < 8 ? 255 : 0
    })
    mockCanvasPixels({ current: [src] })

    const layer = new SpriteLayer({
      image: src.asSource() as HTMLCanvasElement,
      sortByKey: true,
      anchorX: 0.5,
      anchorY: 0.5,
    })
    // Two overlapping sprites; slot 0 sorts first (drawn below), slot 1 on top.
    layer.add(0, 0, 16, 16, 0, 100)
    layer.add(0, 0, 16, 16, 0, 200)
    layer.sortKey[0] = 0
    layer.sortKey[1] = 1
    // Quad of each spans -8..8 on both axes (centred anchor). Opaque texels are top-left,
    // i.e. world x,y in [-8, 0).
    expect(layer.pickIndex(-4, -4, { alpha: 10 })).toBe(1) // topmost wins on an opaque texel
    expect(layer.pickIndex(4, 4, { alpha: 10 })).toBe(-1) // transparent texel misses

    // Flip X on the top sprite: its opaque texels now sit at world x in (0, 8].
    layer.flags[1] |= SPRITE_FLIP_X
    expect(layer.pickIndex(4, -4, { alpha: 10 })).toBe(1)
    expect(layer.pickIndex(-4, -4, { alpha: 10 })).toBe(0) // lower sprite now wins there

    // Flip Y too, then repaint and dirty: the same rules must apply to the re-read mask.
    layer.flags[1] |= SPRITE_FLIP_Y
    src.paint((x, y, px, i) => {
      px[i + 3] = x >= 8 && y >= 8 ? 255 : 0 // opaque now in the bottom-right 8x8
    })
    layer.markAtlasDirty()
    // Sprite 1 flipped on both axes: its bottom-right atlas quadrant maps to world top-left.
    expect(layer.pickIndex(-4, -4, { alpha: 10 })).toBe(1)
    expect(layer.pickIndex(4, 4, { alpha: 10 })).toBe(0) // sprite 1 misses here; unflipped sprite 0 hits
    // Threshold semantics survive the re-read: alpha 255 > 200 hits, a transparent texel does not.
    expect(layer.pickIndex(-4, -4, { alpha: 200 })).toBe(1)
    expect(layer.pickIndex(-4, 4, { alpha: 200 })).toBe(-1) // both sprites map transparent texels here
  })

  it('a mask re-read through a pixelSource resolver follows the same rules as an image atlas', () => {
    const src = new FakePixelSource(16, 16).leftHalfOpaque()
    mockCanvasPixels({ current: [src] })

    const layer = new SpriteLayer({ dynamicSrc: 'dyn', anchorX: 0, anchorY: 0 })
    layer.pixelSource = () => src.asSource()
    layer.add(0, 0, 16, 16, 0, 1)

    expect(layer.pickIndex(4, 8, { alpha: 10 })).toBe(0)
    expect(layer.pickIndex(12, 8, { alpha: 10 })).toBe(-1)

    // A dynamic canvas is repainted and re-uploaded; bumping imageVersion (the same signal
    // markAtlasDirty sends) must refresh the resolver-fed mask too.
    src.rightHalfOpaque()
    layer.atlases[0].imageVersion = (layer.atlases[0].imageVersion ?? 0) + 1
    expect(layer.pickIndex(4, 8, { alpha: 10 })).toBe(-1)
    expect(layer.pickIndex(12, 8, { alpha: 10 })).toBe(0)
  })
})
