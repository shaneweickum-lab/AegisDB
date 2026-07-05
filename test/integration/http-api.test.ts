import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer } from '../../src/server/http-server.ts';
import { AppContext } from '../../src/server/app-context.ts';

async function withRunningServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), 'aegisdb-http-'));
  const app = new AppContext(dataDir);
  const server: Server = createHttpServer({ app });

  await new Promise<void>((resolve) => server.listen(0, resolve));
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

async function unlock(baseUrl: string, passphrase = 'correct horse battery staple'): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/unlock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passphrase }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  return body.token;
}

test('protected routes reject requests with no session token', () =>
  withRunningServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/collections/notes/documents`);
    assert.equal(res.status, 401);
  }));

test('protected routes reject a forged bearer token', () =>
  withRunningServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/collections/notes/documents`, {
      headers: { authorization: 'Bearer this-was-never-issued' },
    });
    assert.equal(res.status, 401);
  }));

test('full lifecycle: unlock -> create -> get -> update -> list -> delete -> lock', () =>
  withRunningServer(async (baseUrl) => {
    const token = await unlock(baseUrl);
    const authHeaders = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    const createRes = await fetch(`${baseUrl}/api/collections/notes/documents`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ data: { title: 'hello', body: 'world' } }),
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    assert.equal(created.version, 1);

    const getRes = await fetch(`${baseUrl}/api/collections/notes/documents/${created.id}`, {
      headers: authHeaders,
    });
    assert.equal(getRes.status, 200);
    assert.deepEqual((await getRes.json()).data, { title: 'hello', body: 'world' });

    const updateRes = await fetch(`${baseUrl}/api/collections/notes/documents/${created.id}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ data: { title: 'hello v2', body: 'world' } }),
    });
    assert.equal(updateRes.status, 200);
    assert.equal((await updateRes.json()).version, 2);

    const listRes = await fetch(`${baseUrl}/api/collections/notes/documents`, { headers: authHeaders });
    const list = await listRes.json();
    assert.equal(list.length, 1);
    assert.equal(list[0].data.title, 'hello v2');

    const deleteRes = await fetch(`${baseUrl}/api/collections/notes/documents/${created.id}`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    assert.deepEqual(await deleteRes.json(), { ok: true });

    const afterDeleteRes = await fetch(`${baseUrl}/api/collections/notes/documents/${created.id}`, {
      headers: authHeaders,
    });
    assert.equal(afterDeleteRes.status, 404);

    const lockRes = await fetch(`${baseUrl}/api/auth/lock`, { method: 'POST', headers: authHeaders });
    assert.equal(lockRes.status, 200);

    const afterLockRes = await fetch(`${baseUrl}/api/collections/notes/documents`, { headers: authHeaders });
    assert.equal(afterLockRes.status, 401, 'token must be invalid after lock');
  }));

test('creating a document without a data field is a 400, not a 500', () =>
  withRunningServer(async (baseUrl) => {
    const token = await unlock(baseUrl);
    const res = await fetch(`${baseUrl}/api/collections/notes/documents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  }));

test('malformed JSON body is a 400', () =>
  withRunningServer(async (baseUrl) => {
    const token = await unlock(baseUrl);
    const res = await fetch(`${baseUrl}/api/collections/notes/documents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{not valid json',
    });
    assert.equal(res.status, 400);
  }));

test('oversized body is rejected rather than exhausting memory', () =>
  withRunningServer(async (baseUrl) => {
    const token = await unlock(baseUrl);
    const hugeString = 'x'.repeat(2 * 1024 * 1024); // 2 MiB, over the 1 MiB default cap
    const res = await fetch(`${baseUrl}/api/collections/notes/documents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ data: hugeString }),
    });
    assert.equal(res.status, 413);
  }));

test('unknown route is a plain 404', () =>
  withRunningServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/nonexistent`);
    assert.equal(res.status, 404);
  }));

test('compaction is reachable over the API and reflects real state', () =>
  withRunningServer(async (baseUrl) => {
    const token = await unlock(baseUrl);
    const authHeaders = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    for (let i = 0; i < 5; i++) {
      await fetch(`${baseUrl}/api/collections/notes/documents`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ data: { n: i } }),
      });
    }
    const res = await fetch(`${baseUrl}/api/admin/compact`, { method: 'POST', headers: authHeaders });
    assert.equal(res.status, 200);
    const report = await res.json();
    assert.equal(report.liveKeys, 5);
  }));

// The frontend is deployed separately from this server (a static Vercel
// page pointed at whichever backend is actually running — see
// docs/DEPLOYMENT.md), so every one of these is a real cross-origin
// scenario, not a hypothetical one.
test('an OPTIONS preflight is answered with 204 and CORS headers, without touching auth', () =>
  withRunningServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/collections/notes/documents`, {
      method: 'OPTIONS',
      headers: { origin: 'https://example.vercel.app', 'access-control-request-method': 'POST' },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.match(res.headers.get('access-control-allow-headers') ?? '', /authorization/);
    assert.match(res.headers.get('access-control-allow-methods') ?? '', /POST/);
  }));

test('a real cross-origin request still succeeds and carries CORS headers on the actual response', () =>
  withRunningServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/auth/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://example.vercel.app' },
      body: JSON.stringify({ passphrase: 'cross-origin-test' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  }));

test('CORS headers are present even on error responses (401, 404)', () =>
  withRunningServer(async (baseUrl) => {
    const unauthorized = await fetch(`${baseUrl}/api/collections/notes/documents`);
    assert.equal(unauthorized.headers.get('access-control-allow-origin'), '*');

    const notFound = await fetch(`${baseUrl}/api/nonexistent`);
    assert.equal(notFound.headers.get('access-control-allow-origin'), '*');
  }));
