import { extname } from 'node:path';
import { extractPlainText } from './text.ts';
import { extractDocxText } from './docx/extract.ts';

export type ExtractionMethod = 'utf8-direct' | 'docx-textract';

export interface FileIngestResult {
  fileName: string;
  extractionMethod: ExtractionMethod;
  extractedText: string;
  warnings: string[];
}

const DOCX_EXTENSIONS = new Set(['.docx']);

/** Type sniff -> extract -> return text (spec 8.4). Only the extracted
 *  text ever proceeds further (e.g. into the Engine, or into a document
 *  via the optional persist step in ingest-routes.ts) — the original
 *  uploaded bytes are discarded once this returns, per spec 8.4's "the
 *  original upload is discarded after extraction." */
export function ingestFile(fileName: string, fileBytes: Uint8Array): FileIngestResult {
  const ext = extname(fileName).toLowerCase();

  if (DOCX_EXTENSIONS.has(ext)) {
    const { text, warnings } = extractDocxText(fileBytes);
    return { fileName, extractionMethod: 'docx-textract', extractedText: text, warnings };
  }

  // Anything else is treated as plain text/code — spec 8.4's "any
  // plain-text/code file" bucket is deliberately permissive (no
  // extension allowlist), since the point is accepting arbitrary
  // source/text files, not gatekeeping by extension.
  return { fileName, extractionMethod: 'utf8-direct', extractedText: extractPlainText(fileBytes), warnings: [] };
}
