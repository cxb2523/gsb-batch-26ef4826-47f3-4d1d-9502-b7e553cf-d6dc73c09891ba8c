import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  installBrowserGlobals,
  createContainer,
  freshStore,
  dragRotate,
} from './helpers.mjs'

let env

beforeEach(() => {
  env = installBrowserGlobals()
})

afterEach(async () => {
  const store = await freshStore()
  store.dispose()
})

// ---------------------------------------------------------------------------
// 1. Visibility: store flags are the single source of truth
// ---------------------------------------------------------------------------

test('init adds pyramids and axis lines to the scene matching visible flags', async () => {
  const store = await freshStore()
  const el = createContainer()

  await store.init({ width: 800, height: 600, el })

  assert.equal(store.pyramidsVisible, true)
  assert.equal(store.axisLinesVisible, true)
  assert.equal(store.pyramids.length, 500)
  assert.equal(store.axisLines.length, 3)
  for (const mesh of store.pyramids) {
    assert.equal(mesh.parent, store.scene)
  }
  for (const line of store.axisLines) {
    assert.equal(line.parent, store.scene)
  }
})

test('toggling visibility removes/reattaches objects and updates the flags', async () => {
  const store = await freshStore()
  const el = createContainer()
  await store.init({ width: 800, height: 600, el })

  store.togglePyramids()
  assert.equal(store.pyramidsVisible, false)
  for (const mesh of store.pyramids) {
    assert.equal(mesh.parent, null)
  }
  // Axis lines untouched
  for (const line of store.axisLines) {
    assert.equal(line.parent, store.scene)
  }

  store.toggleAxisLines()
  assert.equal(store.axisLinesVisible, false)
  for (const line of store.axisLines) {
    assert.equal(line.parent, null)
  }

  store.togglePyramids()
  assert.equal(store.pyramidsVisible, true)
  for (const mesh of store.pyramids) {
    assert.equal(mesh.parent, store.scene)
  }
})

test('repeated visibility actions are idempotent: no double-add and no false removal', async () => {
  const store = await freshStore()
  const el = createContainer()
  await store.init({ width: 800, height: 600, el })

  // Already visible -> setVisible(true) must not duplicate children
  store.setPyramidsVisible(true)
  store.setPyramidsVisible(true)
  const pyramidChildren = store.scene.children.filter((c) => c.isMesh)
  assert.equal(pyramidChildren.length, 500)

  store.setAxisLinesVisible(true)
  store.setAxisLinesVisible(true)
  const lineChildren = store.scene.children.filter((c) => c.isLine)
  assert.equal(lineChildren.length, 3)

  // Hidden -> repeated hide stays hidden and does not throw
  store.setAxisLinesVisible(false)
  store.setAxisLinesVisible(false)
  assert.equal(store.axisLines.every((l) => l.parent === null), true)
})

test('re-init reconciles the scene with toggled-off visibility flags', async () => {
  const store = await freshStore()
  const el = createContainer()
  await store.init({ width: 800, height: 600, el })

  store.togglePyramids()
  store.toggleAxisLines()
  assert.equal(store.pyramidsVisible, false)
  assert.equal(store.axisLinesVisible, false)

  // Simulate navigating away and back
  store.dispose()
  await store.init({ width: 800, height: 600, el })

  assert.equal(store.pyramids.length, 500)
  assert.equal(store.axisLines.length, 3)
  assert.equal(store.pyramids.every((m) => m.parent === null), true)
  assert.equal(store.axisLines.every((l) => l.parent === null), true)
})

// ---------------------------------------------------------------------------
// 2. Camera reset: controls are synchronized so the next drag does not snap
// ---------------------------------------------------------------------------

test('resetCamera restores position, up, target and internal controls state', async () => {
  const store = await freshStore()
  const el = createContainer()
  await store.init({ width: 800, height: 600, el })
  const canvas = store.renderer.domElement
  const controls = store.controls

  // Rotate the camera away from the initial pose
  dragRotate(canvas, { x: 400, y: 300 }, { x: 300, y: 220 })
  controls.update()
  const before = store.camera.position.clone()
  assert.notDeepEqual(
    [before.x, before.y, before.z].map((v) => Math.round(v)),
    [0, 0, 500]
  )
  // TrackballControls tilts camera.up while rotating
  assert.notDeepEqual(
    [store.camera.up.x, store.camera.up.y, store.camera.up.z].map((v) => Math.round(v * 1000) / 1000),
    [0, 1, 0]
  )

  const renderCallsBeforeReset = store.renderer.renderCalls
  store.resetCamera()

  assert.deepEqual(
    [store.camera.position.x, store.camera.position.y, store.camera.position.z],
    [0, 0, 500]
  )
  assert.deepEqual(
    [store.camera.up.x, store.camera.up.y, store.camera.up.z],
    [0, 1, 0]
  )
  assert.deepEqual(
    [controls.target.x, controls.target.y, controls.target.z],
    [0, 0, 0]
  )
  // Controls internal state must track the reset pose (this is what the old
  // resetCameraRotation missed: _lastPosition stayed on the old pose).
  assert.deepEqual(
    [controls._lastPosition.x, controls._lastPosition.y, controls._lastPosition.z],
    [0, 0, 500]
  )
  // An immediate repaint is part of the reset
  assert.ok(store.renderer.renderCalls > renderCallsBeforeReset)
  // Reactive camera position follows
  assert.deepEqual(store.cameraPosition, { x: 0, y: 0, z: 500 })
})

test('dragging immediately after reset moves smoothly from the reset pose', async () => {
  const store = await freshStore()
  const el = createContainer()
  await store.init({ width: 800, height: 600, el })
  const canvas = store.renderer.domElement
  const controls = store.controls

  // Move away, then reset
  dragRotate(canvas, { x: 400, y: 300 }, { x: 250, y: 200 })
  controls.update()
  store.resetCamera()

  const radiusAtReset = store.camera.position.length()

  // First interaction after reset: a fresh gesture starting at the pointer
  dragRotate(canvas, { x: 400, y: 300 }, { x: 360, y: 280 })
  controls.update()

  // The camera must still be near the reset orbit — no teleport back to the
  // pre-reset orientation (which would read as a large jump).
  const radiusAfter = store.camera.position.length()
  assert.ok(Math.abs(radiusAfter - radiusAtReset) < 1,
    `radius jumped from ${radiusAtReset} to ${radiusAfter}`)

  const jump = store.camera.position.distanceTo({ x: 0, y: 0, z: 500 })
  assert.ok(jump < 120, `camera jumped ${jump} units away from reset pose on first drag`)

  // Internal last-position bookkeeping follows the actual camera
  assert.ok(
    controls._lastPosition.distanceTo(store.camera.position) < 0.01
  )
})

// ---------------------------------------------------------------------------
// 3. Render-loop lifecycle: no stacked loops, listeners or canvases
// ---------------------------------------------------------------------------

test('init starts exactly one rAF loop and one controls/window listener each', async () => {
  const store = await freshStore()
  const el = createContainer()
  await store.init({ width: 800, height: 600, el })

  assert.equal(env.pendingFrames.size, 1)
  assert.equal(env.windowListeners.listenerCount('resize'), 1)
  assert.equal(store.renderer.domElement.listenerCount('pointerdown'), 1)
  assert.equal(el.children.length, 1)
  assert.equal(el.children[0].tagName, 'CANVAS')

  env.runOneFrame()
  assert.equal(env.pendingFrames.size, 1, 'loop reschedules itself each frame')
})

test('dispose cancels the queued frame, unbinds listeners and frees resources', async () => {
  const store = await freshStore()
  const el = createContainer()
  await store.init({ width: 800, height: 600, el })
  const canvas = store.renderer.domElement
  const renderer = store.renderer
  const controls = store.controls

  store.dispose()

  assert.equal(env.pendingFrames.size, 0, 'no animation frame remains queued')
  assert.equal(env.windowListeners.listenerCount('resize'), 0)
  assert.equal(canvas.listenerCount('pointerdown'), 0)
  assert.equal(renderer.disposed, true)
  assert.equal(controls.domElement, canvas)
  assert.equal(el.children.length, 0, 'canvas removed from the DOM')
  assert.equal(store.animationFrameId, null)
  assert.equal(store.renderer, null)
  assert.equal(store.controls, null)
  assert.equal(store.scene, null)
  assert.equal(store.camera, null)

  // A frame fired after dispose must not resurrect the loop
  env.runOneFrame()
  assert.equal(env.pendingFrames.size, 0)
})

test('dispose is safe to call repeatedly and before init', async () => {
  const store = await freshStore()
  assert.doesNotThrow(() => store.dispose())
  const el = createContainer()
  await store.init({ width: 800, height: 600, el })
  assert.doesNotThrow(() => {
    store.dispose()
    store.dispose()
  })
})

test('repeated init does not stack loops, listeners or canvases', async () => {
  const store = await freshStore()
  const el = createContainer()

  await store.init({ width: 800, height: 600, el })
  await store.init({ width: 800, height: 600, el })
  await store.init({ width: 800, height: 600, el })

  assert.equal(env.pendingFrames.size, 1)
  assert.equal(env.windowListeners.listenerCount('resize'), 1)
  assert.equal(store.renderer.domElement.listenerCount('pointerdown'), 1)
  assert.equal(el.children.length, 1, 'only one canvas in the DOM')
})

test('a second init tears down the previous renderer before creating a new one', async () => {
  const store = await freshStore()
  const el = createContainer()
  await store.init({ width: 800, height: 600, el })
  const firstRenderer = store.renderer

  await store.init({ width: 800, height: 600, el })

  assert.equal(firstRenderer.disposed, true)
  assert.notEqual(store.renderer, firstRenderer)
  assert.equal(el.children.length, 1)
})

// ---------------------------------------------------------------------------
// 4. Window resize: camera aspect, renderer size and controls all sync
// ---------------------------------------------------------------------------

test('window resize updates aspect ratio, renderer size and controls metrics', async () => {
  const store = await freshStore()
  const el = createContainer(800, 600)
  await store.init({ width: 800, height: 600, el })

  let handleResizeCalls = 0
  const originalHandleResize = store.controls.handleResize.bind(store.controls)
  store.controls.handleResize = () => {
    handleResizeCalls++
    originalHandleResize()
  }

  el.offsetWidth = 1024
  el.offsetHeight = 512
  env.resize()

  assert.equal(store.width, 1024)
  assert.equal(store.height, 512)
  assert.equal(store.camera.aspect, 1024 / 512)
  assert.deepEqual(
    store.renderer.setSizeCalls[store.renderer.setSizeCalls.length - 1],
    [1024, 512]
  )
  assert.ok(handleResizeCalls > 0, 'controls.handleResize is called on resize')
})
