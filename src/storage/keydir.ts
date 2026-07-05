export interface KeydirEntry {
  /** Byte offset of the value's record in the DATA file. */
  offset: number;
  /** Total length (header + key + value) of that data record. */
  length: number;
  deleted: boolean;
}

export type Keydir = Map<string, KeydirEntry>;

function encodeUint32BE(n: number): Uint8Array {
  return Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

function decodeUint32BE(buf: Uint8Array, offset: number): number {
  return (buf[offset]! * 0x1000000) + (buf[offset + 1]! << 16) + (buf[offset + 2]! << 8) + buf[offset + 3]!;
}

/** An index-log record's value is just {offset, length} into the data
 *  file — 8 bytes, deleted status is carried by the index record's own
 *  tombstone flag (record.ts), not duplicated into this payload. */
export function encodeIndexValue(offset: number, length: number): Uint8Array {
  return Uint8Array.of(...encodeUint32BE(offset), ...encodeUint32BE(length));
}

export function decodeIndexValue(value: Uint8Array): { offset: number; length: number } {
  if (value.length !== 8) throw new Error(`index value must be 8 bytes, got ${value.length}`);
  return { offset: decodeUint32BE(value, 0), length: decodeUint32BE(value, 4) };
}

interface ScannedIndexRecord {
  key: string;
  value: Uint8Array;
  deleted: boolean;
}

/** Rebuilds the keydir from a sequential scan of the index log. Later
 *  records for the same key overwrite earlier ones, matching spec 3.3's
 *  log-structured (not in-place) index design. */
export function buildKeydir(scannedIndexRecords: ScannedIndexRecord[]): Keydir {
  const keydir: Keydir = new Map();
  for (const record of scannedIndexRecords) {
    const { offset, length } = decodeIndexValue(record.value);
    keydir.set(record.key, { offset, length, deleted: record.deleted });
  }
  return keydir;
}
