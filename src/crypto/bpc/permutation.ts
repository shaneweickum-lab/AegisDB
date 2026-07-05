import { makeHkdfByteStream, type ByteStream } from '../../core/hkdf.ts';

/** Unbiased integer in [0, exclusiveMax) via rejection sampling on single
 *  byte draws. Plain `byte % exclusiveMax` would bias the shuffle whenever
 *  exclusiveMax doesn't evenly divide 256 — which is most values here —
 *  and a biased shuffle would visibly skew the cipher's output histogram,
 *  undermining the frequency-flattening effect the visualizer demonstrates. */
function uniformInt(stream: ByteStream, exclusiveMax: number): number {
  if (exclusiveMax <= 0 || exclusiveMax > 256) {
    throw new RangeError(`uniformInt: exclusiveMax must be in (0, 256], got ${exclusiveMax}`);
  }
  const limit = Math.floor(256 / exclusiveMax) * exclusiveMax;
  let draw: number;
  do {
    draw = stream.next();
  } while (draw >= limit);
  return draw % exclusiveMax;
}

function fisherYates(stream: ByteStream, size: number): Uint8Array {
  const arr = new Uint8Array(size);
  for (let i = 0; i < size; i++) arr[i] = i;
  for (let i = size - 1; i > 0; i--) {
    const j = uniformInt(stream, i + 1);
    const a = arr[i]!;
    const b = arr[j]!;
    arr[i] = b;
    arr[j] = a;
  }
  return arr;
}

export interface BandPermutation {
  forward: Uint8Array; // alphabet index -> in-band code
  inverse: Uint8Array; // in-band code -> alphabet index
}

/** Deterministic per-(documentKey, band) keyed permutation of [0, 256). */
export function buildBandPermutation(documentKey: Uint8Array, band: number): BandPermutation {
  const stream = makeHkdfByteStream(documentKey, `bpc-band-${band}`);
  const forward = fisherYates(stream, 256);
  const inverse = new Uint8Array(256);
  for (let index = 0; index < forward.length; index++) {
    inverse[forward[index]!] = index;
  }
  return { forward, inverse };
}
