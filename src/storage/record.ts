import { crc32 } from 'node:zlib';
import { concatBytes, utf8Decode, utf8Encode } from '../core/bytes.ts';

// Self-describing per-record framing, reused for both the data log and the
// index log (spec 3.3's own suggestion for the data file — "a half-written
// trailing block is detectable via the LEN field and MAGIC bytes on next
// startup" — applied uniformly to both files rather than only the data
// file, so a torn tail is detectable and truncatable either way).
export const RECORD_MAGIC = Uint8Array.of(0xae, 0x15);
export const RECORD_VERSION = 1;
export const TOMBSTONE_FLAG = 0b0000_0001;

// magic(2) + version(1) + flags(1) + keyLen(2) + valueLen(4) + crc32(4)
export const RECORD_HEADER_LENGTH = 14;

export interface DecodedRecord {
  key: string;
  value: Uint8Array;
  deleted: boolean;
  /** Total bytes this record occupies on disk (header + key + value). */
  totalLength: number;
}

function uint16BE(n: number): Uint8Array {
  return Uint8Array.of((n >>> 8) & 0xff, n & 0xff);
}

function uint32BE(n: number): Uint8Array {
  return Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

function readUint16BE(buf: Uint8Array, offset: number): number {
  return (buf[offset]! << 8) | buf[offset + 1]!;
}

function readUint32BE(buf: Uint8Array, offset: number): number {
  return (buf[offset]! * 0x1000000) + (buf[offset + 1]! << 16) + (buf[offset + 2]! << 8) + buf[offset + 3]!;
}

export function encodeRecord(key: string, value: Uint8Array, deleted = false): Uint8Array {
  const keyBytes = utf8Encode(key);
  if (keyBytes.length > 0xffff) throw new RangeError('record key exceeds 65535 bytes');
  if (value.length > 0xffffffff) throw new RangeError('record value exceeds 4 GiB');

  const flags = deleted ? TOMBSTONE_FLAG : 0;
  const keyLenBytes = uint16BE(keyBytes.length);
  const valueLenBytes = uint32BE(value.length);
  const body = concatBytes(Uint8Array.of(flags), keyLenBytes, valueLenBytes, keyBytes, value);
  const crc = crc32(body);

  return concatBytes(
    RECORD_MAGIC,
    Uint8Array.of(RECORD_VERSION),
    Uint8Array.of(flags),
    keyLenBytes,
    valueLenBytes,
    uint32BE(crc),
    keyBytes,
    value
  );
}

/** Attempts to decode one record starting at `offset` in `buffer`. Returns
 *  `null` for ANY unparseable case — insufficient bytes, bad magic, or a
 *  CRC mismatch — rather than distinguishing them, because on an
 *  append-only log the first unparseable record encountered while
 *  scanning forward is, by construction, either a torn tail from an
 *  interrupted write or injected corruption; either way recovery's
 *  response is identical: stop here, this is the valid prefix. */
export function tryDecodeRecordAt(buffer: Uint8Array, offset: number): DecodedRecord | null {
  if (offset + RECORD_HEADER_LENGTH > buffer.length) return null;
  if (buffer[offset] !== RECORD_MAGIC[0] || buffer[offset + 1] !== RECORD_MAGIC[1]) return null;
  const version = buffer[offset + 2]!;
  if (version !== RECORD_VERSION) return null;

  const flags = buffer[offset + 3]!;
  const keyLen = readUint16BE(buffer, offset + 4);
  const valueLen = readUint32BE(buffer, offset + 6);
  const crc = readUint32BE(buffer, offset + 10);

  const keyStart = offset + RECORD_HEADER_LENGTH;
  const valueStart = keyStart + keyLen;
  const valueEnd = valueStart + valueLen;
  if (valueEnd > buffer.length) return null;

  const keyBytes = buffer.subarray(keyStart, valueStart);
  const value = buffer.subarray(valueStart, valueEnd);
  const body = concatBytes(Uint8Array.of(flags), uint16BE(keyLen), uint32BE(valueLen), keyBytes, value);
  if (crc32(body) !== crc) return null;

  return {
    key: utf8Decode(keyBytes),
    value,
    deleted: (flags & TOMBSTONE_FLAG) !== 0,
    totalLength: RECORD_HEADER_LENGTH + keyLen + valueLen,
  };
}
