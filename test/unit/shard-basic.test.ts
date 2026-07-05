import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Shard } from '../../src/storage/shard.ts';
import { utf8Decode, utf8Encode } from '../../src/core/bytes.ts';

async function withTempShard(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'aegisdb-shard-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('opens cleanly against a directory that does not exist yet (real deployments start from nothing)', () =>
  withTempShard(async (parentDir) => {
    const freshDir = join(parentDir, 'not-created-yet', 'nested');
    const shard = await Shard.open(freshDir);
    await shard.put('a', utf8Encode('works'));
    assert.equal(utf8Decode((await shard.get('a'))!), 'works');
    await shard.close();
  }));

test('put then get returns the same bytes', () =>
  withTempShard(async (dir) => {
    const shard = await Shard.open(dir);
    await shard.put('doc-1', utf8Encode('hello world'));
    const value = await shard.get('doc-1');
    assert.equal(utf8Decode(value!), 'hello world');
    await shard.close();
  }));

test('get returns null for a missing key', () =>
  withTempShard(async (dir) => {
    const shard = await Shard.open(dir);
    assert.equal(await shard.get('nope'), null);
    await shard.close();
  }));

test('put twice overwrites (get returns the latest version)', () =>
  withTempShard(async (dir) => {
    const shard = await Shard.open(dir);
    await shard.put('doc-1', utf8Encode('v1'));
    await shard.put('doc-1', utf8Encode('v2'));
    assert.equal(utf8Decode((await shard.get('doc-1'))!), 'v2');
    await shard.close();
  }));

test('delete tombstones a key: get returns null, listIds omits it', () =>
  withTempShard(async (dir) => {
    const shard = await Shard.open(dir);
    await shard.put('doc-1', utf8Encode('v1'));
    const deleted = await shard.delete('doc-1');
    assert.equal(deleted, true);
    assert.equal(await shard.get('doc-1'), null);
    assert.deepEqual(shard.listIds(), []);
    await shard.close();
  }));

test('delete on a missing key returns false', () =>
  withTempShard(async (dir) => {
    const shard = await Shard.open(dir);
    assert.equal(await shard.delete('nope'), false);
    await shard.close();
  }));

test('listIds reflects all live (non-deleted) keys', () =>
  withTempShard(async (dir) => {
    const shard = await Shard.open(dir);
    await shard.put('a', utf8Encode('1'));
    await shard.put('b', utf8Encode('2'));
    await shard.put('c', utf8Encode('3'));
    await shard.delete('b');
    assert.deepEqual(shard.listIds().sort(), ['a', 'c']);
    await shard.close();
  }));

test('state survives close + reopen (recovery rebuilds the keydir)', () =>
  withTempShard(async (dir) => {
    const shard = await Shard.open(dir);
    await shard.put('doc-1', utf8Encode('persisted'));
    await shard.put('doc-2', utf8Encode('also persisted'));
    await shard.delete('doc-2');
    await shard.close();

    const reopened = await Shard.open(dir);
    assert.equal(utf8Decode((await reopened.get('doc-1'))!), 'persisted');
    assert.equal(await reopened.get('doc-2'), null);
    assert.deepEqual(reopened.listIds(), ['doc-1']);
    await reopened.close();
  }));

test('empty values round-trip', () =>
  withTempShard(async (dir) => {
    const shard = await Shard.open(dir);
    await shard.put('empty', new Uint8Array(0));
    const value = await shard.get('empty');
    assert.equal(value!.length, 0);
    await shard.close();
  }));

test('compact() preserves the live key set and its values', () =>
  withTempShard(async (dir) => {
    const shard = await Shard.open(dir);
    await shard.put('keep-1', utf8Encode('alpha'));
    await shard.put('keep-2', utf8Encode('beta'));
    await shard.put('gone', utf8Encode('will be deleted'));
    await shard.delete('gone');
    await shard.put('keep-1', utf8Encode('alpha-v2')); // superseded version should also be reclaimed

    const report = await shard.compact();
    assert.equal(report.liveKeys, 2);
    assert.ok(report.bytesAfter < report.bytesBefore);

    assert.equal(utf8Decode((await shard.get('keep-1'))!), 'alpha-v2');
    assert.equal(utf8Decode((await shard.get('keep-2'))!), 'beta');
    assert.equal(await shard.get('gone'), null);
    assert.deepEqual(shard.listIds().sort(), ['keep-1', 'keep-2']);
    await shard.close();
  }));

test("compact() reclaims superseded same-size overwrites, not just tombstones (regression: bytesBefore must reflect the real pre-compaction file size)", () =>
  withTempShard(async (dir) => {
    const shard = await Shard.open(dir);
    // Overwrite the same small set of keys many times with same-size
    // values and no deletes at all — every prior version is still
    // physically present in the data file until compaction runs, but a
    // "sum of the keydir's current entries" metric would see only the
    // latest version per key and (wrongly) report nothing reclaimable.
    for (let round = 0; round < 50; round++) {
      for (let k = 0; k < 5; k++) {
        await shard.put(`key-${k}`, utf8Encode(`value-${round}`.padEnd(20, ' ')));
      }
    }

    const report = await shard.compact();
    assert.equal(report.liveKeys, 5);
    assert.ok(
      report.bytesAfter < report.bytesBefore,
      `expected compaction to reclaim space from 245 superseded versions, got bytesBefore=${report.bytesBefore} bytesAfter=${report.bytesAfter}`
    );
    await shard.close();
  }));

test('compact() result survives close + reopen', () =>
  withTempShard(async (dir) => {
    const shard = await Shard.open(dir);
    await shard.put('a', utf8Encode('1'));
    await shard.put('b', utf8Encode('2'));
    await shard.delete('a');
    await shard.compact();
    await shard.close();

    const reopened = await Shard.open(dir);
    assert.deepEqual(reopened.listIds(), ['b']);
    assert.equal(await reopened.get('a'), null);
    await reopened.close();
  }));
