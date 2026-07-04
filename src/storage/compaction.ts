import { rename, rm } from 'node:fs/promises';
import { tryDecodeRecordAt } from './record.ts';
import { AppendLog } from './wal.ts';
import { encodeIndexValue, type Keydir } from './keydir.ts';
import { fsyncDir } from './recovery.ts';

export interface CompactionReport {
  liveKeys: number;
  bytesBefore: number;
  bytesAfter: number;
}

/** Spec 7: snapshot live entries, stream-copy their values into a fresh
 *  data+index pair at the next generation, then atomically promote via
 *  a rename dance that always leaves a rollback-able .prev pair until
 *  the promotion is fully confirmed (see recovery.ts). Ciphertext is
 *  copied byte-for-byte — compaction changes position, not content, so
 *  no key material is needed here (spec 7.2). */
export async function compactShard(
  dir: string,
  dataPath: string,
  indexPath: string,
  dataLog: AppendLog,
  indexLog: AppendLog,
  keydir: Keydir
): Promise<{ dataLog: AppendLog; indexLog: AppendLog; keydir: Keydir; report: CompactionReport }> {
  const newGeneration = dataLog.generation + 1;
  const dataTmpPath = `${dataPath}.compact.tmp`;
  const indexTmpPath = `${indexPath}.compact.tmp`;

  let bytesBefore = 0;
  for (const entry of keydir.values()) bytesBefore += entry.length;

  const liveEntries = [...keydir.entries()].filter(([, entry]) => !entry.deleted);
  const newDataLog = await AppendLog.create(dataTmpPath, newGeneration);
  const newIndexLog = await AppendLog.create(indexTmpPath, newGeneration);
  const newKeydir: Keydir = new Map();
  let bytesAfter = 0;

  for (const [key, entry] of liveEntries) {
    const raw = await dataLog.readAt(entry.offset, entry.length);
    const decoded = tryDecodeRecordAt(raw, 0);
    if (!decoded) throw new Error(`compact: corrupt live record for key "${key}" at offset ${entry.offset}`);

    const written = await newDataLog.append(key, decoded.value, false);
    await newIndexLog.append(key, encodeIndexValue(written.offset, written.length), false);
    newKeydir.set(key, { offset: written.offset, length: written.length, deleted: false });
    bytesAfter += written.length;
  }

  await newDataLog.close();
  await newIndexLog.close();

  // Move the current live pair aside, then promote the new generation.
  // Any crash from here forward is safely reconciled on next open by
  // recovery.ts, which always resolves to a matching-generation pair.
  await rename(dataPath, `${dataPath}.prev`);
  await rename(indexPath, `${indexPath}.prev`);
  await fsyncDir(dir);

  await rename(dataTmpPath, dataPath);
  await rename(indexTmpPath, indexPath);
  await fsyncDir(dir);

  const openedDataLog = await AppendLog.open(dataPath);
  const openedIndexLog = await AppendLog.open(indexPath);

  await dataLog.close();
  await indexLog.close();

  // Best-effort cleanup — a crash here just leaves harmless .prev files
  // for the next open's recovery pass to remove.
  await rm(`${dataPath}.prev`, { force: true });
  await rm(`${indexPath}.prev`, { force: true });
  await fsyncDir(dir);

  return {
    dataLog: openedDataLog,
    indexLog: openedIndexLog,
    keydir: newKeydir,
    report: { liveKeys: newKeydir.size, bytesBefore, bytesAfter },
  };
}
