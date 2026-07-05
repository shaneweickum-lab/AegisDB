import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer } from '../../src/server/http-server.ts';
import { AppContext } from '../../src/server/app-context.ts';
import { buildZip } from '../helpers/build-zip.ts';

async function withRunningServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), 'aegisdb-ingest-'));
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

async function unlock(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/unlock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passphrase: 'ingest-test' }),
  });
  return (await res.json()).token;
}

test('ingests a plain text file over HTTP', () =>
  withRunningServer(async (baseUrl) => {
    const token = await unlock(baseUrl);
    const res = await fetch(`${baseUrl}/api/ingest/file`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-file-name': 'notes.txt' },
      body: 'hello from a text file',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.extractionMethod, 'utf8-direct');
    assert.equal(body.extractedText, 'hello from a text file');
  }));

test('ingests a .docx file over HTTP', () =>
  withRunningServer(async (baseUrl) => {
    const token = await unlock(baseUrl);
    const xml = '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>uploaded docx</w:t></w:r></w:p></w:body></w:document>';
    const fileBytes = buildZip([{ name: 'word/document.xml', content: xml, compress: true }]);

    const res = await fetch(`${baseUrl}/api/ingest/file`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-file-name': 'report.docx' },
      body: Buffer.from(fileBytes),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.extractionMethod, 'docx-textract');
    assert.equal(body.extractedText, 'uploaded docx');
    assert.ok(body.warnings.length > 0);
  }));

test('requires the x-file-name header', () =>
  withRunningServer(async (baseUrl) => {
    const token = await unlock(baseUrl);
    const res = await fetch(`${baseUrl}/api/ingest/file`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: 'no filename header',
    });
    assert.equal(res.status, 400);
  }));

test('a malformed .docx upload gets a clean 400, not a 500', () =>
  withRunningServer(async (baseUrl) => {
    const token = await unlock(baseUrl);
    const res = await fetch(`${baseUrl}/api/ingest/file`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-file-name': 'broken.docx' },
      body: 'not actually a zip file',
    });
    assert.equal(res.status, 400);
  }));

test('?collection= persists the extracted text as a real document', () =>
  withRunningServer(async (baseUrl) => {
    const token = await unlock(baseUrl);
    const res = await fetch(`${baseUrl}/api/ingest/file?collection=uploads`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-file-name': 'notes.txt' },
      body: 'persist me',
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.persisted.data.text, 'persist me');
    assert.equal(body.persisted.data.source, 'notes.txt');

    const listRes = await fetch(`${baseUrl}/api/collections/uploads/documents`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const list = await listRes.json();
    assert.equal(list.length, 1);
  }));

test('ingest requires an unlocked session', () =>
  withRunningServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/ingest/file`, {
      method: 'POST',
      headers: { 'x-file-name': 'notes.txt' },
      body: 'hi',
    });
    assert.equal(res.status, 401);
  }));
