import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractBearerToken, SessionManager } from '../../src/server/auth/session.ts';

test('unlock issues a token that resolves to a session with the derived key', () => {
  const sessions = new SessionManager();
  const { token, derived } = sessions.unlock('correct horse battery staple');
  const session = sessions.resolve(token);
  assert.ok(session);
  assert.deepEqual(session!.masterKey, derived.key);
});

test('the same passphrase + salt re-derives the same master key', () => {
  const sessions = new SessionManager();
  const first = sessions.unlock('passphrase', undefined);
  const second = sessions.unlock('passphrase', first.derived.salt);
  assert.deepEqual(first.derived.key, second.derived.key);
});

test('resolve returns null for an unknown token (forged token rejection)', () => {
  const sessions = new SessionManager();
  assert.equal(sessions.resolve('forged-token-that-was-never-issued'), null);
});

test('resolve returns null once a session has expired', () => {
  const sessions = new SessionManager(-1); // already-expired TTL
  const { token } = sessions.unlock('x');
  assert.equal(sessions.resolve(token), null);
});

test('revoke invalidates the token and zeroes the master key', () => {
  const sessions = new SessionManager();
  const { token, derived } = sessions.unlock('x');
  assert.equal(sessions.revoke(token), true);
  assert.equal(sessions.resolve(token), null);
  assert.ok(derived.key.every((byte) => byte === 0), 'master key bytes should be zeroed on revoke');
});

test('revoke on an unknown token is a safe no-op', () => {
  const sessions = new SessionManager();
  assert.equal(sessions.revoke('never-issued'), false);
});

test('extractBearerToken parses the Authorization header', () => {
  assert.equal(extractBearerToken('Bearer abc123'), 'abc123');
  assert.equal(extractBearerToken(undefined), null);
  assert.equal(extractBearerToken('Basic abc123'), null);
});
