/** Bands cap the drift so it's a bounded, legible visual instead of an
 *  unbounded exponential — and, critically, so the math stays integer-only
 *  (no floating-point exponentiation, unlike the original spec's cipher). */
export const BAND_MAX = 31;

function bitLength(n: number): number {
  let bits = 0;
  let v = n;
  while (v > 0) {
    bits += 1;
    v = v >>> 1;
  }
  return bits;
}

/** band(count) = floor(log2(count + 2)), computed via integer bit-length,
 *  capped at BAND_MAX. Monotonically non-decreasing in count by construction. */
export function bandForCount(count: number): number {
  if (count < 0 || !Number.isInteger(count)) {
    throw new RangeError(`bandForCount: count must be a non-negative integer, got ${count}`);
  }
  const band = bitLength(count + 2) - 1;
  return Math.min(band, BAND_MAX);
}
