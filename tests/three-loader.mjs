/**
 * ESM loader hook for the store tests.
 *
 * The real three.js module is used as-is, except WebGLRenderer is replaced
 * with a lightweight stub because creating a real renderer needs a WebGL
 * context that does not exist in Node. Everything else (Scene, Camera,
 * TrackballControls, math types, ...) runs for real so the camera/controls
 * synchronization logic is genuinely exercised.
 */
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// The package's exports map hides package.json and ./build/*.js, so derive
// the ESM build path from the resolvable CJS entry instead.
const threeCjsPath = require.resolve('three')
const realThreeUrl = pathToFileURL(
  threeCjsPath.replace(/[\\/]build[\\/]three\.cjs$/, '/build/three.module.js')
).href

const stubSource = `
export * from ${JSON.stringify(realThreeUrl)}
export { WebGLRendererStub as WebGLRenderer }

function miniEventTarget() {
  const map = new Map()
  return {
    addEventListener(type, fn) {
      if (!map.has(type)) map.set(type, new Set())
      map.get(type).add(fn)
    },
    removeEventListener(type, fn) { map.get(type)?.delete(fn) },
    dispatchEvent(event) {
      for (const fn of [...(map.get(event.type) ?? [])]) fn.call(this, event)
      return true
    },
    listenerCount(type) { return map.get(type)?.size ?? 0 },
  }
}

class WebGLRendererStub {
  constructor(options = {}) {
    this.options = options
    this.renderCalls = 0
    this.setSizeCalls = []
    this.disposed = false
    this.pixelRatio = 1
    this.domElement = Object.assign(miniEventTarget(), {
      tagName: 'CANVAS',
      style: {},
      parentNode: null,
      clientWidth: 800,
      ownerDocument: { documentElement: { clientLeft: 0, clientTop: 0 } },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      setPointerCapture() {},
      releasePointerCapture() {},
    })
  }
  setPixelRatio(value) { this.pixelRatio = value }
  setSize(width, height) {
    this.setSizeCalls.push([width, height])
    this.width = width
    this.height = height
    this.domElement.getBoundingClientRect = () => ({
      left: 0, top: 0, width, height,
    })
    this.domElement.clientWidth = width
  }
  render() { this.renderCalls++ }
  dispose() {
    this.disposed = true
    if (this.domElement.parentNode && this.domElement.parentNode.removeChild) {
      this.domElement.parentNode.removeChild(this.domElement)
    }
  }
}
`

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'three') {
    return {
      url: 'stub:three-webgl-renderer',
      shortCircuit: true,
    }
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url === 'stub:three-webgl-renderer') {
    return {
      format: 'module',
      source: stubSource,
      shortCircuit: true,
    }
  }
  return nextLoad(url, context)
}
