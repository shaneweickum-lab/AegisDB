import { Shard } from './shard.ts';
import { decodeSealedRecord, encodeSealedRecord } from './sealed-record-codec.ts';
import { generateUlid } from '../core/ulid.ts';
import { utf8Decode, utf8Encode } from '../core/bytes.ts';
import { createAesGcmEngine } from '../crypto/aes-gcm-engine.ts';
import type { CipherEngine, CipherEngineId, SealContext } from '../crypto/engine.ts';

export interface DocumentRecord<T = unknown> {
  id: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  data: T;
}

export interface DocumentStoreOptions {
  masterKey: Uint8Array;
  /** Defaults to AES-256-GCM — see docs/THREAT-MODEL.md for why. */
  defaultEngine?: CipherEngine;
  /** Per-collection engine choice for NEW writes (e.g. opt a demo
   *  collection into 'bpc-2b'). Reads always use whichever engine the
   *  record was actually sealed with (SealedRecord.engineId), so this
   *  only affects what happens going forward. */
  engineOverrides?: Record<string, CipherEngine>;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

/** Generic collections of JSON documents on top of a Shard (spec 1.1's
 *  Layer 1/2 boundary made concrete): every document is sealed through a
 *  configured CipherEngine before it ever reaches the storage layer,
 *  which only ever sees opaque bytes. Secondary "indexes" here are
 *  nothing but a key-prefix convention over the shard's own keydir
 *  (`${collection}:${id}`) — derived, rebuildable, never a separate
 *  persisted structure that could drift from the source of truth. */
export class DocumentStore {
  private readonly shard: Shard;
  private readonly masterKey: Uint8Array;
  private readonly engines: Map<CipherEngineId, CipherEngine>;
  private readonly writeEngineByCollection: Map<string, CipherEngine>;
  private readonly defaultEngine: CipherEngine;
  private readonly now: () => number;

  private constructor(shard: Shard, options: DocumentStoreOptions) {
    this.shard = shard;
    this.masterKey = options.masterKey;
    this.defaultEngine = options.defaultEngine ?? createAesGcmEngine();
    this.now = options.now ?? (() => Date.now());

    this.engines = new Map([[this.defaultEngine.id, this.defaultEngine]]);
    this.writeEngineByCollection = new Map();
    for (const [collection, engine] of Object.entries(options.engineOverrides ?? {})) {
      this.engines.set(engine.id, engine);
      this.writeEngineByCollection.set(collection, engine);
    }
  }

  static async open(dir: string, options: DocumentStoreOptions): Promise<DocumentStore> {
    const shard = await Shard.open(dir);
    return new DocumentStore(shard, options);
  }

  private storageKey(collection: string, id: string): string {
    return `${collection}:${id}`;
  }

  private sealContext(storageKey: string): SealContext {
    return { masterKey: this.masterKey, recordId: storageKey };
  }

  private engineForRead(engineId: CipherEngineId): CipherEngine {
    const engine = this.engines.get(engineId);
    if (!engine) throw new Error(`DocumentStore: no engine registered for id "${engineId}"`);
    return engine;
  }

  private async writeRecord<T>(collection: string, record: DocumentRecord<T>): Promise<void> {
    const key = this.storageKey(collection, record.id);
    const engine = this.writeEngineByCollection.get(collection) ?? this.defaultEngine;
    const plaintext = utf8Encode(JSON.stringify(record));
    const sealed = engine.seal(plaintext, this.sealContext(key));
    await this.shard.put(key, encodeSealedRecord(sealed));
  }

  async insert<T>(collection: string, data: T): Promise<DocumentRecord<T>> {
    const record: DocumentRecord<T> = { id: generateUlid(), version: 1, createdAt: this.now(), updatedAt: this.now(), data };
    await this.writeRecord(collection, record);
    return record;
  }

  async get<T = unknown>(collection: string, id: string): Promise<DocumentRecord<T> | null> {
    const key = this.storageKey(collection, id);
    const bytes = await this.shard.get(key);
    if (!bytes) return null;
    const sealed = decodeSealedRecord(bytes);
    const plaintext = this.engineForRead(sealed.engineId).open(sealed, this.sealContext(key));
    return JSON.parse(utf8Decode(plaintext)) as DocumentRecord<T>;
  }

  async update<T>(collection: string, id: string, data: T): Promise<DocumentRecord<T>> {
    const existing = await this.get<T>(collection, id);
    if (!existing) throw new Error(`DocumentStore: cannot update missing document "${collection}:${id}"`);
    const record: DocumentRecord<T> = {
      id,
      version: existing.version + 1,
      createdAt: existing.createdAt,
      updatedAt: this.now(),
      data,
    };
    await this.writeRecord(collection, record);
    return record;
  }

  async delete(collection: string, id: string): Promise<boolean> {
    return this.shard.delete(this.storageKey(collection, id));
  }

  /** Index-only, no decrypt (spec 3.2's stated goal) — just a prefix
   *  filter over the shard's own keydir. */
  listIds(collection: string): string[] {
    const prefix = `${collection}:`;
    return this.shard.listIds().filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
  }

  /** Full-scan-and-decrypt query. Honestly O(collection size), not real
   *  indexing — filtering by document content necessarily requires
   *  decrypting each candidate, unlike listIds above. */
  async query<T = unknown>(collection: string, predicate?: (doc: DocumentRecord<T>) => boolean): Promise<DocumentRecord<T>[]> {
    const results: DocumentRecord<T>[] = [];
    for (const id of this.listIds(collection)) {
      const doc = await this.get<T>(collection, id);
      if (doc && (!predicate || predicate(doc))) results.push(doc);
    }
    return results;
  }

  async compact() {
    return this.shard.compact();
  }

  async close(): Promise<void> {
    return this.shard.close();
  }
}
