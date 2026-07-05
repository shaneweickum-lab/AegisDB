import { randomBytes } from 'node:crypto';
import { readUint16BE, writeUint16BE } from '../../core/bytes.ts';
import { alphabetIndex, symbolForIndex } from '../../core/alphabet.ts';
import { deriveDocumentKey } from '../document-key.ts';
import type { CipherEngine, CipherTrace, SealContext, SealedRecord } from '../engine.ts';
import { bandForCount } from './bands.ts';
import { buildBandPermutation, type BandPermutation } from './permutation.ts';
import { createKeystream } from './keystream.ts';
import { createTraceRecorder } from './trace.ts';

const IV_LENGTH = 16;

function getOrBuildPermutation(
  cache: Map<number, BandPermutation>,
  documentKey: Uint8Array,
  band: number
): BandPermutation {
  let perm = cache.get(band);
  if (!perm) {
    perm = buildBandPermutation(documentKey, band);
    cache.set(band, perm);
  }
  return perm;
}

/** Pure encode: given plaintext, a document key, and an IV, deterministically
 *  produces ciphertext (+ optional trace). Split out from the CipherEngine
 *  wrapper below so determinism (spec 6.1: same input+IV -> same output) is
 *  directly testable without fighting the engine's internal random IV. */
export function encodeBpc(
  plaintext: Uint8Array,
  documentKey: Uint8Array,
  iv: Uint8Array,
  withTrace = false
): { ciphertext: Uint8Array; trace: CipherTrace | undefined } {
  const keystream = createKeystream(iv);
  const counts = new Map<number, number>();
  const permCache = new Map<number, BandPermutation>();
  const ciphertext = new Uint8Array(plaintext.length * 2);
  const recorder = createTraceRecorder(withTrace);

  for (let i = 0; i < plaintext.length; i++) {
    const byte = plaintext[i]!;
    const count = counts.get(byte) ?? 0; // read before increment (spec 2.3)
    counts.set(byte, count + 1);

    const band = bandForCount(count);
    const perm = getOrBuildPermutation(permCache, documentKey, band);
    const symbolIndex = alphabetIndex(byte);
    const keystreamByte = keystream.next();
    const inBandCode = perm.forward[symbolIndex]! ^ keystreamByte;

    writeUint16BE(ciphertext, i * 2, band * 256 + inBandCode);
    recorder.record({ position: i, byte, band, count, outHigh: band, outLow: inBandCode });
  }

  return { ciphertext, trace: recorder.finish() };
}

/** Pure decode: the exact inverse of encodeBpc, given the same document key
 *  and the IV stored alongside the ciphertext. */
export function decodeBpc(
  ciphertext: Uint8Array,
  documentKey: Uint8Array,
  iv: Uint8Array,
  withTrace = false
): { plaintext: Uint8Array; trace: CipherTrace | undefined } {
  if (ciphertext.length % 2 !== 0) {
    throw new Error('bpc-2b: ciphertext length must be even (2 bytes per symbol)');
  }
  const keystream = createKeystream(iv);
  const counts = new Map<number, number>();
  const permCache = new Map<number, BandPermutation>();
  const symbolCount = ciphertext.length / 2;
  const plaintext = new Uint8Array(symbolCount);
  const recorder = createTraceRecorder(withTrace);

  for (let i = 0; i < symbolCount; i++) {
    const out16 = readUint16BE(ciphertext, i * 2);
    const band = out16 >>> 8;
    const inBandCode = out16 & 0xff;
    const keystreamByte = keystream.next();
    const code = inBandCode ^ keystreamByte;

    const perm = getOrBuildPermutation(permCache, documentKey, band);
    const symbolIndex = perm.inverse[code]!;
    const byte = symbolForIndex(symbolIndex);
    plaintext[i] = byte;

    const count = counts.get(byte) ?? 0;
    counts.set(byte, count + 1);
    recorder.record({ position: i, byte, band, count, outHigh: band, outLow: inBandCode });
  }

  return { plaintext, trace: recorder.finish() };
}

/** Pedagogical, visualizer-facing engine — see docs/CIPHER.md for the full
 *  design and docs/THREAT-MODEL.md for why AES-256-GCM, not this, protects
 *  data at rest. Output is 2 bytes per input byte: high byte = band
 *  (self-declared per symbol, so decode never needs a stored state
 *  snapshot the way the original spec's design did), low byte = the
 *  permuted-and-keystreamed in-band code. */
export function createBpcEngine(): CipherEngine {
  return {
    id: 'bpc-2b',

    seal(plaintext: Uint8Array, ctx: SealContext): SealedRecord {
      const documentKey = deriveDocumentKey(ctx);
      const iv = new Uint8Array(randomBytes(IV_LENGTH));
      const { ciphertext, trace } = encodeBpc(plaintext, documentKey, iv, ctx.withTrace ?? false);
      return { engineId: 'bpc-2b', iv, ciphertext, trace };
    },

    open(sealed: SealedRecord, ctx: SealContext): Uint8Array {
      const documentKey = deriveDocumentKey(ctx);
      const { plaintext } = decodeBpc(sealed.ciphertext, documentKey, sealed.iv, ctx.withTrace ?? false);
      return plaintext;
    },
  };
}
