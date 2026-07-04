import { makeHkdfByteStream, type ByteStream } from '../../core/hkdf.ts';

/** Spec 2.4.2: stretches a short IV into an arbitrarily long keystream via
 *  a standard hash-based expansion (HKDF-Expand/SHA-256) rather than a
 *  hand-rolled PRNG — the spec's own guidance, since PRNG bias is a
 *  well-known footgun and this is the one place leaning on a vetted
 *  primitive matters even for a pedagogical cipher. */
export function createKeystream(iv: Uint8Array): ByteStream {
  return makeHkdfByteStream(iv, 'aegis-keystream');
}
