/**
 * Build-path verification for the spatial index trees.
 *
 * Replicates the Gulp `dist` concatenation for the `src/syngen/tool/*.js`
 * batch (the trees ship in that exact ordered group, see Gulpfile getJs()),
 * writing the bundle to the OS temp directory so nothing is added to the repo.
 * The bundle is loaded with browser stubs and the trees are smoke-tested
 * through the concatenated build, including insert/remove/find/retrieve and
 * the cross-child removal and duplicate-dedup contracts.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')

const repoRoot = path.resolve(__dirname, '..')
const srcRoot = path.join(repoRoot, 'src')

function read(relativePath) {
  return fs.readFileSync(path.join(srcRoot, relativePath), 'utf8')
}

const toolFiles = fs.readdirSync(path.join(srcRoot, 'syngen', 'tool'))
  .filter((file) => file.endsWith('.js'))
  .sort()
  .map((file) => path.join('syngen', 'tool', file))

const files = ['syngen.js', 'syngen/const.js', 'syngen/fn.js', ...toolFiles]

const bundle = [
  read('wrapper/header.js'),
  ...files.map(read),
  read('wrapper/footer.js'),
].join('\n')

const target = path.join(os.tmpdir(), 'syngen-tools-bundle.js')
fs.writeFileSync(target, bundle)

const sandbox = {
  AudioContext: class AudioContext {
    constructor() {
      this.currentTime = 0
    }

    addEventListener() {}
  },
  document: {addEventListener() {}, hidden: false},
  window: {addEventListener() {}},
  console,
}
sandbox.self = sandbox
sandbox.globalThis = sandbox

const syngen = vm.runInContext(bundle, vm.createContext(sandbox), {filename: target})

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

// quadtree: duplicate dedup, cross-child removal, exact-radius find
const q = syngen.tool.quadtree.create({maxItems: 2, x: 0, y: 0, width: 100, height: 100})
const qa = {x: 10, y: 10}
const qb = {x: 80, y: 80}
q.insert(qa)
q.insert(qa)
q.insert(qb)
assert(q.nodes.length === 4, 'quadtree split into four nodes')
assert(q.items.length === 0, 'quadtree parent released items')
const qFound = q.retrieve({x: 0, y: 0, width: 100, height: 100})
assert(qFound.length === 2 && qFound.includes(qa), 'quadtree retrieve dedups duplicates')

// Move qa so its computed index no longer matches where it is stored, then
// remove each of its two copies one at a time.
qa.x = 60
qa.y = 60
q.remove(qa)
let remaining = q.retrieve({x: 0, y: 0, width: 100, height: 100})
assert(remaining.filter((item) => item === qa).length === 1,
  'quadtree first remove follows the moved item and deletes one copy')
q.remove(qa)
remaining = q.retrieve({x: 0, y: 0, width: 100, height: 100})
assert(!remaining.includes(qa), 'quadtree second remove deletes the other copy')
assert(remaining.includes(qb), 'quadtree unrelated item survives')

// octree: finite-radius find and cross-child removal
const o = syngen.tool.octree.create({maxItems: 2, x: 0, y: 0, z: 0, width: 100, height: 100, depth: 100})
const oa = {x: 1, y: 1, z: 1}
o.insert(oa)
o.insert({x: 10, y: 10, z: 10})
o.insert({x: 90, y: 90, z: 90})
assert(o.nodes.length === 8, 'octree split into eight nodes')
// Querying with the stored object itself skips it; the next item is ~15.6 away.
assert(o.find(oa, 5) === undefined, 'octree next-neighbor outside finite radius is excluded')
assert(o.find(oa, 20) !== undefined, 'octree neighbor found once radius reaches it')
oa.x = 90
oa.y = 90
oa.z = 90
o.remove(oa)
assert(!o.retrieve({x: 0, y: 0, z: 0, width: 100, height: 100, depth: 100}).includes(oa),
  'octree remove follows the moved item across children')

// bitree: finite-radius bounds, one-removes-one-copy
const bi = syngen.tool.bitree.create({maxItems: 2, minValue: 0, range: 100})
const dup = {value: 5}
bi.insert(dup)
bi.insert(dup)
bi.insert({value: 95})
assert(bi.nodes.length > 0, 'bitree split into child nodes')
assert(bi.retrieve(0, 100).length === 2, 'bitree retrieve dedups duplicates')
bi.remove(dup)
const afterFirst = bi.retrieve(0, 100)
assert(afterFirst.includes(dup) && afterFirst.length === 2, 'bitree one remove deletes one copy')
assert(bi.find({value: 50}, 5) === undefined, 'bitree finite radius respected')

// filter on quadtree now receives center/radius like the octree
const qFilter = syngen.tool.quadtree.create({maxItems: 2, x: 0, y: 0, width: 100, height: 100})
qFilter.insert({x: 10, y: 10})
qFilter.insert({x: 80, y: 80})
qFilter.insert({x: 80, y: 10})
let sawBounds = false
qFilter.filter((center, radius) => {
  sawBounds = typeof center.x === 'number' && typeof center.y === 'number' && typeof radius === 'number'
  return true
})
assert(sawBounds, 'quadtree filter receives center and radius node bounds')

fs.unlinkSync(target)
console.log(`tool-batch build smoke test passed (${files.length} modules concatenated); temp bundle removed`)
