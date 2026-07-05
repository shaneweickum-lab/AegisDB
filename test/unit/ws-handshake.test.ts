import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAcceptValue, isWebSocketUpgradeRequest } from '../../src/server/ws/handshake.ts';

// RFC 6455 section 1.3's own worked example.
test('computeAcceptValue matches the RFC 6455 worked example exactly', () => {
  assert.equal(computeAcceptValue('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('isWebSocketUpgradeRequest recognizes a valid upgrade', () => {
  const req = { headers: { upgrade: 'websocket', connection: 'Upgrade' } } as any;
  assert.equal(isWebSocketUpgradeRequest(req), true);
});

test('isWebSocketUpgradeRequest rejects a plain HTTP request', () => {
  const req = { headers: {} } as any;
  assert.equal(isWebSocketUpgradeRequest(req), false);
});

test('isWebSocketUpgradeRequest is case-insensitive on header values', () => {
  const req = { headers: { upgrade: 'WebSocket', connection: 'keep-alive, Upgrade' } } as any;
  assert.equal(isWebSocketUpgradeRequest(req), true);
});
