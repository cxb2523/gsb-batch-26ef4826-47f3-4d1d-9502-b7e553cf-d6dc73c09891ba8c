import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Atmosphere } from '../src/atmosphere.js';

// The Atmosphere's bookkeeping round a renderer that does nothing: what gets
// drawn when there is no loop to draw it. A canvas here is only its numbers.

const { made, FakeRenderer, atStart, sample } = vi.hoisted(() => {
  const made: InstanceType<typeof FakeRenderer>[] = [];
  // whether a renderer is made with its variant already linked (compile on the spot)
  const atStart = { linked: false };
  const sample = (v: number) => ({ srgb: [v, v, v], linear: [v, v, v], luminance: v });
  class FakeRenderer {
    available = true;
    ready = false;
    colorSpace = 'srgb';
    cloudScale = 1;
    rays = 0;
    cumulonimbus = 'auto';
    render = vi.fn();
    prepare = vi.fn();
    dispose = vi.fn();
    // what isSettled answers: flipped by the tests as variants start and land
    linked = atStart.linked;
    isSettled = vi.fn(() => this.available && this.linked);
    takeGpuTimes = (): { ms: number; pixels: number }[] => [];
    // a measurement for every probe; the tests may override it
    probe = vi.fn(() => ({
      frame: { average: sample(0.5), grid: { cols: 1, rows: 1, cells: [sample(0.5)] } },
      environment: null,
    }));
    readonly canvas: HTMLCanvasElement;
    readonly opts: { onReady?: (available: boolean) => void; onLinked?: () => void };
    constructor(canvas: HTMLCanvasElement, opts: FakeRenderer['opts']) {
      this.canvas = canvas;
      this.opts = opts;
      made.push(this);
    }
    resize(w: number, h: number) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }
  return { made, FakeRenderer, atStart, sample };
});

vi.mock('../src/renderer.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/renderer.js')>(),
  AtmosphereRenderer: FakeRenderer,
}));

const sized = (w: number, h: number) =>
  ({ width: 0, height: 0, clientWidth: w, clientHeight: h }) as HTMLCanvasElement;

function mount(options: ConstructorParameters<typeof Atmosphere>[1], canvas = sized(640, 360)) {
  const sky = new Atmosphere(canvas, { resolutionScale: 1, ...options });
  return { sky, canvas, renderer: made[made.length - 1] };
}

function reduceMotion(matches: boolean) {
  vi.stubGlobal('matchMedia', () => ({ matches, addEventListener() {}, removeEventListener() {} }));
}

beforeEach(() => {
  made.length = 0;
  atStart.linked = false;
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  reduceMotion(false);
});

afterEach(() => vi.unstubAllGlobals());

it('paints the sunset into the new buffer on the frame that changes resolution', () => {
  const { sky, canvas, renderer } = mount({ adaptiveResolution: true });
  const pixels = canvas.width * canvas.height;
  renderer.takeGpuTimes = () => Array.from({ length: 12 }, () => ({ ms: 100, pixels }));
  let paintedPixels = 0;
  renderer.render.mockImplementation(() => { paintedPixels = canvas.width * canvas.height; });
  sky.jump({ time: 17.8, weather: 'fair', ground: 'sea' });
  expect(canvas.width * canvas.height).toBeLessThan(pixels);
  expect(paintedPixels).toBe(canvas.width * canvas.height);
});

describe('a still frame under reduced motion', () => {
  beforeEach(() => reduceMotion(true));

  it('is drawn again after a resize, which clears the canvas', () => {
    const { sky, canvas, renderer } = mount({});
    expect(renderer.render).toHaveBeenCalledTimes(1);
    (canvas as { clientWidth: number }).clientWidth = 800;
    sky.resize();
    expect(canvas.width).toBe(800);
    expect(renderer.render).toHaveBeenCalledTimes(2);
  });

  it('is not drawn again when the size has not changed', () => {
    const { sky, renderer } = mount({});
    sky.resize();
    expect(renderer.render).toHaveBeenCalledTimes(1);
  });

  it('is the same moment each time, so a redraw moves nothing', () => {
    const { sky, canvas, renderer } = mount({});
    const wind = sky.state.timeOfDay;
    const first = renderer.render.mock.calls[0];
    const windOff = first[3], evo = first[4], time = first[0];
    (canvas as { clientWidth: number }).clientWidth = 800;
    sky.resize();
    const again = renderer.render.mock.calls[1];
    expect(again[0]).toBe(time);
    expect(again[3]).toBe(windOff);
    expect(again[4]).toBe(evo);
    expect(sky.state.timeOfDay).toBe(wind);
  });

  it('is drawn again when the variant it needed has linked', () => {
    const { renderer } = mount({});
    renderer.opts.onLinked?.();
    expect(renderer.render).toHaveBeenCalledTimes(2);
  });
});

describe('a jump() with no loop', () => {
  it('is drawn when the shader comes ready, though start() was never called', () => {
    const { sky, renderer } = mount({ autoStart: false });
    sky.jump();
    expect(renderer.render).toHaveBeenCalledTimes(1);   // too early: this one draws nothing
    renderer.opts.onReady?.(true);
    expect(renderer.render).toHaveBeenCalledTimes(2);
  });

  it('stays up through a resize', () => {
    const { sky, canvas, renderer } = mount({ autoStart: false });
    sky.jump();
    (canvas as { clientHeight: number }).clientHeight = 500;
    sky.resize();
    expect(renderer.render).toHaveBeenCalledTimes(2);
  });

  it('is forgotten by stop()', () => {
    const { sky, canvas, renderer } = mount({ autoStart: false });
    sky.jump();
    sky.stop();
    renderer.opts.onReady?.(true);
    (canvas as { clientWidth: number }).clientWidth = 800;
    sky.resize();
    expect(renderer.render).toHaveBeenCalledTimes(1);
  });
});

describe('with nothing asked for', () => {
  it('draws nothing when the shader comes ready or the canvas resizes', () => {
    const { sky, canvas, renderer } = mount({ autoStart: false });
    renderer.opts.onReady?.(true);
    renderer.opts.onLinked?.();
    (canvas as { clientWidth: number }).clientWidth = 800;
    sky.resize();
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it('still tells the caller the shader is ready', () => {
    const onReady = vi.fn();
    const { renderer } = mount({ autoStart: false, onReady });
    renderer.opts.onReady?.(true);
    expect(onReady).toHaveBeenCalledWith(true);
  });
});

describe('a running loop', () => {
  it('is left to its next tick', () => {
    const { sky, canvas, renderer } = mount({});
    sky.jump();
    expect(renderer.render).toHaveBeenCalledTimes(1);
    renderer.opts.onReady?.(true);
    renderer.opts.onLinked?.();
    (canvas as { clientWidth: number }).clientWidth = 800;
    sky.resize();
    expect(renderer.render).toHaveBeenCalledTimes(1);
  });
});

describe('out of view', () => {
  let tick: (t: number) => void;
  let seen: ((entries: { isIntersecting: boolean }[]) => void) | null;
  let watching: boolean;
  const inDocument = () => ({ ...sized(640, 360), isConnected: true }) as HTMLCanvasElement;
  const view = (isIntersecting: boolean) => seen?.([{ isIntersecting }]);

  beforeEach(() => {
    seen = null;
    watching = false;
    vi.stubGlobal('requestAnimationFrame', (f: (t: number) => void) => { tick = f; return 1; });
    vi.stubGlobal('IntersectionObserver', class {
      constructor(f: typeof seen) { seen = f; }
      observe() { watching = true; }
      disconnect() { watching = false; }
    });
  });

  it('draws nothing, and draws again on the way back without waiting for a tick', () => {
    const { renderer } = mount({ fps: 60 }, inDocument());
    tick(100);
    expect(renderer.render).toHaveBeenCalledTimes(1);
    view(false);
    tick(200);
    tick(300);
    expect(renderer.render).toHaveBeenCalledTimes(1);
    view(true);
    expect(renderer.render).toHaveBeenCalledTimes(2);
    tick(400);
    expect(renderer.render).toHaveBeenCalledTimes(3);
  });

  it('goes on with the clocks, so the sky comes back where it would have been', () => {
    const { sky, renderer } = mount({ fps: 60 }, inDocument());
    const before = sky.state;
    tick(1000);
    const evo = renderer.render.mock.calls[0][4];
    view(false);
    for (let t = 1100; t < 3000; t += 100) tick(t);
    view(true);
    expect(renderer.render.mock.calls[1][4]).toBeGreaterThan(evo + 0.05);
    expect(sky.state.timeOfDay).toBeCloseTo(before.timeOfDay);
  });

  it('still draws what it is asked to with no loop running', () => {
    const { sky, renderer } = mount({ autoStart: false }, inDocument());
    view(false);
    sky.jump();
    expect(renderer.render).toHaveBeenCalledTimes(1);
  });

  it('does not draw on the way back with the loop stopped', () => {
    const { sky, renderer } = mount({ autoStart: false }, inDocument());
    sky.start();
    sky.stop();
    view(false);
    view(true);
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it('draws on a canvas outside the document, which never intersects anything', () => {
    const { renderer } = mount({ fps: 60 });
    view(false);
    tick(100);
    expect(renderer.render).toHaveBeenCalledTimes(1);
  });

  it('draws on under pauseOffscreen: false, watching nothing', () => {
    const { renderer } = mount({ fps: 60, pauseOffscreen: false }, inDocument());
    expect(watching).toBe(false);
    tick(100);
    expect(renderer.render).toHaveBeenCalledTimes(1);
  });

  it('stops watching when disposed', () => {
    const { sky } = mount({}, inDocument());
    expect(watching).toBe(true);
    sky.dispose();
    expect(watching).toBe(false);
  });

  it('draws nothing when disposed, even if visibility comes back', () => {
    const { sky, renderer } = mount({ fps: 60 }, inDocument());
    tick(100);
    expect(renderer.render).toHaveBeenCalledTimes(1);
    sky.dispose();
    view(false);
    view(true);
    tick(200);
    expect(renderer.render).toHaveBeenCalledTimes(1);
  });

  describe('with the adaptive resolution', () => {
    /** feed the renderer `ms` for every frame at the canvas's size as it is now */
    const timing = (renderer: InstanceType<typeof FakeRenderer>, canvas: HTMLCanvasElement, ms: number) => {
      renderer.takeGpuTimes = () => Array.from({ length: 12 }, () => ({
        ms, pixels: canvas.width * canvas.height,
      }));
    };
    // a low floor, so a second, worse frame has somewhere further to drop to
    const adaptive = { fps: 60, adaptiveResolution: { min: 0.25 } };

    it('comes back at the governor\'s scale, not the size it left at', () => {
      const { sky, canvas, renderer } = mount(adaptive, inDocument());
      const painted: number[] = [];
      renderer.render.mockImplementation(() => { painted.push(canvas.width); });
      timing(renderer, canvas, 40);
      tick(100);
      const scale = sky.resolution;
      expect(scale).toBeLessThan(1);
      expect(canvas.width).toBe(Math.round(640 * scale));
      // the layout changes while it is out of view, so the canvas's own size is
      // now stale, and nothing is drawn to bring it up to date
      view(false);
      (canvas as { clientWidth: number }).clientWidth = 800;
      for (let t = 200; t < 500; t += 100) tick(t);
      const before = renderer.render.mock.calls.length;
      view(true);
      expect(renderer.render.mock.calls.length - before).toBe(1);
      expect(sky.resolution).toBe(scale);
      expect(canvas.width).toBe(Math.round(800 * scale));
      expect(painted[painted.length - 1]).toBe(canvas.width);
    });

    it('does not act on the timings that arrive while it is paused', () => {
      const { sky, canvas, renderer } = mount(adaptive, inDocument());
      timing(renderer, canvas, 40);
      tick(100);
      const scale = sky.resolution;
      const width = canvas.width;
      expect(scale).toBeLessThan(1);
      // a frame that would drop it further
      timing(renderer, canvas, 300);
      view(false);
      for (let t = 200; t < 2000; t += 100) tick(t);
      view(true);
      expect(sky.resolution).toBe(scale);
      expect(canvas.width).toBe(width);
      expect(renderer.render).toHaveBeenCalledTimes(2);
    });
  });

  describe('with the light probe', () => {
    it('does not run while paused, and picks up its interval where it left off', () => {
      const { renderer } = mount({ fps: 60, lightProbe: { rate: 10, smoothing: 0 } }, inDocument());
      tick(100);
      expect(renderer.probe).toHaveBeenCalledTimes(1);
      view(false);
      for (let t = 200; t <= 500; t += 100) tick(t);
      expect(renderer.probe).toHaveBeenCalledTimes(1);
      view(true);                     // drawn at once, but the probe is not yet due
      expect(renderer.probe).toHaveBeenCalledTimes(1);
      tick(600);                      // a probe interval of drawing after the last one
      expect(renderer.probe).toHaveBeenCalledTimes(2);
    });

    it('smooths over the drawn interval, not the pause', () => {
      const { sky, renderer } = mount({ fps: 60, lightProbe: { rate: 10, smoothing: 1 } }, inDocument());
      let v = 0.2;
      renderer.probe.mockImplementation(() => ({
        frame: { average: sample(v), grid: { cols: 1, rows: 1, cells: [sample(v)] } },
        environment: null,
      }));
      tick(100);
      view(false);
      v = 0.8;
      for (let t = 200; t <= 500; t += 100) tick(t);
      view(true);
      tick(600);
      // one probe interval (0.1 s) elapsed in drawing time, not the half second
      // of wall clock: k = 1 - e^(-0.1 / 1)
      const k = 1 - Math.exp(-0.1);
      expect(sky.light.frame!.average.linear[0]).toBeCloseTo(0.2 + (0.8 - 0.2) * k, 6);
    });
  });
});

describe('settling', () => {
  let tick: (t: number) => void;
  let now = 0;
  const frame = () => tick((now += 100));

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (f: (t: number) => void) => { tick = f; return 1; });
  });

  /** a set() that needs a variant the renderer has not got */
  const needsNew = (renderer: InstanceType<typeof FakeRenderer>) =>
    renderer.prepare.mockImplementation(() => { renderer.linked = false; });
  /** the variant landing */
  const link = (renderer: InstanceType<typeof FakeRenderer>) => { renderer.linked = true; renderer.opts.onLinked?.(); };

  it('says so once the first variant is in and has been drawn', async () => {
    const onSettled = vi.fn();
    const { sky, renderer } = mount({ fps: 60, onSettled });
    expect(sky.settled).toBe(false);
    renderer.linked = true;
    renderer.ready = true;
    renderer.opts.onReady?.(true);
    // (the loop draws it on its next tick, and says so then)
    expect(onSettled).not.toHaveBeenCalled();
    frame();
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(true);
    expect(sky.settled).toBe(true);
    await expect(sky.whenSettled()).resolves.toBe(true);
    frame();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('goes unsettled on a set() that needs a new variant, and settles again once it is in', async () => {
    const onSettled = vi.fn();
    const { sky, renderer } = mount({ fps: 60, onSettled });
    link(renderer);
    frame();
    expect(onSettled).toHaveBeenCalledTimes(1);

    needsNew(renderer);
    sky.set({ weather: 'rain' });
    expect(sky.settled).toBe(false);
    const waiting = sky.whenSettled();
    frame();
    frame();
    expect(onSettled).toHaveBeenCalledTimes(1);
    link(renderer);
    frame();
    expect(onSettled).toHaveBeenCalledTimes(2);
    expect(onSettled).toHaveBeenLastCalledWith(true);
    await expect(waiting).resolves.toBe(true);
  });

  it('says nothing for a set() that needs no new variant', () => {
    const onSettled = vi.fn();
    const { sky, renderer } = mount({ fps: 60, onSettled });
    link(renderer);
    frame();
    sky.set({ time: 15 });
    frame();
    expect(sky.settled).toBe(true);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('settles as soon as the variant lands with no loop to draw it', () => {
    const onSettled = vi.fn();
    const { sky, renderer } = mount({ autoStart: false, onSettled });
    needsNew(renderer);
    sky.set({ weather: 'rain' });
    link(renderer);
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(true);
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it('draws a still frame again before it says so, under reduced motion', () => {
    reduceMotion(true);
    const onSettled = vi.fn(() => expect(renderer.render).toHaveBeenCalledTimes(2));
    const { sky, renderer } = mount({ onSettled });
    expect(renderer.render).toHaveBeenCalledTimes(1);
    link(renderer);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(sky.settled).toBe(true);
  });

  it('is settled from the start where the shader compiles on the spot', async () => {
    const onSettled = vi.fn();
    atStart.linked = true;
    const { sky } = mount({ autoStart: false, onSettled });
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(true);
    await expect(sky.whenSettled()).resolves.toBe(true);
  });

  it('says false, and lets the waiters go, when the sky will never draw', async () => {
    const onSettled = vi.fn();
    const { sky, renderer } = mount({ fps: 60, onSettled });
    const waiting = sky.whenSettled();
    renderer.available = false;
    renderer.opts.onReady?.(false);
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(false);
    await expect(waiting).resolves.toBe(false);
    await expect(sky.whenSettled()).resolves.toBe(false);
    expect(sky.settled).toBe(false);
  });

  it('lets the waiters go when disposed first', async () => {
    const { sky } = mount({ fps: 60 });
    const waiting = sky.whenSettled();
    sky.dispose();
    await expect(waiting).resolves.toBe(false);
  });
});
