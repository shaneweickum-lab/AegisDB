import { randomBytes as cryptoRandomBytes } from 'node:crypto';

// Crockford base32 (excludes I, L, O, U to avoid visual ambiguity).
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeBase32(bytes: Uint8Array): string {
  let bitBuffer = 0;
  let bitCount = 0;
  let out = '';
  for (const byte of bytes) {
    bitBuffer = (bitBuffer << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      out += ENCODING[(bitBuffer >>> (bitCount - 5)) & 0x1f];
      bitCount -= 5;
    }
  }
  if (bitCount > 0) {
    out += ENCODING[(bitBuffer << (5 - bitCount)) & 0x1f];
  }
  return out;
}

function timeToBytes(timeMs: number): Uint8Array {
  const bytes = new Uint8Array(6); // 48 bits
  let t = timeMs;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = t % 256;
    t = Math.floor(t / 256);
  }
  return bytes;
}

function incrementRandom(random: Uint8Array): Uint8Array {
  const next = new Uint8Array(random);
  for (let i = next.length - 1; i >= 0; i--) {
    const current = next[i]!;
    if (current < 255) {
      next[i] = current + 1;
      return next;
    }
    next[i] = 0;
  }
  throw new RangeError('ULID monotonic random component overflowed within the same millisecond');
}

export interface UlidState {
  lastTimeMs: number;
  lastRandom: Uint8Array | null;
}

export function createUlidState(): UlidState {
  return { lastTimeMs: -1, lastRandom: null };
}

const defaultState = createUlidState();

export interface UlidOptions {
  nowMs?: number;
  randomBytesFn?: (length: number) => Uint8Array;
  state?: UlidState;
}

/** Monotonic ULID: 48-bit ms timestamp + 80-bit randomness, Crockford base32.
 *  Within the same millisecond, the random component increments rather than
 *  re-randomizing, so ULIDs generated in a tight loop still sort strictly. */
export function generateUlid(options: UlidOptions = {}): string {
  const state = options.state ?? defaultState;
  const nowMs = options.nowMs ?? Date.now();
  const randomBytesFn = options.randomBytesFn ?? ((n: number) => new Uint8Array(cryptoRandomBytes(n)));

  let random: Uint8Array;
  if (nowMs === state.lastTimeMs && state.lastRandom) {
    random = incrementRandom(state.lastRandom);
  } else {
    random = randomBytesFn(10); // 80 bits
  }
  state.lastTimeMs = nowMs;
  state.lastRandom = random;

  return encodeBase32(timeToBytes(nowMs)) + encodeBase32(random);
}
