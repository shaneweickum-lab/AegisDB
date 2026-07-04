import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppendLog, FILE_HEADER_LENGTH } from '../../src/storage/wal.ts';
import { utf8Encode } from '../../src/core/bytes.ts';

async function withTempFile(fn: (path: string, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'aegisdb-wal-'));
  try {
    await fn(join(dir, 'test.log'), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** This is the headline crash-safety test (spec 6.2): for a fully-written
 *  log, truncate it at EVERY possible byte offset (simulating a crash at
 *  every point mid-write) and reopen. Recovery must never throw, must
 *  never claim a record that wasn't fully and correctly written, and
 *  must recover every record that WAS fully written. */
test('scanning a log truncated at any byte offset always recovers exactly the largest valid prefix', () =>
  withTempFile(async (path) => {
    const original = await AppendLog.create(path, 0);
    const written: Array<{ offset: number; length: number }> = [];
    const entries = [
      ['alpha', 'first value'],
      ['beta', 'a somewhat longer second value to vary record sizes'],
      ['gamma', ''],
      ['delta', 'x'.repeat(500)],
      ['alpha', 'overwritten first value'],
    ] as const;
    for (const [key, value] of entries) {
      written.push(await original.append(key, utf8Encode(value)));
    }
    await original.close();

    const fullBytes = await readFile(path);
    const fullSize = fullBytes.length;

    for (let truncateAt = 0; truncateAt <= fullSize; truncateAt++) {
      const expectedValidRecordCount = written.filter((w) => w.offset + w.length <= truncateAt).length;
      const expectedValidLength =
        expectedValidRecordCount === 0 ? FILE_HEADER_LENGTH : written[expectedValidRecordCount - 1]!.offset + written[expectedValidRecordCount - 1]!.length;

      await writeFile(path, fullBytes.subarray(0, truncateAt));
      // A truncation shorter than the file header itself isn't a log this
      // abstraction can even open — that's a whole-file-loss scenario
      // handled one level up (Shard.open falls back to AppendLog.create).
      if (truncateAt < FILE_HEADER_LENGTH) continue;

      const log = await AppendLog.open(path);
      const scan = await log.scan();
      assert.equal(
        scan.validLength,
        Math.max(expectedValidLength, FILE_HEADER_LENGTH),
        `truncateAt=${truncateAt}: expected valid length ${expectedValidLength}, got ${scan.validLength}`
      );
      assert.equal(scan.records.length, expectedValidRecordCount, `truncateAt=${truncateAt}: record count mismatch`);
      await log.truncateTo(scan.validLength);
      await log.close();

      const onDiskSize = (await readFile(path)).length;
      assert.equal(onDiskSize, scan.validLength, `truncateAt=${truncateAt}: file size after truncateTo mismatch`);
    }
  }));

test('a single corrupted CRC byte truncates from that record onward, but never returns wrong data', () =>
  withTempFile(async (path) => {
    const log = await AppendLog.create(path, 0);
    const first = await log.append('keep-me', utf8Encode('intact'));
    const second = await log.append('corrupt-me', utf8Encode('will be lost'));
    await log.append('also-lost', utf8Encode('lost too, even though untouched'));
    await log.close();

    const bytes = await readFile(path);
    // Flip a byte inside the second record's value, well past its header.
    const corruptOffset = second.offset + 14 + 'corrupt-me'.length + 2;
    bytes[corruptOffset] = bytes[corruptOffset]! ^ 0xff;
    await writeFile(path, bytes);

    const reopened = await AppendLog.open(path);
    const scan = await reopened.scan();
    assert.equal(scan.records.length, 1, 'only the first, uncorrupted record should survive');
    assert.equal(scan.records[0]!.key, 'keep-me');
    assert.equal(scan.validLength, first.offset + first.length);
    await reopened.close();
  }));
