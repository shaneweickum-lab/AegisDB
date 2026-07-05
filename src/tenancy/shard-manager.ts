import { DocumentStore } from '../storage/store.ts';
import { ProfileRegistry } from './profile-registry.ts';

const DEFAULT_MAX_OPEN_SHARDS = 16;

/** Lazily opens one DocumentStore per profile and caches it, evicting the
 *  least-recently-used shard once the open-handle budget is exceeded
 *  (spec 10.5's "startup cost proportional to profile count, not total
 *  post count" — nothing here is opened until a profile is actually
 *  accessed). A JS Map's insertion order does the LRU bookkeeping: a
 *  cache hit re-inserts the key to move it to the most-recently-used end,
 *  so the least-recently-used entry is always the Map's first key. */
export class ShardManager {
  private readonly registry: ProfileRegistry;
  private readonly maxOpenShards: number;
  private readonly cache = new Map<string, DocumentStore>();

  constructor(registry: ProfileRegistry, maxOpenShards: number = DEFAULT_MAX_OPEN_SHARDS) {
    this.registry = registry;
    this.maxOpenShards = maxOpenShards;
  }

  get openCount(): number {
    return this.cache.size;
  }

  isOpen(serial: string): boolean {
    return this.cache.has(serial);
  }

  /** Returns this profile's store, opening it if necessary. `masterKey`
   *  is only used on a cold open — a cache hit reuses whatever store is
   *  already open, on the assumption that repeated calls for the same
   *  profile within a process use the same (correctly re-derived) key. */
  async forProfile(serial: string, masterKey: Uint8Array): Promise<DocumentStore> {
    const cached = this.cache.get(serial);
    if (cached) {
      this.cache.delete(serial);
      this.cache.set(serial, cached); // bump to most-recently-used
      return cached;
    }

    const dir = this.registry.shardDir(serial);
    const store = await DocumentStore.open(dir, { masterKey });
    this.cache.set(serial, store);
    await this.evictOverCapacity();
    return store;
  }

  private async evictOverCapacity(): Promise<void> {
    while (this.cache.size > this.maxOpenShards) {
      const leastRecentlyUsed = this.cache.keys().next().value;
      if (leastRecentlyUsed === undefined) break;
      await this.evict(leastRecentlyUsed);
    }
  }

  async evict(serial: string): Promise<boolean> {
    const store = this.cache.get(serial);
    if (!store) return false;
    this.cache.delete(serial);
    await store.close();
    return true;
  }

  async closeAll(): Promise<void> {
    const stores = [...this.cache.values()];
    this.cache.clear();
    await Promise.all(stores.map((store) => store.close()));
  }
}
