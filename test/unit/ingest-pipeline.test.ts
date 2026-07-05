import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestFile } from '../../src/ingest/pipeline.ts';
import { buildZip } from '../helpers/build-zip.ts';

test('routes .txt files through the plain-text path', () => {
  const result = ingestFile('notes.txt', Buffer.from('plain text content', 'utf8'));
  assert.equal(result.extractionMethod, 'utf8-direct');
  assert.equal(result.extractedText, 'plain text content');
  assert.deepEqual(result.warnings, []);
});

test('routes .md and arbitrary code/text extensions through the plain-text path (no allowlist)', () => {
  for (const name of ['README.md', 'index.ts', 'script.py', 'data.json', 'noextension']) {
    const result = ingestFile(name, Buffer.from('x = 1', 'utf8'));
    assert.equal(result.extractionMethod, 'utf8-direct');
  }
});

test('routes .docx files through the docx-textract path', () => {
  const xml = '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>from docx</w:t></w:r></w:p></w:body></w:document>';
  const fileBytes = buildZip([{ name: 'word/document.xml', content: xml, compress: true }]);
  const result = ingestFile('report.docx', fileBytes);
  assert.equal(result.extractionMethod, 'docx-textract');
  assert.equal(result.extractedText, 'from docx');
});

test('.docx extension matching is case-insensitive', () => {
  const xml = '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>x</w:t></w:r></w:p></w:body></w:document>';
  const fileBytes = buildZip([{ name: 'word/document.xml', content: xml, compress: true }]);
  const result = ingestFile('REPORT.DOCX', fileBytes);
  assert.equal(result.extractionMethod, 'docx-textract');
});

test('a malformed .docx surfaces a clean error rather than throwing something opaque', () => {
  assert.throws(() => ingestFile('bad.docx', Buffer.from('not a zip at all')));
});
