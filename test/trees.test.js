/**
 * Validation suite for the one-, two-, and three-dimensional spatial index trees.
 *
 * Covers the behaviors required of syngen.tool.bitree, .quadtree, and .octree:
 *   1. Queries after a node splits traverse every child and never revisit parents
 *   2. Removal follows items across children when index and storage disagree
 *   3. Repeated insertion of the same object: one remove removes one copy,
 *      and query results never contain duplicates
 *   4. Finite-radius find respects its search bounds, including boundaries
 *   5. Quadtree filter exposes the same center/radius node bounds as octree
 *
 * Run with: node test/trees.test.js
 */
const assert = require('assert')
const {loadSyngen} = require('./harness')

const syngen = loadSyngen()

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok - ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL - ${name}`)
    console.log(`        ${error.message}`)
  }
}

function section(name) {
  console.log(`\n${name}`)
}

/** Recursively collects every stored reference, including duplicates. */
function collectAll(node, result = []) {
  for (const item of node.items) {
    result.push(item)
  }

  for (const child of node.nodes) {
    collectAll(child, result)
  }

  return result
}

/** Asserts an array contains each expected item exactly once. */
function assertUniqueSet(actual, expected, message) {
  assert.strictEqual(actual.length, expected.length,
    `${message}: expected ${expected.length} unique item(s), got ${actual.length} (${JSON.stringify(actual)}`)

  for (const item of expected) {
    assert.ok(actual.includes(item), `${message}: missing item ${JSON.stringify(item)}`)
    assert.strictEqual(actual.filter((candidate) => candidate === item).length, 1,
      `${message}: duplicate item ${JSON.stringify(item)}`)
  }
}

function countByIdentity(items, target) {
  return items.filter((item) => item === target).length
}

// ---------------------------------------------------------------------------
// Binary search tree (one dimension)
// ---------------------------------------------------------------------------

section('bitree')

test('exposes the full public interface with defaults intact', () => {
  const tree = syngen.tool.bitree.create()
  for (const method of ['create', 'from', 'insert', 'remove', 'find', 'retrieve', 'clear', 'destroy']) {
    assert.strictEqual(typeof syngen.tool.bitree[method] === 'function'
      || typeof tree[method] === 'function', true, `missing ${method}`)
  }
  assert.strictEqual(tree.dimension, 'value')
  assert.strictEqual(tree.maxItems, 12)
})

test('split: parent empties and retrieve reaches every child', () => {
  const tree = syngen.tool.bitree.create({maxItems: 2, minValue: 0, range: 100})
  const items = [
    {id: 'a', value: 10},
    {id: 'b', value: 20},
    {id: 'c', value: 30},
    {id: 'd', value: 60},
    {id: 'e', value: 70},
  ]

  for (const item of items) {
    tree.insert(item)
  }

  assert.ok(tree.nodes.length > 0, 'root should have split into children')
  assert.strictEqual(tree.items.length, 0, 'parent must not retain items pushed to children')
  assertUniqueSet(tree.retrieve(0, 100), items, 'full retrieve')
  assertUniqueSet(tree.retrieve(15, 10), [items[1]], 'range [15,25]')
  assertUniqueSet(tree.retrieve(55, 20), [items[3], items[4]], 'range [55,75]')
  assert.strictEqual(tree.retrieve(40, 10).length, 0, 'empty range returns nothing')
})

test('from() builds a split tree with the same behavior', () => {
  const items = [{value: 1}, {value: 2}, {value: 90}, {value: 95}]
  const tree = syngen.tool.bitree.from(items, {maxItems: 2, minValue: 0, range: 100})
  assert.ok(tree.nodes.length > 0)
  assertUniqueSet(tree.retrieve(0, 100), items, 'from retrieve')
})

test('remove: follows an item whose index no longer matches its storage node', () => {
  const tree = syngen.tool.bitree.create({maxItems: 2, minValue: 0, range: 100})
  const moving = {id: 'moving', value: 20}
  const items = [{value: 10}, moving, {value: 30}, {value: 70}]

  for (const item of items) {
    tree.insert(item)
  }

  // The object is stored in a left-side leaf but now indexes to the right side.
  moving.value = 70
  tree.remove(moving)

  assert.strictEqual(collectAll(tree).includes(moving), false,
    'remove must descend into the actual storage child instead of failing silently')
  assert.strictEqual(tree.retrieve(0, 100).length, 3)
})

test('remove: deleting an absent item never throws and changes nothing', () => {
  const tree = syngen.tool.bitree.from([{value: 1}, {value: 2}], {maxItems: 2, minValue: 0, range: 100})
  tree.remove({value: 1})
  assert.strictEqual(collectAll(tree).length, 2)
})

test('duplicate insert: one remove removes exactly one copy, queries stay unique', () => {
  const tree = syngen.tool.bitree.create({maxItems: 2, minValue: 0, range: 100})
  const duplicate = {id: 'dup', value: 20}
  const other = {id: 'other', value: 80}

  tree.insert(duplicate)
  tree.insert(duplicate)
  tree.insert(other)

  assert.strictEqual(countByIdentity(collectAll(tree), duplicate), 2, 'both copies are stored')
  assertUniqueSet(tree.retrieve(0, 100), [duplicate, other], 'no duplicate in query results')

  tree.remove(duplicate)
  assert.strictEqual(countByIdentity(collectAll(tree), duplicate), 1, 'only one copy removed')
  assertUniqueSet(tree.retrieve(0, 100), [duplicate, other], 'remaining copy still queryable')

  tree.remove(duplicate)
  assert.strictEqual(countByIdentity(collectAll(tree), duplicate), 0, 'second remove deletes the other copy')
  assertUniqueSet(tree.retrieve(0, 100), [other], 'only the other item remains')
})

test('find: finite radius bounds the search, boundary distance stays excluded', () => {
  const at10 = {value: 10}
  const at20 = {value: 20}
  const at30 = {value: 30}
  const tree = syngen.tool.bitree.from([at10, at20, at30], {maxItems: 2, minValue: 0, range: 100})

  // The query object is itself stored: the next-closest item is at distance 10.
  assert.strictEqual(tree.find(at30, 5), undefined, 'item 10 units away must not match radius 5')
  assert.strictEqual(tree.find(at30, 10), undefined, 'distance equal to radius is excluded')
  assert.strictEqual(tree.find(at30, 10.0001), at20, 'item just inside the radius matches')

  // Query object not present in the tree: nearest neighbors sit at distance 5.
  const probe = {value: 25}
  assert.strictEqual(tree.find(probe, 4), undefined, 'nothing within radius 4')
  assert.strictEqual(tree.find(probe, 5), undefined, 'boundary distance is excluded')
  assert.ok([at20, at30].includes(tree.find(probe, 5.0001)), 'nearest neighbor matches inside radius')

  // Unlimited search still works after splitting.
  assert.strictEqual(tree.find({value: 95}, Infinity), at30)
  assert.strictEqual(tree.find({value: 0}, Infinity), at10)
})

test('find and retrieve: items landing exactly on split midpoints stay reachable', () => {
  // Range 0..100 splits at 50, then 25 and 75. Boundary values use <= middle.
  const onMiddles = [
    {value: 25},
    {value: 50},
    {value: 75},
  ]
  const others = [{value: 1}, {value: 99}]
  const tree = syngen.tool.bitree.from([...onMiddles, ...others],
    {maxItems: 2, minValue: 0, range: 100})

  assert.ok(tree.nodes.length > 0, 'tree split around the midpoint items')
  assertUniqueSet(tree.retrieve(0, 100), [...onMiddles, ...others], 'midpoint items retrieved')

  // A fresh probe on a midpoint finds the stored object at distance zero.
  assert.strictEqual(tree.find({value: 50}, 1), onMiddles[1], 'probe at midpoint finds that item')

  // Querying with the stored midpoint object itself skips it and returns the next nearest.
  assert.strictEqual(tree.find(onMiddles[1], 24), undefined, 'next neighbor is 25 away, outside radius 24')
  assert.strictEqual(tree.find(onMiddles[1], 25), undefined, 'distance 25 is the excluded boundary')
  assert.strictEqual(tree.find(onMiddles[1], 26), onMiddles[0], 'value 25 matches inside radius 26')

  // Removing a midpoint item must reach whichever leaf actually stores it.
  const midpoint = onMiddles[1]
  tree.remove(midpoint)
  assert.strictEqual(collectAll(tree).includes(midpoint), false)
  assertUniqueSet(tree.retrieve(0, 100), [onMiddles[0], onMiddles[2], ...others])
})

test('clear and destroy empty the tree', () => {
  const tree = syngen.tool.bitree.from([{value: 1}, {value: 2}, {value: 3}], {maxItems: 2, minValue: 0, range: 100})
  tree.clear()
  assert.strictEqual(tree.items.length, 0)
  assert.strictEqual(tree.nodes.length, 0)
  assert.strictEqual(tree.retrieve(0, 100).length, 0)
  tree.destroy()
})

// ---------------------------------------------------------------------------
// Quadtree (two dimensions)
// ---------------------------------------------------------------------------

section('quadtree')

test('exposes the full public interface with defaults intact', () => {
  const tree = syngen.tool.quadtree.create()
  for (const method of ['create', 'from', 'insert', 'remove', 'find', 'retrieve', 'filter', 'clear', 'destroy']) {
    assert.strictEqual(typeof syngen.tool.quadtree[method] === 'function'
      || typeof tree[method] === 'function', true, `missing ${method}`)
  }
  assert.strictEqual(tree.maxItems, 12)
})

test('node bounds: center and radius mirror the octree conventions', () => {
  const tree = syngen.tool.quadtree.create({x: 10, y: 20, width: 40, height: 60})
  assert.strictEqual(tree.center.x, 30)
  assert.strictEqual(tree.center.y, 50)
  assert.strictEqual(tree.radius, Math.max(40, 60) / syngen.const.unit2)

  // Bounds propagate to child nodes after splitting.
  const split = syngen.tool.quadtree.create({maxItems: 1, x: 0, y: 0, width: 100, height: 100})
  split.insert({x: 10, y: 10})
  split.insert({x: 90, y: 90})
  assert.ok(split.nodes.length === 4)
  for (const node of split.nodes) {
    assert.strictEqual(node.center.x, node.x + (node.width / 2))
    assert.strictEqual(node.center.y, node.y + (node.height / 2))
    assert.strictEqual(node.radius, Math.max(node.height, node.width) / syngen.const.unit2)
  }
})

test('split: parent empties and retrieve/filter traverse every child', () => {
  const tree = syngen.tool.quadtree.create({maxItems: 2, x: 0, y: 0, width: 100, height: 100})
  const items = [
    {id: 'sw1', x: 10, y: 10},
    {id: 'sw2', x: 20, y: 20},
    {id: 'ne', x: 80, y: 80},
    {id: 'se', x: 90, y: 10},
    {id: 'nw', x: 10, y: 90},
  ]

  for (const item of items) {
    tree.insert(item)
  }

  assert.ok(tree.nodes.length === 4, 'root should split into four children')
  assert.strictEqual(tree.items.length, 0, 'parent must not retain items pushed to children')

  const fullRect = {x: 0, y: 0, width: 100, height: 100}
  assertUniqueSet(tree.retrieve(fullRect), items, 'full retrieve')
  assertUniqueSet(tree.retrieve({x: 0, y: 0, width: 30, height: 30}),
    [items[0], items[1]], 'southwest corner retrieve')
  assertUniqueSet(tree.retrieve({x: 70, y: 70, width: 30, height: 30}),
    [items[2]], 'northeast corner retrieve')

  const filtered = tree.filter(() => true)
  assertUniqueSet(filtered, items, 'filter with an always-true node filter')
})

test('remove: follows an item across children when its index changes', () => {
  const tree = syngen.tool.quadtree.create({maxItems: 2, x: 0, y: 0, width: 100, height: 100})
  const moving = {id: 'moving', x: 20, y: 20}
  const items = [{x: 10, y: 10}, moving, {x: 80, y: 80}, {x: 90, y: 10}]

  for (const item of items) {
    tree.insert(item)
  }

  // Stored in the southwest node; after moving it indexes to the northeast node.
  moving.x = 80
  moving.y = 80
  tree.remove(moving)

  assert.strictEqual(collectAll(tree).includes(moving), false,
    'remove must search the storage children, not only the computed index')
  assert.strictEqual(tree.retrieve({x: 0, y: 0, width: 100, height: 100}).length, 3)
})

test('duplicate insert: one remove removes one copy and queries never repeat', () => {
  const tree = syngen.tool.quadtree.create({maxItems: 2, x: 0, y: 0, width: 100, height: 100})
  const duplicate = {id: 'dup', x: 20, y: 20}
  const other = {id: 'other', x: 80, y: 80}

  tree.insert(duplicate)
  tree.insert(duplicate)
  tree.insert(other)

  assert.strictEqual(countByIdentity(collectAll(tree), duplicate), 2)
  assertUniqueSet(tree.retrieve({x: 0, y: 0, width: 100, height: 100}),
    [duplicate, other], 'retrieve must deduplicate')
  assertUniqueSet(tree.filter(() => true), [duplicate, other], 'filter must deduplicate')

  tree.remove(duplicate)
  assert.strictEqual(countByIdentity(collectAll(tree), duplicate), 1)
  assertUniqueSet(tree.retrieve({x: 0, y: 0, width: 100, height: 100}), [duplicate, other])

  tree.remove(duplicate)
  assert.strictEqual(countByIdentity(collectAll(tree), duplicate), 0)
  assertUniqueSet(tree.retrieve({x: 0, y: 0, width: 100, height: 100}), [other])
})

test('find: finite radius bounds the two-dimensional search', () => {
  const tree = syngen.tool.quadtree.create({maxItems: 2, x: 0, y: 0, width: 100, height: 100})
  const near = {x: 20, y: 20}
  const far = {x: 80, y: 80}
  tree.insert(near)
  tree.insert(far)

  assert.strictEqual(tree.find({x: 50, y: 50}, 5), undefined, 'no neighbor within radius 5')

  const nearest = tree.find({x: 50, y: 50}, 45)
  assert.strictEqual(nearest, near, 'point at distance ~42.4 matches radius 45')
  assert.strictEqual(tree.find({x: 50, y: 50}, 40), undefined, 'same point excluded by radius 40')

  assert.strictEqual(tree.find(near, Infinity), far, 'unlimited radius finds the other item')
})

test('find: an item at exactly the finite radius is excluded across nodes', () => {
  // Enough points to force several splits, with a target exactly 5 units away.
  const tree = syngen.tool.quadtree.create({maxItems: 2, x: 0, y: 0, width: 100, height: 100})
  const boundary = {x: 15, y: 10}
  const closer = {x: 12, y: 10}
  tree.insert(boundary)
  tree.insert(closer)
  tree.insert({x: 80, y: 80})
  tree.insert({x: 90, y: 15})
  tree.insert({x: 15, y: 90})

  const query = {x: 10, y: 10}
  assert.strictEqual(tree.find(query, 5), closer,
    'distance-5 boundary item excluded; distance-2 item returned')
  assert.strictEqual(tree.find(query, 2), undefined, 'closer item at exactly 2 is also excluded')
  assert.ok(tree.find(query, 2.0001) === closer || tree.find(query, 5.0001) === boundary)
})

test('filter: node bounds are exposed as center and radius like the octree', () => {
  const tree = syngen.tool.quadtree.create({maxItems: 2, x: 0, y: 0, width: 100, height: 100})
  const items = [
    {id: 'sw', x: 10, y: 10},
    {id: 'ne', x: 80, y: 80},
    {id: 'se', x: 80, y: 10},
  ]

  for (const item of items) {
    tree.insert(item)
  }

  // Accessing center.x must not throw: the node bounds exist and describe each node.
  const westHalf = tree.filter((center, radius) => {
    assert.strictEqual(typeof center.x, 'number')
    assert.strictEqual(typeof center.y, 'number')
    assert.strictEqual(typeof radius, 'number')
    return center.x <= 50
  })

  assertUniqueSet(westHalf, [items[0]], 'node filter prunes east-side children')

  const withItemFilter = tree.filter(() => true, (item) => item.x > 50)
  assertUniqueSet(withItemFilter, [items[1], items[2]], 'item filter applies on top of node filter')
})

test('clear and destroy empty the tree', () => {
  const tree = syngen.tool.quadtree.from([{x: 1, y: 1}, {x: 2, y: 2}],
    {maxItems: 1, x: 0, y: 0, width: 100, height: 100})
  tree.clear()
  assert.strictEqual(tree.items.length, 0)
  assert.strictEqual(tree.nodes.length, 0)
  assert.strictEqual(tree.retrieve({x: 0, y: 0, width: 100, height: 100}).length, 0)
  tree.destroy()
})

// ---------------------------------------------------------------------------
// Octree (three dimensions)
// ---------------------------------------------------------------------------

section('octree')

test('exposes the full public interface with defaults intact', () => {
  const tree = syngen.tool.octree.create()
  for (const method of ['create', 'from', 'insert', 'remove', 'find', 'retrieve', 'filter', 'clear', 'destroy']) {
    assert.strictEqual(typeof syngen.tool.octree[method] === 'function'
      || typeof tree[method] === 'function', true, `missing ${method}`)
  }
  assert.strictEqual(tree.maxItems, 32)
  assert.strictEqual(tree.center.x, tree.x + (tree.width / 2))
  assert.strictEqual(tree.center.y, tree.y + (tree.height / 2))
  assert.strictEqual(tree.center.z, tree.z + (tree.depth / 2))
  assert.strictEqual(tree.radius, Math.max(tree.height, tree.width, tree.depth) / syngen.const.unit3)
})

test('split: parent empties and retrieve/filter traverse every child', () => {
  const tree = syngen.tool.octree.create({maxItems: 2, x: 0, y: 0, z: 0, width: 100, height: 100, depth: 100})
  const items = [
    {id: 'low-southwest', x: 10, y: 10, z: 10},
    {id: 'low-northeast', x: 80, y: 80, z: 10},
    {id: 'high-southwest', x: 10, y: 10, z: 80},
    {id: 'high-northeast', x: 80, y: 80, z: 80},
    {id: 'low-southeast', x: 80, y: 10, z: 10},
  ]

  for (const item of items) {
    tree.insert(item)
  }

  assert.ok(tree.nodes.length === 8, 'root should split into eight children')
  assert.strictEqual(tree.items.length, 0, 'parent must not retain items pushed to children')

  const fullPrism = {x: 0, y: 0, z: 0, width: 100, height: 100, depth: 100}
  assertUniqueSet(tree.retrieve(fullPrism), items, 'full retrieve')
  assertUniqueSet(tree.retrieve({x: 0, y: 0, z: 0, width: 30, height: 30, depth: 30}),
    [items[0]], 'low-southwest corner retrieve')
  assertUniqueSet(tree.filter(() => true), items, 'filter traverses all children')
})

test('remove: follows an item across children when its index changes', () => {
  const tree = syngen.tool.octree.create({maxItems: 2, x: 0, y: 0, z: 0, width: 100, height: 100, depth: 100})
  const moving = {id: 'moving', x: 10, y: 10, z: 10}
  const items = [{x: 80, y: 80, z: 10}, moving, {x: 10, y: 10, z: 80}, {x: 80, y: 80, z: 80}]

  for (const item of items) {
    tree.insert(item)
  }

  // Index 0 at insert time; now the coordinates route it to index 7.
  moving.x = 80
  moving.y = 80
  moving.z = 80
  tree.remove(moving)

  assert.strictEqual(collectAll(tree).includes(moving), false,
    'remove must descend into the child that actually stores the item')
  assert.strictEqual(tree.retrieve({x: 0, y: 0, z: 0, width: 100, height: 100, depth: 100}).length, 3)
})

test('duplicate insert: one remove removes one copy and queries never repeat', () => {
  const tree = syngen.tool.octree.create({maxItems: 2, x: 0, y: 0, z: 0, width: 100, height: 100, depth: 100})
  const duplicate = {id: 'dup', x: 10, y: 10, z: 10}
  const other = {id: 'other', x: 80, y: 80, z: 80}

  tree.insert(duplicate)
  tree.insert(duplicate)
  tree.insert(other)

  assert.strictEqual(countByIdentity(collectAll(tree), duplicate), 2)
  assertUniqueSet(tree.retrieve({x: 0, y: 0, z: 0, width: 100, height: 100, depth: 100}),
    [duplicate, other], 'retrieve must deduplicate')
  assertUniqueSet(tree.filter(() => true), [duplicate, other], 'filter must deduplicate')

  tree.remove(duplicate)
  assert.strictEqual(countByIdentity(collectAll(tree), duplicate), 1)
  tree.remove(duplicate)
  assert.strictEqual(countByIdentity(collectAll(tree), duplicate), 0)
  assertUniqueSet(tree.retrieve({x: 0, y: 0, z: 0, width: 100, height: 100, depth: 100}), [other])
})

test('find: finite radius bounds the three-dimensional search', () => {
  const tree = syngen.tool.octree.create({maxItems: 2, x: 0, y: 0, z: 0, width: 100, height: 100, depth: 100})
  const near = {x: 20, y: 20, z: 20}
  const far = {x: 80, y: 80, z: 80}
  tree.insert(near)
  tree.insert(far)

  assert.strictEqual(tree.find({x: 50, y: 50, z: 50}, 5), undefined)

  const nearest = tree.find({x: 50, y: 50, z: 50}, 55)
  assert.strictEqual(nearest, near, 'point at distance ~51.96 matches radius 55')
  assert.strictEqual(tree.find({x: 50, y: 50, z: 50}, 50), undefined, 'same point excluded by radius 50')

  assert.strictEqual(tree.find(near, Infinity), far)
})

test('find: an item at exactly the finite radius is excluded across nodes', () => {
  const tree = syngen.tool.octree.create({maxItems: 2, x: 0, y: 0, z: 0, width: 100, height: 100, depth: 100})
  const boundary = {x: 15, y: 10, z: 10} // exactly 5 from the query
  const closer = {x: 12, y: 10, z: 10}   // exactly 3 from the query
  tree.insert(boundary)
  tree.insert(closer)
  tree.insert({x: 80, y: 80, z: 80})
  tree.insert({x: 90, y: 15, z: 15})
  tree.insert({x: 15, y: 90, z: 15})

  const query = {x: 10, y: 10, z: 10}
  assert.strictEqual(tree.find(query, 5), closer,
    'distance-5 boundary item excluded; distance-2 item returned')
  assert.strictEqual(tree.find(query, 2), undefined, 'closer item at exactly 2 is also excluded')
  assert.ok(tree.find(query, 2.0001) === closer || tree.find(query, 5.0001) === boundary)
})

test('clear and destroy empty the tree', () => {
  const tree = syngen.tool.octree.from([{x: 1, y: 1, z: 1}, {x: 2, y: 2, z: 2}],
    {maxItems: 1, x: 0, y: 0, z: 0, width: 100, height: 100, depth: 100})
  tree.clear()
  assert.strictEqual(tree.items.length, 0)
  assert.strictEqual(tree.nodes.length, 0)
  assert.strictEqual(tree.retrieve({x: 0, y: 0, z: 0, width: 100, height: 100, depth: 100}).length, 0)
  tree.destroy()
})

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
