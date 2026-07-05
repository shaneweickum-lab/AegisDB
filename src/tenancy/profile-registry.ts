import { join } from 'node:path';
import { generateUlid } from '../core/ulid.ts';
import { deriveMasterKey, type DerivedMasterKey } from '../core/kdf.ts';
import { utf8Decode, utf8Encode } from '../core/bytes.ts';
import { Shard } from '../storage/shard.ts';

// Exactly the Crockford base32 alphabet ulid.ts encodes with, 26 chars.
const SERIAL_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export class InvalidSerialError extends Error {
  constructor(serial: string) {
    super(`invalid profile serial: ${JSON.stringify(serial)}`);
  }
}

/** Every path built from a serial goes through this first — the serial
 *  becomes a folder name (spec 10.2), so an unvalidated one is a path
 *  traversal vector the moment it's ever accepted from outside this
 *  process (e.g. from an HTTP request in a future integration). */
export function validateSerial(serial: string): string {
  if (!SERIAL_PATTERN.test(serial)) throw new InvalidSerialError(serial);
  return serial;
}

export interface ProfileRecord {
  serial: string;
  displayName: string;
  saltHex: string;
  createdAt: number;
}

const PROFILES_DIR = 'profiles';
const REGISTRY_DIR = 'profiles-registry';

/** spec 10.1/10.2: profiles.index is a small top-level registry, loaded
 *  fully at boot, mapping a profile's serial to its metadata — critically,
 *  this registry is NEVER encrypted with a profile's own key, because you
 *  need a profile's salt (stored here) BEFORE you can derive that key.
 *  It's backed by a plain Shard (raw KV), not a DocumentStore. */
export class ProfileRegistry {
  private readonly registryShard: Shard;
  private readonly rootDir: string;

  private constructor(registryShard: Shard, rootDir: string) {
    this.registryShard = registryShard;
    this.rootDir = rootDir;
  }

  static async open(rootDir: string): Promise<ProfileRegistry> {
    const registryShard = await Shard.open(join(rootDir, REGISTRY_DIR));
    return new ProfileRegistry(registryShard, rootDir);
  }

  async createProfile(displayName: string, passphrase: string): Promise<{ record: ProfileRecord; masterKey: Uint8Array }> {
    const serial = generateUlid();
    const derived: DerivedMasterKey = deriveMasterKey(passphrase);
    const record: ProfileRecord = {
      serial,
      displayName,
      saltHex: Buffer.from(derived.salt).toString('hex'),
      createdAt: Date.now(),
    };
    await this.registryShard.put(serial, utf8Encode(JSON.stringify(record)));
    return { record, masterKey: derived.key };
  }

  async getProfile(serial: string): Promise<ProfileRecord | null> {
    validateSerial(serial);
    const raw = await this.registryShard.get(serial);
    if (!raw) return null;
    return JSON.parse(utf8Decode(raw)) as ProfileRecord;
  }

  /** Re-derives an existing profile's master key from its stored salt.
   *  There is no separate verification step (no stored password hash to
   *  check against) — a wrong passphrase silently derives a wrong key,
   *  and later reads against that profile's shard will fail to decrypt
   *  rather than being rejected up front. This matches the rest of the
   *  system's "no session, no derivable key" model rather than adding a
   *  distinct authentication primitive; see docs/TENANCY.md. */
  async unlockProfile(serial: string, passphrase: string): Promise<Uint8Array> {
    const profile = await this.getProfile(serial);
    if (!profile) throw new Error(`unknown profile: ${serial}`);
    const salt = new Uint8Array(Buffer.from(profile.saltHex, 'hex'));
    return deriveMasterKey(passphrase, salt).key;
  }

  listProfiles(): string[] {
    return this.registryShard.listIds();
  }

  shardDir(serial: string): string {
    validateSerial(serial);
    return join(this.rootDir, PROFILES_DIR, `PROFILE-${serial}`);
  }

  async close(): Promise<void> {
    await this.registryShard.close();
  }
}
