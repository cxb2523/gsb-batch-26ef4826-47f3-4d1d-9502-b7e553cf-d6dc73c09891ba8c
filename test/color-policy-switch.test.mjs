import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CadCanvasRenderer,
  CadWebGLRenderer,
  readCadColorPolicy
} from '../dist/cad-viewer.es.js';

// --- Minimal DOM stubs so the renderers run under plain Node ---------------

const rafQueue = new Map();
let rafId = 0;

globalThis.window = {
  devicePixelRatio: 1,
  requestAnimationFrame: (callback) => {
    const id = ++rafId;
    rafQueue.set(id, callback);
    return id;
  },
  cancelAnimationFrame: (id) => {
    rafQueue.delete(id);
  }
};

function create2dContext(records) {
  return {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    globalAlpha: 1,
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    save() {},
    restore() {},
    setTransform() {},
    translate() {},
    rotate() {},
    scale() {},
    clearRect() {},
    fillRect() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    rect() {},
    arc() {},
    setLineDash() {},
    drawImage() {},
    measureText: (text) => ({ width: String(text).length * 10 }),
    stroke() { records.push({ kind: 'stroke', color: this.strokeStyle }); },
    fill() { records.push({ kind: 'fill', color: this.fillStyle }); },
    fillText() { records.push({ kind: 'text', color: this.fillStyle }); }
  };
}

function createCanvasStub(context) {
  return {
    width: 0,
    height: 0,
    clientWidth: 800,
    clientHeight: 600,
    style: {},
    parentElement: null,
    classList: { add() {}, remove() {} },
    getContext: () => context,
    addEventListener() {},
    removeEventListener() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    hasPointerCapture: () => false
  };
}

function createWebGLContextStub(uploads) {
  return {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    LINES: 1,
    TRIANGLES: 4,
    POINTS: 0,
    COLOR_BUFFER_BIT: 0x4000,
    DEPTH_TEST: 0x0b71,
    BLEND: 0x0be2,
    SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    FLOAT: 0x1406,
    UNSIGNED_BYTE: 0x1401,
    viewport() {},
    clearColor() {},
    clear() {},
    disable() {},
    enable() {},
    blendFunc() {},
    useProgram() {},
    uniform1f() {},
    uniform2f() {},
    createShader: () => ({}),
    shaderSource() {},
    compileShader() {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    createProgram: () => ({}),
    attachShader() {},
    linkProgram() {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    deleteShader() {},
    deleteProgram() {},
    getUniformLocation: () => ({}),
    getAttribLocation: () => 0,
    createBuffer: () => ({}),
    bindBuffer() {},
    bufferData(target, data) {
      if (data instanceof Uint8Array) uploads.push(Uint8Array.from(data));
    },
    deleteBuffer() {},
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    drawArrays() {}
  };
}

function createWebGLCanvasStub(gl) {
  const canvas = createCanvasStub(null);
  canvas.getContext = (kind) => (kind === 'webgl2' ? gl : null);
  return canvas;
}

// --- Fixtures ----------------------------------------------------------------

function createDocument() {
  return {
    format: 'dxf',
    layers: {},
    blocks: {},
    entities: [
      { type: 'LINE', color: '#00ff00', startPoint: { x: 0, y: 0, z: 0 }, endPoint: { x: 100, y: 100, z: 0 } },
      { type: 'TEXT', color: '#ff0000', text: 'Hello', insertionPoint: { x: 10, y: 20, z: 0 }, textHeight: 5 }
    ],
    metadata: {},
    warnings: []
  };
}

const MONO = { mode: 'monochrome', monochromeColor: '#102030' };
const MONO_CSS = 'rgb(16, 32, 48)';

function uploadIncludes(uploads, rgba) {
  return uploads.some((bytes) => {
    for (let i = 0; i + 3 < bytes.length; i += 4) {
      if (bytes[i] === rgba[0] && bytes[i + 1] === rgba[1] && bytes[i + 2] === rgba[2] && bytes[i + 3] === rgba[3]) return true;
    }
    return false;
  });
}

// --- Canvas2D renderer -------------------------------------------------------

test('CadCanvasRenderer switches color policy without resetting the viewport', () => {
  const records = [];
  const renderer = new CadCanvasRenderer(createCanvasStub(create2dContext(records)), { contrastMode: 'preserve' });
  const document = createDocument();
  renderer.setDocument(document);

  renderer.setViewState({ centerX: 12, centerY: 34, scale: 2.5 });
  const zoomBefore = renderer.getZoomRatio();

  records.length = 0;
  renderer.setColorPolicy(MONO);

  assert.deepEqual(renderer.getViewState(), { centerX: 12, centerY: 34, scale: 2.5 });
  assert.equal(renderer.getZoomRatio(), zoomBefore);
  assert.ok(records.some((r) => r.color === MONO_CSS), `expected monochrome stroke, got ${JSON.stringify(records)}`);
  assert.ok(!records.some((r) => r.color === '#00ff00' || r.color === '#ff0000'), 'source colors must not linger');

  assert.deepEqual(readCadColorPolicy(renderer.getDocument()), { mode: 'monochrome', monochromeColor: '#102030' });
  assert.equal(renderer.getSourceDocument(), document);
  assert.deepEqual(document.metadata, {}, 'source document metadata must stay untouched');

  records.length = 0;
  renderer.setColorPolicy({ mode: 'source' });
  assert.deepEqual(renderer.getViewState(), { centerX: 12, centerY: 34, scale: 2.5 });
  assert.ok(records.some((r) => r.color === '#00ff00'), 'source colors must be restored');
  assert.ok(!records.some((r) => r.color === MONO_CSS), 'monochrome color must not linger');
  assert.equal(readCadColorPolicy(renderer.getDocument()).mode, 'source');

  records.length = 0;
  renderer.setColorPolicy({ mode: 'monochrome', monochromeColor: '#010203' });
  assert.ok(records.some((r) => r.color === 'rgb(1, 2, 3)'), 'updated monochromeColor must apply');
  assert.ok(!records.some((r) => r.color === MONO_CSS), 'previous monochrome color must not linger');
});

test('CadCanvasRenderer fit after a policy switch matches a direct policy load', () => {
  const switched = new CadCanvasRenderer(createCanvasStub(create2dContext([])), { contrastMode: 'preserve' });
  switched.setDocument(createDocument());
  switched.setColorPolicy(MONO);

  const direct = new CadCanvasRenderer(createCanvasStub(create2dContext([])), { contrastMode: 'preserve' });
  direct.setColorPolicy(MONO);
  direct.setDocument(createDocument());

  for (const mode of ['saved-view', 'extents']) {
    switched.fitToView(0.92, mode);
    direct.fitToView(0.92, mode);
    assert.deepEqual(switched.getViewState(), direct.getViewState(), `view mismatch for fit mode ${mode}`);
    assert.equal(switched.getZoomRatio(), direct.getZoomRatio());
  }
  assert.deepEqual(readCadColorPolicy(switched.getDocument()), readCadColorPolicy(direct.getDocument()));
});

test('CadCanvasRenderer ignores policy switches with no document and after destroy', () => {
  const renderer = new CadCanvasRenderer(createCanvasStub(create2dContext([])), { contrastMode: 'preserve' });
  assert.doesNotThrow(() => renderer.setColorPolicy(MONO));
  assert.equal(renderer.getDocument(), undefined);

  renderer.setColorPolicy({ mode: 'source' });
  renderer.setDocument(createDocument());
  let statsCalls = 0;
  let viewCalls = 0;
  renderer.onStats = () => statsCalls++;
  renderer.onViewChange = () => viewCalls++;
  renderer.destroy();
  assert.doesNotThrow(() => renderer.setColorPolicy(MONO));
  assert.equal(statsCalls, 0, 'destroyed renderer must not render');
  assert.equal(viewCalls, 0, 'destroyed renderer must not emit view changes');
  assert.equal(readCadColorPolicy(renderer.getDocument()).mode, 'source', 'destroyed renderer must not rebuild');
});

// --- WebGL renderer ----------------------------------------------------------

test('CadWebGLRenderer rebuilds color batches without resetting the viewport', () => {
  const uploads = [];
  const renderer = new CadWebGLRenderer(createWebGLCanvasStub(createWebGLContextStub(uploads)), { contrastMode: 'preserve' });
  const document = createDocument();
  renderer.setDocument(document);

  assert.ok(uploadIncludes(uploads, [0, 255, 0, 255]), 'source colors must reach the GPU');

  renderer.setViewState({ centerX: 5, centerY: -7, scale: 4 });
  const zoomBefore = renderer.getZoomRatio();

  uploads.length = 0;
  renderer.setColorPolicy(MONO);

  assert.deepEqual(renderer.getViewState(), { centerX: 5, centerY: -7, scale: 4 });
  assert.equal(renderer.getZoomRatio(), zoomBefore);
  assert.ok(uploads.length > 0, 'color batches must be rebuilt');
  assert.ok(uploadIncludes(uploads, [16, 32, 48, 255]), 'monochrome color must reach the GPU');
  assert.ok(!uploadIncludes(uploads, [0, 255, 0, 255]), 'source colors must not linger in GPU batches');

  assert.deepEqual(readCadColorPolicy(renderer.getDocument()), { mode: 'monochrome', monochromeColor: '#102030' });
  assert.equal(renderer.getSourceDocument(), document);
  assert.deepEqual(document.metadata, {}, 'source document metadata must stay untouched');

  uploads.length = 0;
  renderer.setColorPolicy({ mode: 'source' });
  assert.deepEqual(renderer.getViewState(), { centerX: 5, centerY: -7, scale: 4 });
  assert.ok(uploadIncludes(uploads, [0, 255, 0, 255]), 'source colors must be restored');
  assert.ok(!uploadIncludes(uploads, [16, 32, 48, 255]), 'monochrome color must not linger');
});

test('CadWebGLRenderer cancels a pending animation frame when switching policy', () => {
  const uploads = [];
  const renderer = new CadWebGLRenderer(createWebGLCanvasStub(createWebGLContextStub(uploads)), { contrastMode: 'preserve' });
  renderer.setDocument(createDocument());

  rafQueue.clear();
  renderer.zoom(1.5); // schedules a requestAnimationFrame render
  assert.equal(rafQueue.size, 1);

  renderer.setColorPolicy(MONO);
  assert.equal(rafQueue.size, 0, 'stale scheduled render must be cancelled');

  uploads.length = 0;
  for (const callback of [...rafQueue.values()]) callback();
  assert.equal(uploads.length, 0, 'no stale scene may be uploaded after the switch');
});

test('CadWebGLRenderer fit after a policy switch matches a direct policy load', () => {
  const switched = new CadWebGLRenderer(createWebGLCanvasStub(createWebGLContextStub([])), { contrastMode: 'preserve' });
  switched.setDocument(createDocument());
  switched.setColorPolicy(MONO);

  const direct = new CadWebGLRenderer(createWebGLCanvasStub(createWebGLContextStub([])), { contrastMode: 'preserve' });
  direct.setColorPolicy(MONO);
  direct.setDocument(createDocument());

  for (const mode of ['saved-view', 'extents']) {
    switched.fitToView(0.92, mode);
    direct.fitToView(0.92, mode);
    assert.deepEqual(switched.getViewState(), direct.getViewState(), `view mismatch for fit mode ${mode}`);
    assert.equal(switched.getZoomRatio(), direct.getZoomRatio());
  }
  assert.deepEqual(readCadColorPolicy(switched.getDocument()), readCadColorPolicy(direct.getDocument()));
});

test('CadWebGLRenderer ignores policy switches with no document and after destroy', () => {
  const renderer = new CadWebGLRenderer(createWebGLCanvasStub(createWebGLContextStub([])), { contrastMode: 'preserve' });
  assert.doesNotThrow(() => renderer.setColorPolicy(MONO));
  assert.equal(renderer.getDocument(), undefined);

  renderer.setColorPolicy({ mode: 'source' });
  renderer.setDocument(createDocument());
  let statsCalls = 0;
  let viewCalls = 0;
  renderer.onStats = () => statsCalls++;
  renderer.onViewChange = () => viewCalls++;
  renderer.destroy();
  assert.doesNotThrow(() => renderer.setColorPolicy(MONO));
  assert.equal(statsCalls, 0, 'destroyed renderer must not render');
  assert.equal(viewCalls, 0, 'destroyed renderer must not emit view changes');
  assert.equal(readCadColorPolicy(renderer.getDocument()).mode, 'source', 'destroyed renderer must not rebuild');
});
