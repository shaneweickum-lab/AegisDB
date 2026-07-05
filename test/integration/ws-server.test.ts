import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer } from '../../src/server/http-server.ts';
import { AppContext } from '../../src/server/app-context.ts';

async function withRunningServer(fn: (baseUrl: string, app: AppContext) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), 'aegisdb-ws-'));
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
    body: JSON.stringify({ passphrase: 'ws-test-passphrase' }),
  });
  const body = await res.json();
  return body.token;
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('websocket error')));
  });
}

function waitForMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.addEventListener('message', (event) => resolve(event.data as string), { once: true });
  });
}

function waitForClose(ws: WebSocket): Promise<{ code: number }> {
  return new Promise((resolve) => {
    ws.addEventListener('close', (event) => resolve({ code: event.code }), { once: true });
  });
}

test('rejects a WebSocket upgrade with no token', () =>
  withRunningServer(async (baseUrl) => {
    const wsUrl = baseUrl.replace('http', 'ws') + '/api/telemetry/state';
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => {
      ws.addEventListener('error', () => resolve());
      ws.addEventListener('open', () => resolve()); // shouldn't happen, but don't hang if it does
    });
    assert.notEqual(ws.readyState, WebSocket.OPEN);
  }));

test('rejects an upgrade at an unknown path', () =>
  withRunningServer(async (baseUrl) => {
    const token = await unlock(baseUrl);
    const wsUrl = `${baseUrl.replace('http', 'ws')}/api/not-a-real-endpoint?token=${token}`;
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => {
      ws.addEventListener('error', () => resolve());
      ws.addEventListener('open', () => resolve());
    });
    assert.notEqual(ws.readyState, WebSocket.OPEN);
  }));

test('a real WebSocket client completes the handshake and receives hub-published messages', () =>
  withRunningServer(async (baseUrl, app) => {
    const token = await unlock(baseUrl);
    const wsUrl = `${baseUrl.replace('http', 'ws')}/api/telemetry/state?token=${token}`;
    const ws = new WebSocket(wsUrl);
    await waitForOpen(ws);
    assert.equal(ws.readyState, WebSocket.OPEN);

    // Give the server a tick to register the subscription (the 'open'
    // event fires client-side right after the handshake completes, which
    // races the server's hub.subscribe call by a negligible amount).
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(app.hub.subscriberCount('telemetry'), 1);

    const messagePromise = waitForMessage(ws);
    app.hub.publish('telemetry', { position: 0, byte: 65, band: 0 });

    const raw = await messagePromise;
    const parsed = JSON.parse(raw);
    assert.equal(parsed.topic, 'telemetry');
    assert.deepEqual(parsed.data, { position: 0, byte: 65, band: 0 });

    ws.close();
  }));

test('client-initiated close completes a clean close handshake', () =>
  withRunningServer(async (baseUrl) => {
    const token = await unlock(baseUrl);
    const wsUrl = `${baseUrl.replace('http', 'ws')}/api/telemetry/state?token=${token}`;
    const ws = new WebSocket(wsUrl);
    await waitForOpen(ws);

    const closePromise = waitForClose(ws);
    ws.close(1000, 'done');
    const { code } = await closePromise;
    assert.equal(code, 1000);
  }));

test('multiple subscribers all receive the same broadcast', () =>
  withRunningServer(async (baseUrl, app) => {
    const token = await unlock(baseUrl);
    const wsUrl = `${baseUrl.replace('http', 'ws')}/api/telemetry/state?token=${token}`;

    const clients = [new WebSocket(wsUrl), new WebSocket(wsUrl), new WebSocket(wsUrl)];
    await Promise.all(clients.map(waitForOpen));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(app.hub.subscriberCount('telemetry'), 3);

    const messagePromises = clients.map(waitForMessage);
    app.hub.publish('telemetry', { hello: 'everyone' });
    const received = await Promise.all(messagePromises);
    for (const raw of received) {
      assert.deepEqual(JSON.parse(raw).data, { hello: 'everyone' });
    }

    for (const ws of clients) ws.close();
  }));
