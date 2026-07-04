import { concatBytes, utf8Decode, utf8Encode } from '../core/bytes.ts';
import type { CipherEngineId, SealedRecord } from '../crypto/engine.ts';

// [engineIdLen(1)][engineId][ivLen(1)][iv][hasAuthTag(1)][authTagLen(1)?][authTag?][ciphertext...]
// `trace` is never persisted — it's ephemeral, visualizer-only output.

export function encodeSealedRecord(sealed: SealedRecord): Uint8Array {
  const engineIdBytes = utf8Encode(sealed.engineId);
  const hasAuthTag = sealed.authTag !== undefined;

  const parts: Uint8Array[] = [
    Uint8Array.of(engineIdBytes.length),
    engineIdBytes,
    Uint8Array.of(sealed.iv.length),
    sealed.iv,
    Uint8Array.of(hasAuthTag ? 1 : 0),
  ];
  if (hasAuthTag) {
    parts.push(Uint8Array.of(sealed.authTag!.length), sealed.authTag!);
  }
  parts.push(sealed.ciphertext);
  return concatBytes(...parts);
}

export function decodeSealedRecord(buf: Uint8Array): SealedRecord {
  let offset = 0;
  const engineIdLen = buf[offset++]!;
  const engineId = utf8Decode(buf.subarray(offset, offset + engineIdLen)) as CipherEngineId;
  offset += engineIdLen;

  const ivLen = buf[offset++]!;
  const iv = buf.subarray(offset, offset + ivLen);
  offset += ivLen;

  const hasAuthTag = buf[offset++]! === 1;
  let authTag: Uint8Array | undefined;
  if (hasAuthTag) {
    const authTagLen = buf[offset++]!;
    authTag = buf.subarray(offset, offset + authTagLen);
    offset += authTagLen;
  }

  const ciphertext = buf.subarray(offset);
  return { engineId, iv, ciphertext, authTag };
}
