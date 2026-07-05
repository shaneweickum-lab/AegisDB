import { findEntry, parseZip, ZipFormatError } from './zip.ts';
import { inflateEntry } from './inflate.ts';
import { extractDocumentText } from './wt-extract.ts';

const DOCUMENT_XML_PATH = 'word/document.xml';

export interface DocxExtractionResult {
  text: string;
  warnings: string[];
}

/** Ties the hand-parsed ZIP container, node:zlib inflate, and the
 *  regex-based run-text extractor together — spec 8.4's ".docx ->
 *  docx-textract" path: unzip -> parse document.xml -> concatenate run
 *  text, discarding styling/images/tables into a documented warning
 *  rather than silently dropping content. */
export function extractDocxText(fileBytes: Uint8Array): DocxExtractionResult {
  const zip = parseZip(fileBytes);
  const entry = findEntry(zip, DOCUMENT_XML_PATH);
  if (!entry) throw new ZipFormatError(`not a valid .docx file: missing ${DOCUMENT_XML_PATH}`);

  const compressed = zip.readEntryCompressedBytes(entry);
  const inflated = inflateEntry(entry, compressed);
  const xml = Buffer.from(inflated).toString('utf8');
  const text = extractDocumentText(xml);

  return {
    text,
    warnings: ['images, tables, and styling were discarded — only run text was extracted (spec 8.5)'],
  };
}
