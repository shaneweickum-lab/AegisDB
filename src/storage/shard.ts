import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tryDecodeRecordAt } from './record.ts';
import { AppendLog } from './wal.ts';
import { buildKeydir, encodeIndexValue, type Keydir } from './keydir.ts';
import { reconcileInterruptedCompaction } from './recovery.ts';
import { compactShard, type CompactionReport } from './compaction.ts';

const DATA_FILE_NAME = 'shard.data';
const INDEX_FILE_NAME = 'shard.index';

/** One self-contained key/value store: a data log + an index log in a
 *  single directory. This is deliberately a single-file-pair design
 *  (matching the original spec's aegis.data/aegis.index, not a
 *  multi-segment log) — compaction rewrites the whole pair at once,
 *  which is simple to reason about and entirely adequate at this
 *  project's scale; segment merging would be unneeded complexity here.
 *  Phase 3 layers a generic document API on top; Phase 9 gives each
 *  tenant profile its own independent Shard directory. */
export class Shard {
  private dataLog: AppendLog;
  private indexLog: AppendLog;
  private keydir: Keydir;
  private readonly dir: string;
  private readonly dataPath: string;
  private readonly indexPath: string;
  private mutex: Promise<void> = Promise.resolve();

  private constructor(dir: string, dataPath: string, indexPath: string, dataLog: AppendLog, indexLog: AppendLog, keydir: Keydir) {
    this.dir = dir;
    this.dataPath = dataPath;
    this.indexPath = indexPath;
    this.dataLog = dataLog;
    this.indexLog = indexLog;
    this.keydir = keydir;
  }

  static async open(dir: string): Promise<Shard> {
    const dataPath = join(dir, DATA_FILE_NAME);
    const indexPath = join(dir, INDEX_FILE_NAME);

    await reconcileInterruptedCompaction(dir, dataPath, indexPath);

    const dataLog = existsSync(dataPath) ? await AppendLog.open(dataPath) : await AppendLog.create(dataPath, 0);
    const indexLog = existsSync(indexPath) ? await AppendLog.open(indexPath) : await AppendLog.create(indexPath, 0);

    // Each log independently truncates its own torn tail. Because every
    // write does data-append-and-fsync strictly before the corresponding
    // index-append-and-fsync, no index entry can ever reference a data
    // record that didn't survive the data log's own truncation — so no
    // additional cross-file consistency check is needed here.
    const dataScan = await dataLog.scan();
    await dataLog.truncateTo(dataScan.validLength);
    const indexScan = await indexLog.scan();
    await indexLog.truncateTo(indexScan.validLength);

    const keydir = buildKeydir(indexScan.records);
    return new Shard(dir, dataPath, indexPath, dataLog, indexLog, keydir);
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutex.then(fn, fn);
    this.mutex = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    await this.withLock(async () => {
      const written = await this.dataLog.append(key, value, false);
      await this.indexLog.append(key, encodeIndexValue(written.offset, written.length), false);
      this.keydir.set(key, { offset: written.offset, length: written.length, deleted: false });
    });
  }

  async get(key: string): Promise<Uint8Array | null> {
    const entry = this.keydir.get(key);
    if (!entry || entry.deleted) return null;
    const raw = await this.dataLog.readAt(entry.offset, entry.length);
    const decoded = tryDecodeRecordAt(raw, 0);
    if (!decoded) throw new Error(`shard: corrupt record for key "${key}" at offset ${entry.offset}`);
    return decoded.value;
  }

  async delete(key: string): Promise<boolean> {
    return this.withLock(async () => {
      const entry = this.keydir.get(key);
      if (!entry || entry.deleted) return false;
      const written = await this.dataLog.append(key, new Uint8Array(0), true);
      await this.indexLog.append(key, encodeIndexValue(written.offset, written.length), true);
      this.keydir.set(key, { offset: written.offset, length: written.length, deleted: true });
      return true;
    });
  }

  listIds(): string[] {
    return [...this.keydir.entries()].filter(([, entry]) => !entry.deleted).map(([key]) => key);
  }

  /** Spec 7.3: reads (get/listIds above) are served entirely from
   *  pre-compaction state until this fully completes and swaps `this`'s
   *  fields — writes queue behind the same mutex reads don't use, so
   *  compaction is "stop the writes, allow the reads," not a full lock. */
  async compact(): Promise<CompactionReport> {
    return this.withLock(async () => {
      const result = await compactShard(this.dir, this.dataPath, this.indexPath, this.dataLog, this.indexLog, this.keydir);
      this.dataLog = result.dataLog;
      this.indexLog = result.indexLog;
      this.keydir = result.keydir;
      return result.report;
    });
  }

  async close(): Promise<void> {
    await this.dataLog.close();
    await this.indexLog.close();
  }
}
