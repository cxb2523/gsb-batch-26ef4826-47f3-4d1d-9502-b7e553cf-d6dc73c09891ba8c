/**
 * Registers the test-only ESM loader that stubs WebGLRenderer.
 */
import { register } from 'node:module'

register('./three-loader.mjs', import.meta.url)
