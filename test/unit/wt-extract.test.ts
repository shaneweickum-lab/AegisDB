import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractDocumentText } from '../../src/ingest/docx/wt-extract.ts';

function wrapDocument(bodyXml: string): string {
  return `<?xml version="1.0"?><w:document><w:body>${bodyXml}</w:body></w:document>`;
}

test('extracts a single run in a single paragraph', () => {
  const xml = wrapDocument('<w:p><w:r><w:t>Hello world</w:t></w:r></w:p>');
  assert.equal(extractDocumentText(xml), 'Hello world');
});

test('concatenates multiple runs within one paragraph with no extra separators', () => {
  const xml = wrapDocument('<w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t xml:space="preserve">world</w:t></w:r></w:p>');
  assert.equal(extractDocumentText(xml), 'Hello world');
});

test('separates paragraphs with a newline', () => {
  const xml = wrapDocument('<w:p><w:r><w:t>First</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p>');
  assert.equal(extractDocumentText(xml), 'First\nSecond');
});

test('unescapes named XML entities', () => {
  const xml = wrapDocument('<w:p><w:r><w:t>Tom &amp; Jerry &lt;3 &quot;quotes&quot;</w:t></w:r></w:p>');
  assert.equal(extractDocumentText(xml), 'Tom & Jerry <3 "quotes"');
});

test('unescapes numeric character references (decimal and hex)', () => {
  const xml = wrapDocument('<w:p><w:r><w:t>&#65;&#66;&#x43;</w:t></w:r></w:p>');
  assert.equal(extractDocumentText(xml), 'ABC');
});

test('preserves whitespace-only runs (xml:space="preserve") verbatim', () => {
  const xml = wrapDocument(
    '<w:p><w:r><w:t>word1</w:t></w:r><w:r><w:t xml:space="preserve">   </w:t></w:r><w:r><w:t>word2</w:t></w:r></w:p>'
  );
  assert.equal(extractDocumentText(xml), 'word1   word2');
});

test('ignores non-text document structure (styling/formatting elements)', () => {
  const xml = wrapDocument(
    '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>bold text</w:t></w:r></w:p>'
  );
  assert.equal(extractDocumentText(xml), 'bold text');
});

test('returns empty string for a document with no runs', () => {
  const xml = wrapDocument('<w:p></w:p>');
  assert.equal(extractDocumentText(xml), '');
});

test('handles an unclosed final paragraph gracefully (no trailing </w:p>)', () => {
  const xml = wrapDocument('<w:p><w:r><w:t>complete</w:t></w:r></w:p><w:r><w:t>dangling</w:t></w:r>');
  assert.equal(extractDocumentText(xml), 'complete\ndangling');
});
