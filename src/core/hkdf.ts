import { hkdfSync } from 'node:crypto';
import { utf8Encode } from './bytes.ts';

const EMPTY_SALT = new Uint8Array(0);

/** Full HKDF (extract + expand) via node:crypto. `salt` defaults to empty,
 *  matching HKDF's spec fallback for cases where no independent salt exists. */
export function deriveKey(
  ikm: Uint8Array,
  info: string,
  length: number,
  salt: Uint8Array = EMPTY_SALT
): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', ikm, salt, utf8Encode(info), length));
}

const SHA256_MAX_EXPAND_LEN = 255 * 32;

export interface ByteStream {
  next(): number;
}

/** Deterministic byte stream keyed by (seedKey, label): repeatedly calls
 *  HKDF-Expand with an incrementing block-counter suffix so it can supply
 *  unbounded bytes while staying fully reproducible given the same key. */
export function makeHkdfByteStream(seedKey: Uint8Array, label: string): ByteStream {
  let blockCounter = 0;
  let buffer: Uint8Array = new Uint8Array(0);
  let pos = 0;

  function refill(): void {
    buffer = deriveKey(seedKey, `${label}:${blockCounter}`, SHA256_MAX_EXPAND_LEN);
    blockCounter += 1;
    pos = 0;
  }

  return {
    next(): number {
      if (pos >= buffer.length) refill();
      const value = buffer[pos]!;
      pos += 1;
      return value;
    },
  };
}
