/**
 * Minimal browser globals for exercising the Pinia three.js store in Node.
 * Only what TrackballControls, the renderer stub and the store touch.
 */
import { createPinia, setActivePinia } from 'pinia'

export function miniEventTarget() {
  const map = new Map()
  return {
    addEventListener(type, fn) {
      if (!map.has(type)) map.set(type, new Set())
      map.get(type).add(fn)
    },
    removeEventListener(type, fn) {
      map.get(type)?.delete(fn)
    },
    dispatchEvent(event) {
      const listeners = map.get(event.type)
      if (listeners) {
        for (const fn of [...listeners]) fn.call(this, event)
      }
      return true
    },
    listenerCount(type) {
      return map.get(type)?.size ?? 0
    },
  }
}

export function createContainer(width = 800, height = 600) {
  const target = miniEventTarget()
  return {
    ...target,
    tagName: 'DIV',
    offsetWidth: width,
    offsetHeight: height,
    children: [],
    style: {},
    ownerDocument: { documentElement: { clientLeft: 0, clientTop: 0 } },
    appendChild(child) {
      this.children.push(child)
      child.parentNode = this
      return child
    },
    removeChild(child) {
      const index = this.children.indexOf(child)
      if (index >= 0) this.children.splice(index, 1)
      child.parentNode = null
      return child
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width, height }
    },
    setPointerCapture() {},
    releasePointerCapture() {},
  }
}

/**
 * Install fake window globals and return controls over the rAF queue.
 */
export function installBrowserGlobals() {
  let nextFrameId = 0
  const pendingFrames = new Map()
  const windowTarget = miniEventTarget()

  const fakeWindow = {
    ...windowTarget,
    devicePixelRatio: 1,
    pageXOffset: 0,
    pageYOffset: 0,
    requestAnimationFrame(callback) {
      const id = ++nextFrameId
      pendingFrames.set(id, callback)
      return id
    },
    cancelAnimationFrame(id) {
      pendingFrames.delete(id)
    },
  }

  globalThis.window = fakeWindow

  return {
    pendingFrames,
    runOneFrame() {
      const entries = [...pendingFrames.entries()]
      pendingFrames.clear()
      for (const [, callback] of entries) callback()
    },
    resize() {
      fakeWindow.dispatchEvent({ type: 'resize' })
    },
    windowListeners: fakeWindow,
  }
}

export function freshStore() {
  setActivePinia(createPinia())
  // Import lazily so each test gets the store bound to the active pinia.
  return import('../src/store.js').then(({ useThreeStore }) => useThreeStore())
}

export function pointerEvent(type, { pointerId = 1, pageX = 400, pageY = 300, button = 0 } = {}) {
  return {
    type,
    pointerId,
    pointerType: 'mouse',
    button,
    pageX,
    pageY,
    preventDefault() {},
  }
}

/**
 * Simulate a mouse rotate-drag on the controls' canvas.
 */
export function dragRotate(canvas, from, to) {
  canvas.dispatchEvent(pointerEvent('pointerdown', { pageX: from.x, pageY: from.y }))
  canvas.dispatchEvent(pointerEvent('pointermove', { pageX: to.x, pageY: to.y }))
  canvas.dispatchEvent(pointerEvent('pointerup', { pageX: to.x, pageY: to.y }))
}
