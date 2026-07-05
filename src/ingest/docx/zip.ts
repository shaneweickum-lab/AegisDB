// Hand-parsed ZIP container (no zip library) — only the container format
// itself is parsed by hand; DEFLATE decompression uses node:zlib's
// built-in inflateRawSync (an allowed built-in, not a "zip library").

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const EOCD_MIN_LENGTH = 22;
const MAX_COMMENT_LENGTH = 0xffff;

const COMPRESSION_STORED = 0;
const COMPRESSION_DEFLATE = 8;

export class ZipFormatError extends Error {}

function readUint16LE(buf: Uint8Array, offset: number): number {
  return buf[offset]! | (buf[offset + 1]! << 8);
}

function readUint32LE(buf: Uint8Array, offset: number): number {
  return (buf[offset]! | (buf[offset + 1]! << 8) | (buf[offset + 2]! << 16) | (buf[offset + 3]! * 0x1000000)) >>> 0;
}

interface EndOfCentralDirectory {
  totalRecords: number;
  centralDirSize: number;
  centralDirOffset: number;
}

/** The EOCD record sits at the end of the file, but a trailing comment
 *  field (up to 64KiB) means its exact position isn't fixed — scan
 *  backward for the signature, same as any real ZIP reader has to. */
function findEndOfCentralDirectory(buf: Uint8Array): EndOfCentralDirectory {
  const searchStart = Math.max(0, buf.length - EOCD_MIN_LENGTH - MAX_COMMENT_LENGTH);
  for (let offset = buf.length - EOCD_MIN_LENGTH; offset >= searchStart; offset--) {
    if (readUint32LE(buf, offset) === EOCD_SIGNATURE) {
      const totalRecords = readUint16LE(buf, offset + 10);
      const centralDirSize = readUint32LE(buf, offset + 12);
      const centralDirOffset = readUint32LE(buf, offset + 16);

      if (totalRecords === 0xffff || centralDirSize === 0xffffffff || centralDirOffset === 0xffffffff) {
        throw new ZipFormatError('ZIP64 archives are not supported');
      }
      return { totalRecords, centralDirSize, centralDirOffset };
    }
  }
  throw new ZipFormatError('not a valid ZIP file: End Of Central Directory record not found');
}

export interface ZipEntry {
  fileName: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  encrypted: boolean;
}

function parseCentralDirectory(buf: Uint8Array, eocd: EndOfCentralDirectory): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let offset = eocd.centralDirOffset;

  for (let i = 0; i < eocd.totalRecords; i++) {
    if (offset + 46 > buf.length || readUint32LE(buf, offset) !== CENTRAL_DIR_SIGNATURE) {
      throw new ZipFormatError(`corrupt central directory record at index ${i}`);
    }
    const flags = readUint16LE(buf, offset + 8);
    const compressionMethod = readUint16LE(buf, offset + 10);
    const compressedSize = readUint32LE(buf, offset + 20);
    const uncompressedSize = readUint32LE(buf, offset + 24);
    const fileNameLength = readUint16LE(buf, offset + 28);
    const extraFieldLength = readUint16LE(buf, offset + 30);
    const commentLength = readUint16LE(buf, offset + 32);
    const localHeaderOffset = readUint32LE(buf, offset + 42);

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new ZipFormatError('ZIP64 archives are not supported');
    }

    const fileNameStart = offset + 46;
    const fileName = Buffer.from(buf.subarray(fileNameStart, fileNameStart + fileNameLength)).toString('utf8');

    entries.push({
      fileName,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      encrypted: (flags & 0x1) !== 0,
    });

    offset = fileNameStart + fileNameLength + extraFieldLength + commentLength;
  }

  return entries;
}

/** Extracts one entry's raw (still-compressed) bytes by seeking to its
 *  local file header — the central directory only gives an offset; the
 *  local header's own filename/extra-field lengths (which can differ
 *  from the central directory's) determine where the actual data starts. */
function readCompressedBytes(buf: Uint8Array, entry: ZipEntry): Uint8Array {
  const offset = entry.localHeaderOffset;
  if (offset + 30 > buf.length || readUint32LE(buf, offset) !== LOCAL_HEADER_SIGNATURE) {
    throw new ZipFormatError(`corrupt local file header for "${entry.fileName}"`);
  }
  const fileNameLength = readUint16LE(buf, offset + 26);
  const extraFieldLength = readUint16LE(buf, offset + 28);
  const dataStart = offset + 30 + fileNameLength + extraFieldLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buf.length) {
    throw new ZipFormatError(`truncated archive: "${entry.fileName}" extends past end of file`);
  }
  return buf.subarray(dataStart, dataEnd);
}

export interface ParsedZip {
  entries: ZipEntry[];
  readEntryCompressedBytes(entry: ZipEntry): Uint8Array;
}

export function parseZip(buf: Uint8Array): ParsedZip {
  const eocd = findEndOfCentralDirectory(buf);
  const entries = parseCentralDirectory(buf, eocd);
  for (const entry of entries) {
    if (entry.encrypted) throw new ZipFormatError(`encrypted ZIP entries are not supported ("${entry.fileName}")`);
    if (entry.compressionMethod !== COMPRESSION_STORED && entry.compressionMethod !== COMPRESSION_DEFLATE) {
      throw new ZipFormatError(`unsupported compression method ${entry.compressionMethod} for "${entry.fileName}"`);
    }
  }
  return { entries, readEntryCompressedBytes: (entry) => readCompressedBytes(buf, entry) };
}

export function findEntry(zip: ParsedZip, fileName: string): ZipEntry | undefined {
  return zip.entries.find((entry) => entry.fileName === fileName);
}

export { COMPRESSION_DEFLATE, COMPRESSION_STORED };
