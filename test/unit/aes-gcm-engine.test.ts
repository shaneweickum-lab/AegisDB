import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAesGcmEngine } from '../../src/crypto/aes-gcm-engine.ts';
import { utf8Decode, utf8Encode } from '../../src/core/bytes.ts';
import type { SealContext } from '../../src/crypto/engine.ts';

function ctx(): SealContext {
  return { masterKey: new Uint8Array(32).fill(5), recordId: 'doc-1' };
}

test('aes-256-gcm round-trips arbitrary plaintext', () => {
  const engine = createAesGcmEngine();
  const plaintext = utf8Encode('{"hello":"world","n":42}');
  const sealed = engine.seal(plaintext, ctx());
  const opened = engine.open(sealed, ctx());
  assert.equal(utf8Decode(opened), utf8Decode(plaintext));
});

test('aes-256-gcm produces different ciphertext for the same input on each seal (random IV)', () => {
  const engine = createAesGcmEngine();
  const plaintext = utf8Encode('same input every time');
  const a = engine.seal(plaintext, ctx());
  const b = engine.seal(plaintext, ctx());
  assert.notDeepEqual(a.ciphertext, b.ciphertext);
  assert.notDeepEqual(a.iv, b.iv);
});

test('aes-256-gcm rejects a flipped ciphertext byte (authenticity)', () => {
  const engine = createAesGcmEngine();
  const sealed = engine.seal(utf8Encode('tamper me'), ctx());
  const tampered = { ...sealed, ciphertext: new Uint8Array(sealed.ciphertext) };
  tampered.ciphertext[0]! ^= 0xff;
  assert.throws(() => engine.open(tampered, ctx()));
});

test('aes-256-gcm rejects a flipped auth tag byte', () => {
  const engine = createAesGcmEngine();
  const sealed = engine.seal(utf8Encode('tamper me too'), ctx());
  const tampered = { ...sealed, authTag: new Uint8Array(sealed.authTag!) };
  tampered.authTag[0]! ^= 0xff;
  assert.throws(() => engine.open(tampered, ctx()));
});

test('aes-256-gcm cannot decrypt with the wrong record id (wrong derived document key)', () => {
  const engine = createAesGcmEngine();
  const sealed = engine.seal(utf8Encode('scoped to doc-1'), ctx());
  assert.throws(() => engine.open(sealed, { masterKey: ctx().masterKey, recordId: 'doc-2' }));
});
