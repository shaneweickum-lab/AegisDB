import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUlidState, generateUlid } from '../../src/core/ulid.ts';

test('ulid is 26 characters of Crockford base32', () => {
  const id = generateUlid();
  assert.equal(id.length, 26);
  assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

test('ulid is lexicographically monotonic within the same millisecond', () => {
  const state = createUlidState();
  const ids: string[] = [];
  for (let i = 0; i < 500; i++) {
    ids.push(generateUlid({ nowMs: 1_700_000_000_000, state }));
  }
  const sorted = [...ids].sort();
  assert.deepEqual(ids, sorted, 'ULIDs generated in the same ms must already be in sorted order');
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ULIDs');
});

test('ulid timestamps sort across different milliseconds', () => {
  const state = createUlidState();
  const earlier = generateUlid({ nowMs: 1_700_000_000_000, state });
  const later = generateUlid({ nowMs: 1_700_000_000_001, state });
  assert.ok(earlier < later);
});

test('ulid is deterministic given an injected clock and random source', () => {
  const fixedRandom = (n: number) => new Uint8Array(n).fill(7);
  const a = generateUlid({ nowMs: 42, randomBytesFn: fixedRandom, state: createUlidState() });
  const b = generateUlid({ nowMs: 42, randomBytesFn: fixedRandom, state: createUlidState() });
  assert.equal(a, b);
});
