import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAesGcmEngine } from '../src/crypto/aes-gcm-engine.ts';
import { createBpcEngine } from '../src/crypto/bpc/bpc-engine.ts';
import { utf8Encode } from '../src/core/bytes.ts';
import { Shard } from '../src/storage/shard.ts';
import { DocumentStore } from '../src/storage/store.ts';
import { ingestFile } from '../src/ingest/pipeline.ts';
import { createHttpServer } from '../src/server/http-server.ts';
import { AppContext } from '../src/server/app-context.ts';
import type { CipherEngine, SealContext } from '../src/crypto/engine.ts';

function randomishText(sizeBytes: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz ,.\n';
  let out = '';
  for (let i = 0; i < sizeBytes; i++) out += alphabet[i % alphabet.length];
  return out;
}

function formatMBps(bytes: number, ms: number): string {
  return (bytes / 1024 / 1024 / (ms / 1000)).toFixed(2);
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'aegisdb-bench-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function benchSealThroughput(engine: CipherEngine, label: string, sizeBytes: number, iterations: number): void {
  const ctx: SealContext = { masterKey: new Uint8Array(32).fill(3), recordId: 'bench' };
  const plaintext = utf8Encode(randomishText(sizeBytes));

  const start = performance.now();
  for (let i = 0; i < iterations; i++) engine.seal(plaintext, ctx);
  const elapsedMs = performance.now() - start;

  const totalBytes = sizeBytes * iterations;
  console.log(
    `  ${label.padEnd(12)} ${String(sizeBytes).padStart(7)}B x ${String(iterations).padStart(4)} ` +
      `-> ${elapsedMs.toFixed(1).padStart(8)}ms  (${formatMBps(totalBytes, elapsedMs)} MB/s, ${(iterations / (elapsedMs / 1000)).toFixed(0)} ops/s)`
  );
}

async function benchDocumentStoreThroughput(): Promise<void> {
  await withTempDir(async (dir) => {
    const masterKey = new Uint8Array(32).fill(7);
    const store = await DocumentStore.open(dir, { masterKey });
    const count = 500;

    const insertStart = performance.now();
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const record = await store.insert('bench', { n: i, text: randomishText(500) });
      ids.push(record.id);
    }
    const insertMs = performance.now() - insertStart;
    console.log(`  insert       ${count} docs -> ${insertMs.toFixed(1)}ms  (${(count / (insertMs / 1000)).toFixed(0)} docs/s)`);

    const readStart = performance.now();
    for (const id of ids) await store.get('bench', id);
    const readMs = performance.now() - readStart;
    console.log(`  get (by id)  ${count} docs -> ${readMs.toFixed(1)}ms  (${(count / (readMs / 1000)).toFixed(0)} docs/s)`);

    await store.close();
  });
}

async function benchCompaction(): Promise<void> {
  for (const totalWrites of [500, 2000]) {
    await withTempDir(async (dir) => {
      const shard = await Shard.open(dir);
      const liveKeys = Math.max(1, Math.floor(totalWrites / 10));
      for (let i = 0; i < totalWrites; i++) {
        await shard.put(`key-${i % liveKeys}`, utf8Encode(randomishText(300)));
      }
      const start = performance.now();
      const report = await shard.compact();
      const elapsedMs = performance.now() - start;
      console.log(
        `  ${String(totalWrites).padStart(5)} writes (${liveKeys} live) -> ${elapsedMs.toFixed(1)}ms, reclaimed ${report.bytesBefore - report.bytesAfter} bytes`
      );
      await shard.close();
    });
  }
}

async function benchDocxIngestion(): Promise<void> {
  const { deflateRawSync } = await import('node:zlib');
  const paragraphs = Array.from({ length: 2000 }, (_, i) => `<w:p><w:r><w:t>Paragraph number ${i} with some text.</w:t></w:r></w:p>`).join('');
  const xml = `<?xml version="1.0"?><w:document><w:body>${paragraphs}</w:body></w:document>`;
  const xmlBytes = Buffer.from(xml, 'utf8');
  const compressed = deflateRawSync(xmlBytes);

  function u16(n: number) {
    return [n & 0xff, (n >>> 8) & 0xff];
  }
  function u32(n: number) {
    return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
  }
  const nameBytes = [...Buffer.from('word/document.xml', 'utf8')];
  const local = [
    ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(8), ...u16(0), ...u16(0), ...u32(0),
    ...u32(compressed.length), ...u32(xmlBytes.length), ...u16(nameBytes.length), ...u16(0),
    ...nameBytes, ...compressed,
  ];
  const central = [
    ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(8), ...u16(0), ...u16(0), ...u32(0),
    ...u32(compressed.length), ...u32(xmlBytes.length), ...u16(nameBytes.length), ...u16(0), ...u16(0),
    ...u16(0), ...u16(0), ...u32(0), ...u32(0), ...nameBytes,
  ];
  const eocd = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(1), ...u16(1), ...u32(central.length), ...u32(local.length), ...u16(0)];
  const fileBytes = Uint8Array.from([...local, ...central, ...eocd]);

  const start = performance.now();
  const result = ingestFile('bench.docx', fileBytes);
  const elapsedMs = performance.now() - start;
  console.log(
    `  ${(fileBytes.length / 1024).toFixed(0)}KB .docx (${xmlBytes.length} bytes of XML) -> ${elapsedMs.toFixed(2)}ms, ` +
      `extracted ${result.extractedText.length} chars`
  );
}

async function benchWsThroughput(): Promise<void> {
  await withTempDir(async (dir) => {
    const app = new AppContext(dir);
    const server = createHttpServer({ app });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const unlockRes = await fetch(`http://127.0.0.1:${port}/api/auth/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: 'bench' }),
    });
    const { token } = await unlockRes.json();

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/telemetry/state?token=${token}`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('ws open failed')));
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const messageCount = 5000;
    let received = 0;
    const donePromise = new Promise<void>((resolve) => {
      ws.addEventListener('message', () => {
        received++;
        if (received >= messageCount) resolve();
      });
    });

    const start = performance.now();
    for (let i = 0; i < messageCount; i++) app.hub.publish('telemetry', { i });
    await donePromise;
    const elapsedMs = performance.now() - start;
    console.log(`  ${messageCount} messages -> ${elapsedMs.toFixed(1)}ms  (${(messageCount / (elapsedMs / 1000)).toFixed(0)} msgs/s)`);

    ws.close();
    await app.lockStore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
}

async function main(): Promise<void> {
  console.log('AegisDB benchmarks\n');

  console.log('Sealed-write throughput (AES-256-GCM vs BPC):');
  for (const sizeBytes of [1024, 10 * 1024, 100 * 1024]) {
    const iterations = sizeBytes >= 100 * 1024 ? 20 : 200;
    benchSealThroughput(createAesGcmEngine(), 'aes-256-gcm', sizeBytes, iterations);
    benchSealThroughput(createBpcEngine(), 'bpc-2b', sizeBytes, iterations);
  }

  console.log('\nDocumentStore insert/get throughput:');
  await benchDocumentStoreThroughput();

  console.log('\nCompaction time vs. live-set size:');
  await benchCompaction();

  console.log('\nWebSocket telemetry throughput:');
  await benchWsThroughput();

  console.log('\n.docx ingestion latency:');
  await benchDocxIngestion();

  console.log('\ndone.');
}

await main();
