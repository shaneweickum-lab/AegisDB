import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InvalidConfigError, parseConfig } from '../../src/deploy/config.ts';

test('defaults to local-tunnel mode with sensible defaults', () => {
  const config = parseConfig({});
  assert.equal(config.mode, 'local-tunnel');
  assert.equal(config.port, 8787);
  assert.equal(config.dataDir, './data');
  assert.equal(config.bindHost, '127.0.0.1');
  assert.deepEqual(config.tunnel, { provider: 'cloudflare' });
  assert.equal(config.publicHost, undefined);
});

test('vps mode binds all interfaces and has no tunnel config', () => {
  const config = parseConfig({ AEGIS_MODE: 'vps', AEGIS_PUBLIC_HOST: 'example.com' });
  assert.equal(config.mode, 'vps');
  assert.equal(config.bindHost, '0.0.0.0');
  assert.equal(config.tunnel, undefined);
  assert.equal(config.publicHost, 'example.com');
});

test('publicHost is ignored in local-tunnel mode (not a meaningful combination)', () => {
  const config = parseConfig({ AEGIS_MODE: 'local-tunnel', AEGIS_PUBLIC_HOST: 'example.com' });
  assert.equal(config.publicHost, undefined);
});

test('tunnel config is ignored in vps mode', () => {
  const config = parseConfig({ AEGIS_MODE: 'vps', AEGIS_TUNNEL_PROVIDER: 'ngrok' });
  assert.equal(config.tunnel, undefined);
});

test('rejects an invalid mode', () => {
  assert.throws(() => parseConfig({ AEGIS_MODE: 'production' }), InvalidConfigError);
});

test('rejects a non-numeric port', () => {
  assert.throws(() => parseConfig({ PORT: 'not-a-number' }), InvalidConfigError);
});

test('rejects an out-of-range port', () => {
  assert.throws(() => parseConfig({ PORT: '70000' }), InvalidConfigError);
  assert.throws(() => parseConfig({ PORT: '-1' }), InvalidConfigError);
});

test('accepts port 0 (Node convention: let the OS assign an ephemeral port)', () => {
  const config = parseConfig({ PORT: '0' });
  assert.equal(config.port, 0);
});

test('rejects an empty AEGIS_DATA_DIR', () => {
  assert.throws(() => parseConfig({ AEGIS_DATA_DIR: '   ' }), InvalidConfigError);
});

test('rejects an invalid tunnel provider', () => {
  assert.throws(() => parseConfig({ AEGIS_TUNNEL_PROVIDER: 'wireguard' }), InvalidConfigError);
});

test('rejects a non-positive session TTL', () => {
  assert.throws(() => parseConfig({ AEGIS_SESSION_TTL_MS: '0' }), InvalidConfigError);
  assert.throws(() => parseConfig({ AEGIS_SESSION_TTL_MS: 'nope' }), InvalidConfigError);
});

test('accepts a custom tunnel subdomain', () => {
  const config = parseConfig({ AEGIS_TUNNEL_PROVIDER: 'ngrok', AEGIS_TUNNEL_SUBDOMAIN: 'my-aegisdb' });
  assert.deepEqual(config.tunnel, { provider: 'ngrok', subdomain: 'my-aegisdb' });
});
