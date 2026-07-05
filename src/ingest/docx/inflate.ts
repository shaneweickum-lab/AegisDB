import { inflateRawSync } from 'node:zlib';
import { COMPRESSION_DEFLATE, COMPRESSION_STORED, type ZipEntry } from './zip.ts';

export class DecompressionBombError extends Error {}

const DEFAULT_MAX_INFLATED_BYTES = 64 * 1024 * 1024; // 64 MiB

/** DEFLATE decompression itself is node:zlib (an allowed built-in) — only
 *  the ZIP container framing above this is hand-parsed. Guards against a
 *  decompression bomb by checking the entry's own declared uncompressed
 *  size before ever calling inflate, rather than trusting it blindly. */
export function inflateEntry(
  entry: ZipEntry,
  compressedBytes: Uint8Array,
  maxInflatedBytes: number = DEFAULT_MAX_INFLATED_BYTES
): Uint8Array {
  if (entry.uncompressedSize > maxInflatedBytes) {
    throw new DecompressionBombError(
      `"${entry.fileName}" declares an uncompressed size of ${entry.uncompressedSize} bytes, over the ${maxInflatedBytes}-byte cap`
    );
  }

  if (entry.compressionMethod === COMPRESSION_STORED) {
    return compressedBytes;
  }
  if (entry.compressionMethod === COMPRESSION_DEFLATE) {
    const inflated = inflateRawSync(compressedBytes, { maxOutputLength: maxInflatedBytes });
    return new Uint8Array(inflated);
  }
  throw new Error(`unsupported compression method ${entry.compressionMethod}`);
}
