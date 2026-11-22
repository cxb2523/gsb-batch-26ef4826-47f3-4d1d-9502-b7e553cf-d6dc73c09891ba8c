/**
 * Test harness: loads the framework sources in a sandbox so the tree
 * implementations can be exercised in Node without a browser build.
 *
 * The source is concatenated in the same order as the Gulp `dist` task,
 * wrapped with src/wrapper/header.js and footer.js, and evaluated with
 * minimal stubs for the browser globals touched at load time.
 */
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const repoRoot = path.resolve(__dirname, '..')
const srcRoot = path.join(repoRoot, 'src')

function read(relativePath) {
  return fs.readFileSync(path.join(srcRoot, relativePath), 'utf8')
}

function listJs(dir) {
  return fs.readdirSync(path.join(srcRoot, dir))
    .filter((file) => file.endsWith('.js'))
    .sort()
    .map((file) => path.join(dir, file))
}

function bundleSources() {
  const files = [
    'syngen.js',
    'syngen/const.js',
    'syngen/fn.js',
    ...listJs('syngen/tool'),
  ]

  const parts = [
    read('wrapper/header.js'),
    ...files.map(read),
    read('wrapper/footer.js'),
  ]

  return parts.join('\n')
}

function loadSyngen() {
  const sandbox = {
    AudioContext: class AudioContext {
      constructor() {
        this.currentTime = 0
      }

      addEventListener() {}
    },
    document: {
      addEventListener() {},
      hidden: false,
    },
    window: {
      addEventListener() {},
    },
    console,
  }

  sandbox.self = sandbox
  sandbox.globalThis = sandbox

  const context = vm.createContext(sandbox)
  const result = vm.runInContext(bundleSources(), context, {
    filename: 'syngen.bundle.js',
  })

  return result
}

module.exports = {
  loadSyngen,
}
