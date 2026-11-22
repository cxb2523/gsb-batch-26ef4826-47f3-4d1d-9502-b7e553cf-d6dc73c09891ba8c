//
// Local verification for song cleanup when sounds are deleted.
// Run with: npm test
//

const test = require('node:test')
const assert = require('node:assert')

const { cleanSongDoc } = require('../imports/api/songCleanup.js')

test('orphan sound ids are removed from song.sounds', () => {
  const existing = new Set(['a', 'c'])
  const song = { sounds: ['a', 'b', 'c'], selectedSound: 'a' }

  const cleaned = cleanSongDoc(song, sid => existing.has(sid))

  assert.deepStrictEqual(cleaned.sounds, ['a', 'c'])
})

test('selectedSound is reset when it points to a deleted sound', () => {
  const existing = new Set(['a'])
  const song = { sounds: ['a', 'b'], selectedSound: 'b' }

  const cleaned = cleanSongDoc(song, sid => existing.has(sid))

  assert.deepStrictEqual(cleaned.sounds, ['a'])
  assert.strictEqual(cleaned.selectedSound, false)
})

test('valid selectedSound is kept', () => {
  const existing = new Set(['a', 'b'])
  const song = { sounds: ['a', 'b'], selectedSound: 'b' }

  const cleaned = cleanSongDoc(song, sid => existing.has(sid))

  assert.deepStrictEqual(cleaned.sounds, ['a', 'b'])
  assert.strictEqual(cleaned.selectedSound, 'b')
})

test('song without sounds array does not crash', () => {
  const cleaned = cleanSongDoc({ selectedSound: false }, () => false)
  assert.deepStrictEqual(cleaned.sounds, [])
  assert.strictEqual(cleaned.selectedSound, false)
})
