import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alphabetIndex } from '../../src/core/alphabet.ts';
import { bandForCount } from '../../src/crypto/bpc/bands.ts';
import { buildBandPermutation, type BandPermutation } from '../../src/crypto/bpc/permutation.ts';
import { utf8Encode } from '../../src/core/bytes.ts';

function byteHistogram(bytes: Uint8Array): number[] {
  const hist = new Array(256).fill(0);
  for (const b of bytes) hist[b]++;
  return hist;
}

function chiSquaredDeviationFromUniform(hist: number[]): number {
  const total = hist.reduce((a, b) => a + b, 0);
  const expected = total / hist.length;
  return hist.reduce((sum, observed) => sum + (observed - expected) ** 2 / expected, 0);
}

/** Isolates the *band-drift* mechanism itself (spec 2.1's actual claim)
 *  from the IV keystream, which would flatten any distribution on its own
 *  and would otherwise make this an unfair/uninformative comparison. This
 *  applies each symbol's per-band permutation with no keystream XOR, using
 *  either the real growing band (bandingEnabled=true) or a single fixed
 *  band 0 for every occurrence (bandingEnabled=false) — the latter is
 *  exactly a naive fixed-substitution cipher built from the same
 *  permutation machinery, so the comparison is apples-to-apples. */
function substituteWithOptionalBanding(
  plaintext: Uint8Array,
  documentKey: Uint8Array,
  bandingEnabled: boolean
): Uint8Array {
  const counts = new Map<number, number>();
  const permCache = new Map<number, BandPermutation>();
  const out = new Uint8Array(plaintext.length);
  for (let i = 0; i < plaintext.length; i++) {
    const byte = plaintext[i]!;
    const count = counts.get(byte) ?? 0;
    counts.set(byte, count + 1);
    const band = bandingEnabled ? bandForCount(count) : 0;
    let perm = permCache.get(band);
    if (!perm) {
      perm = buildBandPermutation(documentKey, band);
      permCache.set(band, perm);
    }
    out[i] = perm.forward[alphabetIndex(byte)]!;
  }
  return out;
}

const documentKey = new Uint8Array(32).fill(7);

test('band drift measurably flattens a skewed byte distribution vs. the same permutation held fixed (spec 2.1)', () => {
  // Heavily skewed unigram distribution, similar in spirit to English text
  // dominated by 'e'/'t'/'a' (spec 6.1.1) — with no keystream involved,
  // this isolates whether *banding itself* is doing the flattening work.
  const skewed = 'e'.repeat(4000) + 't'.repeat(2500) + 'a'.repeat(2000) + 'z'.repeat(50) + 'q'.repeat(20);
  const plaintext = utf8Encode(skewed);

  const withBanding = substituteWithOptionalBanding(plaintext, documentKey, true);
  const fixedSingleBand = substituteWithOptionalBanding(plaintext, documentKey, false);

  const bandedDeviation = chiSquaredDeviationFromUniform(byteHistogram(withBanding));
  const fixedDeviation = chiSquaredDeviationFromUniform(byteHistogram(fixedSingleBand));

  assert.ok(
    bandedDeviation < fixedDeviation,
    `expected band-drift chi-squared deviation (${bandedDeviation.toFixed(1)}) to be lower than the fixed-single-permutation baseline's (${fixedDeviation.toFixed(1)})`
  );
});

test('a uniformly distributed input is not made meaningfully less uniform by banding', () => {
  // Sanity check: banding should help skewed input without hurting already-uniform input.
  const uniform = new Uint8Array(8192);
  for (let i = 0; i < uniform.length; i++) uniform[i] = i % 256;

  const withBanding = substituteWithOptionalBanding(uniform, documentKey, true);
  const deviation = chiSquaredDeviationFromUniform(byteHistogram(withBanding));
  const expectedCountPerByte = uniform.length / 256;
  // Loose bound: deviation should stay small relative to the sample size, not blow up.
  assert.ok(deviation < expectedCountPerByte * 256);
});
