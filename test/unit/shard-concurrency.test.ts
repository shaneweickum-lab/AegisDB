import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Shard } from '../../src/storage/shard.ts';
import { utf8Decode, utf8Encode } from '../../src/core/bytes.ts';

async function withTempShard(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'aegisdb-shard-concurrency-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('concurrent puts to the same key are serialized: final value is one of the writes, never mangled', () =>
  withTempShard(async (dir) => {
    const shard = await Shard.open(dir);
    const writes = Array.from({ length: 50 }, (_, i) => shard.put('contested', utf8Encode(`value-${i}`)));
    await Promise.all(writes);

    const value = utf8Decode((await shard.get('contested'))!);
    assert.match(value, /^value-\d+$/, `expected a clean "value-N", got ${JSON.stringify(value)}`);
    await shard.close();
  }));

test('concurrent puts across many distinct keys all land correctly', () =>
  withTempShard(async (dir) => {
    const shard = await Shard.open(dir);
    const keys = Array.from({ length: 100 }, (_, i) => `key-${i}`);
    await Promise.all(keys.map((k) => shard.put(k, utf8Encode(k.toUpperCase()))));

    for (const k of keys) {
      assert.equal(utf8Decode((await shard.get(k))!), k.toUpperCase());
    }
    assert.equal(shard.listIds().length, keys.length);
    await shard.close();
  }));

test('reads interleaved with a burst of writes never throw or see a torn record', () =>
  withTempShard(async (dir) => {
    const shard = await Shard.open(dir);
    await shard.put('base', utf8Encode('initial'));

    const writers = Array.from({ length: 30 }, (_, i) => shard.put(`w-${i}`, utf8Encode('x'.repeat(200))));
    const readers = Array.from({ length: 60 }, async () => {
      // 'base' always exists from before this burst started; every read of
      // it must succeed and return a valid value, regardless of how many
      // unrelated writes are in flight concurrently.
      const value = await shard.get('base');
      assert.ok(value !== null);
      assert.equal(utf8Decode(value), 'initial');
    });

    await Promise.all([...writers, ...readers]);
    assert.equal(shard.listIds().length, 31); // base + 30 writers
    await shard.close();
  }));

test('reads during an in-flight compact() are served consistently, never throw', () =>
  withTempShard(async (dir) => {
    const shard = await Shard.open(dir);
    for (let i = 0; i < 40; i++) {
      await shard.put(`k-${i}`, utf8Encode(`v-${i}`));
    }
    for (let i = 0; i < 20; i++) {
      await shard.delete(`k-${i}`); // create reclaimable garbage for compact() to do real work on
    }

    const compaction = shard.compact();
    const concurrentReads = Array.from({ length: 20 }, async () => {
      const value = await shard.get('k-39');
      assert.ok(value !== null);
      assert.equal(utf8Decode(value), 'v-39');
    });

    const [report] = await Promise.all([compaction, ...concurrentReads]);
    assert.equal(report.liveKeys, 20);
    assert.deepEqual(
      shard.listIds().sort(),
      Array.from({ length: 20 }, (_, i) => `k-${i + 20}`).sort()
    );
    await shard.close();
  }));

test('a put issued while compact() is in flight is safely queued, not lost', () =>
  withTempShard(async (dir) => {
    const shard = await Shard.open(dir);
    await shard.put('existing', utf8Encode('before'));

    const compaction = shard.compact();
    const queuedPut = shard.put('during-compaction', utf8Encode('queued'));
    await Promise.all([compaction, queuedPut]);

    assert.equal(utf8Decode((await shard.get('during-compaction'))!), 'queued');
    assert.equal(utf8Decode((await shard.get('existing'))!), 'before');
    await shard.close();
  }));
