// BPC operates over the full byte range (0-255) rather than a restricted
// printable-ASCII subset, since real input (JSON.stringify(doc) as UTF-8)
// can contain any byte value. BASE_ID still gives named symbols
// (A-Z, a-z, 0-9) the lowest indices, matching the original spec's
// "Base ID starting at 2" flavor for visualizer legibility, then fills
// the rest of the table with every remaining byte value in ascending
// order so the mapping is a total bijection over 0..255.

export const ALPHABET_SIZE = 256;

function buildBaseIdTable(): { toIndex: Uint16Array; toByte: Uint16Array } {
  const named: number[] = [];
  for (let c = 0x41; c <= 0x5a; c++) named.push(c); // A-Z
  for (let c = 0x61; c <= 0x7a; c++) named.push(c); // a-z
  for (let c = 0x30; c <= 0x39; c++) named.push(c); // 0-9

  const seen = new Set(named);
  const rest: number[] = [];
  for (let b = 0; b < 256; b++) {
    if (!seen.has(b)) rest.push(b);
  }

  const order = [...named, ...rest];
  if (order.length !== ALPHABET_SIZE) {
    throw new Error(`alphabet table construction invariant violated: ${order.length} entries`);
  }

  const toIndex = new Uint16Array(ALPHABET_SIZE);
  const toByte = new Uint16Array(ALPHABET_SIZE);
  for (let index = 0; index < order.length; index++) {
    const byte = order[index]!;
    toIndex[byte] = index;
    toByte[index] = byte;
  }
  return { toIndex, toByte };
}

const TABLE = buildBaseIdTable();

/** Spec-flavored "Base ID": named symbols (A-Z/a-z/0-9) start at 2. */
export function baseId(byte: number): number {
  return alphabetIndex(byte) + 2;
}

export function alphabetIndex(byte: number): number {
  const index = TABLE.toIndex[byte];
  if (index === undefined) throw new RangeError(`byte value out of range: ${byte}`);
  return index;
}

export function symbolForIndex(index: number): number {
  const byte = TABLE.toByte[index];
  if (byte === undefined) throw new RangeError(`alphabet index out of range: ${index}`);
  return byte;
}
