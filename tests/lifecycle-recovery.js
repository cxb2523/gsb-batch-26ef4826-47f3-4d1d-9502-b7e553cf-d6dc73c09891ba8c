import assert from 'node:assert/strict'
import { afterEach, beforeEach, mock, test } from 'node:test'

// -----------------------------------------------------------------------------
// Same hand-rolled DOM / GL mocks as tests/lifecycle.js — no real browser.
// A fresh mock GL is created per test so call-count assertions stay isolated.
// -----------------------------------------------------------------------------

const elements = new Set()
const frames = []
const loseContext = mock.fn()

const createGL = () => new Proxy({
  getExtension: mock.fn(() => ({ loseContext })),
}, {
  get: (target, key) => {
    if (key in target) return target[key]
    const value = /^[A-Z_]+$/.test(key)
      ? 1
      : mock.fn(() => key.includes('InfoLog') ? '' : {})
    target[key] = value
    return value
  },
})

let gl = createGL()

class Element {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase()
    this.parentElement = null
    this.clientWidth = 640
    this.clientHeight = 480
    elements.add(this)
  }
  get isConnected() {
    return this === document.body || Boolean(this.parentElement?.isConnected)
  }
  appendChild(child) {
    child.parentElement = this
    return child
  }
  remove() { this.parentElement = null }
  addEventListener() {}
  getContext() { return gl }
}

const matches = (element, selector) => {
  const [tag, id] = selector.split('#')
  const tagOk = !tag || element.tagName === tag.toUpperCase()
  const idOk = !selector.includes('#') || element.id === id
  return element.isConnected && tagOk && idOk
}

globalThis.document = {
  createElement: tag => new Element(tag),
  querySelector: selector => [...elements].find(element => matches(element, selector)),
  querySelectorAll: selector => [...elements].filter(element => matches(element, selector)),
}
document.body = new Element('body')
globalThis.window = {}
globalThis.requestAnimationFrame = frame => frames.push(frame)

const { default: gradientGL } = await import('../index.js')

const mount = (id = 'stage', tag = 'canvas') => document.body.appendChild(
  Object.assign(new Element(tag), { id }),
)
const tick = () => frames.splice(0).map(frame => frame())
const assertRejects = async (fn, message) => {
  await assert.rejects(fn, error => {
    assert.equal(error.message, message)
    return true
  })
}

beforeEach(() => {
  gl = createGL()
  mount()
})

afterEach(async () => {
  try {
    const program = await gradientGL('c1.915c')
    program.destroy()
  } catch {
    // A test may leave no usable context; nothing to clean up.
  }
  frames.splice(0)
  elements.clear()
  loseContext.mock.resetCalls()
})

// -----------------------------------------------------------------------------
// Requirement 1: caller-owned canvas survives a shader switch with its context.
// -----------------------------------------------------------------------------

test('shader switch on a caller canvas never loses its context or removes it', async () => {
  const target = mount('target', 'canvas')
  const program = await gradientGL('c1.915c', '#target')
  const before = loseContext.mock.callCount()

  const next = await gradientGL('b1.915c', '#target')
  tick()

  assert.notEqual(next, program)
  assert.ok(next.isMounted(target))
  assert.ok(target.isConnected)
  assert.equal(loseContext.mock.callCount(), before)

  next.destroy()
  assert.equal(loseContext.mock.callCount(), before)
  assert.ok(target.isConnected)
})

test('shader switch releases the old program and its buffers, not the context', async () => {
  const target = mount('target', 'canvas')
  await gradientGL('c1.915c', '#target')
  const deletedPrograms = gl.deleteProgram.mock.callCount()
  const deletedBuffers = gl.deleteBuffer.mock.callCount()

  const next = await gradientGL('b1.915c', '#target')

  assert.ok(gl.deleteProgram.mock.callCount() > deletedPrograms)
  assert.ok(gl.deleteBuffer.mock.callCount() > deletedBuffers)
  assert.equal(loseContext.mock.callCount(), 0)
  assert.ok(next.isMounted(target))
})

test('switched program keeps drawing frames on the same caller canvas', async () => {
  const target = mount('target', 'canvas')
  const first = await gradientGL('c1.915c', '#target')
  const sharedContext = target.getContext()
  const next = await gradientGL('b1.915c', '#target')
  assert.equal(target.getContext(), sharedContext)
  tick()
  const draws = gl.drawArrays.mock.callCount()
  tick()
  assert.ok(gl.drawArrays.mock.callCount() > draws)
  assert.notEqual(next, first)
  assert.ok(next.isMounted(target))
})

// -----------------------------------------------------------------------------
// Requirement 2: library-created canvas still releases context and leaves DOM.
// -----------------------------------------------------------------------------

test('owned canvas loses its context and is removed on destroy', async () => {
  await gradientGL('c1.915c')
  const owned = document.querySelector('#gradient-gl')
  assert.ok(owned)
  const lost = loseContext.mock.callCount()

  const program = await gradientGL('c1.915c')
  program.destroy()

  assert.ok(loseContext.mock.callCount() > lost)
  assert.equal(owned.parentElement, null)
  assert.equal(document.querySelectorAll('#gradient-gl').length, 0)
})

// -----------------------------------------------------------------------------
// Requirement 3: updateSeed refreshes the four uniforms; same seed is skipped.
// -----------------------------------------------------------------------------

test('new seed writes fresh speed, hue, saturation and lightness uniforms', async () => {
  const target = mount('target', 'canvas')
  const program = await gradientGL('c1.915c', '#target')
  // The four scalar uniforms are written in this fixed order, one call each,
  // every time external uniforms are applied.
  const uniformNames = ['timeScale', 'hueShift', 'saturation', 'lightness']
  const readUniforms = () => {
    const calls = gl.uniform1f.mock.calls
    return Object.fromEntries(
      uniformNames.map((name, index) => [
        name,
        calls.at(-uniformNames.length + index).arguments[1],
      ]),
    )
  }

  const firstValues = readUniforms()
  assert.ok(uniformNames.every(name => Number.isFinite(firstValues[name])))

  assert.equal(await gradientGL('c1.e9a0', '#target'), program)
  const secondValues = readUniforms()

  for (const name of uniformNames) {
    assert.notEqual(secondValues[name], firstValues[name], `${name} should refresh`)
  }
})

test('repeating the identical seed skips every uniform write', async () => {
  const target = mount('target', 'canvas')
  const program = await gradientGL('c1.915c', '#target')
  const uniform1fCalls = gl.uniform1f.mock.callCount()
  const uniform1ivCalls = gl.uniform1iv.mock.callCount()

  assert.equal(await gradientGL('c1.915c', '#target'), program)
  assert.equal(gl.uniform1f.mock.callCount(), uniform1fCalls)
  assert.equal(gl.uniform1iv.mock.callCount(), uniform1ivCalls)
})

// -----------------------------------------------------------------------------
// Requirement 4: failed switches leave no half-initialized active program.
// -----------------------------------------------------------------------------

test('unknown shader fails without tearing down the live program', async () => {
  const program = await gradientGL('c1.915c', '#stage')
  await assertRejects(() => gradientGL('z9.915c', '#stage'), 'Unknown shader')

  // The previously rendering program is still mounted and reusable.
  assert.ok(program.isMounted(document.querySelector('#stage')))
  const again = await gradientGL('c1.915c', '#stage')
  assert.equal(again, program)

  // A later valid switch still mounts normally.
  const next = await gradientGL('b1.915c', '#stage')
  assert.notEqual(next, program)
  assert.ok(next.isMounted(document.querySelector('#stage')))
})

test('WebGL2 unavailable cleans up and a later boot still mounts', async () => {
  const target = mount('target', 'canvas')
  target.getContext = () => null

  await assertRejects(
    () => gradientGL('c1.915c', '#target'),
    'WebGL2 not supported',
  )

  // The caller canvas stays in the DOM, untouched by the failed initialization.
  assert.ok(target.isConnected)
  assert.equal(loseContext.mock.callCount(), 0)

  // Restore a usable context: the next boot must mount on the same canvas.
  target.getContext = Element.prototype.getContext
  const program = await gradientGL('b1.915c', '#target')
  assert.ok(program.isMounted(target))
  tick()
  const draws = gl.drawArrays.mock.callCount()
  tick()
  assert.ok(gl.drawArrays.mock.callCount() > draws)
})

test('failed init then success leaves a single connected canvas', async () => {
  const target = mount('target', 'canvas')
  target.getContext = () => null
  await assertRejects(() => gradientGL('c1.915c', '#target'), 'WebGL2 not supported')

  target.getContext = Element.prototype.getContext
  await gradientGL('c1.915c', '#target')
  assert.ok(target.isConnected)
  assert.equal(document.querySelectorAll('canvas#target').length, 1)
})
