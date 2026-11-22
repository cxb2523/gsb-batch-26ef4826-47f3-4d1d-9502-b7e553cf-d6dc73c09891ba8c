import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'

import {
  installBrowserGlobals,
  createContainer,
  freshStore,
} from './helpers.mjs'

let env

beforeEach(() => {
  env = installBrowserGlobals()
})

/**
 * Compile a <script> block and evaluate it, mapping the project's "@" alias
 * to the real store module. Returns the component options object.
 */
async function loadComponent(relativePath) {
  const filename = fileURLToPath(new URL(relativePath, import.meta.url))
  const source = readFileSync(filename, 'utf8')
  const { descriptor } = parse(source, { filename })
  const id = filename.replace(/\W/g, '')
  const compiled = compileScript(descriptor, { id })
  const storeUrl = new URL('../src/store.js', import.meta.url).href
  const transformed = compiled.content.replace(
    /from\s+["']@\/store["']/,
    `from ${JSON.stringify(storeUrl)}`
  )
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(transformed).toString('base64')}`
  )
  const template = compileTemplate({
    source: descriptor.template.content,
    filename,
    id,
  })
  assert.equal(template.errors.length, 0, `template errors: ${template.errors}`)
  return { options: module.default, templateSource: descriptor.template.content }
}

test('ViewPort mounts the store loop and disposes everything on unmount', async () => {
  const { options } = await loadComponent('../src/components/ViewPort.vue')
  const store = await freshStore()
  const el = createContainer()

  // Execute the real mounted() hook with a component-like `this`
  const instance = { $el: el }
  await options.mounted.call(instance)

  assert.ok(store.renderer)
  assert.ok(store.controls)
  assert.equal(store.animationFrameId !== null, true)
  assert.equal(env.pendingFrames.size, 1)
  assert.equal(el.children.length, 1)
  assert.equal(env.windowListeners.listenerCount('resize'), 1)

  // Execute the real beforeUnmount() hook
  options.beforeUnmount.call(instance)

  assert.equal(env.pendingFrames.size, 0)
  assert.equal(env.windowListeners.listenerCount('resize'), 0)
  assert.equal(store.renderer, null)
  assert.equal(store.controls, null)
  assert.equal(el.children.length, 0)
})

test('ViewPort remount (leave and re-enter) yields a single loop and canvas', async () => {
  const { options } = await loadComponent('../src/components/ViewPort.vue')
  const store = await freshStore()
  const el = createContainer()
  const instance = { $el: el }

  for (let i = 0; i < 3; i++) {
    await options.mounted.call(instance)
    options.beforeUnmount.call(instance)
  }
  // Final mount should leave exactly one live loop/canvas
  await options.mounted.call(instance)
  assert.equal(env.pendingFrames.size, 1)
  assert.equal(el.children.length, 1)
  assert.equal(env.windowListeners.listenerCount('resize'), 1)
  options.beforeUnmount.call(instance)
  assert.equal(env.pendingFrames.size, 0)
  assert.equal(el.children.length, 0)
})

test('ControlPanel checkboxes bind to store visibility flags and dispatch store actions', async () => {
  const { options, templateSource } = await loadComponent(
    '../src/components/ControlPanel.vue'
  )
  const store = await freshStore()

  // No local visibility state survives in the component options
  assert.equal(options.data, undefined)
  assert.equal(typeof options.methods.resetCameraPosition, 'function')

  // The compiled template must read the store flags and only call actions
  assert.match(templateSource, /:checked="store\.pyramidsVisible"/)
  assert.match(templateSource, /@change="store\.togglePyramids\(\)"/)
  assert.match(templateSource, /:checked="store\.axisLinesVisible"/)
  assert.match(templateSource, /@change="store\.toggleAxisLines\(\)"/)
  assert.doesNotMatch(templateSource, /v-model/)
  assert.doesNotMatch(templateSource, /axisLinesVisible:\s*true/)

  // The reset button dispatches the single store reset action
  options.methods.resetCameraPosition.call({ store })

  // Drive the component's actual action surface against a live store
  const el = createContainer()
  await store.init({ width: 800, height: 600, el })
  assert.equal(store.pyramidsVisible, true)
  store.togglePyramids()
  assert.equal(store.pyramidsVisible, false)
  assert.equal(store.pyramids.every((m) => m.parent === null), true)
  options.methods.resetCameraPosition.call({ store })
  assert.deepEqual(store.cameraPosition, { x: 0, y: 0, z: 500 })
})
