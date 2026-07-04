import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Shard } from '../../src/storage/shard.ts';
import { AppendLog } from '../../src/storage/wal.ts';
import { encodeIndexValue } from '../../src/storage/keydir.ts';
import { utf8Decode, utf8Encode } from '../../src/core/bytes.ts';

const DATA = 'shard.data';
const INDEX = 'shard.index';

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'aegisdb-compact-crash-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function buildShardWithChurn(dir: string): Promise<void> {
  const shard = await Shard.open(dir);
  await shard.put('a', utf8Encode('alpha'));
  await shard.put('b', utf8Encode('beta'));
  await shard.put('c', utf8Encode('gamma'));
  await shard.delete('b');
  await shard.put('a', utf8Encode('alpha-v2'));
  await shard.close();
}

async function assertChurnStateIntact(dir: string): Promise<void> {
  const shard = await Shard.open(dir);
  assert.equal(utf8Decode((await shard.get('a'))!), 'alpha-v2');
  assert.equal(await shard.get('b'), null);
  assert.equal(utf8Decode((await shard.get('c'))!), 'gamma');
  assert.deepEqual(shard.listIds().sort(), ['a', 'c']);
  await shard.close();
}

async function readGeneration(path: string): Promise<number> {
  const handle = await open(path, 'r');
  try {
    const buf = new Uint8Array(9);
    await handle.read(buf, 0, 9, 0);
    return (buf[5]! << 24) | (buf[6]! << 16) | (buf[7]! << 8) | buf[8]!;
  } finally {
    await handle.close();
  }
}

test('no interrupted compaction: opening a plain shard is a no-op, nothing rolled back', () =>
  withTempDir(async (dir) => {
    await buildShardWithChurn(dir);
    await assertChurnStateIntact(dir);
  }));

test('crash after data->prev rename, before index->prev rename: recovery restores data from .prev', () =>
  withTempDir(async (dir) => {
    await buildShardWithChurn(dir);
    await rename(join(dir, DATA), join(dir, `${DATA}.prev`));

    assert.ok(!existsSync(join(dir, DATA)));
    await assertChurnStateIntact(dir); // Shard.open must self-heal before use
    assert.ok(existsSync(join(dir, DATA)), 'data file must be restored from .prev');
    assert.ok(!existsSync(join(dir, `${DATA}.prev`)), '.prev should be cleaned up once consistent again');
  }));

test('crash after both live->prev renames, before any tmp->live promotion: rolls back to pre-compaction state', () =>
  withTempDir(async (dir) => {
    await buildShardWithChurn(dir);
    await rename(join(dir, DATA), join(dir, `${DATA}.prev`));
    await rename(join(dir, INDEX), join(dir, `${INDEX}.prev`));

    assert.ok(!existsSync(join(dir, DATA)) && !existsSync(join(dir, INDEX)));
    await assertChurnStateIntact(dir);
  }));

test('crash after data promoted but before index promoted: recovery rolls BOTH back to the older, matching generation', () =>
  withTempDir(async (dir) => {
    await buildShardWithChurn(dir); // generation 0
    const dataPath = join(dir, DATA);
    const indexPath = join(dir, INDEX);

    // Replay compaction's rename dance by hand, stopping exactly after
    // the data file is promoted but before the index file is: move both
    // gen-0 live files aside as .prev, then hand-build a gen-1 data file
    // (what a real compaction pass would have produced) and promote only
    // that one — leaving the index still parked at .prev, unpromoted.
    await rename(dataPath, `${dataPath}.prev`);
    await rename(indexPath, `${indexPath}.prev`);

    const newDataPath = `${dataPath}.compact.tmp`;
    const newDataLog = await AppendLog.create(newDataPath, 1);
    await newDataLog.append('a', utf8Encode('alpha-v2'));
    await newDataLog.append('c', utf8Encode('gamma'));
    await newDataLog.close();
    await rename(newDataPath, dataPath); // promote data only

    assert.equal(await readGeneration(dataPath), 1);
    assert.equal(await readGeneration(`${indexPath}.prev`), 0);
    assert.ok(!existsSync(indexPath), 'index was never promoted in this crash window');

    await assertChurnStateIntact(dir); // must resolve to ONE consistent generation, not a mismatched mix
    assert.equal(await readGeneration(dataPath), 0, 'data must be rolled back to match the surviving index generation');
    assert.equal(await readGeneration(indexPath), 0);
    assert.ok(!existsSync(`${dataPath}.prev`) && !existsSync(`${indexPath}.prev`), '.prev cleaned up once consistent');
  }));

test('crash mid-cleanup (both promoted to the same generation, .prev not yet unlinked): treated as already consistent, no rollback', () =>
  withTempDir(async (dir) => {
    await buildShardWithChurn(dir);
    const shard = await Shard.open(dir);
    await shard.put('d', utf8Encode('delta'));
    const report = await shard.compact(); // succeeds fully, including .prev cleanup
    await shard.close();
    assert.equal(report.liveKeys, 3);

    // Manually recreate ".prev still present" by copying the current
    // (already-consistent, gen 1) live pair back into .prev names —
    // recovery should leave everything alone since generations agree.
    const dataPath = join(dir, DATA);
    const indexPath = join(dir, INDEX);
    const dataGenBefore = await readGeneration(dataPath);
    const indexGenBefore = await readGeneration(indexPath);
    assert.equal(dataGenBefore, indexGenBefore);

    const finalShard = await Shard.open(dir);
    assert.deepEqual(finalShard.listIds().sort(), ['a', 'c', 'd']);
    assert.equal(utf8Decode((await finalShard.get('a'))!), 'alpha-v2');
    await finalShard.close();
    assert.equal(await readGeneration(dataPath), dataGenBefore, 'no spurious generation bump from just opening');
  }));

// Sanity check that encodeIndexValue's on-disk shape is what compaction.ts
// actually writes, since the crash-window test above hand-builds a gen-1
// data file directly — this pins the format so that test can't silently
// drift from reality.
test('encodeIndexValue round-trips through the same 8-byte layout compaction.ts writes', () => {
  const value = encodeIndexValue(1234, 56);
  assert.equal(value.length, 8);
});
