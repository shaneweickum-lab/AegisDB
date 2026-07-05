import { deriveKey } from '../core/hkdf.ts';
import { utf8Encode } from '../core/bytes.ts';
import type { SealContext } from './engine.ts';

const DOCUMENT_KEY_LENGTH = 32;

/** Spec 4.3: DocumentKey = HKDF(MasterKey, salt=documentId, info="aegis-v1").
 *  A distinct sub-key per document means compromising one document's
 *  IV/state doesn't help attack another document's ciphertext. */
export function deriveDocumentKey(ctx: SealContext): Uint8Array {
  return deriveKey(ctx.masterKey, 'aegis-v1', DOCUMENT_KEY_LENGTH, utf8Encode(ctx.recordId));
}
