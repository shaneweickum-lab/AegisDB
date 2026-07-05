import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALPHABET_SIZE, alphabetIndex, baseId, symbolForIndex } from '../../src/core/alphabet.ts';

test('alphabet is a total bijection over all 256 byte values', () => {
  const seenIndices = new Set<number>();
  for (let byte = 0; byte < 256; byte++) {
    const index = alphabetIndex(byte);
    assert.ok(index >= 0 && index < ALPHABET_SIZE);
    assert.ok(!seenIndices.has(index), `duplicate alphabet index ${index} for byte ${byte}`);
    seenIndices.add(index);
    assert.equal(symbolForIndex(index), byte);
  }
  assert.equal(seenIndices.size, ALPHABET_SIZE);
});

test("named symbols (A-Z, a-z, 0-9) get the spec's low Base IDs starting at 2", () => {
  assert.equal(baseId('A'.charCodeAt(0)), 2);
  assert.equal(baseId('Z'.charCodeAt(0)), 27);
  assert.equal(baseId('a'.charCodeAt(0)), 28);
  assert.equal(baseId('z'.charCodeAt(0)), 53);
  assert.equal(baseId('0'.charCodeAt(0)), 54);
  assert.equal(baseId('9'.charCodeAt(0)), 63);
});

test('rejects out-of-range byte/index values', () => {
  assert.throws(() => alphabetIndex(256));
  assert.throws(() => alphabetIndex(-1));
  assert.throws(() => symbolForIndex(256));
});
