import { existsSync } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';

const FILE_HEADER_LENGTH = 9; // matches wal.ts's FILE_HEADER_LENGTH

async function peekGeneration(path: string): Promise<number> {
  const handle = await open(path, 'r');
  try {
    const buf = new Uint8Array(FILE_HEADER_LENGTH);
    await handle.read(buf, 0, FILE_HEADER_LENGTH, 0);
    return (buf[5]! << 24) | (buf[6]! << 16) | (buf[7]! << 8) | buf[8]!;
  } finally {
    await handle.close();
  }
}

export async function fsyncDir(dir: string): Promise<void> {
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function restoreIfMissing(livePath: string, prevPath: string): Promise<void> {
  if (!existsSync(livePath) && existsSync(prevPath)) {
    await rename(prevPath, livePath);
  }
}

/** Reconciles any compaction that was interrupted mid-flight, for every
 *  possible crash window in the rename dance compaction.ts performs:
 *  between the two live->prev renames, between prev and tmp->live
 *  promotion, between the two tmp->live promotions, or during cleanup.
 *  Always resolves towards a matching-generation pair — compaction is
 *  idempotent and can simply be re-run later, so "prefer the older but
 *  definitely-consistent generation" is always a safe choice. Called on
 *  every shard open, before any recovery scan of the live files. */
export async function reconcileInterruptedCompaction(
  dir: string,
  dataPath: string,
  indexPath: string
): Promise<void> {
  const dataPrev = `${dataPath}.prev`;
  const indexPrev = `${indexPath}.prev`;
  const dataTmp = `${dataPath}.compact.tmp`;
  const indexTmp = `${indexPath}.compact.tmp`;

  await restoreIfMissing(dataPath, dataPrev);
  await restoreIfMissing(indexPath, indexPrev);

  if (existsSync(dataPath) && existsSync(indexPath)) {
    const dataGen = await peekGeneration(dataPath);
    const indexGen = await peekGeneration(indexPath);
    if (dataGen !== indexGen) {
      const targetGen = Math.min(dataGen, indexGen);
      if (dataGen !== targetGen && existsSync(dataPrev)) {
        await rename(dataPrev, dataPath);
      }
      if (indexGen !== targetGen && existsSync(indexPrev)) {
        await rename(indexPrev, indexPath);
      }
    }
  }

  await fsyncDir(dir);
  await rm(dataTmp, { force: true });
  await rm(indexTmp, { force: true });

  // Only drop the rollback option once the live pair is confirmed consistent.
  if (existsSync(dataPath) && existsSync(indexPath)) {
    const dataGen = await peekGeneration(dataPath);
    const indexGen = await peekGeneration(indexPath);
    if (dataGen === indexGen) {
      await rm(dataPrev, { force: true });
      await rm(indexPrev, { force: true });
      await fsyncDir(dir);
    }
  }
}
