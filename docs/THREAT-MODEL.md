# Threat Model & Cipher Scoping

AegisDB ships two interchangeable cipher engines behind one
`CipherEngine` interface (`src/crypto/engine.ts`). They are not
interchangeable in trust level, and this document exists so that claim
is never blurry.

## `aes-256-gcm` — the engine that protects data at rest

This is a standard, vetted AEAD construction from `node:crypto`
(`crypto.createCipheriv('aes-256-gcm', ...)`). It is the **default**
engine for every document collection unless a collection explicitly opts
into the pedagogical engine for demo purposes. Authenticity is enforced
by GCM's auth tag — any bit-flip in ciphertext or tag causes `open()` to
throw rather than silently return corrupted plaintext.

## `bpc-2b` / `bpc-1b` — the Banded Permutation Cipher, pedagogical only

BPC (see `docs/CIPHER.md`) is a hand-designed, state-dependent
polyalphabetic substitution cipher built to demonstrate stateful
algorithmic engineering and to drive the live visualizer (Section 5 of
the original spec). It is:

- **Not cryptanalytically vetted.** It has not been reviewed by
  cryptographers, has no published security proof, and should be assumed
  breakable by anyone who studies it seriously. Its "frequency
  flattening" property is a real, testable, and demonstrable effect
  (see the chi-squared test in `test/property/`), but demonstrable
  flattening is not the same claim as semantic security.
- **Not IND-CPA secure** in any formal sense. Diffusion comes from a
  per-position IV-derived keystream applied within each band's slot, plus
  band drift; neither is a substitute for the diffusion/confusion
  guarantees of a reviewed AEAD cipher.
- **Deliberately explained, not hidden.** The whole point of the
  visualizer and workbench (Sections 5 and 8) is to show *exactly* how
  this cipher works, byte by byte — a security-relevant primitive that
  invites full inspection like this is a portfolio demonstration, not a
  production claim.

## The actual rule enforced in code

Any collection or record sealed with a `bpc-*` engine id is a deliberate,
explicit choice (e.g. the workbench and visualizer's own scratch
documents) — never the default for user data, and never used for the
social feed's persisted posts or for session/auth material. The storage
layer records which engine sealed each record (`SealedRecord.engineId`)
so this is auditable after the fact, not just a runtime convention.

## What this system does and does not protect against

- **Protects:** the contents of `aegis.data`/shard files at rest on disk,
  against someone with filesystem access but without the unlocked
  session's master key (derived from a passphrase via `scrypt`, held only
  in server memory for the session's lifetime).
- **Does not protect:** confidentiality between two users of the social
  feed app from each other — Layer 3 decrypts posts server-side before
  they reach any client, so the threat model is "protect the disk," not
  "end-to-end secrecy between User A and User B." This is stated plainly
  here (and in the feed UI) rather than implied.
- **Does not protect:** against a compromised or unlocked server process
  — an unlocked session's in-memory master key is, by design, capable of
  decrypting that tenant's data; this is the same trust boundary any
  server-side-encryption system has.
