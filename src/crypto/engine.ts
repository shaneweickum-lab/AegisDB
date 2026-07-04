/** Per-byte trace of a BPC encode/decode step, consumed by the visualizer.
 *  Never populated on the AES-GCM path. */
export interface CipherTraceStep {
  position: number;
  byte: number;
  band: number;
  count: number;
  outHigh: number;
  outLow: number;
}

export interface CipherTrace {
  steps: CipherTraceStep[];
}

export interface SealContext {
  masterKey: Uint8Array;
  recordId: string;
  /** When true, BPC populates `SealedRecord.trace`. Ignored by AES-GCM. */
  withTrace?: boolean;
}

export interface SealedRecord {
  engineId: CipherEngineId;
  iv: Uint8Array;
  ciphertext: Uint8Array;
  /** AES-GCM only: the authentication tag. */
  authTag?: Uint8Array;
  /** BPC only, opt-in via SealContext.withTrace. */
  trace?: CipherTrace;
}

export type CipherEngineId = 'aes-256-gcm' | 'bpc-2b';

/** Layer-2 boundary (spec Section 1.1): pure transformation given bytes and
 *  a key/context, deterministically producing a sealed record and back. */
export interface CipherEngine {
  readonly id: CipherEngineId;
  seal(plaintext: Uint8Array, ctx: SealContext): SealedRecord;
  open(sealed: SealedRecord, ctx: SealContext): Uint8Array;
}
