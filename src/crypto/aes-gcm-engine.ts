import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { deriveDocumentKey } from './document-key.ts';
import type { CipherEngine, SealContext, SealedRecord } from './engine.ts';

const IV_LENGTH = 12; // 96-bit IV is the recommended/standard width for GCM
const AUTH_TAG_LENGTH = 16;

/** The real engine: standard AES-256-GCM via node:crypto. This — not BPC —
 *  is what protects data at rest by default. See docs/THREAT-MODEL.md. */
export function createAesGcmEngine(): CipherEngine {
  return {
    id: 'aes-256-gcm',

    seal(plaintext: Uint8Array, ctx: SealContext): SealedRecord {
      const documentKey = deriveDocumentKey(ctx);
      const iv = new Uint8Array(randomBytes(IV_LENGTH));
      const cipher = createCipheriv('aes-256-gcm', documentKey, iv, { authTagLength: AUTH_TAG_LENGTH });
      const ciphertext = new Uint8Array(Buffer.concat([cipher.update(plaintext), cipher.final()]));
      const authTag = new Uint8Array(cipher.getAuthTag());
      return { engineId: 'aes-256-gcm', iv, ciphertext, authTag };
    },

    open(sealed: SealedRecord, ctx: SealContext): Uint8Array {
      if (!sealed.authTag) throw new Error('aes-256-gcm: sealed record is missing its auth tag');
      const documentKey = deriveDocumentKey(ctx);
      const decipher = createDecipheriv('aes-256-gcm', documentKey, sealed.iv, {
        authTagLength: AUTH_TAG_LENGTH,
      });
      decipher.setAuthTag(sealed.authTag);
      // Throws if ciphertext or tag was tampered with — this is GCM's
      // authenticity guarantee, not something we implement ourselves.
      const plaintext = Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
      return new Uint8Array(plaintext);
    },
  };
}
