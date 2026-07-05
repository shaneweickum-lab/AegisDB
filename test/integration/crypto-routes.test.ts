import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer } from '../../src/server/http-server.ts';
import { AppContext } from '../../src/server/app-context.ts';

async function withRunningServer(fn: (baseUrl: string, app: AppContext) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), 'aegisdb-crypto-routes-'));
  const app = new AppContext(dataDir);
  const server: Server = createHttpServer({ app });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`, app);
  } finally {
    await app.lockStore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function unlock(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/unlock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passphrase: 'workbench-test' }),
  });
  return (await res.json()).token;
}

test('encode then decode round-trips through the REST workbench endpoints', () =>
  withRunningServer(async (baseUrl) => {
    const token = await unlock(baseUrl);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    const encodeRes = await fetch(`${baseUrl}/api/crypto/encode`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: 'the quick brown fox' }),
    });
    assert.equal(encodeRes.status, 200);
    const encoded = await encodeRes.json();
    assert.ok(encoded.ciphertext);
    assert.ok(encoded.iv);
    assert.equal(encoded.trace.steps.length, 'the quick brown fox'.length);

    const decodeRes = await fetch(`${baseUrl}/api/crypto/decode`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ciphertext: encoded.ciphertext, iv: encoded.iv }),
    });
    assert.equal(decodeRes.status, 200);
    const decoded = await decodeRes.json();
    assert.equal(decoded.text, 'the quick brown fox');
    assert.equal(decoded.trace.steps.length, 'the quick brown fox'.length);
  }));

test('encode requires text', () =>
  withRunningServer(async (baseUrl) => {
    const token = await unlock(baseUrl);
    const res = await fetch(`${baseUrl}/api/crypto/encode`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  }));

test('decode with a mismatched IV fails cleanly rather than crashing', () =>
  withRunningServer(async (baseUrl) => {
    const token = await unlock(baseUrl);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const encoded = await (
      await fetch(`${baseUrl}/api/crypto/encode`, { method: 'POST', headers, body: JSON.stringify({ text: 'hello' }) })
    ).json();

    const wrongIv = Buffer.alloc(16, 0x99).toString('hex');
    const res = await fetch(`${baseUrl}/api/crypto/decode`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ciphertext: encoded.ciphertext, iv: wrongIv }),
    });
    // Either it decodes to garbage (still 200, since BPC has no auth tag)
    // or it throws (400) — either way, the server must respond cleanly.
    assert.ok(res.status === 200 || res.status === 400);
  }));

test('crypto routes require an unlocked session', () =>
  withRunningServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/crypto/encode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    assert.equal(res.status, 401);
  }));

test('trace steps are published to the telemetry hub as encode runs', () =>
  withRunningServer(async (baseUrl, app) => {
    const token = await unlock(baseUrl);
    const wsUrl = `${baseUrl.replace('http', 'ws')}/api/telemetry/state?token=${token}`;
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('ws error')));
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(app.hub.subscriberCount('telemetry'), 1);

    const received: unknown[] = [];
    ws.addEventListener('message', (event) => received.push(JSON.parse(event.data as string)));

    await fetch(`${baseUrl}/api/crypto/encode`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'abc' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(received.length, 3);
    ws.close();
  }));
