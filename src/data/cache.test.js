import test from 'node:test';
import assert from 'node:assert/strict';
import { readAircraftCache, saveAircraftCache } from './cache.js';

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test('saves and reads a versioned aircraft snapshot', () => {
  const storage = createStorage();
  const snapshot = { regionKey: 'europe', updatedAt: '2026-10-16T10:00:00.000Z', aircraft: [{ id: 'abc123' }] };

  assert.equal(saveAircraftCache(snapshot, storage), true);
  assert.deepEqual(readAircraftCache(storage), { version: 1, ...snapshot });
});

test('ignores malformed or unsupported cache values', () => {
  const storage = createStorage();
  storage.setItem('airspace-aircraft-cache-v1', '{bad json');
  assert.equal(readAircraftCache(storage), null);
  storage.setItem('airspace-aircraft-cache-v1', JSON.stringify({ version: 2, aircraft: [] }));
  assert.equal(readAircraftCache(storage), null);
});

test('does not fail when browser storage is unavailable', () => {
  const brokenStorage = {
    getItem() { throw new Error('storage blocked'); },
    setItem() { throw new Error('storage full'); },
  };

  assert.equal(readAircraftCache(brokenStorage), null);
  assert.equal(saveAircraftCache({ aircraft: [] }, brokenStorage), false);
});
