/**
 * Sprite sheet builder: collects samples (frame × layer × tag), trims them, merges duplicates,
 * lays them out, renders the texture and describes it as JSON.
 */

import { opaqueBounds, type Rect } from "~/core/Image";
import type { SpriteContext } from "./SpriteContext";
import { parentOf, type Tag } from "~/core/SpriteModel";

export type SheetType = 'horizontal' | 'vertical' | 'rows' | 'columns' | 'packed';
export type TrimMode = 'none' | 'sprite' | 'cels';

export type SheetOptions = {
  type: SheetType;
  /** Cells per row ('rows') or per column ('columns'); 0 = automatic */
  count: number;
  frames: number[];
  /** Only this layer; otherwise all visible layers */
  layer?: number;
  splitLayers: boolean;
  splitTags: boolean;
  border: number;
  spacing: number;
  inner: number;
  trim: TrimMode;
  /** Grow trimmed boxes outward to whole grid cells */
  trimByGrid: boolean;
  /** Repeat the edge pixels one pixel outward (avoids seams when textures are filtered) */
  extrude: boolean;
  mergeDuplicates: boolean;
  ignoreEmpty: boolean;
  powerOfTwo: boolean;
  scale: number;
  /** File name template for frame names in the data file */
  template: string;
  /** Exported part of each frame (slice / selection); frames sit at the top-left of the largest one */
  area?: (frame: number) => Rect | null;
};

type Sample = {
  frame: number;
  layer: number | null;
  tag: Tag | null;
  /** Position of the frame inside its tag (or the export) */
  index: number;
  data: Uint32Array;
  /** Top-left of the exported area in sprite coordinates (0,0 for the whole canvas) */
  origin: { x: number; y: number; };
  /** Trimmed source rectangle inside the (area-sized) sample, in sample pixels */
  src: Rect;
  /** Size of the untrimmed source frame (the exported area, or the whole sprite) */
  source: { w: number; h: number };
  /** Placement shared by identical samples */
  slot: Slot;
  /** Frame rectangle in the output texture (excludes inner padding and extruded edges) */
  rect: Rect;
  /** Trimmed region in output pixels, relative to the untrimmed source frame */
  spriteSource: Rect;
  /** Untrimmed source frame size in output pixels */
  sourceSize: { w: number; h: number; };
  /** Extruded band around the frame, in output pixels (zeros when not extruding) */
  extrude: { left: number; top: number; right: number; bottom: number; };
};

type Slot = { w: number; h: number; x: number; y: number; band: string; };

export type Sheet = ReturnType<typeof buildSheet>;

/** Default frame name: title, (layer), #tag, frame number, extension */
export function defaultTemplate(o: Pick<SheetOptions, 'splitLayers' | 'splitTags' | 'frames'>) {
  return `{title}${o.splitLayers ? ' ({layer})' : ''}${o.splitTags ? ' #{tag}' : ''}${o.frames.length > 1 ? ' {frame}' : ''}.{extension}`;
}

/** Fills `{var}` placeholders; frame numbers take a base and zero padding from a suffix: {frame01} */
export function fillTemplate(t: string, vars: Record<string, string>, frame: number, tagFrame: number) {
  return t.replace(/\{(\w+?)(\d*)\}/g, (all, name: string, digits: string) => {
    if (name === 'frame' || name === 'tagframe') {
      const n = (name === 'frame' ? frame : tagFrame) + (digits ? +digits : 0);
      return String(n).padStart(digits.length, '0');
    }
    return vars[name + digits] ?? vars[name] ?? all;
  });
}

function hash(data: Uint32Array, r: Rect, w: number) {
  let h = 2166136261 ^ r.w ^ (r.h << 12);
  for (let y = r.y; y < r.y + r.h; y++)
    for (let x = r.x; x < r.x + r.w; x++) h = Math.imul(h ^ data[y * w + x], 16777619);
  return `${r.w}x${r.h}:${h >>> 0}`;
}

const pow2 = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(1, n)));

/** Output pixel of a logical edge; every rectangle in the data file uses this rule. */
const edge = (n: number, k: number) => Math.round(n * k);

/** Output texture size from the logical layout size; power-of-two is applied last. */
export function sheetSize(width: number, height: number, kx: number, ky: number, powerOfTwo: boolean) {
  const w = Math.max(1, edge(width, kx)), h = Math.max(1, edge(height, ky));
  return { w: powerOfTwo ? pow2(w) : w, h: powerOfTwo ? pow2(h) : h };
}

/** Rectangle clipped to the source frame; at least one pixel is kept. */
function clampRect(r: Rect, area: { w: number; h: number; }): Rect {
  const x = Math.max(0, Math.min(r.x, area.w - 1));
  const y = Math.max(0, Math.min(r.y, area.h - 1));
  const x1 = Math.max(x + 1, Math.min(area.w, r.x + r.w));
  const y1 = Math.max(y + 1, Math.min(area.h, r.y + r.h));
  return { x, y, w: x1 - x, h: y1 - y };
}

/** Smallest-area shelf packing over a few candidate widths (tallest first) */
function pack(slots: Slot[], spacing: number, border: number) {
  const order = slots.slice().sort((a, b) => b.h - a.h || b.w - a.w);
  const area = slots.reduce((t, s) => t + (s.w + spacing) * (s.h + spacing), 0);
  const widest = Math.max(...slots.map(s => s.w));
  let best: { w: number; h: number; pos: [number, number][]; } | null = null;
  for (let k = 0; k < 24; k++) {
    const limit = Math.max(widest, Math.ceil(Math.sqrt(area) * (0.6 + k * 0.1)));
    const pos: [number, number][] = [];
    let x = 0, y = 0, shelf = 0, w = 0;
    for (const s of order) {
      if (x > 0 && x + s.w > limit) { x = 0; y += shelf + spacing; shelf = 0; }
      pos.push([x, y]);
      x += s.w + spacing;
      shelf = Math.max(shelf, s.h);
      w = Math.max(w, x - spacing);
    }
    const h = y + shelf;
    if (!best || w * h < best.w * best.h || (w * h === best.w * best.h && Math.max(w, h) < Math.max(best.w, best.h)))
      best = { w, h, pos };
  }
  order.forEach((s, i) => { s.x = border + best!.pos[i][0]; s.y = border + best!.pos[i][1]; });
  return { width: best!.w + border * 2, height: best!.h + border * 2 };
}

export type SheetContext = {
  sprite: Pick<SpriteContext, 'width' | 'height' | 'layers' | 'frames' | 'tags' | 'slices' | 'render' | 'visibleDeep'>;
  prefs: { gridX: number; gridY: number; gridW: number; gridH: number };
  /** Pixel aspect ratio baked into the texture; defaults to square pixels */
  ratioX?: number;
  ratioY?: number;
};

export function buildSheet(o: SheetOptions, { sprite, prefs, ratioX = 1, ratioY = 1 }: SheetContext) {
  // The texture is laid out in sprite pixels, then rendered at the output scale: every
  // rectangle in the data file uses the same rounded-edge mapping as the canvas.
  const kx = o.scale * ratioX, ky = o.scale * ratioY;
  const areas = o.area ? o.frames.map(f => o.area!(f)).filter((r): r is Rect => !!r) : [];
  const W = o.area ? Math.max(1, ...areas.map(r => r.w)) : sprite.width;
  const H = o.area ? Math.max(1, ...areas.map(r => r.h)) : sprite.height;

  // 1. Samples
  const layers = o.splitLayers
    ? sprite.layers.map((l, i) => !l.group && sprite.visibleDeep(i) ? i : -1).filter(i => i >= 0).reverse()
    : [o.layer ?? null];
  const tagged = o.splitTags && sprite.tags.length
    ? sprite.tags.map(t => ({ tag: t as Tag | null, frames: o.frames.filter(f => f >= t.from && f <= t.to) })).filter(g => g.frames.length)
    : [{ tag: null as Tag | null, frames: o.frames }];
  const samples: Omit<Sample, 'slot' | 'rect' | 'spriteSource' | 'sourceSize' | 'extrude'>[] = [];
  for (const { tag, frames } of tagged)
    for (const layer of layers)
      frames.forEach((frame, index) => {
        const r = o.area?.(frame) ?? { x: 0, y: 0, w: W, h: H };
        const crop = new OffscreenCanvas(W, H);
        crop.getContext('2d')!.drawImage(sprite.render(frame, layer ?? undefined), r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
        const data = new Uint32Array(crop.getContext('2d')!.getImageData(0, 0, W, H).data.buffer);
        // The untrimmed source is the exported area; sampled content starts at its top-left
        const source = { w: Math.max(1, r.w), h: Math.max(1, r.h) };
        samples.push({ frame, layer, tag, index, data, origin: { x: r.x, y: r.y }, src: { x: 0, y: 0, w: source.w, h: source.h }, source });
      });

  // 2. Trim
  // Grid alignment uses sprite coordinates, so the area offset (slice / selection) is added
  // before snapping and removed afterwards; the box never leaves the source frame.
  const snap = (r: Rect, s: Omit<Sample, 'slot' | 'rect' | 'spriteSource' | 'sourceSize' | 'extrude'>): Rect => {
    if (!o.trimByGrid) return clampRect(r, s.source);
    const gw = Math.max(1, prefs.gridW), gh = Math.max(1, prefs.gridH);
    const offsetX = s.origin.x - prefs.gridX, offsetY = s.origin.y - prefs.gridY;
    const x0 = Math.floor((r.x + offsetX) / gw) * gw - offsetX;
    const y0 = Math.floor((r.y + offsetY) / gh) * gh - offsetY;
    const x1 = Math.ceil((r.x + r.w + offsetX) / gw) * gw - offsetX;
    const y1 = Math.ceil((r.y + r.h + offsetY) / gh) * gh - offsetY;
    return clampRect({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, s.source);
  };
  const bounds = samples.map(s => opaqueBounds({ w: W, h: H, data: s.data }));
  let kept = samples.map((s, i) => ({ s, b: bounds[i] }));
  if (o.ignoreEmpty) kept = kept.filter(k => k.b);
  if (o.trim === 'sprite') {
    // One box for every frame: same-sized frames, content aligned
    let u: Rect | null = null;
    for (const { b } of kept) if (b) u = u ? { x: Math.min(u.x, b.x), y: Math.min(u.y, b.y), w: Math.max(u.x + u.w, b.x + b.w) - Math.min(u.x, b.x), h: Math.max(u.y + u.h, b.y + b.h) - Math.min(u.y, b.y) } : b;
    // An entirely empty sheet keeps a single-pixel placeholder instead of an empty texture
    kept.forEach(({ s }) => { s.src = u ? snap(u, s) : { x: 0, y: 0, w: 1, h: 1 }; });
  } else if (o.trim === 'cels') {
    // An empty frame keeps a 1×1 entry so its duration and position in the tag survive
    kept.forEach(({ s, b }) => { s.src = b ? snap(b, s) : { x: 0, y: 0, w: 1, h: 1 }; });
  }

  // 3. Unique images share one slot
  const pad = o.inner + (o.extrude ? 1 : 0);
  const merge = o.mergeDuplicates || o.type === 'packed';
  const slots = new Map<string, Slot>();
  const all: Sample[] = [];
  let unique = 0;
  for (const { s } of kept) {
    const band = `${o.splitTags ? s.tag?.name ?? '' : ''}|${o.splitLayers ? s.layer : ''}`;
    const key = merge ? hash(s.data, s.src, W) : `#${unique}`;
    let slot = slots.get(key);
    if (!slot) {
      slot = { w: s.src.w + pad * 2, h: s.src.h + pad * 2, x: 0, y: 0, band };
      slots.set(key, slot);
      unique++;
    }
    all.push({ ...s, slot, rect: { x: 0, y: 0, w: 0, h: 0 }, spriteSource: { x: 0, y: 0, w: 0, h: 0 }, sourceSize: { w: 1, h: 1 }, extrude: { left: 0, top: 0, right: 0, bottom: 0 } });
  }
  const list = [...slots.values()];

  // 4. Layout (sprite pixels)
  let width = 0, height = 0;
  if (!list.length) { width = height = 1; } else if (o.type === 'packed') {
    ({ width, height } = pack(list, o.spacing, o.border));
  } else {
    const byRows = o.type !== 'columns' && o.type !== 'vertical';
    const limit = o.type === 'horizontal' || o.type === 'vertical' ? Infinity
      : o.count > 0 ? o.count : Math.ceil(Math.sqrt(list.length));
    let a = o.border, b = o.border, n = 0, cross = 0, prevBand = list[0].band;
    for (const s of list) {
      // A new layer / tag starts a new row (or column)
      if (n > 0 && (n >= limit || s.band !== prevBand)) {
        b += cross + o.spacing;
        a = o.border; n = 0; cross = 0;
      }
      if (byRows) { s.x = a; s.y = b; a += s.w + o.spacing; cross = Math.max(cross, s.h); }
      else { s.x = b; s.y = a; a += s.h + o.spacing; cross = Math.max(cross, s.w); }
      n++;
      prevBand = s.band;
      width = Math.max(width, s.x + s.w);
      height = Math.max(height, s.y + s.h);
    }
    width += o.border;
    height += o.border;
  }

  // 5. Output geometry: one rounded-edge mapping for the canvas and every rectangle
  const size = sheetSize(width, height, kx, ky, o.powerOfTwo);
  for (const s of all) {
    const left = s.slot.x + pad, top = s.slot.y + pad;
    // One canonical output size per rectangle: `round(size × scale)`. Frame, spriteSourceSize,
    // sourceSize and meta.size all use it, so they agree at any scale / pixel ratio.
    const w = Math.max(1, edge(s.src.w, kx)), h = Math.max(1, edge(s.src.h, ky));
    const sw = Math.max(1, edge(s.source.w, kx)), sh = Math.max(1, edge(s.source.h, ky));
    const fx = edge(left, kx), fy = edge(top, ky);
    s.rect = { x: fx, y: fy, w, h };
    // The frame and the trimmed region describe the same pixels; keep the offset inside the source
    s.spriteSource = { x: Math.min(edge(s.src.x, kx), Math.max(0, sw - w)), y: Math.min(edge(s.src.y, ky), Math.max(0, sh - h)), w, h };
    s.sourceSize = { w: sw, h: sh };
    // One sprite pixel of edge repeats outward; rounding can push it just past the texture edge,
    // so the canvas grows below. Inner padding stays empty: extrusion only widens the margins.
    s.extrude = o.extrude
      ? { left: fx - edge(left - 1, kx), top: fy - edge(top - 1, ky), right: edge(left + s.src.w + 1, kx) - fx - w, bottom: edge(top + s.src.h + 1, ky) - fy - h }
      : { left: 0, top: 0, right: 0, bottom: 0 };
    size.w = Math.max(size.w, fx + w + s.extrude.right); size.h = Math.max(size.h, fy + h + s.extrude.bottom);
  }
  if (size.w > 32768 || size.h > 32768 || size.w * size.h > 64 * 1024 * 1024) throw new Error('Export dimensions exceed the image size limit');

  // 6. Render (each unique image once) at output resolution
  const canvas = new OffscreenCanvas(size.w, size.h);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  // Each unique image is drawn once, at the size of its frame rectangle, so the data file's
  // `frame` describes exactly the pixels that end up in the texture (trimmed/extruded excluded).
  const drawn = new Map<Slot, Sample>();
  for (const s of all) if (!drawn.has(s.slot)) drawn.set(s.slot, s);
  for (const s of drawn.values()) {
    const img = new ImageData(new Uint8ClampedArray(s.data.slice().buffer), W, H);
    const tmp = new OffscreenCanvas(W, H);
    tmp.getContext('2d')!.putImageData(img, 0, 0);
    const { x, y, w, h } = s.rect;
    ctx.drawImage(tmp, s.src.x, s.src.y, s.src.w, s.src.h, x, y, w, h);
    if (o.extrude) {
      // Repeat the outermost rows/columns (and corners) outward across the reserved padding.
      // The frame rectangle stays exactly the rendered image, so extruded pixels never count.
      const { left: l, top: t, right: r, bottom: b } = s.extrude;
      const e = (sx: number, sy: number, sw: number, sh: number, dx: number, dy: number) => ctx.drawImage(canvas, sx, sy, sw, sh, dx, dy, sw, sh);
      if (t > 0) e(x, y, w, 1, x, y - t);
      if (b > 0) e(x, y + h - 1, w, 1, x, y + h);
      if (l > 0) e(x, y - t, 1, h + t + b, x - l, y - t);
      if (r > 0) e(x + w - 1, y - t, 1, h + t + b, x + w, y - t);
    }
  }

  return { canvas, width: size.w, height: size.h, samples: all, pad, extrude: o.extrude ? 1 : 0, scaleX: kx, scaleY: ky, ratioX, ratioY, options: o };
}

/** The data file (hash or array flavour) describing every frame of a built sheet */
export function sheetData(sheet: Sheet, title: string, image: string, flavour: 'hash' | 'array', sprite: SheetContext['sprite']) {
  const o = sheet.options, k = o.scale, kx = sheet.scaleX, ky = sheet.scaleY;
  const entries = sheet.samples.map((s, i) => {
    const vars: Record<string, string> = {
      title, extension: 'png', layer: s.layer !== null ? sprite.layers[s.layer].name : '',
      group: s.layer !== null && parentOf(sprite.layers, s.layer) >= 0 ? sprite.layers[parentOf(sprite.layers, s.layer)].name : '',
      tag: s.tag?.name ?? '', duration: String(sprite.frames[s.frame].duration),
      // User notes: {layerdata}, {tagdata}
      layerdata: s.layer !== null ? sprite.layers[s.layer].userData?.text ?? '' : '', tagdata: s.tag?.userData?.text ?? '',
    };
    const name = fillTemplate(o.template || defaultTemplate(o), vars, i, s.index);
    return {
      filename: name,
      // The frame rectangle is the rendered image only: inner padding and extruded pixels stay outside it
      frame: { ...s.rect },
      rotated: false,
      trimmed: s.spriteSource.x !== 0 || s.spriteSource.y !== 0 || s.spriteSource.w !== s.sourceSize.w || s.spriteSource.h !== s.sourceSize.h,
      spriteSourceSize: { ...s.spriteSource },
      sourceSize: { ...s.sourceSize },
      duration: sprite.frames[s.frame].duration,
    };
  });
  const frames = flavour === 'hash' ? Object.fromEntries(entries.map(({ filename, ...rest }) => [filename, rest])) : entries;
  const key = (v: number) => Math.round(v);
  return JSON.stringify({
    frames,
    meta: {
      app: 'Pixprite',
      version: '0.1',
      image,
      format: 'RGBA8888',
      size: { w: sheet.width, h: sheet.height },
      scale: String(k),
      ...(sheet.ratioX !== 1 || sheet.ratioY !== 1 ? { scaleX: kx, scaleY: ky } : {}),
      frameTags: sprite.tags.map(t => ({ name: t.name, from: t.from, to: t.to, direction: t.direction, color: t.color, ...(t.repeat ? { repeat: String(t.repeat) } : {}), ...(t.userData?.text ? { data: t.userData.text } : {}) })),
      slices: sprite.slices.map(sl => ({
        name: sl.name, color: sl.color, ...(sl.userData?.text ? { data: sl.userData.text } : {}),
        keys: sl.keys.map(slice => ({
          frame: slice.frame, bounds: { x: key(slice.x * kx), y: key(slice.y * ky), w: key((slice.x + slice.w) * kx) - key(slice.x * kx), h: key((slice.y + slice.h) * ky) - key(slice.y * ky) },
          ...(slice.center ? { center: { x: key(slice.center.x * kx), y: key(slice.center.y * ky), w: key((slice.center.x + slice.center.w) * kx) - key(slice.center.x * kx), h: key((slice.center.y + slice.center.h) * ky) - key(slice.center.y * ky) } } : {}),
          ...(slice.pivot ? { pivot: { x: key(slice.pivot.x * kx), y: key(slice.pivot.y * ky) } } : {}),
        })),
      })),
      layers: sprite.layers.map((l, i) => {
        const p = parentOf(sprite.layers, i);
        return { name: l.name, ...(p >= 0 ? { group: sprite.layers[p].name } : {}), ...(l.group ? {} : { opacity: Math.round(l.opacity * 255), blendMode: l.blend }), ...(l.userData?.text ? { data: l.userData.text } : {}), ...(l.userData?.color ? { color: l.userData.color } : {}) };
      }).reverse(),
    },
  }, null, 2);
}
