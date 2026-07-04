import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveStatic } from '../../src/server/static.ts';

async function withStaticServer(fn: (baseUrl: string, rootDir: string) => Promise<void>): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), 'aegisdb-static-'));
  await writeFile(join(rootDir, 'index.html'), '<h1>home</h1>');
  await writeFile(join(rootDir, 'app.js'), 'console.log(1);');

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const served = await serveStatic(rootDir, url.pathname, req, res);
    if (!served) res.writeHead(404).end('not found');
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  try {
    await fn(`http://127.0.0.1:${port}`, rootDir);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(rootDir, { recursive: true, force: true });
  }
}

test('serves a real file with the right content-type', () =>
  withStaticServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/app.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /javascript/);
    assert.equal(await res.text(), 'console.log(1);');
  }));

test('serves index.html for the root path', () =>
  withStaticServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '<h1>home</h1>');
  }));

test('404s for a missing file rather than throwing', () =>
  withStaticServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/nope.js`);
    assert.equal(res.status, 404);
  }));

test('rejects path traversal attempts', () =>
  withStaticServer(async (baseUrl, rootDir) => {
    // A file that genuinely exists just outside rootDir, to prove a
    // traversal attempt can't reach it.
    const secretPath = join(rootDir, '..', 'secret.txt');
    await writeFile(secretPath, 'do not serve me');
    try {
      const res = await fetch(`${baseUrl}/../secret.txt`);
      assert.notEqual(res.status, 200);
    } finally {
      await rm(secretPath, { force: true });
    }
  }));

test('returns 304 when If-None-Match matches the current ETag', () =>
  withStaticServer(async (baseUrl) => {
    const first = await fetch(`${baseUrl}/app.js`);
    const etag = first.headers.get('etag');
    assert.ok(etag);
    const second = await fetch(`${baseUrl}/app.js`, { headers: { 'if-none-match': etag! } });
    assert.equal(second.status, 304);
  }));
