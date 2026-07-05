import { open, type FileHandle } from 'node:fs/promises';
import { encodeRecord, tryDecodeRecordAt, type DecodedRecord } from './record.ts';

// File header: magic(4) + version(1) + generation(4 BE), then records.
const FILE_MAGIC = Uint8Array.of(0xa6, 0x15, 0xd0, 0x0d);
const FILE_VERSION = 1;
export const FILE_HEADER_LENGTH = 4 + 1 + 4;

function encodeFileHeader(generation: number): Uint8Array {
  const header = new Uint8Array(FILE_HEADER_LENGTH);
  header.set(FILE_MAGIC, 0);
  header[4] = FILE_VERSION;
  header[5] = (generation >>> 24) & 0xff;
  header[6] = (generation >>> 16) & 0xff;
  header[7] = (generation >>> 8) & 0xff;
  header[8] = generation & 0xff;
  return header;
}

function decodeFileHeader(buf: Uint8Array): number {
  for (let i = 0; i < 4; i++) {
    if (buf[i] !== FILE_MAGIC[i]) throw new Error('append log: bad file magic');
  }
  if (buf[4] !== FILE_VERSION) throw new Error(`append log: unsupported file version ${buf[4]}`);
  return (buf[5]! << 24) | (buf[6]! << 16) | (buf[7]! << 8) | buf[8]!;
}

export interface AppendResult {
  offset: number;
  length: number;
}

export interface ScanResult {
  records: Array<DecodedRecord & { offset: number }>;
  /** Byte length of the valid prefix — anything after this in the file
   *  (a torn tail from an interrupted write, or injected corruption) was
   *  not included and should be truncated by the caller. */
  validLength: number;
}

/** One physical file: a small generation-tagged header followed by a
 *  sequence of self-describing records (record.ts), always written by
 *  direct append + fsync rather than the spec's copy-the-whole-file
 *  tmp+rename shadow (see docs/STORAGE.md) — same crash-safety guarantee,
 *  O(1) amortized append cost instead of O(file size) per write. */
export class AppendLog {
  private readonly handle: FileHandle;
  readonly generation: number;
  private cursor: number;

  private constructor(handle: FileHandle, generation: number, cursor: number) {
    this.handle = handle;
    this.generation = generation;
    this.cursor = cursor;
  }

  /** Current on-disk size in bytes (header + every record appended so
   *  far, including superseded/tombstoned ones that compaction hasn't
   *  reclaimed yet) — NOT the same as "sum of the keydir's current
   *  entries," which only counts each key's latest version. */
  get size(): number {
    return this.cursor;
  }

  static async create(path: string, generation: number): Promise<AppendLog> {
    const handle = await open(path, 'wx+');
    const header = encodeFileHeader(generation);
    await handle.write(header, 0, header.length, 0);
    await handle.sync();
    return new AppendLog(handle, generation, header.length);
  }

  static async open(path: string): Promise<AppendLog> {
    const handle = await open(path, 'r+');
    const { size } = await handle.stat();
    if (size < FILE_HEADER_LENGTH) throw new Error(`append log: ${path} is smaller than its header`);
    const headerBuf = new Uint8Array(FILE_HEADER_LENGTH);
    await handle.read(headerBuf, 0, FILE_HEADER_LENGTH, 0);
    const generation = decodeFileHeader(headerBuf);
    return new AppendLog(handle, generation, size);
  }

  async append(key: string, value: Uint8Array, deleted = false): Promise<AppendResult> {
    const encoded = encodeRecord(key, value, deleted);
    const offset = this.cursor;
    await this.handle.write(encoded, 0, encoded.length, offset);
    await this.handle.sync();
    this.cursor = offset + encoded.length;
    return { offset, length: encoded.length };
  }

  async readAt(offset: number, length: number): Promise<Uint8Array> {
    const buf = new Uint8Array(length);
    const { bytesRead } = await this.handle.read(buf, 0, length, offset);
    if (bytesRead !== length) {
      throw new Error(`append log: short read at offset ${offset} (wanted ${length}, got ${bytesRead})`);
    }
    return buf;
  }

  /** Scans every record from just after the file header to EOF. Used for
   *  startup recovery (build the keydir, detect a torn tail) and for
   *  compaction (read out every live record). */
  async scan(): Promise<ScanResult> {
    const { size } = await this.handle.stat();
    const buf = new Uint8Array(size);
    await this.handle.read(buf, 0, size, 0);

    const records: Array<DecodedRecord & { offset: number }> = [];
    let offset = FILE_HEADER_LENGTH;
    for (;;) {
      const decoded = tryDecodeRecordAt(buf, offset);
      if (!decoded) break;
      records.push({ ...decoded, offset });
      offset += decoded.totalLength;
    }
    return { records, validLength: offset };
  }

  /** Discards a torn tail (or anything after it) by truncating the file to
   *  exactly its valid prefix, and repositions the append cursor there. */
  async truncateTo(validLength: number): Promise<void> {
    await this.handle.truncate(validLength);
    await this.handle.sync();
    this.cursor = validLength;
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}
