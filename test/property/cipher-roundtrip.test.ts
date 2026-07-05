import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBpcEngine, decodeBpc, encodeBpc } from '../../src/crypto/bpc/bpc-engine.ts';
import { deriveDocumentKey } from '../../src/crypto/document-key.ts';
import { createAesGcmEngine } from '../../src/crypto/aes-gcm-engine.ts';
import { utf8Decode, utf8Encode } from '../../src/core/bytes.ts';
import type { CipherEngine, CipherTraceStep, SealContext } from '../../src/crypto/engine.ts';

function ctx(recordId = 'doc-1'): SealContext {
  return { masterKey: new Uint8Array(32).fill(5), recordId };
}

function roundTrip(engine: CipherEngine, plaintext: Uint8Array): Uint8Array {
  const sealed = engine.seal(plaintext, ctx());
  return engine.open(sealed, ctx());
}

const ENGINES: [string, () => CipherEngine][] = [
  ['bpc-2b', createBpcEngine],
  ['aes-256-gcm', createAesGcmEngine],
];

for (const [name, factory] of ENGINES) {
  test(`${name}: round-trips empty input`, () => {
    const opened = roundTrip(factory(), new Uint8Array(0));
    assert.equal(opened.length, 0);
  });

  test(`${name}: round-trips a single byte`, () => {
    const opened = roundTrip(factory(), utf8Encode('x'));
    assert.equal(utf8Decode(opened), 'x');
  });

  test(`${name}: round-trips typical JSON document bytes`, () => {
    const plaintext = utf8Encode(
      JSON.stringify({ id: 'abc123', title: 'Hello, "world"!', content: 'Line one\nLine two\téè', n: 42 })
    );
    const opened = roundTrip(factory(), plaintext);
    assert.equal(utf8Decode(opened), utf8Decode(plaintext));
  });

  test(`${name}: round-trips all 256 byte values in one buffer`, () => {
    const plaintext = new Uint8Array(256);
    for (let i = 0; i < 256; i++) plaintext[i] = i;
    const opened = roundTrip(factory(), plaintext);
    assert.deepEqual(opened, plaintext);
  });
}

// This is the specific pathological case that broke the original spec's
// floating-point exponentiation: a single character repeated thousands of
// times, driving an unbounded exponent past safe float precision.
test('bpc-2b: round-trips a single character repeated 50,000 times', () => {
  const plaintext = new Uint8Array(50_000).fill('e'.charCodeAt(0));
  const opened = roundTrip(createBpcEngine(), plaintext);
  assert.deepEqual(opened, plaintext);
});

test('bpc-2b: round-trips English prose with a skewed letter distribution', () => {
  const prose = 'the quick brown fox jumps over the lazy dog. '.repeat(500);
  const plaintext = utf8Encode(prose);
  const opened = roundTrip(createBpcEngine(), plaintext);
  assert.equal(utf8Decode(opened), prose);
});

test('bpc-2b: different IVs produce different ciphertext for identical input', () => {
  const engine = createBpcEngine();
  const plaintext = utf8Encode('same plaintext, different IV each time');
  const a = engine.seal(plaintext, ctx());
  const b = engine.seal(plaintext, ctx());
  assert.notDeepEqual(a.iv, b.iv);
  assert.notDeepEqual(a.ciphertext, b.ciphertext);
});

test('bpc-2b: encode is pure given a fixed IV (spec 6.1 determinism test)', () => {
  const documentKey = deriveDocumentKey(ctx());
  const iv = new Uint8Array(16).fill(0x42);
  const plaintext = utf8Encode('deterministic given fixed randomness');

  const first = encodeBpc(plaintext, documentKey, iv);
  const second = encodeBpc(plaintext, documentKey, iv);
  assert.deepEqual(first.ciphertext, second.ciphertext, 'same key+plaintext+IV must yield identical ciphertext');

  const { plaintext: recovered } = decodeBpc(first.ciphertext, documentKey, iv);
  assert.deepEqual(recovered, plaintext, 'decode must invert encode exactly');
});

test('bpc-2b: rejects an odd-length ciphertext', () => {
  const engine = createBpcEngine();
  const sealed = engine.seal(utf8Encode('ab'), ctx());
  const truncated = { ...sealed, ciphertext: sealed.ciphertext.slice(0, sealed.ciphertext.length - 1) };
  assert.throws(() => engine.open(truncated, ctx()));
});

test('bpc-2b: withTrace produces one trace step per input byte with expected fields', () => {
  const engine = createBpcEngine();
  const plaintext = utf8Encode('trace me');
  const sealed = engine.seal(plaintext, { ...ctx(), withTrace: true });
  assert.ok(sealed.trace);
  assert.equal(sealed.trace!.steps.length, plaintext.length);
  for (let i = 0; i < plaintext.length; i++) {
    const step: CipherTraceStep = sealed.trace!.steps[i]!;
    assert.equal(step.position, i);
    assert.equal(step.byte, plaintext[i]);
    assert.ok(step.band >= 0);
    assert.ok(step.outLow >= 0 && step.outLow <= 255);
  }
});
