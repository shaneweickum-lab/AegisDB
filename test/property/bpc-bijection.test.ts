import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BAND_MAX, bandForCount } from '../../src/crypto/bpc/bands.ts';
import { buildBandPermutation } from '../../src/crypto/bpc/permutation.ts';

test('bandForCount is monotonically non-decreasing and capped at BAND_MAX', () => {
  let previous = -1;
  for (let count = 0; count < 200_000; count += 37) {
    const band = bandForCount(count);
    assert.ok(band >= previous, `band regressed at count=${count}`);
    assert.ok(band <= BAND_MAX);
    previous = band;
  }
  assert.equal(bandForCount(0), bandForCount(1), 'counts 0 and 1 share the lowest band by construction');
});

test('every band permutation is an exact bijection over [0, 256)', () => {
  const key = new Uint8Array(32).fill(3);
  for (let band = 0; band <= BAND_MAX; band++) {
    const { forward, inverse } = buildBandPermutation(key, band);
    assert.equal(forward.length, 256);
    assert.equal(inverse.length, 256);

    const seen = new Set<number>();
    for (let s = 0; s < 256; s++) {
      const code = forward[s]!;
      assert.ok(!seen.has(code), `band ${band}: duplicate output ${code} for input ${s}`);
      seen.add(code);
      assert.equal(inverse[code], s, `band ${band}: inverse mismatch at code ${code}`);
    }
    assert.equal(seen.size, 256);
  }
});

test('different bands (generally) produce different permutations', () => {
  const key = new Uint8Array(32).fill(3);
  const a = buildBandPermutation(key, 0).forward;
  const b = buildBandPermutation(key, 1).forward;
  assert.notDeepEqual(a, b);
});

test('permutations are deterministic given the same document key and band', () => {
  const key = new Uint8Array(32).fill(11);
  const a = buildBandPermutation(key, 5).forward;
  const b = buildBandPermutation(key, 5).forward;
  assert.deepEqual(a, b);
});
