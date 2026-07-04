# Storage Engine

## Single data+index file pair per shard, not a multi-segment log

The original spec (Section 3) describes exactly one `aegis.data` /
`aegis.index` pair per database, and `compact()` (Section 7) rewrites
that pair wholesale. This is what's implemented (`src/storage/shard.ts`),
rather than a Bitcask-style multi-segment log with segment merging.
Segment rotation solves a problem — unbounded compaction pause time on a
huge single file — that doesn't apply at this project's scale, so it
would be unneeded complexity rather than a real improvement here. Each
`Shard` is a single directory containing `shard.data` and `shard.index`;
Phase 9 gives each tenant profile its own independent `Shard` directory,
which is where multi-shard scaling actually happens instead.

## Direct append + fsync, not per-write copy-and-rename

Spec 3.3 describes writing each new record to a `.tmp` shadow copy and
renaming it over the live file on every write. Taken literally, that
means copying the *entire* file on every single write — O(file size) per
write, compounding to O(n²) over the file's lifetime. The spec itself
offers the alternative for the data file ("for append-only growth, simply
opened in append mode against the live file directly — append is safe
because a half-written trailing block is detectable via the LEN field and
MAGIC bytes on next startup"); this project applies that same
self-describing-record approach to *both* files (`src/storage/record.ts`'s
magic+length+CRC framing, reused for the index log too), giving O(1)
amortized append cost with an identical crash-safety guarantee: any
unparseable record encountered while scanning forward is, by
construction, a torn tail, and recovery truncates the file to its last
valid record (`src/storage/recovery.ts`, `AppendLog.scan`/`truncateTo`).

Correctness of this substitution rests on one invariant: every `put`/
`delete` appends and fsyncs the **data** record before appending and
fsyncing the corresponding **index** record. A crash between those two
steps leaves an orphaned, harmless trailing block in the data file (never
referenced by any index entry, exactly as spec 3.3 describes) — and
because of that ordering, no index entry can ever survive recovery while
referencing a data record that didn't itself survive the data log's own
truncation. That's why `Shard.open()` doesn't need any cross-file
consistency check beyond each log independently recovering its own tail.

## Generation-tagged rollback for interrupted compaction

`compact()` (spec 7.4) writes a fresh generation to `*.compact.tmp` files,
then moves the current live pair aside to `*.prev`, then promotes the new
generation into the live paths, then deletes `*.prev`. Every file (data
and index) carries its generation number in a small header
(`src/storage/wal.ts`'s `FILE_HEADER_LENGTH`).

A crash can land in any of four windows in that dance:

1. Before either live file is moved — live pair is simply untouched.
2. Between the two live→`.prev` renames — one live file is missing.
3. After both are moved aside, before either promotion — both live files
   are missing.
4. After one promotion but not the other — the live pair exists but at
   **mismatched generations**.

`src/storage/recovery.ts`'s `reconcileInterruptedCompaction` handles all
four uniformly: restore any missing live file from its `.prev` counterpart,
then if the (now-restored) live pair's generations still disagree, roll
the newer one back to match the older using its `.prev` copy. This always
resolves to a single, self-consistent generation — compaction is
idempotent, so "prefer the definitely-consistent older generation and
just redo the compaction later" is always the safe choice; `.prev` files
are only unlinked once the live pair is confirmed to agree.
`test/fuzz/interrupted-compaction.test.ts` constructs each of the four
crash windows directly (including window 4, the one that actually needs
the generation check rather than a simple "is it missing" check) and
asserts recovery lands on one consistent generation, never a mismatched
mix.
