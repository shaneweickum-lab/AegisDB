import { concatBytes } from '../../core/bytes.ts';

export const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const;

export interface WsFrame {
  fin: boolean;
  opcode: number;
  payload: Uint8Array;
  masked: boolean;
}

function isControlOpcode(opcode: number): boolean {
  return opcode === OPCODE.CLOSE || opcode === OPCODE.PING || opcode === OPCODE.PONG;
}

/** Builds one frame. Server->client frames must never be masked (RFC 6455
 *  section 5.1) — there is no `mask` parameter here on purpose. */
export function encodeFrame(opcode: number, payload: Uint8Array, fin = true): Uint8Array {
  const length = payload.length;
  let header: Uint8Array;

  if (length < 126) {
    header = Uint8Array.of((fin ? 0x80 : 0) | opcode, length);
  } else if (length <= 0xffff) {
    header = new Uint8Array(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 126;
    header[2] = (length >>> 8) & 0xff;
    header[3] = length & 0xff;
  } else {
    header = new Uint8Array(10);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 127;
    let big = BigInt(length);
    for (let i = 7; i >= 0; i--) {
      header[2 + i] = Number(big & 0xffn);
      big >>= 8n;
    }
  }

  return concatBytes(header, payload);
}

interface ParsedFrame {
  frame: WsFrame;
  consumed: number;
}

/** Attempts to parse exactly one frame from the start of `buf`. Returns
 *  null if `buf` doesn't yet contain a complete frame (TCP can and does
 *  split a single WS frame across multiple 'data' events) — the caller
 *  is expected to accumulate bytes and retry. */
export function tryParseFrame(buf: Uint8Array): ParsedFrame | null {
  if (buf.length < 2) return null;

  const byte0 = buf[0]!;
  const byte1 = buf[1]!;
  const fin = (byte0 & 0x80) !== 0;
  const rsv = byte0 & 0x70;
  if (rsv !== 0) throw new Error('ws: reserved bits set, no extensions are negotiated');

  const opcode = byte0 & 0x0f;
  const masked = (byte1 & 0x80) !== 0;
  let payloadLen = byte1 & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (buf.length < offset + 2) return null;
    payloadLen = (buf[offset]! << 8) | buf[offset + 1]!;
    offset += 2;
  } else if (payloadLen === 127) {
    if (buf.length < offset + 8) return null;
    let big = 0n;
    for (let i = 0; i < 8; i++) big = (big << 8n) | BigInt(buf[offset + i]!);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('ws: frame payload too large');
    payloadLen = Number(big);
    offset += 8;
  }

  if (isControlOpcode(opcode) && (!fin || payloadLen > 125)) {
    throw new Error('ws: control frames must not be fragmented and must be <= 125 bytes');
  }

  let maskKey: Uint8Array | null = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    maskKey = buf.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buf.length < offset + payloadLen) return null;
  const raw = buf.subarray(offset, offset + payloadLen);

  let payload: Uint8Array;
  if (maskKey) {
    payload = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) payload[i] = raw[i]! ^ maskKey[i % 4]!;
  } else {
    payload = new Uint8Array(raw); // copy — raw is a view into the shared buffer
  }

  return { frame: { fin, opcode, payload, masked }, consumed: offset + payloadLen };
}

/** Accumulates bytes across 'data' events and yields every complete
 *  frame as soon as it's available. */
export class FrameDecoder {
  private buffer: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): WsFrame[] {
    this.buffer = concatBytes(this.buffer, chunk);
    const frames: WsFrame[] = [];
    for (;;) {
      const parsed = tryParseFrame(this.buffer);
      if (!parsed) break;
      frames.push(parsed.frame);
      this.buffer = this.buffer.subarray(parsed.consumed);
    }
    return frames;
  }
}
