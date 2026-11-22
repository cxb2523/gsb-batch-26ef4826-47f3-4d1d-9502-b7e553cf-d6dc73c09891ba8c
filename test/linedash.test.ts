import { describe, expect, it } from "vitest";
import * as pureimage from "../src/index.js";
import { dashIntervals, dashSubpath, normalizeLineDash } from "../src/dash.js";
import type { Subpath } from "../src/stroke.js";

const RED = [255, 0, 0, 255];
const GREEN = [0, 255, 0, 255];

/** stroke in green on a red 120x60 canvas, then sample pixels */
function stroke(draw: (ctx: any) => void) {
  const image = pureimage.make(120, 60);
  const ctx = image.getContext("2d");
  ctx.fillStyle = "#f00";
  ctx.fillRect(0, 0, 120, 60);
  ctx.strokeStyle = "#0f0";
  draw(ctx);
  return (x: number, y: number) => Array.from(image.getPixelRGBA_separate(x, y));
}

const openLine = (): Subpath => ({
  points: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ],
  tangents: [null, null, null],
  closed: false,
});

describe("setLineDash / getLineDash API", () => {
  it("defaults to an empty (solid) list", () => {
    const ctx = pureimage.make(10, 10).getContext("2d");
    expect(ctx.getLineDash()).toEqual([]);
    expect(ctx.lineDashOffset).toBe(0);
  });

  it("stores and returns a copy of the segments", () => {
    const ctx = pureimage.make(10, 10).getContext("2d");
    ctx.setLineDash([5, 10]);
    expect(ctx.getLineDash()).toEqual([5, 10]);
    const got = ctx.getLineDash();
    got[0] = 999;
    expect(ctx.getLineDash()).toEqual([5, 10]);
  });

  it("does not keep a reference to the caller's array", () => {
    const ctx = pureimage.make(10, 10).getContext("2d");
    const segments = [5, 10];
    ctx.setLineDash(segments);
    segments.push(20);
    expect(ctx.getLineDash()).toEqual([5, 10]);
  });

  it("doubles an odd-length list", () => {
    const ctx = pureimage.make(10, 10).getContext("2d");
    ctx.setLineDash([5, 10, 15]);
    expect(ctx.getLineDash()).toEqual([5, 10, 15, 5, 10, 15]);
  });

  it("accepts an empty list for a solid line", () => {
    const ctx = pureimage.make(10, 10).getContext("2d");
    ctx.setLineDash([5, 10]);
    ctx.setLineDash([]);
    expect(ctx.getLineDash()).toEqual([]);
  });

  it("ignores lists containing negative, NaN or infinite values", () => {
    const ctx = pureimage.make(10, 10).getContext("2d");
    ctx.setLineDash([5, 10]);
    for (const bad of [[-1, 5], [5, NaN], [Infinity, 5], [5, -Infinity]]) {
      ctx.setLineDash(bad as number[]);
      expect(ctx.getLineDash()).toEqual([5, 10]);
    }
  });

  it("allows zero-length segments", () => {
    const ctx = pureimage.make(10, 10).getContext("2d");
    ctx.setLineDash([0, 5]);
    expect(ctx.getLineDash()).toEqual([0, 5]);
    ctx.setLineDash([5, 0]);
    expect(ctx.getLineDash()).toEqual([5, 0]);
  });

  it("normalizes numeric strings", () => {
    expect(normalizeLineDash(["5", "10"])).toEqual([5, 10]);
  });

  it("throws on a non-iterable argument", () => {
    const ctx = pureimage.make(10, 10).getContext("2d");
    expect(() => ctx.setLineDash(5 as unknown as number[])).toThrow(TypeError);
  });

  it("lineDashOffset takes numeric strings and keeps its value on invalid input", () => {
    const ctx = pureimage.make(10, 10).getContext("2d");
    ctx.lineDashOffset = 4;
    expect(ctx.lineDashOffset).toBe(4);
    ctx.lineDashOffset = "7" as unknown as number;
    expect(ctx.lineDashOffset).toBe(7);
    for (const bad of [NaN, Infinity, -Infinity, "junk"]) {
      ctx.lineDashOffset = bad as number;
      expect(ctx.lineDashOffset).toBe(7);
    }
    ctx.lineDashOffset = -3.5;
    expect(ctx.lineDashOffset).toBe(-3.5);
  });
});

describe("dash state save/restore and reset", () => {
  it("round-trips the dash list and offset through save/restore", () => {
    const ctx = pureimage.make(10, 10).getContext("2d");
    ctx.setLineDash([5, 10]);
    ctx.lineDashOffset = 4;
    ctx.save();
    ctx.setLineDash([1, 2, 3]);
    ctx.lineDashOffset = 9;
    expect(ctx.getLineDash()).toEqual([1, 2, 3, 1, 2, 3]);
    expect(ctx.lineDashOffset).toBe(9);
    ctx.restore();
    expect(ctx.getLineDash()).toEqual([5, 10]);
    expect(ctx.lineDashOffset).toBe(4);
  });

  it("nested saves restore in LIFO order", () => {
    const ctx = pureimage.make(10, 10).getContext("2d");
    ctx.setLineDash([1, 1]);
    ctx.save();
    ctx.setLineDash([2, 2]);
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.restore();
    expect(ctx.getLineDash()).toEqual([2, 2]);
    ctx.restore();
    expect(ctx.getLineDash()).toEqual([1, 1]);
  });

  it("reset() clears the dash list and offset", () => {
    const ctx = pureimage.make(10, 10).getContext("2d");
    ctx.setLineDash([5, 10]);
    ctx.lineDashOffset = 8;
    ctx.reset();
    expect(ctx.getLineDash()).toEqual([]);
    expect(ctx.lineDashOffset).toBe(0);
  });
});

describe("dashIntervals arc-length math", () => {
  it("alternates on/off from the path start", () => {
    expect(dashIntervals([10, 5], 0, 30)).toEqual([
      { from: 0, to: 10 },
      { from: 15, to: 25 },
    ]);
  });

  it("shifts the pattern with a positive lineDashOffset", () => {
    expect(dashIntervals([10, 10], 5, 30)).toEqual([
      { from: 0, to: 5 },
      { from: 15, to: 25 },
    ]);
  });

  it("handles a negative lineDashOffset", () => {
    expect(dashIntervals([10, 5], -3, 30)).toEqual([
      { from: 3, to: 13 },
      { from: 18, to: 28 },
    ]);
  });

  it("wraps offsets larger than the pattern period", () => {
    expect(dashIntervals([10, 5], 15, 30)).toEqual(dashIntervals([10, 5], 0, 30));
    expect(dashIntervals([10, 5], 30, 30)).toEqual(dashIntervals([10, 5], 0, 30));
  });

  it("clips the final interval at the path length", () => {
    expect(dashIntervals([10, 5], 0, 7)).toEqual([{ from: 0, to: 7 }]);
  });

  it("produces nothing for an all-zero pattern", () => {
    expect(dashIntervals([0, 0], 0, 30)).toEqual([]);
  });

  it("merges on runs separated by a zero-width gap", () => {
    expect(dashIntervals([10, 0, 10, 10], 0, 40)).toEqual([
      { from: 0, to: 20 },
      { from: 30, to: 40 },
    ]);
  });
});

describe("dashSubpath geometry", () => {
  it("cuts a straight open path by arc length and caps the pieces", () => {
    const pieces = dashSubpath(openLine(), [5, 5], 0);
    expect(pieces.map((p) => p.closed)).toEqual([false, false]);
    expect(pieces[0].points).toEqual([
      { x: 0, y: 0 },
      { x: 5, y: 0 },
    ]);
    expect(pieces[1].points).toEqual([
      { x: 10, y: 0 },
      { x: 10, y: 5 },
    ]);
    // the cut ends carry the edge tangent, so they are smooth capped ends
    expect(pieces[0].tangents![1]).toEqual({ x: 1, y: 0 });
    expect(pieces[1].tangents![1]).toEqual({ x: 0, y: 1 });
    // the shared corner keeps a null tangent inside each piece
    expect(pieces[0].tangents![0]).toBeNull();
    expect(pieces[1].tangents![0]).toBeNull();
  });

  it("advances by arc length along a flattened curve, not by vertex count", () => {
    // a strongly curved cubic, flattened into 100 equal-parameter samples
    const cubic = (t: number) => {
      const u = 1 - t;
      return {
        x: u ** 3 * 0 + 3 * u * u * t * 0 + 3 * u * t * t * 100 + t ** 3 * 100,
        y: u ** 3 * 0 + 3 * u * u * t * 200 + 3 * u * t * t * 200 + t ** 3 * 0,
      };
    };
    const points = [{ x: 0, y: 0 }];
    const tangents: ({ x: number; y: number } | null)[] = [null];
    for (let i = 1; i <= 100; i++) {
      points.push(cubic(i / 100));
      tangents.push({ x: 1, y: 0 });
    }
    const pieces = dashSubpath({ points, tangents, closed: false }, [10, 10], 0);
    // each piece must span exactly 10 units of true polyline length, at cumulative starts
    // of 0, 20, 40, ... rather than every tenth vertex
    const lengthOf = (pts: { x: number; y: number }[]) => {
      let l = 0;
      for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      return l;
    };
    const total = lengthOf(points);
    // arc length of q along the sampled polyline: nearest projected point over every segment
    const distanceOf = (q: { x: number; y: number }) => {
      let best = 0;
      let bestDist = Infinity;
      let d = 0;
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        const seg = Math.hypot(b.x - a.x, b.y - a.y);
        const t = Math.min(1, Math.max(0, ((q.x - a.x) * (b.x - a.x) + (q.y - a.y) * (b.y - a.y)) / (seg * seg)));
        const proj = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
        const dist = Math.hypot(q.x - proj.x, q.y - proj.y);
        if (dist < bestDist) {
          bestDist = dist;
          best = d + t * seg;
        }
        d += seg;
      }
      return best;
    };
    pieces.forEach((piece, k) => {
      expect(lengthOf(piece.points)).toBeCloseTo(10, 6);
      expect(distanceOf(piece.points[0])).toBeCloseTo(k * 20, 5);
      expect(distanceOf(piece.points[piece.points.length - 1])).toBeCloseTo(k * 20 + 10, 5);
    });
    expect(pieces.length).toBe(Math.ceil(total / 20));
  });

  it("keeps a closed subpath closed when the pattern is on throughout", () => {
    const square: Subpath = {
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      tangents: [null, null, null, null],
      closed: true,
    };
    const pieces = dashSubpath(square, [40, 40], 0); // perimeter 40, all on
    expect(pieces).toHaveLength(1);
    expect(pieces[0].closed).toBe(true);
  });

  it("wraps a dash crossing the closed subpath seam into one continuous piece", () => {
    const square: Subpath = {
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      tangents: [null, null, null, null],
      closed: true,
    };
    // perimeter 40, period 20, offset 5: on [0,5] then off, and on [35,40] at the seam
    const pieces = dashSubpath(square, [10, 10], 5);
    expect(pieces).toHaveLength(2);
    // the intervals on both sides of the seam merge into one piece that passes through
    // the start point (0,0): up the left edge then along the top
    const wrapping = pieces.find((p) => p.points.some((q) => q.x === 0 && q.y === 0));
    expect(wrapping).toBeDefined();
    expect(wrapping!.points[0]).toEqual({ x: 0, y: 5 });
    expect(wrapping!.points[wrapping!.points.length - 1]).toEqual({ x: 5, y: 0 });
    // it passes through the seam vertex without a gap or a duplicated point
    const keys = wrapping!.points.map((p) => `${p.x},${p.y}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("0,0");
  });

  it("returns no pieces for an all-zero dash pattern", () => {
    expect(dashSubpath(openLine(), [0, 0], 0)).toEqual([]);
  });
});

describe("dashed stroke() pixels", () => {
  it("paints on segments and leaves off segments empty", () => {
    const px = stroke((ctx) => {
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 10]);
      ctx.moveTo(10, 30);
      ctx.lineTo(110, 30);
      ctx.stroke();
    });
    expect(px(10, 30)).toEqual(GREEN);
    expect(px(15, 30)).toEqual(GREEN);
    expect(px(20, 30)).toEqual(RED);
    expect(px(25, 30)).toEqual(RED);
    expect(px(30, 30)).toEqual(GREEN);
    expect(px(39, 30)).toEqual(GREEN);
    expect(px(40, 30)).toEqual(RED);
  });

  it("lineDashOffset shifts the pattern along the line", () => {
    const px = stroke((ctx) => {
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 10]);
      ctx.lineDashOffset = 5;
      ctx.moveTo(10, 30);
      ctx.lineTo(110, 30);
      ctx.stroke();
    });
    // on only for the first 5 units, then off for 10
    expect(px(14, 30)).toEqual(GREEN);
    expect(px(15, 30)).toEqual(RED);
    expect(px(24, 30)).toEqual(RED);
    expect(px(25, 30)).toEqual(GREEN);
    expect(px(34, 30)).toEqual(GREEN);
    expect(px(35, 30)).toEqual(RED);
  });

  it("dashes an arc by arc length", () => {
    const px = stroke((ctx) => {
      ctx.lineWidth = 2;
      ctx.setLineDash([20, 20]);
      ctx.arc(30, 30, 20, 0, Math.PI * 2);
      ctx.stroke();
    });
    // start of the circle at (50, 30): on for 20 units of arc, then off
    expect(px(49, 30)).not.toEqual(RED);
    expect(px(45, 30)).toEqual(RED);
    expect(px(40, 30)).toEqual(RED);
    // top of the circle, ~31.4 units around: inside the first off region
    expect(px(30, 11)).toEqual(RED);
    expect(px(30, 10)).not.toEqual(RED);
  });

  it("dashes quadratic and beziers curves along their length", () => {
    const px = stroke((ctx) => {
      ctx.lineWidth = 2;
      ctx.setLineDash([15, 15]);
      ctx.moveTo(10, 50);
      ctx.quadraticCurveTo(60, -40, 110, 50);
      ctx.stroke();
    });
    // the curve starts on; sampling near its start and end along the centre row
    expect(px(10, 49)).not.toEqual(RED);
    // somewhere in the middle the pattern must have switched off at least once
    let sawGap = false;
    for (let x = 12; x < 108; x++) {
      let painted = false;
      for (let y = 0; y < 60; y++) if (px(x, y)[1] > 0) painted = true;
      if (!painted) sawGap = true;
    }
    expect(sawGap).toBe(true);
  });

  it("continues the pattern around a closed path's start point", () => {
    const px = stroke((ctx) => {
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 10]);
      ctx.moveTo(20, 30);
      ctx.lineTo(50, 30);
      ctx.lineTo(50, 45);
      ctx.lineTo(20, 45);
      ctx.closePath();
      ctx.stroke();
    });
    // perimeter 90, traced top(0-30) right(30-45) bottom reversed(45-75) left up(75-90).
    // the seam at s=0/90 is inside an on run, so the start corner is painted from both sides
    expect(px(20, 30)).toEqual(GREEN); // the seam corner itself
    expect(px(22, 30)).toEqual(GREEN); // top edge just after the seam (s=2)
    expect(px(25, 45)).toEqual(GREEN); // bottom edge at s=70: the on run ending at the seam
    // and the off region just before that run stays empty
    expect(px(24, 45)).toEqual(RED);
  });

  it("strokeRect follows the dash pattern", () => {
    const px = stroke((ctx) => {
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 10]);
      ctx.strokeRect(10, 10, 40, 20);
    });
    expect(px(10, 10)).toEqual(GREEN);
    expect(px(15, 10)).toEqual(GREEN);
    expect(px(20, 10)).toEqual(RED);
    expect(px(30, 10)).toEqual(GREEN);
  });

  it("round caps extend past the on segment, butt caps do not", () => {
    const butt = stroke((ctx) => {
      ctx.lineWidth = 6;
      ctx.lineCap = "butt";
      ctx.setLineDash([10, 10]);
      ctx.moveTo(10, 30);
      ctx.lineTo(110, 30);
      ctx.stroke();
    });
    const round = stroke((ctx) => {
      ctx.lineWidth = 6;
      ctx.lineCap = "round";
      ctx.setLineDash([10, 10]);
      ctx.moveTo(10, 30);
      ctx.lineTo(110, 30);
      ctx.stroke();
    });
    // first on segment ends at x=20; round cap reaches ~3px beyond, butt stops there
    expect(butt(21, 30)).toEqual(RED);
    expect(round(21, 30)).not.toEqual(RED);
    expect(round(25, 30)).toEqual(RED);
  });

  it("an empty dash list strokes a solid line", () => {
    const px = stroke((ctx) => {
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 10]);
      ctx.setLineDash([]);
      ctx.moveTo(10, 30);
      ctx.lineTo(110, 30);
      ctx.stroke();
    });
    for (const x of [10, 25, 55, 90, 109]) expect(px(x, 30)).toEqual(GREEN);
  });

  it("an invalid dash list leaves the previous pattern in use", () => {
    const px = stroke((ctx) => {
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 10]);
      ctx.setLineDash([5, -1]);
      ctx.moveTo(10, 30);
      ctx.lineTo(110, 30);
      ctx.stroke();
    });
    expect(px(15, 30)).toEqual(GREEN);
    expect(px(20, 30)).toEqual(RED);
  });

  it("restored dash state is used for drawing", () => {
    const image = pureimage.make(60, 20);
    const ctx = image.getContext("2d");
    ctx.fillStyle = "#f00";
    ctx.fillRect(0, 0, 60, 20);
    ctx.strokeStyle = "#0f0";
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.save();
    ctx.setLineDash([]);
    ctx.restore();
    ctx.moveTo(5, 10);
    ctx.lineTo(55, 10);
    ctx.stroke();
    const px = (x: number, y: number) => Array.from(image.getPixelRGBA_separate(x, y));
    expect(px(9, 10)).toEqual(GREEN);
    expect(px(10, 10)).toEqual(RED);
  });
});
