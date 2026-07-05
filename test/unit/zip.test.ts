import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findEntry, parseZip, ZipFormatError } from '../../src/ingest/docx/zip.ts';
import { buildZip } from '../helpers/build-zip.ts';

test('parses a minimal single-entry ZIP (stored, no compression)', () => {
  const zip = buildZip([{ name: 'hello.txt', content: 'hello world', compress: false }]);
  const parsed = parseZip(zip);
  assert.equal(parsed.entries.length, 1);
  const entry = findEntry(parsed, 'hello.txt')!;
  assert.equal(Buffer.from(parsed.readEntryCompressedBytes(entry)).toString('utf8'), 'hello world');
});

test('parses a deflate-compressed entry', () => {
  const content = 'the quick brown fox jumps over the lazy dog '.repeat(20);
  const zip = buildZip([{ name: 'big.txt', content, compress: true }]);
  const parsed = parseZip(zip);
  const entry = findEntry(parsed, 'big.txt')!;
  assert.ok(entry.compressedSize < entry.uncompressedSize, 'repetitive text should actually compress');
});

test('parses multiple entries and preserves order/content', () => {
  const zip = buildZip([
    { name: 'a.txt', content: 'first', compress: false },
    { name: 'b.txt', content: 'second', compress: true },
    { name: 'c.txt', content: 'third', compress: false },
  ]);
  const parsed = parseZip(zip);
  assert.deepEqual(parsed.entries.map((e) => e.fileName), ['a.txt', 'b.txt', 'c.txt']);
});

test('rejects an encrypted entry', () => {
  const zip = buildZip([{ name: 'secret.txt', content: 'shh', compress: false, encrypted: true }]);
  assert.throws(() => parseZip(zip), ZipFormatError);
});

test('rejects a file with no EOCD record at all', () => {
  const garbage = new Uint8Array(100).fill(0x41);
  assert.throws(() => parseZip(garbage), ZipFormatError);
});

test('rejects a truncated archive (EOCD present but central directory cut off)', () => {
  const zip = buildZip([{ name: 'a.txt', content: 'hello', compress: false }]);
  const truncated = zip.subarray(0, zip.length - 10);
  assert.throws(() => parseZip(truncated));
});

test('findEntry returns undefined for a missing file', () => {
  const zip = buildZip([{ name: 'a.txt', content: 'x', compress: false }]);
  const parsed = parseZip(zip);
  assert.equal(findEntry(parsed, 'word/document.xml'), undefined);
});
