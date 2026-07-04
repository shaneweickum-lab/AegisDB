import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Shard } from '../../src/storage/shard.ts';
import { utf8Decode, utf8Encode } from '../../src/core/bytes.ts';

// Deterministic LCG so a failing seed is reproducible without relying on
// Math.random (and without pulling in a PRNG dependency).
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

type Op = { kind: 'put'; key: string; value: string } | { kind: 'delete'; key: string } | { kind: 'compact' };

function generateOps(rng: () => number, count: number, keyCount: number): Op[] {
  const ops: Op[] = [];
  for (let i = 0; i < count; i++) {
    const key = `key-${Math.floor(rng() * keyCount)}`;
    const roll = rng();
    if (roll < 0.6) {
      ops.push({ kind: 'put', key, value: `v${i}-${Math.floor(rng() * 1_000_000)}` });
    } else if (roll < 0.95) {
      ops.push({ kind: 'delete', key });
    } else {
      ops.push({ kind: 'compact' });
    }
  }
  return ops;
}

test('random put/delete/compact sequences match a reference Map', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aegisdb-shard-property-'));
  try {
    const shard = await Shard.open(dir);
    const reference = new Map<string, string>();
    const rng = makeRng(0xc0ffee);
    const ops = generateOps(rng, 400, 15);

    for (const op of ops) {
      if (op.kind === 'put') {
        await shard.put(op.key, utf8Encode(op.value));
        reference.set(op.key, op.value);
      } else if (op.kind === 'delete') {
        const existed = reference.has(op.key);
        const deleted = await shard.delete(op.key);
        assert.equal(deleted, existed, `delete("${op.key}") disagreement`);
        reference.delete(op.key);
      } else {
        await shard.compact();
      }
    }

    const expectedKeys = [...reference.keys()].sort();
    assert.deepEqual(shard.listIds().sort(), expectedKeys, 'live key set diverged from the reference Map');

    for (const key of expectedKeys) {
      const value = await shard.get(key);
      assert.equal(utf8Decode(value!), reference.get(key), `value mismatch for "${key}"`);
    }
    for (let i = 0; i < 15; i++) {
      const key = `key-${i}`;
      if (!reference.has(key)) {
        assert.equal(await shard.get(key), null, `expected "${key}" to be absent`);
      }
    }

    await shard.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reopening mid-sequence (simulating a clean restart) still matches the reference', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aegisdb-shard-property-restart-'));
  try {
    const reference = new Map<string, string>();
    const rng = makeRng(1234);
    const ops = generateOps(rng, 200, 10);

    let shard = await Shard.open(dir);
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]!;
      if (op.kind === 'put') {
        await shard.put(op.key, utf8Encode(op.value));
        reference.set(op.key, op.value);
      } else if (op.kind === 'delete') {
        await shard.delete(op.key);
        reference.delete(op.key);
      } else {
        await shard.compact();
      }

      if (i % 37 === 0) {
        await shard.close();
        shard = await Shard.open(dir); // simulate a clean process restart
      }
    }

    assert.deepEqual(shard.listIds().sort(), [...reference.keys()].sort());
    await shard.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
