import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractDocxText } from '../../src/ingest/docx/extract.ts';
import { ZipFormatError } from '../../src/ingest/docx/zip.ts';
import { buildZip } from '../helpers/build-zip.ts';

function fakeDocx(documentXml: string, compress = true): Uint8Array {
  return buildZip([
    { name: '[Content_Types].xml', content: '<Types/>', compress },
    { name: 'word/document.xml', content: documentXml, compress },
  ]);
}

const SAMPLE_DOCUMENT_XML =
  '<?xml version="1.0"?><w:document><w:body>' +
  '<w:p><w:r><w:t>Hello, </w:t></w:r><w:r><w:t>world!</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>Second paragraph.</w:t></w:r></w:p>' +
  '</w:body></w:document>';

test('extracts text from a hand-built .docx-shaped archive (compressed)', () => {
  const fileBytes = fakeDocx(SAMPLE_DOCUMENT_XML, true);
  const result = extractDocxText(fileBytes);
  assert.equal(result.text, 'Hello, world!\nSecond paragraph.');
  assert.ok(result.warnings.length > 0, 'should document that formatting was discarded');
});

test('extracts text from an uncompressed (stored) archive too', () => {
  const fileBytes = fakeDocx(SAMPLE_DOCUMENT_XML, false);
  const result = extractDocxText(fileBytes);
  assert.equal(result.text, 'Hello, world!\nSecond paragraph.');
});

test('throws a clear error when word/document.xml is missing', () => {
  const fileBytes = buildZip([{ name: 'not-a-docx.txt', content: 'nope', compress: false }]);
  assert.throws(() => extractDocxText(fileBytes), ZipFormatError);
});

test('throws a clear error on a malformed/truncated archive rather than crashing', () => {
  const fileBytes = fakeDocx(SAMPLE_DOCUMENT_XML, true).subarray(0, 20);
  assert.throws(() => extractDocxText(fileBytes));
});

test('inflate-bomb guard: rejects an entry whose declared uncompressed size exceeds the cap', () => {
  // A real decompression bomb is highly repetitive data; simulate the
  // *declared-size* attack surface directly by building an entry whose
  // header claims a huge uncompressed size in the local file header.
  const oversizedXml = 'x'.repeat(1000);
  const fileBytes = fakeDocx(oversizedXml, true);

  // Corrupt the uncompressed-size field of the word/document.xml local
  // header to claim something enormous, simulating a maliciously crafted
  // archive rather than an honestly large one.
  const marker = Buffer.from('word/document.xml');
  const nameIndex = Buffer.from(fileBytes).indexOf(marker);
  assert.ok(nameIndex > 0);
  const localHeaderStart = nameIndex - 30; // filename immediately follows the 30-byte local header
  const uncompressedSizeOffset = localHeaderStart + 22;
  fileBytes[uncompressedSizeOffset] = 0xff;
  fileBytes[uncompressedSizeOffset + 1] = 0xff;
  fileBytes[uncompressedSizeOffset + 2] = 0xff;
  fileBytes[uncompressedSizeOffset + 3] = 0x7f; // ~2GB, not 0xffffffff (that's the ZIP64 sentinel)

  // Also patch the matching central directory record so parseZip's own
  // ZIP64-sentinel check doesn't trip on the OTHER copy of this field.
  const centralMarker = Buffer.from(fileBytes).indexOf(marker, nameIndex + 1);
  if (centralMarker > 0) {
    const centralHeaderStart = centralMarker - 46;
    const centralUncompressedOffset = centralHeaderStart + 24;
    fileBytes[centralUncompressedOffset] = 0xff;
    fileBytes[centralUncompressedOffset + 1] = 0xff;
    fileBytes[centralUncompressedOffset + 2] = 0xff;
    fileBytes[centralUncompressedOffset + 3] = 0x7f;
  }

  assert.throws(() => extractDocxText(fileBytes), /uncompressed size|bomb|cap/i);
});
