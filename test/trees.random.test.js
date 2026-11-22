/**
 * Randomized property tests: every tree operation is checked against a brute
 * force reference list, so correctness does not depend on hand-picked layouts.
 *
 * A seeded LCG keeps the run deterministic. The live population is kept small
 * and balanced between inserts and removes: this still exercises deep splits,
 * cross-child removals, and duplicate handling without triggering the
 * pre-existing, out-of-scope infinite-split case for saturated nodes with
 * coordinates that quantize to the same point (see the max-depth TODOs in
 * each tree's insert method, present in the upstream implementation).
 *
 * Run with: node test/trees.random.test.js
 */
const assert = require('assert')
const {loadSyngen} = require('./harness')

const syngen = loadSyngen()

// Deterministic LCG so failures can be reproduced from the printed seed.
function lcg(seed) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

function count(items, target) {
  return items.filter((item) => item === target).length
}

function unique(items) {
  return items.filter((item, index) => items.indexOf(item) === index)
}

const POPULATION_LIMIT = 24

let checks = 0

function expect(condition, message) {
  assert.ok(condition, message)
  checks += 1
}

// ---------------------------------------------------------------------------
// bitree
// ---------------------------------------------------------------------------

function testBitree(seed) {
  const random = lcg(seed)
  const tree = syngen.tool.bitree.create({maxItems: 4, minValue: 0, range: 100})
  const reference = []

  for (let iteration = 0; iteration < 1500; iteration += 1) {
    const roll = random()

    if (reference.length < POPULATION_LIMIT && (roll < 0.5 || reference.length < 8)) {
      const item = {
        value: Math.floor(random() * 100),
        tag: iteration,
      }
      expect(tree.insert(item) === tree, 'insert returns the tree')
      reference.push(item)
    } else if (roll < 0.75 && reference.length) {
      const item = reference[Math.floor(random() * reference.length)]
      expect(tree.remove(item) === tree, 'remove returns the tree')
      reference.splice(reference.indexOf(item), 1)
    } else if (roll < 0.9) {
      const minValue = Math.floor(random() * 90)
      const range = Math.floor(random() * 30)
      const expected = unique(reference
        .filter((item) => item.value >= minValue && item.value <= minValue + range))
      const actual = tree.retrieve(minValue, range)
      expect(actual.length === expected.length,
        `bitree retrieve [${minValue}, ${minValue + range}] count`)
      for (const item of expected) {
        expect(actual.includes(item), 'bitree retrieve contains expected item')
        expect(count(actual, item) === 1, 'bitree retrieve has no duplicate')
      }
    } else {
      const query = {value: Math.floor(random() * 100)}
      const radius = Math.floor(random() * 25)
      const distances = reference
        .map((item) => ({item, d: Math.abs(item.value - query.value)}))
        .filter(({d}) => d < radius)
        .sort((a, b) => a.d - b.d)
      const actual = tree.find(query, radius)
      if (!distances.length) {
        expect(actual === undefined, 'bitree find outside radius returns undefined')
      } else {
        expect(actual !== undefined, 'bitree find returns an item within radius')
        expect(Math.abs(actual.value - query.value) === distances[0].d,
          'bitree find returns a nearest item within radius')
        expect(Math.abs(actual.value - query.value) < radius, 'bitree find respects the radius')
      }
    }
  }

  tree.clear()
  expect(tree.retrieve(0, 100).length === 0, 'bitree clear empties the tree')
}

// ---------------------------------------------------------------------------
// quadtree
// ---------------------------------------------------------------------------

function testQuadtree(seed) {
  const random = lcg(seed)
  const tree = syngen.tool.quadtree.create({maxItems: 4, x: 0, y: 0, width: 100, height: 100})
  const reference = []

  for (let iteration = 0; iteration < 1500; iteration += 1) {
    const roll = random()

    if (reference.length < POPULATION_LIMIT && (roll < 0.5 || reference.length < 8)) {
      const item = {
        x: Math.floor(random() * 100),
        y: Math.floor(random() * 100),
        tag: iteration,
      }
      tree.insert(item)
      reference.push(item)
    } else if (roll < 0.75 && reference.length) {
      const item = reference[Math.floor(random() * reference.length)]
      tree.remove(item)
      reference.splice(reference.indexOf(item), 1)
    } else if (roll < 0.9) {
      const rect = {
        height: Math.floor(random() * 30),
        width: Math.floor(random() * 30),
        x: Math.floor(random() * 90),
        y: Math.floor(random() * 90),
      }
      const expected = unique(reference.filter((item) =>
        item.x >= rect.x && item.x <= rect.x + rect.width
        && item.y >= rect.y && item.y <= rect.y + rect.height))
      const actual = tree.retrieve(rect)
      expect(actual.length === expected.length, 'quadtree retrieve count')
      for (const item of expected) {
        expect(actual.includes(item), 'quadtree retrieve contains expected item')
        expect(count(actual, item) === 1, 'quadtree retrieve has no duplicate')
      }

      const filtered = tree.filter(
        (center) => center.x >= 0,
        (item) => item.x >= rect.x && item.x <= rect.x + rect.width
          && item.y >= rect.y && item.y <= rect.y + rect.height
      )
      expect(filtered.length === expected.length, 'quadtree filter matches retrieve count')
    } else {
      const query = {x: Math.floor(random() * 100), y: Math.floor(random() * 100)}
      const radius = Math.floor(random() * 25)
      const distances = reference
        .map((item) => ({
          item,
          d2: ((item.x - query.x) ** 2) + ((item.y - query.y) ** 2),
        }))
        .filter(({d2}) => d2 < radius * radius)
        .sort((a, b) => a.d2 - b.d2)
      const actual = tree.find(query, radius)
      if (!distances.length) {
        expect(actual === undefined, 'quadtree find outside radius returns undefined')
      } else {
        expect(actual !== undefined, 'quadtree find returns an item within radius')
        const actualD2 = ((actual.x - query.x) ** 2) + ((actual.y - query.y) ** 2)
        expect(actualD2 === distances[0].d2, 'quadtree find returns a nearest item within radius')
        expect(actualD2 < radius * radius, 'quadtree find respects the radius')
      }
    }
  }

  tree.clear()
  expect(tree.retrieve({x: 0, y: 0, width: 100, height: 100}).length === 0,
    'quadtree clear empties the tree')
}

// ---------------------------------------------------------------------------
// octree
// ---------------------------------------------------------------------------

function testOctree(seed) {
  const random = lcg(seed)
  const tree = syngen.tool.octree.create({
    maxItems: 4,
    x: 0, y: 0, z: 0,
    width: 100, height: 100, depth: 100,
  })
  const reference = []

  for (let iteration = 0; iteration < 1500; iteration += 1) {
    const roll = random()

    if (reference.length < POPULATION_LIMIT && (roll < 0.5 || reference.length < 8)) {
      const item = {
        x: Math.floor(random() * 50),
        y: Math.floor(random() * 50),
        z: Math.floor(random() * 50),
        tag: iteration,
      }
      tree.insert(item)
      reference.push(item)
    } else if (roll < 0.75 && reference.length) {
      const item = reference[Math.floor(random() * reference.length)]
      tree.remove(item)
      reference.splice(reference.indexOf(item), 1)
    } else if (roll < 0.9) {
      const prism = {
        depth: Math.floor(random() * 30),
        height: Math.floor(random() * 30),
        width: Math.floor(random() * 30),
        x: Math.floor(random() * 40),
        y: Math.floor(random() * 40),
        z: Math.floor(random() * 40),
      }
      const expected = unique(reference.filter((item) =>
        item.x >= prism.x && item.x <= prism.x + prism.width
        && item.y >= prism.y && item.y <= prism.y + prism.height
        && item.z >= prism.z && item.z <= prism.z + prism.depth))
      const actual = tree.retrieve(prism)
      expect(actual.length === expected.length, 'octree retrieve count')
      for (const item of expected) {
        expect(actual.includes(item), 'octree retrieve contains expected item')
        expect(count(actual, item) === 1, 'octree retrieve has no duplicate')
      }
    } else {
      const query = {
        x: Math.floor(random() * 50),
        y: Math.floor(random() * 50),
        z: Math.floor(random() * 50),
      }
      const radius = Math.floor(random() * 25)
      const distances = reference
        .map((item) => ({
          item,
          d2: ((item.x - query.x) ** 2) + ((item.y - query.y) ** 2) + ((item.z - query.z) ** 2),
        }))
        .filter(({d2}) => d2 < radius * radius)
        .sort((a, b) => a.d2 - b.d2)
      const actual = tree.find(query, radius)
      if (!distances.length) {
        expect(actual === undefined, 'octree find outside radius returns undefined')
      } else {
        expect(actual !== undefined, 'octree find returns an item within radius')
        const actualD2 = ((actual.x - query.x) ** 2) + ((actual.y - query.y) ** 2)
          + ((actual.z - query.z) ** 2)
        expect(actualD2 === distances[0].d2, 'octree find returns a nearest item within radius')
        expect(actualD2 < radius * radius, 'octree find respects the radius')
      }
    }
  }

  tree.clear()
  expect(tree.retrieve({
    x: 0, y: 0, z: 0, width: 100, height: 100, depth: 100,
  }).length === 0, 'octree clear empties the tree')
}

for (let seed = 1; seed <= 10; seed += 1) {
  testBitree(seed)
  testQuadtree(seed * 101)
  testOctree(seed * 1009)
}

console.log(`randomized property tests passed: ${checks} assertions across 30 tree runs`)
