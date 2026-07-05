import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentStore } from '../../src/storage/store.ts';
import { createAesGcmEngine } from '../../src/crypto/aes-gcm-engine.ts';
import { createBpcEngine } from '../../src/crypto/bpc/bpc-engine.ts';

async function withTempStore(
  fn: (dir: string, open: () => Promise<DocumentStore>) => Promise<void>,
  options?: Partial<Parameters<typeof DocumentStore.open>[1]>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'aegisdb-store-'));
  const masterKey = new Uint8Array(32).fill(9);
  const open = () => DocumentStore.open(dir, { masterKey, ...options });
  try {
    await fn(dir, open);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface Note {
  title: string;
  body: string;
}

test('insert then get round-trips through seal+storage', () =>
  withTempStore(async (_dir, open) => {
    const store = await open();
    const inserted = await store.insert<Note>('notes', { title: 'Hello', body: 'World' });
    assert.equal(inserted.version, 1);
    assert.ok(inserted.id.length === 26);

    const fetched = await store.get<Note>('notes', inserted.id);
    assert.deepEqual(fetched, inserted);
    await store.close();
  }));

test('get returns null for a missing document', () =>
  withTempStore(async (_dir, open) => {
    const store = await open();
    assert.equal(await store.get('notes', 'does-not-exist'), null);
    await store.close();
  }));

test('update increments version and preserves createdAt', () =>
  withTempStore(async (_dir, open) => {
    const store = await open();
    const inserted = await store.insert<Note>('notes', { title: 'v1', body: '...' });
    const updated = await store.update<Note>('notes', inserted.id, { title: 'v2', body: '...' });

    assert.equal(updated.version, 2);
    assert.equal(updated.createdAt, inserted.createdAt);
    assert.equal((await store.get<Note>('notes', inserted.id))!.data.title, 'v2');
    await store.close();
  }));

test('update on a missing document throws', () =>
  withTempStore(async (_dir, open) => {
    const store = await open();
    await assert.rejects(() => store.update('notes', 'nope', { title: 'x', body: 'y' }));
    await store.close();
  }));

test('delete removes a document from get and listIds', () =>
  withTempStore(async (_dir, open) => {
    const store = await open();
    const inserted = await store.insert<Note>('notes', { title: 'gone', body: 'soon' });
    assert.equal(await store.delete('notes', inserted.id), true);
    assert.equal(await store.get('notes', inserted.id), null);
    assert.deepEqual(store.listIds('notes'), []);
    await store.close();
  }));

test('collections are isolated by key prefix: same id in different collections does not collide', () =>
  withTempStore(async (_dir, open) => {
    const store = await open();
    // Force the same id across two collections by inserting into one,
    // then manually writing to the other collection's namespace via update
    // semantics isn't possible pre-insert, so instead verify two distinct
    // real inserts in different collections never see each other's data.
    const a = await store.insert('notes', { title: 'in notes', body: '' });
    const b = await store.insert('drafts', { title: 'in drafts', body: '' });
    assert.equal(await store.get('drafts', a.id), null);
    assert.equal(await store.get('notes', b.id), null);
    await store.close();
  }));

test('listIds is index-only (never throws even without decrypting) and query decrypts to filter', () =>
  withTempStore(async (_dir, open) => {
    const store = await open();
    await store.insert<Note>('notes', { title: 'keep', body: 'match' });
    await store.insert<Note>('notes', { title: 'skip', body: 'no match' });

    assert.equal(store.listIds('notes').length, 2);
    const matches = await store.query<Note>('notes', (doc) => doc.data.title === 'keep');
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.data.body, 'match');
    await store.close();
  }));

test('ULID ids sort in insertion order', () =>
  withTempStore(async (_dir, open) => {
    const store = await open();
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      ids.push((await store.insert('notes', { title: `n${i}`, body: '' })).id);
    }
    assert.deepEqual(ids, [...ids].sort());
    await store.close();
  }));

test('state and secondary "index" (key-prefix listing) survive close + reopen', () =>
  withTempStore(async (dir, open) => {
    const store = await open();
    const inserted = await store.insert<Note>('notes', { title: 'persisted', body: 'yes' });
    await store.close();

    const reopened = await DocumentStore.open(dir, { masterKey: new Uint8Array(32).fill(9) });
    assert.deepEqual(reopened.listIds('notes'), [inserted.id]);
    assert.deepEqual((await reopened.get<Note>('notes', inserted.id))!.data, { title: 'persisted', body: 'yes' });
    await reopened.close();
  }));

test('a collection opted into bpc-2b round-trips and is read back correctly by engine id, unaffected by the store default', () =>
  withTempStore(
    async (_dir, open) => {
      const store = await open();
      const viaDefault = await store.insert<Note>('notes', { title: 'aes path', body: '' });
      const viaBpc = await store.insert<Note>('demo', { title: 'bpc path', body: 'visualizer-facing' });

      assert.deepEqual((await store.get<Note>('notes', viaDefault.id))!.data, { title: 'aes path', body: '' });
      assert.deepEqual((await store.get<Note>('demo', viaBpc.id))!.data, { title: 'bpc path', body: 'visualizer-facing' });
      await store.close();
    },
    { engineOverrides: { demo: createBpcEngine() } }
  ));

test('a document sealed with a non-default engine is still readable after reopening (engine id travels with the record)', () =>
  withTempStore(
    async (dir, open) => {
      const store = await open();
      const inserted = await store.insert<Note>('demo', { title: 'bpc', body: 'x' });
      await store.close();

      // Reopen WITHOUT the engine override: a store only registers engines
      // it's told about (defaultEngine + engineOverrides), so one that was
      // never told about 'bpc-2b' can't decode a record sealed with it —
      // engineId travels with the record, but the store still needs that
      // engine registered somewhere to actually call .open() with it.
      const withoutOverride = await DocumentStore.open(dir, { masterKey: new Uint8Array(32).fill(9) });
      await assert.rejects(() => withoutOverride.get('demo', inserted.id));
      await withoutOverride.close();

      const withOverride = await DocumentStore.open(dir, {
        masterKey: new Uint8Array(32).fill(9),
        engineOverrides: { demo: createBpcEngine() },
      });
      assert.deepEqual((await withOverride.get<Note>('demo', inserted.id))!.data, { title: 'bpc', body: 'x' });
      await withOverride.close();
    },
    { engineOverrides: { demo: createBpcEngine() } }
  ));

test('an explicit defaultEngine option is honored', () =>
  withTempStore(
    async (_dir, open) => {
      const store = await open();
      const inserted = await store.insert<Note>('anything', { title: 't', body: 'b' });
      assert.deepEqual((await store.get<Note>('anything', inserted.id))!.data, { title: 't', body: 'b' });
      await store.close();
    },
    { defaultEngine: createAesGcmEngine() }
  ));
