import { randomBytes } from 'node:crypto';
import { deriveMasterKey, type DerivedMasterKey } from '../../core/kdf.ts';

export interface Session {
  masterKey: Uint8Array;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;

/** Spec 4.2: passphrase -> scrypt -> MasterKey, held only in server memory
 *  for the session's lifetime, mapped from an opaque random token that is
 *  "unrelated to MasterKey mathematically" — a plain server-side lookup
 *  table, not a signed/derived token, exactly as the spec describes. */
export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  unlock(passphrase: string, salt?: Uint8Array): { token: string; expiresAt: number; derived: DerivedMasterKey } {
    const derived = deriveMasterKey(passphrase, salt);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + this.ttlMs;
    this.sessions.set(token, { masterKey: derived.key, expiresAt });
    return { token, expiresAt, derived };
  }

  resolve(token: string): Session | null {
    const session = this.sessions.get(token);
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
      this.revoke(token);
      return null;
    }
    return session;
  }

  /** Zeroes the in-memory master key before dropping the reference (spec
   *  4.2 step 6) — defense in depth, since the whole point of "no
   *  session, no derivable key" is undermined if the key just lingers in
   *  memory until GC gets around to it. */
  revoke(token: string): boolean {
    const session = this.sessions.get(token);
    if (!session) return false;
    session.masterKey.fill(0);
    this.sessions.delete(token);
    return true;
  }

  get activeCount(): number {
    return this.sessions.size;
  }
}

export function extractBearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) return null;
  const match = /^Bearer\s+(.+)$/.exec(authorizationHeader);
  return match ? match[1]! : null;
}
