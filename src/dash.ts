/**
 * Line dashing.
 *
 * A dash pattern is an even list of alternating "on" and "off" distances, measured along
 * the path's true length: flattened polyline edges are accumulated by arc length rather
 * than split per vertex, so curves and arcs dash by distance, not by point count.
 *
 * Each "on" interval becomes its own open subpath, so it is capped with the current
 * lineCap and never joined to its neighbours. Original vertices inside an interval keep
 * their tangents and corners; points where a dash boundary cuts an edge take that edge's
 * tangent and are smooth ends.
 *
 * @see https://html.spec.whatwg.org/multipage/canvas.html#line-styles
 */
import type { Pt, Subpath } from "./stroke.js";

const EPSILON = 1e-9;

const samePt = (a: Pt, b: Pt) => Math.abs(a.x - b.x) < EPSILON && Math.abs(a.y - b.y) < EPSILON;

/** WebIDL ToNumber, which (unlike Number()) rejects BigInts. */
function toNumber(v: unknown): number {
  if (typeof v === "bigint") throw new TypeError("can't convert a BigInt to a number");
  return Number(v);
}

const isIterable = (v: unknown): v is Iterable<unknown> =>
  typeof v === "object" && v !== null && typeof (v as Iterable<unknown>)[Symbol.iterator] === "function";

/**
 * Validate and normalize a line dash list per the canvas spec.
 *
 * Returns an even-length copy of the segments (an odd list is doubled), or null when the
 * input is invalid (any member negative, NaN or infinite), in which case the current dash
 * list must be left untouched.
 */
export function normalizeLineDash(segments: unknown): number[] | null {
  if (!isIterable(segments)) throw new TypeError("setLineDash: argument is not iterable");
  const list = Array.from(segments, toNumber);
  if (list.some((v) => !Number.isFinite(v) || v < 0)) return null;
  const out = list.length % 2 === 1 ? list.concat(list) : list.slice();
  return out;
}

type Interval = { from: number; to: number };

/**
 * The "on" arc-length intervals of a path of length `length`, given a dash pattern and a
 * phase offset. Distances are measured from the subpath's start. Adjacent on intervals
 * separated by a zero-width gap are merged, so a corner falling on such a boundary keeps
 * its join instead of being split into two capped pieces.
 */
export function dashIntervals(dash: number[], offset: number, length: number): Interval[] {
  if (length <= 0) return [];
  const period = dash.reduce((a, b) => a + b, 0);
  if (period <= 0) return [];

  // the dash pattern starts `offset` before the path start: distance s sits at pattern
  // position (s + offset), so the first segment reached is phase offset % period in
  let phase = offset % period;
  if (phase < 0) phase += period;

  const intervals: Interval[] = [];
  let seg = 0;
  while (phase >= dash[seg]) {
    phase -= dash[seg];
    seg++;
  }
  let on = seg % 2 === 0;
  let s = 0; // distance along the path
  let remaining = dash[seg] - phase; // pattern length left in the current segment
  while (s < length - EPSILON) {
    const take = Math.min(remaining, length - s);
    if (on && take > EPSILON) {
      const interval = { from: s, to: s + take };
      // merge with a previous on interval whose gap was zero-width
      const prev = intervals[intervals.length - 1];
      if (prev && interval.from - prev.to <= EPSILON * Math.max(1, Math.abs(prev.to))) {
        prev.to = interval.to;
      } else {
        intervals.push(interval);
      }
    }
    s += take;
    remaining -= take;
    if (remaining <= EPSILON) {
      seg = (seg + 1) % dash.length;
      remaining = dash[seg];
      on = !on;
    }
  }
  return intervals;
}

type Edge = { a: Pt; b: Pt; len: number };
type Location = { pt: Pt; tangent: Pt | null; edge: number };

/**
 * Split one flattened subpath into the open subpaths covered by the "on" dash intervals.
 * Closed subpaths wrap back onto their start, so an interval crossing the seam comes back
 * as one continuous subpath; a dash list that is on for the whole closed subpath is kept
 * closed so its start point is joined rather than capped.
 */
export function dashSubpath(sub: Subpath, dash: number[], offset: number): Subpath[] {
  const closed = sub.closed;
  const points = sub.points.slice();
  const tangents = (sub.tangents ?? []).slice(0, points.length);
  if (closed && points.length > 1 && samePt(points[0], points[points.length - 1])) {
    points.pop();
    tangents.pop();
  }
  if (points.length < 2) return [];

  const edgeCount = closed ? points.length : points.length - 1;
  const edges: Edge[] = [];
  const cum = [0];
  for (let i = 0; i < edgeCount; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > EPSILON) {
      edges.push({ a, b, len });
      cum.push(cum[cum.length - 1] + len);
    }
  }
  const length = cum[cum.length - 1];
  const intervals = dashIntervals(dash, offset, length);
  if (intervals.length === 0) return [];
  if (closed && intervals.length === 1 && intervals[0].from <= EPSILON && length - intervals[0].to <= EPSILON) {
    return [sub];
  }
  // on a closed polyline an "on" run crossing the seam comes back as two intervals, one
  // ending at the start point and one beginning there; join them into a wrapping interval
  if (
    closed &&
    intervals.length >= 2 &&
    intervals[0].from <= EPSILON &&
    length - intervals[intervals.length - 1].to <= EPSILON
  ) {
    const first = intervals.shift() as Interval;
    const last = intervals.pop() as Interval;
    intervals.unshift({ from: last.from, to: length + first.to });
  }

  // locate distance d along the polyline. An exact vertex keeps its stored tangent (null at
  // a corner), so joins survive inside a dash; a cut inside an edge is smooth, tangent to it.
  const locate = (d: number): Location => {
    for (let e = 0; e < edges.length; e++) {
      const start = cum[e];
      const end = cum[e + 1];
      if (d <= end + EPSILON) {
        if (Math.abs(d - start) <= EPSILON) {
          return { pt: edges[e].a, tangent: tangents[e] ?? null, edge: e };
        }
        if (Math.abs(d - end) <= EPSILON) {
          const vi = (e + 1) % points.length;
          return { pt: edges[e].b, tangent: tangents[vi] ?? null, edge: e };
        }
        const t = (d - start) / edges[e].len;
        const { a, b } = edges[e];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const l = Math.hypot(dx, dy);
        return {
          pt: { x: a.x + dx * t, y: a.y + dy * t },
          tangent: { x: dx / l, y: dy / l },
          edge: e,
        };
      }
    }
    const last = edges.length - 1;
    const vi = closed ? 0 : points.length - 1;
    return { pt: edges[last].b, tangent: tangents[vi] ?? null, edge: last };
  };

  // the open subpath covering [from, to], with 0 <= from <= to <= length. It starts and
  // ends at the located boundary points; original vertices strictly inside keep their
  // stored tangent (null at a corner), edge cuts take the edge's tangent and are smooth.
  const materialize = (from: number, to: number): Subpath => {
    const pts: Pt[] = [];
    const tans: (Pt | null)[] = [];
    const push = (loc: Location) => {
      if (pts.length === 0 || !samePt(pts[pts.length - 1], loc.pt)) {
        pts.push(loc.pt);
        tans.push(loc.tangent);
      }
    };
    push(locate(from));
    let edge = locate(from).edge;
    // walk the vertices at cumulative distances; on a closed polyline these may wrap once
    let guard = 0;
    while (guard++ <= edges.length + 1) {
      const vertexDist = cum[edge + 1];
      if (vertexDist >= to - EPSILON) break;
      edge = (edge + 1) % edges.length;
      const vi = edge % points.length;
      const v = points[vi];
      if (pts.length === 0 || !samePt(pts[pts.length - 1], v)) {
        pts.push(v);
        tans.push(tangents[vi] ?? null);
      }
      if (edge === edges.length - 1 && !closed) break;
    }
    push(locate(to));
    return { points: pts, tangents: tans, closed: false };
  };

  const out: Subpath[] = [];
  for (const interval of intervals) {
    if (interval.to - interval.from <= EPSILON) continue;
    if (closed && interval.to > length) {
      // crosses the seam: the tail from the seam continues from the start, as one subpath
      const head = materialize(interval.from, length);
      const tail = materialize(0, interval.to - length);
      head.points = head.points.concat(tail.points.slice(1));
      head.tangents = (head.tangents ?? []).concat((tail.tangents ?? []).slice(1));
      if (head.points.length >= 2) out.push(head);
    } else {
      const piece = materialize(interval.from, interval.to);
      if (piece.points.length >= 2) out.push(piece);
    }
  }
  return out;
}

/** Apply the current dash list to every subpath, or return them unchanged when solid. */
export function dashSubpaths(subpaths: Subpath[], dash: number[], offset: number): Subpath[] {
  if (dash.length === 0) return subpaths;
  const out: Subpath[] = [];
  for (const sub of subpaths) {
    for (const piece of dashSubpath(sub, dash, offset)) out.push(piece);
  }
  return out;
}
