import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProfileRegistry } from '../../src/tenancy/profile-registry.ts';
import { ShardManager } from '../../src/tenancy/shard-manager.ts';

async function withManager(
  fn: (rootDir: string, registry: ProfileRegistry, manager: ShardManager) => Promise<void>,
  maxOpenShards?: number
): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), 'aegisdb-shard-manager-'));
  const registry = await ProfileRegistry.open(rootDir);
  const manager = new ShardManager(registry, maxOpenShards);
  try {
    await fn(rootDir, registry, manager);
  } finally {
    await manager.closeAll();
    await registry.close().catch(() => {});
    await rm(rootDir, { recursive: true, force: true });
  }
}

test('opens a profile lazily: nothing is open until first access', () =>
  withManager(async (_dir, registry, manager) => {
    const { record, masterKey } = await registry.createProfile('Alice', 'x');
    assert.equal(manager.isOpen(record.serial), false);
    await manager.forProfile(record.serial, masterKey);
    assert.equal(manager.isOpen(record.serial), true);
  }));

test('repeated access to the same profile reuses the cached store', () =>
  withManager(async (_dir, registry, manager) => {
    const { record, masterKey } = await registry.createProfile('Alice', 'x');
    const first = await manager.forProfile(record.serial, masterKey);
    const second = await manager.forProfile(record.serial, masterKey);
    assert.equal(first, second);
    assert.equal(manager.openCount, 1);
  }));

test('cross-tenant isolation: two profiles never see each other\'s documents', () =>
  withManager(async (_dir, registry, manager) => {
    const alice = await registry.createProfile('Alice', 'alice-pass');
    const bob = await registry.createProfile('Bob', 'bob-pass');

    const aliceStore = await manager.forProfile(alice.record.serial, alice.masterKey);
    const bobStore = await manager.forProfile(bob.record.serial, bob.masterKey);

    const aliceDoc = await aliceStore.insert('notes', { text: 'alice secret' });
    const bobDoc = await bobStore.insert('notes', { text: 'bob secret' });

    assert.equal(await bobStore.get('notes', aliceDoc.id), null, "bob's store must not see alice's document");
    assert.equal(await aliceStore.get('notes', bobDoc.id), null, "alice's store must not see bob's document");
    assert.deepEqual(aliceStore.listIds('notes'), [aliceDoc.id]);
    assert.deepEqual(bobStore.listIds('notes'), [bobDoc.id]);
  }));

test("a forged master key for one profile cannot read another profile's data", () =>
  withManager(async (_dir, registry, manager) => {
    const alice = await registry.createProfile('Alice', 'alice-pass');
    const aliceStore = await manager.forProfile(alice.record.serial, alice.masterKey);
    await aliceStore.insert('notes', { text: 'alice secret' });

    // Simulate a completely different session trying to open ALICE'S
    // shard directory with a key that was never derived for it.
    const wrongKey = new Uint8Array(32).fill(0xee);
    const dir = registry.shardDir(alice.record.serial);
    const { DocumentStore } = await import('../../src/storage/store.ts');
    const wrongStore = await DocumentStore.open(dir, { masterKey: wrongKey });
    await assert.rejects(() => wrongStore.query('notes'), /unable to authenticate|bad decrypt|auth/i);
    await wrongStore.close();
  }));

test('LRU eviction closes the least-recently-used shard once over capacity', () =>
  withManager(
    async (_dir, registry, manager) => {
      const profiles = await Promise.all(
        Array.from({ length: 3 }, (_, i) => registry.createProfile(`user-${i}`, `pass-${i}`))
      );
      for (const p of profiles) await manager.forProfile(p.record.serial, p.masterKey);
      assert.equal(manager.openCount, 2, 'only the 2 most recently used should remain open');
      assert.equal(manager.isOpen(profiles[0]!.record.serial), false, 'the least-recently-used profile was evicted');
      assert.equal(manager.isOpen(profiles[1]!.record.serial), true);
      assert.equal(manager.isOpen(profiles[2]!.record.serial), true);
    },
    2
  ));

test('accessing an evicted profile again reopens it cleanly with its data intact', () =>
  withManager(
    async (_dir, registry, manager) => {
      const a = await registry.createProfile('a', 'pa');
      const b = await registry.createProfile('b', 'pb');
      const c = await registry.createProfile('c', 'pc');

      const aStore = await manager.forProfile(a.record.serial, a.masterKey);
      await aStore.insert('notes', { text: 'still here after eviction' });
      await manager.forProfile(b.record.serial, b.masterKey);
      await manager.forProfile(c.record.serial, c.masterKey); // evicts `a`
      assert.equal(manager.isOpen(a.record.serial), false);

      const reopenedAStore = await manager.forProfile(a.record.serial, a.masterKey);
      const docs = await reopenedAStore.query('notes');
      assert.equal(docs.length, 1);
      assert.equal((docs[0]!.data as { text: string }).text, 'still here after eviction');
    },
    2
  ));

test('evict() closes a specific profile on demand', () =>
  withManager(async (_dir, registry, manager) => {
    const { record, masterKey } = await registry.createProfile('Alice', 'x');
    await manager.forProfile(record.serial, masterKey);
    assert.equal(await manager.evict(record.serial), true);
    assert.equal(manager.isOpen(record.serial), false);
    assert.equal(await manager.evict(record.serial), false, 'evicting an already-closed profile is a safe no-op');
  }));

test('closeAll closes every open shard', () =>
  withManager(async (_dir, registry, manager) => {
    const profiles = await Promise.all([registry.createProfile('a', 'x'), registry.createProfile('b', 'y')]);
    for (const p of profiles) await manager.forProfile(p.record.serial, p.masterKey);
    assert.equal(manager.openCount, 2);
    await manager.closeAll();
    assert.equal(manager.openCount, 0);
  }));

test('a crash/corruption confined to one profile shard never affects another profile', () =>
  withManager(async (_dir, registry, manager) => {
    const alice = await registry.createProfile('Alice', 'x');
    const bob = await registry.createProfile('Bob', 'y');

    const aliceStore = await manager.forProfile(alice.record.serial, alice.masterKey);
    const bobStore = await manager.forProfile(bob.record.serial, bob.masterKey);
    await aliceStore.insert('notes', { text: 'alice' });
    const bobDoc = await bobStore.insert('notes', { text: 'bob' });
    await manager.closeAll();

    // Simulate a crash mid-compaction on ALICE's shard only, using the
    // same interrupted-compaction scenario proven safe in
    // test/fuzz/interrupted-compaction.test.ts — moving her live data
    // file aside as if a compaction died partway through.
    const aliceDir = registry.shardDir(alice.record.serial);
    await rename(join(aliceDir, 'shard.data'), join(aliceDir, 'shard.data.prev'));
    assert.ok(!existsSync(join(aliceDir, 'shard.data')));

    const bobDir = registry.shardDir(bob.record.serial);
    assert.ok(existsSync(join(bobDir, 'shard.data')), "bob's files must be completely untouched");

    // Bob's shard opens and reads normally, unaffected by Alice's crash.
    const reopenedBobStore = await manager.forProfile(bob.record.serial, bob.masterKey);
    const bobRecord = await reopenedBobStore.get<{ text: string }>('notes', bobDoc.id);
    assert.equal(bobRecord!.data.text, 'bob');
  }));
