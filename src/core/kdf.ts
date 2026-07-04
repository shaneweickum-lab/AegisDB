import { randomBytes, scryptSync } from 'node:crypto';

export const MASTER_KEY_LENGTH = 32; // 256 bits, matches AES-256
export const SALT_LENGTH = 16;

export interface DerivedMasterKey {
  key: Uint8Array;
  salt: Uint8Array;
}

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Passphrase -> master key via scrypt. Pass an existing `salt` (e.g. read
 *  back from a profile's stored metadata) to re-derive the same key; omit
 *  it to mint a fresh salt for a brand-new profile/session. */
export function deriveMasterKey(passphrase: string, salt?: Uint8Array): DerivedMasterKey {
  const useSalt = salt ?? new Uint8Array(randomBytes(SALT_LENGTH));
  const key = new Uint8Array(scryptSync(passphrase, useSalt, MASTER_KEY_LENGTH, SCRYPT_PARAMS));
  return { key, salt: useSalt };
}
