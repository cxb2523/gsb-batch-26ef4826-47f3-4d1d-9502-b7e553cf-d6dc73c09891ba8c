import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Records,
  loadSettings,
  memoryStorage,
  saveSettings,
  type StorageLike,
} from '../src/game/save.ts';
import { GAME, DEFAULT_SETTINGS } from '../src/config.ts';

test('a new profile has no best time and reports storage availability', () => {
  const records = new Records(memoryStorage());
  assert.equal(records.available, true);
  assert.equal(records.loadBest(), null);
});

test('best time is written once and only beaten by a faster run', () => {
  const records = new Records(memoryStorage());
  assert.equal(records.submitBest(45, 3), true);
  assert.equal(records.submitBest(60, 0), false);
  const best = records.loadBest();
  assert.ok(best);
  assert.equal(best.seconds, 45);
  assert.equal(best.falls, 3);
  assert.equal(records.submitBest(44.5, 1), true);
  assert.equal(records.loadBest()?.seconds, 44.5);
});

test('records survive a round trip through the same storage', () => {
  const storage = memoryStorage();
  new Records(storage).submitBest(31.25, 0);
  const reloaded = new Records(storage);
  assert.equal(reloaded.loadBest()?.seconds, 31.25);
});

test('corrupt JSON or wrong shapes are ignored, never thrown', () => {
  const storage = memoryStorage();
  storage.setItem(GAME.storageKey, '{not json');
  assert.equal(new Records(storage).loadBest(), null);

  storage.setItem(GAME.storageKey, JSON.stringify({ seconds: 'fast' }));
  assert.equal(new Records(storage).loadBest(), null);

  storage.setItem(GAME.storageKey, JSON.stringify({ seconds: -5, at: 'x', falls: 0 }));
  assert.equal(new Records(storage).loadBest(), null);
});

test('storage that throws on every access is survivable', () => {
  const hostile: StorageLike = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('quota');
    },
    removeItem() {
      throw new Error('blocked');
    },
  };
  const records = new Records(hostile);
  assert.equal(records.loadBest(), null);
  assert.equal(records.submitBest(10, 0), false);
  assert.doesNotThrow(() => records.clear());
});

test('submitBest rejects non-finite times', () => {
  const records = new Records(memoryStorage());
  assert.equal(records.submitBest(Number.NaN, 0), false);
  assert.equal(records.submitBest(Number.POSITIVE_INFINITY, 0), false);
  assert.equal(records.submitBest(0, 0), false);
});

test('splits round trip and drop non-finite values', () => {
  const storage = memoryStorage();
  const records = new Records(storage);
  records.saveSplits(50, [5, Number.NaN, 12]);
  const splits = records.loadSplits();
  assert.ok(splits);
  assert.deepEqual(splits.splits, [5, 12]);
});

test('settings default cleanly and ignore out-of-range values', () => {
  assert.deepEqual(loadSettings(null), DEFAULT_SETTINGS);

  const storage = memoryStorage();
  storage.setItem(GAME.settingsKey, JSON.stringify({ autoHop: false, sensitivity: 2.5 }));
  assert.deepEqual(loadSettings(storage), { autoHop: false, sensitivity: 2.5 });

  storage.setItem(GAME.settingsKey, JSON.stringify({ autoHop: 'yes', sensitivity: 999 }));
  assert.deepEqual(loadSettings(storage), DEFAULT_SETTINGS);

  saveSettings(storage, { autoHop: false, sensitivity: 1.5 });
  assert.deepEqual(loadSettings(storage), { autoHop: false, sensitivity: 1.5 });
});

test('clear removes records and settings', () => {
  const storage = memoryStorage();
  const records = new Records(storage);
  records.submitBest(20, 0);
  saveSettings(storage, { autoHop: false, sensitivity: 1 });
  records.clear();
  assert.equal(records.loadBest(), null);
  assert.deepEqual(loadSettings(storage), DEFAULT_SETTINGS);
});
