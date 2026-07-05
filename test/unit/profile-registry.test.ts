import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InvalidSerialError, ProfileRegistry, validateSerial } from '../../src/tenancy/profile-registry.ts';
import { generateUlid } from '../../src/core/ulid.ts';

async function withRegistry(fn: (rootDir: string, registry: ProfileRegistry) => Promise<void>): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), 'aegisdb-profiles-'));
  const registry = await ProfileRegistry.open(rootDir);
  try {
    await fn(rootDir, registry);
  } finally {
    await registry.close().catch(() => {}); // tolerate tests that already closed it themselves
    await rm(rootDir, { recursive: true, force: true });
  }
}

test('validateSerial accepts a real ULID and rejects traversal/garbage input', () => {
  const real = generateUlid();
  assert.equal(validateSerial(real), real);
  for (const bad of ['../../etc/passwd', '', 'not-a-ulid', `${real}/../evil`, `${real}\0`, 'a'.repeat(26)]) {
    assert.throws(() => validateSerial(bad), InvalidSerialError, `expected "${bad}" to be rejected`);
  }
});

test('createProfile mints a distinct serial and a usable master key', () =>
  withRegistry(async (_dir, registry) => {
    const a = await registry.createProfile('Alice', 'alice-passphrase');
    const b = await registry.createProfile('Bob', 'bob-passphrase');
    assert.notEqual(a.record.serial, b.record.serial);
    assert.notDeepEqual(a.masterKey, b.masterKey);
  }));

test('unlockProfile re-derives the same master key from the same passphrase', () =>
  withRegistry(async (_dir, registry) => {
    const created = await registry.createProfile('Alice', 'correct passphrase');
    const unlocked = await registry.unlockProfile(created.record.serial, 'correct passphrase');
    assert.deepEqual(unlocked, created.masterKey);
  }));

test('unlockProfile with the wrong passphrase silently derives a different key (no verification step, by design)', () =>
  withRegistry(async (_dir, registry) => {
    const created = await registry.createProfile('Alice', 'correct passphrase');
    const wrongKey = await registry.unlockProfile(created.record.serial, 'wrong passphrase');
    assert.notDeepEqual(wrongKey, created.masterKey);
  }));

test('unlockProfile throws for an unknown serial', () =>
  withRegistry(async (_dir, registry) => {
    await assert.rejects(() => registry.unlockProfile(generateUlid(), 'x'));
  }));

test('getProfile returns metadata without needing any key', () =>
  withRegistry(async (_dir, registry) => {
    const created = await registry.createProfile('Alice', 'x');
    const profile = await registry.getProfile(created.record.serial);
    assert.equal(profile!.displayName, 'Alice');
    assert.equal(profile!.serial, created.record.serial);
  }));

test('listProfiles reflects every created profile', () =>
  withRegistry(async (_dir, registry) => {
    const a = await registry.createProfile('Alice', 'x');
    const b = await registry.createProfile('Bob', 'y');
    assert.deepEqual(registry.listProfiles().sort(), [a.record.serial, b.record.serial].sort());
  }));

test('shardDir is namespaced per profile and rejects an invalid serial', () =>
  withRegistry(async (dir, registry) => {
    const created = await registry.createProfile('Alice', 'x');
    const shardDir = registry.shardDir(created.record.serial);
    assert.ok(shardDir.startsWith(dir));
    assert.ok(shardDir.includes(created.record.serial));
    assert.throws(() => registry.shardDir('../../etc'));
  }));

test('registry state survives close + reopen', () =>
  withRegistry(async (dir, registry) => {
    const created = await registry.createProfile('Alice', 'x');
    await registry.close();

    const reopened = await ProfileRegistry.open(dir);
    const profile = await reopened.getProfile(created.record.serial);
    assert.equal(profile!.displayName, 'Alice');
    await reopened.close();
  }));
