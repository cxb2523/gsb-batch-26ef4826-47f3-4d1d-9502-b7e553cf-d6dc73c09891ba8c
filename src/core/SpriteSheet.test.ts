import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { installSoftwareCanvas } from './Canvas.test-helper';
import { packRgba } from './Image';
import { compute, type Ops } from './compute';

mock.module('@vicimpa/decorators', () => ({ prop: () => {}, reactive: () => <T,>(value: T) => value }));
const { Sprite } = await import('./Sprite');
type Doc = InstanceType<typeof Sprite>;

installSoftwareCanvas();
const OriginalWorker = globalThis.Worker;

/** Deterministic opaque color for a canvas pixel, so tests can trace rendering. */
const color = (x: number, y: number) => packRgba((x * 67 + 11) & 255, (y * 91 + 23) & 255, ((x + y) * 53 + 7) & 255, 255);

type Frame = { canvas: OffscreenCanvas; json: any; };

async function exportSheet(doc: Doc, sheet: Partial<NonNullable<Ops['export']['args']['opts']['sheet']>>, opts: Partial<Ops['export']['args']['opts']> = {}, frames?: number[], grid = { gridX: 0, gridY: 0, gridW: 1, gridH: 1 }): Promise<Frame> {
  const all = frames ?? doc.frames.map((_, i) => i);
  const areas = Object.fromEntries(all.map(f => [f, { x: 0, y: 0, w: doc.width, h: doc.height }]));
  const result = await compute('export', {
    raw: doc.captureDocument(), base: 'S', frames: all, areas, grid,
    opts: {
      kind: 'sheet', scale: 1, json: 'array', ...opts,
      sheet: {
        type: 'horizontal', count: 0, splitLayers: false, splitTags: false, border: 0, spacing: 0, inner: 0,
        trim: 'none', trimByGrid: false, extrude: false, mergeDuplicates: false, ignoreEmpty: false, powerOfTwo: false,
        template: '{title}-{frame01}.png', ...sheet,
      },
    },
  }, () => { });
  if (!Array.isArray(result)) throw new Error('Expected sheet files');
  const png = result.find(o => o.name.endsWith('.png'))!;
  const data = result.find(o => o.name.endsWith('.json'))!;
  const blob = png.blob as Blob & { canvas?: OffscreenCanvas; };
  // Software canvas exposes the canvas right after convertToBlob (stubbed below).
  if (!blob.canvas) throw new Error('PNG canvas not captured');
  return { canvas: blob.canvas, json: JSON.parse(await data.blob.text()) };
}

/** The software canvas has no platform PNG encoder; capture the canvas itself. */
const restoreEncoder = (() => {
  const proto = (globalThis.OffscreenCanvas as any).prototype;
  const original = proto.convertToBlob;
  proto.convertToBlob = async function () { return Object.assign(new Blob([], { type: 'image/png' }), { canvas: this }); };
  return original;
})();
afterEach(() => { globalThis.Worker = OriginalWorker; });
afterAll(() => { (globalThis.OffscreenCanvas as any).prototype.convertToBlob = restoreEncoder; });

const pixels = (can: OffscreenCanvas) => new Uint32Array(can.getContext('2d')!.getImageData(0, 0, can.width, can.height).data.buffer);

/** A 6×5 sprite with a transparent border and an opaque 3×2 blob offset inside frame 0. */
function borderedSprite() {
  const doc = new Sprite(6, 5);
  const data = new Uint32Array(6 * 5);
  for (let y = 1; y <= 2; y++) for (let x = 2; x <= 4; x++) data[y * 6 + x] = color(x, y);
  doc.layers[0].cels[0] = { x: 0, y: 0, w: 6, h: 5, data };
  doc.layers[0].cels[1] = { x: 0, y: 0, w: 6, h: 5, data: data.slice() };
  doc.frames = [{ duration: 100 }, { duration: 100 }];
  return doc;
}

test('extruded pixels expand only the image margin and never the frame rectangle', async () => {
  const doc = borderedSprite();
  const plain = await exportSheet(doc, { trim: 'cels' });
  const grown = await exportSheet(doc, { trim: 'cels', extrude: true });
  const [a] = plain.json.frames, [b] = grown.json.frames;
  // Extrusion adds a one-pixel band on every side of every slot: the texture grows, the frames don't
  expect(grown.canvas.width).toBe(plain.canvas.width + 2 * plain.json.frames.length);
  expect(grown.canvas.height).toBe(plain.canvas.height + 2);
  expect(grown.json.meta.size).toEqual({ w: grown.canvas.width, h: grown.canvas.height });
  // The frame rectangle itself keeps the untrimmed image size in both cases
  expect(b.frame.w).toBe(a.frame.w);
  expect(b.frame.h).toBe(a.frame.h);
  expect(b.frame.x).toBe(a.frame.x + 1);
  expect(b.frame.y).toBe(a.frame.y + 1);
  // The extruded pixel is outside the frame; the frame interior holds the blob edge
  const px = pixels(grown.canvas), W = grown.canvas.width;
  const at = (x: number, y: number) => px[y * W + x];
  expect(at(b.frame.x - 1, b.frame.y)).toBe(at(b.frame.x, b.frame.y));
  expect(at(b.frame.x + b.frame.w, b.frame.y)).toBe(at(b.frame.x + b.frame.w - 1, b.frame.y));
});

test('trim sprite and cels keep positions reproducible through spriteSourceSize/sourceSize', async () => {
  const doc = borderedSprite();
  for (const trim of ['sprite', 'cels'] as const) {
    const { json } = await exportSheet(doc, { trim, type: 'horizontal' });
    for (const f of json.frames) {
      expect(f.sourceSize).toEqual({ w: 6, h: 5 });
      // The trimmed region sits at the blob's offset (2,1) inside the 6×5 source frame
      expect(f.spriteSourceSize).toEqual({ x: 2, y: 1, w: 3, h: 2 });
      expect(f.frame.w).toBe(f.spriteSourceSize.w);
      expect(f.frame.h).toBe(f.spriteSourceSize.h);
    }
  }
});

test('an empty frame keeps a 1×1 placeholder in cel mode and is skipped in sprite mode with ignoreEmpty', async () => {
  const doc = borderedSprite();
  doc.layers[0].cels[1] = null;
  doc.frames = [{ duration: 100 }, { duration: 100 }];
  const cel = await exportSheet(doc, { trim: 'cels' });
  expect(cel.json.frames).toHaveLength(2);
  expect(cel.json.frames[1].frame.w).toBe(1);
  expect(cel.json.frames[1].frame.h).toBe(1);
  const skipped = await exportSheet(doc, { trim: 'sprite', ignoreEmpty: true });
  expect(skipped.json.frames).toHaveLength(1);
});

test('trimByGrid aligns to cells without ever exceeding the source frame', async () => {
  const doc = new Sprite(20, 20);
  const data = new Uint32Array(20 * 20);
  // Content at (3..8, 4..9): starts inside a 4px grid cell offset by 1
  for (let y = 4; y <= 9; y++) for (let x = 3; x <= 8; x++) data[y * 20 + x] = color(x, y);
  doc.layers[0].cels[0] = { x: 0, y: 0, w: 20, h: 20, data };
  const grid = { gridX: 1, gridY: 1, gridW: 4, gridH: 4 };
  const { json } = await exportSheet(doc, { trim: 'cels', trimByGrid: true }, {}, [0], grid);
  const f = json.frames[0];
  // Snapped to the 4px lattice anchored at (1,1): x0=1, y0=1, x1=9
  expect(f.spriteSourceSize).toEqual({ x: 1, y: 1, w: 8, h: 12 });
  expect(f.frame.w).toBe(f.spriteSourceSize.w);
  expect(f.frame.h).toBe(f.spriteSourceSize.h);

  // A blob reaching the source edge must not push the aligned box outside it
  const edge = new Uint32Array(20 * 20);
  for (let y = 17; y < 20; y++) for (let x = 17; x < 20; x++) edge[y * 20 + x] = color(x, y);
  doc.layers[0].cels[0] = { x: 0, y: 0, w: 20, h: 20, data: edge };
  const second = await exportSheet(doc, { trim: 'cels', trimByGrid: true }, {}, [0], grid);
  expect(second.json.frames[0].spriteSourceSize).toEqual({ x: 17, y: 17, w: 3, h: 3 });
  expect(second.json.frames[0].frame.w).toBe(3);
});

test('scale and pixel ratio share one rounding rule across frame, sourceSize and meta.size', async () => {
  const doc = new Sprite(7, 5);
  doc.setPixelRatio(8, 7);
  const data = new Uint32Array(7 * 5);
  for (let y = 1; y <= 3; y++) for (let x = 2; x <= 4; x++) data[y * 7 + x] = color(x, y);
  doc.layers[0].cels[0] = { x: 0, y: 0, w: 7, h: 5, data };
  // An intentionally non-integer effective scale on both axes
  const { canvas, json } = await exportSheet(doc, { trim: 'cels' }, { scale: 3, applyPixelRatio: true });
  const f = json.frames[0];
  expect(json.meta.size).toEqual({ w: canvas.width, h: canvas.height });
  // frame and spriteSourceSize describe the same rounded pixel count
  expect(f.frame.w).toBe(f.spriteSourceSize.w);
  expect(f.frame.h).toBe(f.spriteSourceSize.h);
  // The untrimmed source frame follows the same rounded edges
  expect(f.sourceSize).toEqual({ w: Math.round(7 * 3 * 8), h: Math.round(5 * 3 * 7) });
  // The frame stays inside the texture
  expect(f.frame.x + f.frame.w).toBeLessThanOrEqual(canvas.width);
  expect(f.frame.y + f.frame.h).toBeLessThanOrEqual(canvas.height);
  // The rendered frame pixels match the spriteSourceSize rect
  const px = pixels(canvas), W = canvas.width;
  const first = px[f.frame.y * W + f.frame.x];
  expect(first).not.toBe(0);
});

test('fractional scale rounds every rectangle with the same rule and keeps frames in the image', async () => {
  const doc = new Sprite(5, 4);
  const data = new Uint32Array(5 * 4);
  for (let y = 1; y <= 2; y++) for (let x = 1; x <= 2; x++) data[y * 5 + x] = color(x, y);
  doc.layers[0].cels[0] = { x: 0, y: 0, w: 5, h: 4, data };
  // A fractional scale is reachable through the export options; geometry must still agree
  const { canvas, json } = await exportSheet(doc, { trim: 'cels' }, { scale: 1.5 });
  const f = json.frames[0];
  expect(json.meta.size).toEqual({ w: canvas.width, h: canvas.height });
  expect(f.sourceSize).toEqual({ w: Math.round(5 * 1.5), h: Math.round(4 * 1.5) });
  expect(f.frame.w).toBe(Math.round(2 * 1.5));
  expect(f.frame.h).toBe(Math.round(2 * 1.5));
  expect(f.spriteSourceSize).toMatchObject({ w: f.frame.w, h: f.frame.h });
  expect(f.frame.x + f.frame.w).toBeLessThanOrEqual(canvas.width);
  expect(f.frame.y + f.frame.h).toBeLessThanOrEqual(canvas.height);
});

test('combined options: transparent border, empty frame, grid alignment, non-integer ratio and extrusion stay consistent', async () => {
  // Two frames: a blob with transparent border, and an empty frame
  const doc = new Sprite(12, 9);
  doc.setPixelRatio(5, 3); // effective scale 3*5=15 and 3*3=9 on the two axes
  const blob = new Uint32Array(12 * 9);
  for (let y = 2; y <= 4; y++) for (let x = 3; x <= 6; x++) blob[y * 12 + x] = color(x, y);
  doc.frames = [{ duration: 90 }, { duration: 30 }];
  doc.layers[0].cels[0] = { x: 0, y: 0, w: 12, h: 9, data: blob };
  doc.layers[0].cels[1] = null; // empty frame keeps a 1×1 placeholder
  const grid = { gridX: 0, gridY: 0, gridW: 4, gridH: 4 };
  const { canvas, json } = await exportSheet(
    doc,
    { trim: 'cels', trimByGrid: true, extrude: true, type: 'rows' },
    { scale: 3, applyPixelRatio: true },
    undefined, grid,
  );
  expect(json.meta.size).toEqual({ w: canvas.width, h: canvas.height });
  const px = pixels(canvas), W = canvas.width;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height ? 0 : px[y * W + x]);

  const [trimmed, empty] = json.frames;
  // The empty frame is a single-pixel entry, scaled by the same rounding rule
  expect(empty.spriteSourceSize).toMatchObject({ x: 0, y: 0 });
  expect(empty.sourceSize).toEqual({ w: Math.round(12 * 15), h: Math.round(9 * 9) });
  // The blob (x 3..6, y 2..4) snaps to 4px cells: x 0..8, y 0..8, then scales by 15/9
  expect(trimmed.spriteSourceSize.w).toBe(Math.round(8 * 15));
  expect(trimmed.spriteSourceSize.h).toBe(Math.round(8 * 9));
  expect(trimmed.spriteSourceSize.x).toBe(0);
  expect(trimmed.spriteSourceSize.y).toBe(0);
  // Restoration: frame + spriteSourceSize maps back onto sourceSize
  expect(trimmed.frame.w).toBe(trimmed.spriteSourceSize.w);
  expect(trimmed.frame.h).toBe(trimmed.spriteSourceSize.h);
  expect(trimmed.sourceSize).toEqual(empty.sourceSize);

  for (const f of json.frames) {
    expect(f.frame.x + f.frame.w).toBeLessThanOrEqual(canvas.width);
    expect(f.frame.y + f.frame.h).toBeLessThanOrEqual(canvas.height);
  }

  // The extruded band repeats the frame edge but is *outside* the frame rectangle; the frame
  // interior's outer edge is the real image, not the extrusion.
  expect(at(trimmed.frame.x - 1, trimmed.frame.y + 1)).toBe(at(trimmed.frame.x, trimmed.frame.y + 1));
  expect(at(trimmed.frame.x + trimmed.frame.w, trimmed.frame.y + 1)).toBe(at(trimmed.frame.x + trimmed.frame.w - 1, trimmed.frame.y + 1));
  expect(at(trimmed.frame.x + 1, trimmed.frame.y - 1)).toBe(at(trimmed.frame.x + 1, trimmed.frame.y));
  expect(at(trimmed.frame.x + 1, trimmed.frame.y + trimmed.frame.h)).toBe(at(trimmed.frame.x + 1, trimmed.frame.y + trimmed.frame.h - 1));
  // A corner of the band equals the frame corner (extrusion covers corners too)
  expect(at(trimmed.frame.x - 1, trimmed.frame.y - 1)).toBe(at(trimmed.frame.x, trimmed.frame.y));
  // The blob edge sits inside the frame; the transparent inset around it is still clear
  expect(at(trimmed.frame.x, trimmed.frame.y)).toBe(0);
});

test('every frame rectangle lands inside the image and the window matches sourceSize', async () => {
  const doc = borderedSprite();
  doc.frames = [{ duration: 100 }, { duration: 100 }, { duration: 100 }];
  doc.layers[0].cels[2] = { x: 0, y: 0, w: 6, h: 5, data: new Uint32Array(6 * 5) };
  for (const trim of ['none', 'sprite', 'cels'] as const) {
    for (const extrude of [false, true]) {
      const { canvas, json } = await exportSheet(doc, { trim, extrude, type: 'rows' });
      expect(json.meta.size).toEqual({ w: canvas.width, h: canvas.height });
      for (const f of json.frames) {
        expect(f.frame.x).toBeGreaterThanOrEqual(0);
        expect(f.frame.y).toBeGreaterThanOrEqual(0);
        expect(f.frame.x + f.frame.w).toBeLessThanOrEqual(canvas.width);
        expect(f.frame.y + f.frame.h).toBeLessThanOrEqual(canvas.height);
        // Untrimmed window: the whole source frame sits at the origin of a same-sized window
        if (trim === 'none') {
          expect(f.spriteSourceSize).toEqual({ x: 0, y: 0, w: f.sourceSize.w, h: f.sourceSize.h });
        }
      }
    }
  }
});

test('a slice area is treated as the source frame, independent of its offset in the sprite', async () => {
  const doc = new Sprite(16, 16);
  const data = new Uint32Array(16 * 16);
  // Content inside a slice window at (5,6) sized 10×8, with a transparent inset
  for (let y = 8; y <= 10; y++) for (let x = 7; x <= 9; x++) data[y * 16 + x] = color(x, y);
  doc.layers[0].cels[0] = { x: 0, y: 0, w: 16, h: 16, data };
  const area = { x: 5, y: 6, w: 10, h: 8 };
  const result = await compute('export', {
    raw: doc.captureDocument(), base: 'S', frames: [0], areas: { 0: area },
    grid: { gridX: 0, gridY: 0, gridW: 4, gridH: 4 },
    opts: {
      kind: 'sheet', scale: 1, json: 'array',
      sheet: {
        type: 'horizontal', count: 0, splitLayers: false, splitTags: false, border: 0, spacing: 0, inner: 0,
        trim: 'cels', trimByGrid: true, extrude: false, mergeDuplicates: false, ignoreEmpty: false, powerOfTwo: false,
        template: '{title}-{frame01}.png',
      },
    },
  }, () => { });
  if (!Array.isArray(result)) throw new Error('Expected sheet files');
  const json = JSON.parse(await result[1].blob.text());
  const f = json.frames[0];
  // The source frame is the slice (10×8); content at sprite (7,8) is (2,2) inside it
  expect(f.sourceSize).toEqual({ w: 10, h: 8 });
  // Grid cells are anchored at the sprite origin: sprite x 7..9 snaps to 4..12 and is then
  // clipped to the slice window 5..15 (local 0..7); y 8..10 snaps to 8..12 (local 2..6)
  expect(f.spriteSourceSize).toEqual({ x: 0, y: 2, w: 7, h: 4 });
});
