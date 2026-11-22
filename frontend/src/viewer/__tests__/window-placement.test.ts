import { describe, expect, it } from 'vitest';

import {
  FALLBACK_ANCHOR_DISTANCE,
  FALLBACK_CAPTURE_TANGENT,
  MAX_DEPTH_SCALE,
  MIN_DEPTH_SCALE,
  NEAR_ANCHOR_QUANTILE,
  clipFarField,
  computePlacement,
  computeWindowPlacement,
  computeTrueWindowPlacement,
  estimateCaptureAspect,
  estimateCaptureTangent,
  estimateDepthQuantile,
  findFarFieldCut,
  planScenePlacement,
  MAX_ZOOM,
  MIN_ZOOM,
  MIN_EYE_FRACTION,
  lifeSizeDistanceMm,
  apexDistance,
  lifeSizeViewingDistance,
  mapTrackedEye,
} from '../window-placement';

describe('estimating the capture field of view from the gaussians themselves', () => {
  it('recovers the angle a synthetic frame was made with', () => {
    const tangent = 0.4;
    const values: number[] = [];
    for (let i = 0; i < 4000; i++) {
      const depth = 2 + (i % 40) / 10;
      const y = ((i % 81) / 80 * 2 - 1) * tangent * depth;
      values.push((i % 17) / 16, y, -depth);
    }
    const estimate = estimateCaptureTangent(new Float32Array(values), { stride: 1 });
    expect(estimate).toBeGreaterThan(tangent * 0.9);
    expect(estimate).toBeLessThanOrEqual(tangent * 1.02);
  });

  it('is not dragged out by a few strays', () => {
    const values: number[] = [];
    for (let i = 0; i < 2000; i++) values.push(0, 0.2 * 3, -3);
    for (let i = 0; i < 5; i++) values.push(0, 6 * 3, -3);
    expect(estimateCaptureTangent(new Float32Array(values), { stride: 1 })).toBeCloseTo(0.2, 6);
  });

  it('reports nothing rather than guessing when there is nothing to read', () => {
    expect(estimateCaptureTangent(undefined)).toBe(null);
    expect(estimateCaptureTangent(new Float32Array([]))).toBe(null);
    expect(estimateCaptureTangent(new Float32Array([0, 0, 0]), { stride: 1 })).toBe(null);
  });
});

const options = { captureTangent: 0.4, anchorDistance: 1.97 };
const apex = 1 / options.captureTangent;
const comfortable = 350 / 67;   // holding the device at arm's length, in window units

/** Where a scene point lands on the window, seen from an eye that may have moved. */
function directionFromEye(
  placement: { scale: number; translation: { z: number } },
  eyeDistance: number,
  point: { x: number; depth: number },
  eyeOffsetX = 0,
) {
  const x = placement.scale * point.x - eyeOffsetX;
  const z = placement.translation.z - placement.scale * point.depth - eyeDistance;
  return x / -z;
}

describe('placing the scene behind the window', () => {
  it('puts the capture camera where the photograph was taken from', () => {
    expect(computeWindowPlacement(options).translation.z).toBeCloseTo(apex, 12);
    expect(apexDistance(options.captureTangent)).toBeCloseTo(apex, 12);
  });

  it('makes the window exactly the physical screen', () => {
    // apex * captureTangent is (1/t) * t. The construction closes on itself,
    // and anything else silently rescales how far the view moves when the head
    // does -- which an earlier version did, by a factor of 2.1.
    expect(computeWindowPlacement(options).windowHalfHeight).toBe(1);
  });

  it('reproduces the photograph at every depth, which is what the far field needs', () => {
    const p = computeWindowPlacement(options);
    for (const depth of [2.66, 10, 40, 100, 169.14]) {
      expect(directionFromEye(p, apex, { x: 0.3 * depth, depth })).toBeCloseTo(0.3, 9);
    }
  });

  it('reproduces it at every size too, so size is free to mean something else', () => {
    for (const sizeScale of [0.3, 1, 3]) {
      const p = computeWindowPlacement({ ...options, sizeScale });
      expect(directionFromEye(p, apex, { x: 3, depth: 10 })).toBeCloseTo(0.3, 9);
    }
  });

  it('puts the anchored depth in the plane of the window at size one', () => {
    expect(computeWindowPlacement(options).anchorDepth).toBeCloseTo(0, 12);
  });

  it('leaves everything behind the glass when the near edge is anchored', () => {
    // Anchoring the median instead put the front of the scene 26 to 31 per cent
    // of the way from the window to the eye, where parallax is fiercest, and
    // the near relief came out violently exaggerated on a device.
    const p = computeWindowPlacement(options);
    for (const depth of [1.97, 2.66, 10, 169]) {
      const z = p.translation.z - p.scale * depth;
      expect(z).toBeLessThanOrEqual(1e-9);
    }
  });

  it('refuses nonsense rather than producing a scene at the origin', () => {
    expect(() => computeWindowPlacement({ ...options, anchorDistance: 0 })).toThrow();
    expect(() => computeWindowPlacement({ ...options, captureTangent: 0 })).toThrow();
    expect(() => apexDistance(0)).toThrow();
  });
});

describe('placing a physical miniature behind a literal window', () => {
  it('keeps the aperture equal to the physical screen at every model size', () => {
    for (const modelScale of [0.3, 1, 3]) {
      const p = computeTrueWindowPlacement({ ...options, modelScale });
      expect(p.windowHalfHeight).toBe(1);
    }
  });

  it('keeps the selected near-depth anchor on the glass at every model size', () => {
    for (const modelScale of [0.3, 1, 3]) {
      const p = computeTrueWindowPlacement({ ...options, modelScale });
      expect(p.anchorDepth).toBeCloseTo(0, 12);
      expect(p.translation.z - p.scale * options.anchorDistance).toBeCloseTo(0, 12);
    }
  });

  it('uniformly scales both the miniature and its capture viewpoint', () => {
    const small = computeTrueWindowPlacement({ ...options, modelScale: 0.5 });
    const large = computeTrueWindowPlacement({ ...options, modelScale: 2 });
    expect(large.scale / small.scale).toBeCloseTo(4, 12);
    expect(large.translation.z / small.translation.z).toBeCloseTo(4, 12);
  });

  it('clamps invalid or extreme model sizes without changing the aperture', () => {
    const fallback = computeTrueWindowPlacement({ ...options, modelScale: Number.NaN });
    const tiny = computeTrueWindowPlacement({ ...options, modelScale: 1e-9 });
    const huge = computeTrueWindowPlacement({ ...options, modelScale: 1e9 });
    expect(fallback.windowHalfHeight).toBe(1);
    expect(tiny.scale).toBeCloseTo((apex / options.anchorDistance) * MIN_DEPTH_SCALE, 12);
    expect(huge.scale).toBeCloseTo((apex / options.anchorDistance) * MAX_DEPTH_SCALE, 12);
  });
});

describe('measuring optical-axis depth for the glass anchor', () => {
  it('does not change when a splat moves sideways at the same z depth', () => {
    const onAxis = new Float32Array([0, 0, -2, 0, 0, -4]);
    const offAxis = new Float32Array([100, -80, -2, -70, 90, -4]);
    expect(estimateDepthQuantile(onAxis, { stride: 1, quantile: 0 })).toBe(2);
    expect(estimateDepthQuantile(offAxis, { stride: 1, quantile: 0 })).toBe(2);
  });

  it('ignores zero and non-finite depths and clamps the quantile', () => {
    const centers = new Float32Array([
      0, 0, 0,
      0, 0, Number.NaN,
      5, 6, -3,
      8, 9, -7,
    ]);
    expect(estimateDepthQuantile(centers, { stride: 1, quantile: -2 })).toBe(3);
    expect(estimateDepthQuantile(centers, { stride: 1, quantile: 5 })).toBe(7);
    expect(estimateDepthQuantile(new Float32Array([1, 2, 0]), { stride: 1 })).toBe(null);
  });
});

describe('mapping the head so a comfortable distance is the apex', () => {
  const map = (x: number, y: number, z: number) =>
    mapTrackedEye({ eye: { x, y, z }, nominalZ: comfortable, apex });

  it('lands the comfortable holding distance exactly on the apex', () => {
    // Without it the viewer sits permanently off-apex, which is what made the
    // background enormous when this was first attempted.
    expect(map(0, 0, comfortable).z).toBeCloseTo(apex, 12);
  });

  it('keeps the picture exact there, which is the reason for the mapping', () => {
    const p = computeWindowPlacement(options);
    const eye = map(0, 0, comfortable);
    for (const depth of [1.97, 40, 169.14]) {
      expect(directionFromEye(p, eye.z, { x: 0.3 * depth, depth })).toBeCloseTo(0.3, 9);
    }
  });

  it('scales all three axes by the same factor', () => {
    // This is the whole correction. Scaling the depth alone measured sideways
    // movement against an apex two and a half times nearer than the device is
    // really held, so every head movement produced two and a half times the
    // parallax it should -- reported from hardware as depth that felt
    // exaggerated and unpleasant on every image tried.
    const factor = apex / comfortable;
    const mapped = map(0.4, -0.3, comfortable);
    expect(mapped.x).toBeCloseTo(0.4 * factor, 12);
    expect(mapped.y).toBeCloseTo(-0.3 * factor, 12);
    expect(mapped.z).toBeCloseTo(comfortable * factor, 12);
  });

  it('gives the same picture as viewing from the comfortable distance', () => {
    // The version that felt natural on hardware put the apex at the distance
    // the device is held and made the window proportionally larger. This one
    // puts the apex at the photograph's own viewpoint and keeps the window at
    // the screen. They are the same construction written two ways, and the
    // equality is what guarantees the parallax is neither damped nor
    // exaggerated -- scaling the depth alone broke it and multiplied the
    // parallax by two and a half.
    const anchor = options.anchorDistance;
    const t = options.captureTangent;

    // Where a point lands within the frame, as a fraction of half the frame.
    const framePosition = (
      sceneScale: number, apexZ: number, windowHalf: number,
      eyeX: number, point: { x: number; depth: number },
    ) => {
      const dx = sceneScale * point.x - eyeX;
      const dz = apexZ - sceneScale * point.depth - apexZ;   // relative to the eye
      return (dx / -dz) * apexZ / windowHalf;
    };

    for (const eyeXReal of [0, 0.15, 0.4, -0.3]) {
      for (const point of [{ x: 0.5, depth: 2 }, { x: -2, depth: 20 }, { x: 8, depth: 120 }]) {
        // As it was: apex at the holding distance, window scaled to suit.
        const asItWas = framePosition(
          comfortable / anchor, comfortable, comfortable * t, eyeXReal, point,
        );
        // As it is: apex at the photograph's viewpoint, window the screen, and
        // the whole head position mapped by the same factor.
        const p = computeWindowPlacement(options);
        const eye = mapTrackedEye({
          eye: { x: eyeXReal, y: 0, z: comfortable }, nominalZ: comfortable, apex,
        });
        const asItIs = framePosition(p.scale, apex, p.windowHalfHeight, eye.x, point);
        expect(asItIs).toBeCloseTo(asItWas, 9);
      }
    }
  });

  it('preserves how much the distance changed, in proportion', () => {
    // Within the range it is allowed to move: below the floor the ratio is
    // deliberately no longer preserved.
    for (const k of [0.8, 1.3, 2]) {
      expect(map(0, 0, comfortable * k).z / apex).toBeCloseTo(k, 9);
    }
  });

  it('stops the eye short of the glass, where the nearest things run away', () => {
    // Coming closer magnifies whatever is nearest much faster than the rest,
    // which on a face reads as the forehead stretching away from the mouth. A
    // window really does that, but the tracker also reports the head as closer
    // when the device is merely rotated -- measured at 285 mm for a device held
    // at 400 -- so the effect arrives without anyone having moved.
    expect(MIN_EYE_FRACTION).toBeGreaterThan(0.5);
    for (const k of [0.5, 0.3, 0.05]) {
      expect(map(0, 0, comfortable * k).z).toBeCloseTo(apex * MIN_EYE_FRACTION, 9);
    }
    // And it is still a floor, not a freeze: real movement above it counts.
    expect(map(0, 0, comfortable * 0.9).z).toBeLessThan(apex);
    expect(map(0, 0, comfortable * 0.9).z).toBeGreaterThan(apex * MIN_EYE_FRACTION);
  });

  it('cannot reach the plane of the window, where there is no frustum at all', () => {
    expect(map(0, 0, comfortable / 100).z).toBeGreaterThan(0);
    expect(map(0, 0, comfortable * 1000).z).toBeCloseTo(apex * 6, 9);
  });

  it('falls back to the apex rather than throwing on a tracker that reports nonsense', () => {
    expect(map(0, 0, Number.NaN).z).toBe(apex);
    expect(map(0, 0, -1).z).toBe(apex);
    expect(map(Number.NaN, 0, comfortable).x).toBe(0);
    expect(() => mapTrackedEye({ eye: { x: 0, y: 0, z: 5 }, nominalZ: 5, apex: 0 })).toThrow();
    expect(() => mapTrackedEye({ eye: { x: 0, y: 0, z: 5 }, nominalZ: 0, apex: 2 })).toThrow();
  });
});

describe('reading the photograph\'s shape back off the gaussians', () => {
  // A frame w wide and h tall, unprojected: the extreme gaussians sit on its
  // edge, so the ratio of the two tangents is the ratio of its sides.
  const frame = (halfW: number, halfH: number, depth = 2) => {
    const out: number[] = [];
    for (let i = 0; i <= 40; i++) {
      const f = i / 40;
      out.push((-halfW + 2 * halfW * f) * depth, halfH * depth, -depth);
      out.push((-halfW + 2 * halfW * f) * depth, -halfH * depth, -depth);
      out.push(halfW * depth, (-halfH + 2 * halfH * f) * depth, -depth);
      out.push(-halfW * depth, (-halfH + 2 * halfH * f) * depth, -depth);
    }
    return new Float32Array(out);
  };

  it('measures the two axes separately', () => {
    const centers = frame(0.6, 0.4);
    expect(estimateCaptureTangent(centers, { stride: 1, percentile: 1 })).toBeCloseTo(0.4, 6);
    expect(estimateCaptureTangent(centers, { stride: 1, percentile: 1, axis: 'x' }))
      .toBeCloseTo(0.6, 6);
  });

  it('reports a landscape frame as wider than tall and a portrait as the reverse', () => {
    expect(estimateCaptureAspect(frame(0.6, 0.4), { stride: 1, percentile: 1 }))
      .toBeCloseTo(1.5, 6);
    expect(estimateCaptureAspect(frame(0.3, 0.4), { stride: 1, percentile: 1 }))
      .toBeCloseTo(0.75, 6);
  });

  it('says nothing rather than guessing when there is nothing to measure', () => {
    expect(estimateCaptureAspect(undefined)).toBe(null);
    expect(estimateCaptureAspect(new Float32Array([]))).toBe(null);
  });

  it('is what decides how much of the width a screen shows', () => {
    // An upright phone against an ordinary landscape photograph: without
    // opening zoomed out, two thirds of the width is off the sides.
    const phone = 1206 / 2622;
    const aspect = estimateCaptureAspect(frame(0.667, 0.5), { stride: 1, percentile: 1 })!;
    expect(Math.min(1, phone / aspect)).toBeCloseTo(0.345, 3);
  });
});

describe('trading framing against apparent size, which a small screen forces', () => {
  const screenHalfHeightMm = 67;

  it('shows the whole photograph at zoom one', () => {
    const p = computeWindowPlacement(options);
    expect(p.visibleFraction).toBe(1);
    expect(p.windowHalfHeight).toBe(1);
  });

  it('crops in as it zooms, and says how much is left', () => {
    const p = computeWindowPlacement({ ...options, zoom: 2 });
    expect(p.visibleFraction).toBeCloseTo(0.5, 12);
    expect(p.windowHalfHeight).toBeCloseTo(0.5, 12);
  });

  it('never moves the apex or the scene, so zooming stays exact', () => {
    for (const zoom of [1, 1.5, 3]) {
      expect(computeWindowPlacement({ ...options, zoom }).translation.z).toBeCloseTo(apex, 12);
      expect(computeWindowPlacement({ ...options, zoom }).scale)
        .toBeCloseTo(computeWindowPlacement(options).scale, 12);
    }
  });

  it('brings the life-size distance out towards arm’s length as it crops', () => {
    const at = (zoom: number) =>
      lifeSizeDistanceMm(computeWindowPlacement({ ...options, zoom }).windowHalfHeight,
        apex, screenHalfHeightMm);
    expect(at(2)).toBeGreaterThan(at(1));
    expect(at(1)).toBeCloseTo(screenHalfHeightMm * apex, 6);
  });

  it('clamps the zoom rather than letting it invert or run away', () => {
    // Below one the window grows past the frame, which is how a photograph
    // wider than the screen is ever seen whole -- so more than 1 here is the
    // point rather than a fault. It still stops, at MIN_ZOOM.
    expect(computeWindowPlacement({ ...options, zoom: 0.1 }).visibleFraction)
      .toBeCloseTo(1 / MIN_ZOOM, 12);
    expect(computeWindowPlacement({ ...options, zoom: 0.6 }).visibleFraction)
      .toBeCloseTo(1 / 0.6, 12);
    // Nonsense still falls back to showing exactly the frame.
    expect(computeWindowPlacement({ ...options, zoom: -2 }).visibleFraction).toBe(1);
    expect(computeWindowPlacement({ ...options, zoom: Number.NaN }).visibleFraction).toBe(1);
    expect(computeWindowPlacement({ ...options, zoom: 1e6 }).visibleFraction)
      .toBeCloseTo(1 / MAX_ZOOM, 12);
  });

  it('leaves the apex and the scene alone when zooming out, as when zooming in', () => {
    // The same guarantee the zoom-in test makes: only the window changes, so
    // the geometry stays exact on both sides of one.
    for (const zoom of [0.3, 0.6, 1, 2]) {
      expect(computeWindowPlacement({ ...options, zoom }).translation.z).toBeCloseTo(apex, 12);
      expect(computeWindowPlacement({ ...options, zoom }).scale)
        .toBeCloseTo(computeWindowPlacement({ ...options, zoom: 1 }).scale, 12);
    }
  });

  it('makes a larger miniature flatter, and a smaller one deeper', () => {
    const shift = (sizeScale: number) => {
      const p = computeWindowPlacement({ ...options, sizeScale });
      return Math.abs(directionFromEye(p, apex, { x: 3, depth: 10 }, 0.5)
        - directionFromEye(p, apex, { x: 3, depth: 10 }, 0));
    };
    expect(shift(0.3)).toBeGreaterThan(shift(1));
    expect(shift(1)).toBeGreaterThan(shift(3));
  });

  it('clamps the size control too', () => {
    const base = apex / options.anchorDistance;
    expect(computeWindowPlacement({ ...options, sizeScale: 1e6 }).scale)
      .toBeCloseTo(base * MAX_DEPTH_SCALE, 12);
    expect(computeWindowPlacement({ ...options, sizeScale: 1e-9 }).scale)
      .toBeCloseTo(base * MIN_DEPTH_SCALE, 12);
  });

  it('reports where the picture would look life-sized, without placing anything there', () => {
    expect(lifeSizeViewingDistance(0.4)).toBeCloseTo(2.5, 12);
    expect(() => lifeSizeDistanceMm(0, 5, 67)).toThrow();
  });
});

describe('finding the empty band in a scene’s depth', () => {
  // Consumed by clipFarField, which removes what lies beyond the band; the
  // viewer then places only what survives and stops drawing at the cut.
  const bimodal = () => {
    const v: number[] = [];
    for (let i = 0; i < 3000; i++) v.push(0, 0, -(2 + (i % 100) / 100));
    for (let i = 0; i < 1200; i++) v.push(0, 0, -(4 + (i % 100) / 20));
    for (let i = 0; i < 1500; i++) v.push(0, 0, -(40 + (i % 100)));
    return new Float32Array(v);
  };

  it('finds the empty band between the subject and the background', () => {
    const cut = findFarFieldCut(bimodal(), { stride: 1 })!;
    expect(cut).toBeGreaterThan(9);
    expect(cut).toBeLessThan(40);
  });

  it('declines to cut a scene that is evenly filled', () => {
    const even: number[] = [];
    for (let i = 0; i < 6000; i++) even.push(0, 0, -(2 + (i % 1000) / 20));
    expect(findFarFieldCut(new Float32Array(even), { stride: 1 })).toBe(null);
  });

  it('reports nothing rather than guessing when there is too little to read', () => {
    expect(findFarFieldCut(undefined)).toBe(null);
    expect(findFarFieldCut(new Float32Array([0, 0, -3]), { stride: 1 })).toBe(null);
  });
});

describe('one placement chain for both modes', () => {
  it('is what the mode-specific entry points compute', () => {
    for (const sizeScale of [0.3, 1, 3]) {
      for (const zoom of [0.5, 1, 2]) {
        expect(computePlacement({ ...options, sizeScale, zoom, mode: 'photo' }))
          .toEqual(computeWindowPlacement({ ...options, sizeScale, zoom }));
        expect(computePlacement({ ...options, sizeScale, zoom, mode: 'trueWindow' }))
          .toEqual(computeTrueWindowPlacement({ ...options, modelScale: sizeScale * zoom }));
      }
    }
  });

  it('places the same scene identically in either mode at rest', () => {
    // This is what keeps a mode switch from jumping the anchor, the visible
    // fraction or the background depth: with the controls untouched the two
    // modes are the same placement.
    const photo = computePlacement({ ...options, mode: 'photo' });
    const window = computePlacement({ ...options, mode: 'trueWindow' });
    expect(photo.scale).toBeCloseTo(window.scale, 12);
    expect(photo.translation).toEqual(window.translation);
    expect(photo.anchorDepth).toBeCloseTo(window.anchorDepth, 12);
    expect(photo.windowHalfHeight).toBe(1);
    expect(window.windowHalfHeight).toBe(1);
    expect(photo.visibleFraction).toBe(1);
    expect(window.visibleFraction).toBe(1);
  });

  it('lets zoom resize the window only in photo mode', () => {
    const photo = computePlacement({ ...options, zoom: 2, mode: 'photo' });
    const window = computePlacement({ ...options, zoom: 2, mode: 'trueWindow' });
    expect(photo.windowHalfHeight).toBeCloseTo(0.5, 12);
    expect(photo.visibleFraction).toBeCloseTo(0.5, 12);
    // The true window's aperture is always the physical screen; the same
    // control grows the miniature instead.
    expect(window.windowHalfHeight).toBe(1);
    expect(window.scale)
      .toBeCloseTo(computePlacement({ ...options, mode: 'trueWindow' }).scale * 2, 12);
  });

  it('falls back to safe values rather than building a degenerate frustum', () => {
    const restPhoto = computePlacement({ ...options, mode: 'photo' });
    const restWindow = computePlacement({ ...options, mode: 'trueWindow' });
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -2]) {
      expect(computePlacement({ ...options, zoom: bad, mode: 'photo' })).toEqual(restPhoto);
      expect(computePlacement({ ...options, sizeScale: bad, mode: 'photo' })).toEqual(restPhoto);
      expect(computePlacement({ ...options, zoom: bad, mode: 'trueWindow' })).toEqual(restWindow);
      expect(computePlacement({ ...options, sizeScale: bad, mode: 'trueWindow' }))
        .toEqual(restWindow);
    }
    // Extreme but finite values clamp instead of running away.
    expect(computePlacement({ ...options, zoom: 1e6, mode: 'photo' }).windowHalfHeight)
      .toBeCloseTo(1 / MAX_ZOOM, 12);
    expect(computePlacement({ ...options, zoom: 1e-9, mode: 'photo' }).windowHalfHeight)
      .toBeCloseTo(1 / MIN_ZOOM, 12);
    expect(computePlacement({ ...options, sizeScale: 1e-9, mode: 'trueWindow' }).scale)
      .toBeCloseTo((apex / options.anchorDistance) * MIN_DEPTH_SCALE, 12);
    expect(computePlacement({ ...options, sizeScale: 1e9, mode: 'trueWindow' }).scale)
      .toBeCloseTo((apex / options.anchorDistance) * MAX_DEPTH_SCALE, 12);
    // The two numbers there is no safe guess for still refuse.
    expect(() => computePlacement({ ...options, captureTangent: Number.NaN, mode: 'photo' }))
      .toThrow();
    expect(() => computePlacement({ ...options, anchorDistance: -1, mode: 'trueWindow' }))
      .toThrow();
  });
});

describe('cutting the far field at the empty band', () => {
  // A flat near band, so the anchor quantile lands on exactly the same depth
  // however many far splats the cut removes.
  const scene = () => {
    const v: number[] = [];
    for (let i = 0; i < 2000; i++) v.push(0, 0, -2);
    for (let i = 0; i < 1000; i++) v.push(0, 0, -(4 + (i % 50) / 10));
    for (let i = 0; i < 1500; i++) v.push(0, 0, -(40 + (i % 100)));
    return new Float32Array(v);
  };

  it('removes only what lies beyond the gap, in order', () => {
    const centers = scene();
    const clip = clipFarField(centers, { stride: 1 });
    expect(clip.cut).not.toBe(null);
    const kept = clip.centers!;
    expect(kept.length).toBeLessThan(centers.length);
    // Nothing beyond the cut survives.
    for (let i = 0; i + 2 < kept.length; i += 3) {
      expect(Math.hypot(kept[i], kept[i + 1], kept[i + 2])).toBeLessThanOrEqual(clip.cut!);
    }
    // Everything this side of the gap is still there, exactly as it was.
    const expected: number[] = [];
    for (let i = 0; i + 2 < centers.length; i += 3) {
      if (Math.hypot(centers[i], centers[i + 1], centers[i + 2]) <= clip.cut!) {
        expected.push(centers[i], centers[i + 1], centers[i + 2]);
      }
    }
    expect(kept.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) expect(kept[i]).toBe(expected[i]);
    // And the fraction it reports is the fraction that remains.
    expect(clip.visibleFraction).toBeCloseTo(kept.length / centers.length, 12);
    expect(clip.visibleFraction).toBeLessThan(1);
  });

  it('leaves the near anchor where it was', () => {
    const centers = scene();
    const before = estimateDepthQuantile(centers, { quantile: NEAR_ANCHOR_QUANTILE, stride: 1 });
    const clip = clipFarField(centers, { stride: 1 });
    expect(estimateDepthQuantile(clip.centers, { quantile: NEAR_ANCHOR_QUANTILE, stride: 1 }))
      .toBe(before);
  });

  it('cuts nothing when the histogram has no gap', () => {
    const even: number[] = [];
    for (let i = 0; i < 6000; i++) even.push(0, 0, -(2 + (i % 1000) / 20));
    const centers = new Float32Array(even);
    const clip = clipFarField(centers, { stride: 1 });
    expect(clip.cut).toBe(null);
    // The same array, not a copy: nothing happened.
    expect(clip.centers).toBe(centers);
    expect(clip.visibleFraction).toBe(1);
  });

  it('cuts nothing when there is nothing to read', () => {
    expect(clipFarField(undefined).cut).toBe(null);
    expect(clipFarField(undefined).centers).toBe(undefined);
    expect(clipFarField(undefined).visibleFraction).toBe(1);
    const tiny = new Float32Array([0, 0, -3]);
    expect(clipFarField(tiny, { stride: 1 }).centers).toBe(tiny);
  });
});

describe('planning a scene’s placement end to end', () => {
  // The same flat-near bimodal scene as the clipping tests.
  const scene = () => {
    const v: number[] = [];
    for (let i = 0; i < 2000; i++) v.push(0, 0, -2);
    for (let i = 0; i < 1000; i++) v.push(0, 0, -(4 + (i % 50) / 10));
    for (let i = 0; i < 1500; i++) v.push(0, 0, -(40 + (i % 100)));
    return new Float32Array(v);
  };

  it('clips the far field and places what survives', () => {
    const centers = scene();
    const plan = planScenePlacement({
      centers, captureTangent: 0.4, anchorDistance: 2, mode: 'photo', anchorStride: 1, cutOptions: { stride: 1 },
    });
    expect(plan.farCut).not.toBe(null);
    expect(plan.sceneVisibleFraction).toBeLessThan(1);
    expect(plan.sceneVisibleFraction).toBeCloseTo(plan.centers!.length / centers.length, 12);
    // The placement is the unified chain's answer for the recomputed inputs.
    expect(plan.placement).toEqual(computePlacement({
      captureTangent: plan.captureTangent,
      anchorDistance: plan.anchorDistance,
      mode: 'photo',
    }));
  });

  it('recomputes the anchor after clipping without moving it off the glass', () => {
    const centers = scene();
    const before = estimateDepthQuantile(centers, { quantile: NEAR_ANCHOR_QUANTILE, stride: 1 });
    for (const mode of ['photo', 'trueWindow'] as const) {
      const plan = planScenePlacement({
        centers, captureTangent: 0.4, anchorDistance: 2, mode, anchorStride: 1, cutOptions: { stride: 1 },
      });
      // The cut only removed the background, so the near anchor is unchanged...
      expect(plan.anchorDistance).toBe(before);
      // ...and the near end stays behind the glass.
      expect(plan.placement.anchorDepth).toBeLessThanOrEqual(1e-9);
    }
  });

  it('cuts nothing and changes nothing when the histogram has no gap', () => {
    const even: number[] = [];
    for (let i = 0; i < 6000; i++) even.push(0, 0, -(2 + (i % 1000) / 20));
    const centers = new Float32Array(even);
    const plan = planScenePlacement({
      centers, captureTangent: 0.4, anchorDistance: 2, mode: 'photo', anchorStride: 1, cutOptions: { stride: 1 },
    });
    expect(plan.farCut).toBe(null);
    expect(plan.sceneVisibleFraction).toBe(1);
    expect(plan.centers).toBe(centers);
    expect(plan.anchorDistance).toBe(
      estimateDepthQuantile(centers, { quantile: NEAR_ANCHOR_QUANTILE, stride: 1 }),
    );
  });

  it('falls back to safe values when the scene and the parameters say nothing', () => {
    const plan = planScenePlacement({
      centers: undefined,
      captureTangent: Number.NaN,
      anchorDistance: 0,
      mode: 'photo',
    });
    expect(plan.captureTangent).toBe(FALLBACK_CAPTURE_TANGENT);
    expect(plan.anchorDistance).toBe(FALLBACK_ANCHOR_DISTANCE);
    expect(plan.farCut).toBe(null);
    expect(plan.sceneVisibleFraction).toBe(1);
    expect(Number.isFinite(plan.placement.scale)).toBe(true);
    expect(plan.placement.windowHalfHeight).toBe(1);
    expect(plan.placement.anchorDepth).toBeLessThanOrEqual(1e-9);
  });

  it('re-estimates a missing tangent from the scene itself', () => {
    const tangent = 0.4;
    const values: number[] = [];
    for (let i = 0; i < 4000; i++) {
      const depth = 2 + (i % 40) / 10;
      const y = ((i % 81) / 80 * 2 - 1) * tangent * depth;
      values.push((i % 17) / 16, y, -depth);
    }
    const plan = planScenePlacement({
      centers: new Float32Array(values),
      captureTangent: Number.NaN,
      anchorDistance: 2,
      mode: 'photo',
    });
    expect(plan.captureTangent).toBeGreaterThan(tangent * 0.9);
    expect(plan.captureTangent).toBeLessThanOrEqual(tangent * 1.02);
  });

  it('gives both modes the same scene when the mode switches', () => {
    const centers = scene();
    const inputs = {
      centers, captureTangent: 0.4, anchorDistance: 2, anchorStride: 1, cutOptions: { stride: 1 },
    };
    const photo = planScenePlacement({ ...inputs, mode: 'photo' });
    const window = planScenePlacement({ ...inputs, mode: 'trueWindow' });
    // The scene-level decisions do not depend on the mode at all.
    expect(photo.farCut).not.toBe(null);
    expect(window.anchorDistance).toBe(photo.anchorDistance);
    expect(window.farCut).toBe(photo.farCut);
    expect(window.captureTangent).toBe(photo.captureTangent);
    expect(window.sceneVisibleFraction).toBe(photo.sceneVisibleFraction);
    // And at rest the placement itself is identical, so switching modes
    // cannot jump the anchor, the scale or the background depth.
    expect(window.placement.scale).toBeCloseTo(photo.placement.scale, 12);
    expect(window.placement.translation).toEqual(photo.placement.translation);
    expect(window.placement.anchorDepth).toBeCloseTo(photo.placement.anchorDepth, 12);
    expect(window.placement.windowHalfHeight).toBe(photo.placement.windowHalfHeight);
  });
});
