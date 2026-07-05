import { deflateRawSync } from 'node:zlib';

function u16(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}
function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

export interface ZipInput {
  name: string;
  content: string | Uint8Array;
  compress: boolean;
  encrypted?: boolean;
}

/** Hand-builds a minimal, genuinely valid ZIP archive byte-for-byte,
 *  mirroring the real format (local header + central directory + EOCD)
 *  — used to exercise src/ingest/docx/zip.ts against real ZIP structure
 *  without needing an external binary fixture file in the repo. */
export function buildZip(inputs: ZipInput[]): Uint8Array {
  const localParts: number[] = [];
  const centralParts: number[] = [];

  for (const input of inputs) {
    const nameBytes = [...Buffer.from(input.name, 'utf8')];
    const rawContent = typeof input.content === 'string' ? Buffer.from(input.content, 'utf8') : Buffer.from(input.content);
    const data = input.compress ? deflateRawSync(rawContent) : rawContent;
    const method = input.compress ? 8 : 0;
    const flags = input.encrypted ? 0x1 : 0x0;

    const localOffset = localParts.length;

    localParts.push(
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(flags),
      ...u16(method),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(data.length),
      ...u32(rawContent.length),
      ...u16(nameBytes.length),
      ...u16(0),
      ...nameBytes,
      ...data
    );

    centralParts.push(
      ...u32(0x02014b50),
      ...u16(20),
      ...u16(20),
      ...u16(flags),
      ...u16(method),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(data.length),
      ...u32(rawContent.length),
      ...u16(nameBytes.length),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(localOffset),
      ...nameBytes
    );
  }

  const centralDirOffset = localParts.length;
  const centralDirSize = centralParts.length;
  const eocd = [
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(inputs.length),
    ...u16(inputs.length),
    ...u32(centralDirSize),
    ...u32(centralDirOffset),
    ...u16(0),
  ];

  return Uint8Array.from([...localParts, ...centralParts, ...eocd]);
}
