import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveKey, makeHkdfByteStream } from '../../src/core/hkdf.ts';

test('deriveKey is deterministic for the same inputs', () => {
  const ikm = new Uint8Array(32).fill(1);
  const a = deriveKey(ikm, 'label', 32);
  const b = deriveKey(ikm, 'label', 32);
  assert.deepEqual(a, b);
});

test('deriveKey output differs when info label differs', () => {
  const ikm = new Uint8Array(32).fill(1);
  const a = deriveKey(ikm, 'label-a', 32);
  const b = deriveKey(ikm, 'label-b', 32);
  assert.notDeepEqual(a, b);
});

test('makeHkdfByteStream is deterministic and can supply more bytes than a single HKDF-Expand block', () => {
  const seed = new Uint8Array(32).fill(9);
  const streamA = makeHkdfByteStream(seed, 'stream');
  const streamB = makeHkdfByteStream(seed, 'stream');

  const bytesA: number[] = [];
  const bytesB: number[] = [];
  // 255*32 = 8160 is the single-block HKDF-Expand(sha256) limit; pull past
  // it to exercise the refill/block-counter path.
  for (let i = 0; i < 9000; i++) {
    bytesA.push(streamA.next());
    bytesB.push(streamB.next());
  }
  assert.deepEqual(bytesA, bytesB);

  // Not a strict randomness test — just a sanity check that refill actually
  // produces different bytes rather than repeating the first block forever.
  const firstBlock = bytesA.slice(0, 100);
  const afterRefill = bytesA.slice(8160, 8260);
  assert.notDeepEqual(firstBlock, afterRefill);
});
