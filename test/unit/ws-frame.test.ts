import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, FrameDecoder, OPCODE, tryParseFrame } from '../../src/server/ws/frame.ts';

function maskPayload(payload: Uint8Array, maskKey: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i]! ^ maskKey[i % 4]!;
  return out;
}

function buildMaskedClientFrame(opcode: number, payload: Uint8Array, fin = true): Uint8Array {
  const maskKey = Uint8Array.of(0x12, 0x34, 0x56, 0x78);
  const masked = maskPayload(payload, maskKey);
  const length = masked.length;
  let header: number[];
  if (length < 126) {
    header = [(fin ? 0x80 : 0) | opcode, 0x80 | length];
  } else {
    header = [(fin ? 0x80 : 0) | opcode, 0x80 | 126, (length >>> 8) & 0xff, length & 0xff];
  }
  return Uint8Array.of(...header, ...maskKey, ...masked);
}

test('encodeFrame round-trips at the 7-bit/16-bit boundary (125, 126, 65535, 65536 byte payloads)', () => {
  for (const size of [0, 1, 125, 126, 127, 65535, 65536, 70000]) {
    const payload = new Uint8Array(size).fill(0xab);
    const encoded = encodeFrame(OPCODE.BINARY, payload);
    const parsed = tryParseFrame(encoded);
    assert.ok(parsed, `size ${size} did not parse`);
    assert.equal(parsed!.frame.opcode, OPCODE.BINARY);
    assert.equal(parsed!.frame.fin, true);
    assert.equal(parsed!.frame.masked, false, 'server frames must never be masked');
    assert.deepEqual(parsed!.frame.payload, payload);
    assert.equal(parsed!.consumed, encoded.length);
  }
});

test('tryParseFrame returns null for an incomplete frame (partial header)', () => {
  const encoded = encodeFrame(OPCODE.TEXT, new Uint8Array(200).fill(1));
  assert.equal(tryParseFrame(encoded.subarray(0, 1)), null); // not even a full 2-byte base header
  assert.equal(tryParseFrame(encoded.subarray(0, 3)), null); // extended length not fully present
});

test('tryParseFrame returns null for a frame whose payload has not fully arrived yet', () => {
  const encoded = encodeFrame(OPCODE.TEXT, new Uint8Array(50).fill(1));
  assert.equal(tryParseFrame(encoded.subarray(0, encoded.length - 1)), null);
});

test('correctly unmasks a masked client frame', () => {
  const payload = new TextEncoder().encode('hello from a client');
  const frame = buildMaskedClientFrame(OPCODE.TEXT, payload);
  const parsed = tryParseFrame(frame);
  assert.ok(parsed);
  assert.equal(parsed!.frame.masked, true);
  assert.deepEqual(parsed!.frame.payload, payload);
});

test('FrameDecoder reassembles a frame split across multiple chunks', () => {
  const payload = new Uint8Array(500).fill(0x42);
  const encoded = encodeFrame(OPCODE.BINARY, payload);
  const decoder = new FrameDecoder();

  const mid = Math.floor(encoded.length / 2);
  assert.deepEqual(decoder.push(encoded.subarray(0, mid)), []);
  const frames = decoder.push(encoded.subarray(mid));
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0]!.payload, payload);
});

test('FrameDecoder yields multiple frames delivered in a single chunk', () => {
  const a = encodeFrame(OPCODE.TEXT, new TextEncoder().encode('first'));
  const b = encodeFrame(OPCODE.TEXT, new TextEncoder().encode('second'));
  const decoder = new FrameDecoder();
  const combined = new Uint8Array(a.length + b.length);
  combined.set(a, 0);
  combined.set(b, a.length);

  const frames = decoder.push(combined);
  assert.equal(frames.length, 2);
  assert.equal(new TextDecoder().decode(frames[0]!.payload), 'first');
  assert.equal(new TextDecoder().decode(frames[1]!.payload), 'second');
});

test('rejects a frame with reserved bits set (no extensions negotiated)', () => {
  const encoded = encodeFrame(OPCODE.TEXT, new Uint8Array(0));
  const withReservedBit = new Uint8Array(encoded);
  withReservedBit[0] = withReservedBit[0]! | 0x40; // set RSV1
  assert.throws(() => tryParseFrame(withReservedBit));
});

test('rejects a fragmented control frame', () => {
  const encoded = encodeFrame(OPCODE.PING, new Uint8Array(0), false); // fin=false on a control frame
  assert.throws(() => tryParseFrame(encoded));
});

test('rejects an oversized control frame payload', () => {
  const encoded = encodeFrame(OPCODE.PING, new Uint8Array(126));
  assert.throws(() => tryParseFrame(encoded));
});
