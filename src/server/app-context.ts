import { DocumentStore } from '../storage/store.ts';
import { SessionManager } from './auth/session.ts';
import { Hub } from './ws/hub.ts';

export class NotUnlockedError extends Error {
  constructor() {
    super('no unlocked session — POST /api/auth/unlock first');
  }
}

/** Shared server state across all requests. Deliberately single-tenant
 *  for now (Phase 9 generalizes this to one Shard/DocumentStore per
 *  profile) — a single unlocked DocumentStore, gated by the session
 *  table, matching spec 4.2's "no session, no derivable per-document
 *  key, no readable index" model before profile sharding exists. */
export class AppContext {
  readonly sessions: SessionManager;
  readonly dataDir: string;
  readonly hub: Hub;
  private store: DocumentStore | null = null;

  constructor(dataDir: string, sessions: SessionManager = new SessionManager(), hub: Hub = new Hub()) {
    this.dataDir = dataDir;
    this.sessions = sessions;
    this.hub = hub;
  }

  hasStore(): boolean {
    return this.store !== null;
  }

  getStore(): DocumentStore {
    if (!this.store) throw new NotUnlockedError();
    return this.store;
  }

  async unlockStore(masterKey: Uint8Array): Promise<void> {
    if (this.store) await this.store.close();
    this.store = await DocumentStore.open(this.dataDir, { masterKey });
  }

  async lockStore(): Promise<void> {
    if (this.store) {
      await this.store.close();
      this.store = null;
    }
  }
}
