import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../../src/deploy/config.ts';
import { createHttpServer } from '../../src/server/http-server.ts';
import { AppContext } from '../../src/server/app-context.ts';
import { SessionManager } from '../../src/server/auth/session.ts';

// Exercises the exact wiring src/index.ts does (config -> sessions ->
// AppContext -> server), just with an ephemeral port and a temp data
// dir instead of reading real env / binding a fixed port — this is the
// "full integration test booting the server end-to-end" the plan calls
// for, over REST and WS together.
async function withConfiguredServer(
  envOverrides: Record<string, string>,
  fn: (baseUrl: string) => Promise<void>
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), 'aegisdb-bootstrap-'));
  const config = parseConfig({ ...envOverrides, AEGIS_DATA_DIR: dataDir, PORT: '0' });
  const sessions = new SessionManager(config.sessionTtlMs);
  const app = new AppContext(config.dataDir, sessions);
  const server = createHttpServer({ app });

  await new Promise<void>((resolve) => server.listen(config.port, config.bindHost, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await app.lockStore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('boots in local-tunnel mode (default) and serves REST + WS end-to-end', () =>
  withConfiguredServer({}, async (baseUrl) => {
    const unlockRes = await fetch(`${baseUrl}/api/auth/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: 'bootstrap-test' }),
    });
    assert.equal(unlockRes.status, 200);
    const { token } = await unlockRes.json();

    const createRes = await fetch(`${baseUrl}/api/collections/notes/documents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ data: { title: 'boot test' } }),
    });
    assert.equal(createRes.status, 201);

    const wsUrl = `${baseUrl.replace('http', 'ws')}/api/telemetry/state?token=${token}`;
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('ws failed to open')));
    });
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.close();
  }));

test('boots in vps mode and serves REST end-to-end', () =>
  withConfiguredServer({ AEGIS_MODE: 'vps' }, async (baseUrl) => {
    const unlockRes = await fetch(`${baseUrl}/api/auth/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: 'vps-boot-test' }),
    });
    assert.equal(unlockRes.status, 200);
  }));

test('invalid configuration is rejected before any server is created', () => {
  assert.throws(() => parseConfig({ AEGIS_MODE: 'not-a-real-mode' }));
});
