// Extracts run text from a Word document.xml by string/regex scanning —
// no XML parser. This works because we only need <w:t> run contents in
// document order plus paragraph boundaries, not a general DOM; a real
// XML parser would be a lot of machinery for that narrow a need.

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function unescapeXmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity[0] === '#') {
      const codePoint = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}

// Matches either a <w:t> run's contents (captured) or a paragraph-closing
// tag (uncaptured) — a single pass over the document preserves the
// original order of runs and paragraph breaks. `xml:space="preserve"` on
// a run needs no special handling here: we already take each run's raw
// inner text verbatim, which is exactly what that attribute would ask a
// generic XML processor to do anyway.
const RUN_OR_PARAGRAPH_BOUNDARY = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<\/w:p>/g;

export function extractDocumentText(documentXml: string): string {
  const paragraphs: string[] = [];
  let currentParagraph = '';

  for (const match of documentXml.matchAll(RUN_OR_PARAGRAPH_BOUNDARY)) {
    const runText = match[1];
    if (runText !== undefined) {
      currentParagraph += unescapeXmlEntities(runText);
    } else {
      paragraphs.push(currentParagraph);
      currentParagraph = '';
    }
  }
  if (currentParagraph.length > 0) paragraphs.push(currentParagraph);

  return paragraphs.join('\n');
}
