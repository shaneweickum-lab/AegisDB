# Project Aegis — Original Product Specification (v1.0)

> Kept verbatim for implementation reference. **Section 2 (the "EFS" cipher)
> has a real invertibility bug as written** — decoding requires knowing a
> character to look up that character's own occurrence count, which is
> circular, and the floating-point exponentiation loses precision on long
> documents. See `docs/CIPHER.md` for the corrected design actually
> implemented (the "Banded Permutation Cipher"), and `docs/THREAT-MODEL.md`
> for how the two cipher engines (BPC + real AES-256-GCM) are scoped.

================================================================================
PROJECT AEGIS
Zero-Dependency Cryptographic Micro-Database Ecosystem
Product Specification & System Architecture Document
Version 1.0
================================================================================

PREFACE / SCOPE NOTE
--------------------------------------------------------------------------------
This document specifies an educational/portfolio-grade cryptographic and
database subsystem. The cipher described in Section 2 is a custom stream
transform designed to demonstrate stateful algorithmic engineering, byte-level
data manipulation, and visualization design skill. It is NOT a peer-reviewed
or cryptanalytically vetted primitive and must not be relied upon to protect
sensitive production data. For any real-world confidentiality requirement,
the system should shell out to a vetted, standard library implementation
(e.g., AES-256-GCM via Node's `crypto` module or Go's `crypto/aes`) behind
the same API surface. The architecture below is written so that swap is a
drop-in replacement at the Cryptographic Engine boundary — the rest of the
stack (DB engine, API layer, UI) is agnostic to which primitive is behind it.

================================================================================
1. SYSTEM ARCHITECTURE & DATA FLOW
================================================================================

1.1 ARCHITECTURAL PATTERN

Project Aegis follows a strict layered/hexagonal decomposition. Each layer
communicates only with its immediate neighbor through a narrow, typed
interface, which keeps the Cryptographic Engine and the Database Engine
independently unit-testable and independently replaceable.

    Layer 4  Interactive Visualizer UI (Next.js / Tailwind / WebSocket client)
    Layer 3  Authenticated API Controller Layer (REST + session middleware)
    Layer 2  Cryptographic Engine (stateful stream cipher, pure functions)
    Layer 1  Flat-File I/O Database Manager ("AegisDB")
    Layer 0  Local Filesystem (append-only binary + index files)

Rules of engagement between layers:
  - Layer 4 never touches Layer 1 or Layer 2 directly. It only consumes
    Layer 3's REST/WebSocket contracts.
  - Layer 3 holds no cryptographic state itself. It is a stateless request
    router that instantiates a scoped Engine context per authenticated
    session and passes it down.
  - Layer 2 is a pure transformation library: given bytes and a key/IV
    state, it deterministically produces output bytes and a mutated state.
    It has zero knowledge of HTTP, sessions, or file paths.
  - Layer 1 knows nothing about encryption. It receives and returns opaque
    Buffer/Uint8Array blobs, and is only responsible for offset bookkeeping,
    atomic writes, and index maintenance.

1.2 END-TO-END DATA LIFECYCLE (ASCII SYSTEM DIAGRAM)

    CLIENT (Browser) -> Visualizer Dashboard -> fetch/WS -> State Matrix Map
      -> HTTPS/WSS ->
    LAYER 3 - API CONTROLLER (stateless)
      POST /api/auth/unlock  -> derive session key -> issue session token
      POST /api/documents    -> validate payload -> call Engine.encode
      GET  /api/documents/:id -> call DB.readOffset -> Engine.decode
      -> raw JSON doc (in-memory only) ->
    LAYER 2 - CRYPTOGRAPHIC ENGINE (pure, stateful)
      JSON.stringify(doc) -> UTF-8 byte stream -> per-char frequency counter
      C[ch]++ -> Output = (BaseID(ch) ^ (1 + C[ch]/10)) mod 256 -> XOR against
      IV-derived keystream byte -> mutated ciphertext byte block
      -> encrypted Buffer + updated state map ->
    LAYER 1 - AEGISDB FLAT-FILE I/O MANAGER (atomic)
      1. Look up / allocate byte offset in in-memory Index Map
      2. Write ciphertext block to aegis.data.tmp (shadow copy)
      3. Append updated index entry to aegis.index.tmp
      4. fsync() both temp files
      5. Atomic rename tmp -> live (POSIX rename() is atomic per-file)
      ->
    LAYER 0 - LOCAL FILESYSTEM
      aegis.data   (append-only encrypted record blocks)
      aegis.index  (id -> {offset, length, version} table)

    READ PATH (reverse):
    aegis.index lookup -> seek(offset) in aegis.data -> read(length) bytes
      -> Engine.decode(bytes, storedStateSnapshot, IV) -> UTF-8 -> JSON.parse
      -> API response body -> UI State Matrix Map replay

1.3 STATE OWNERSHIP

The Engine's frequency map C is per-document-stream, not global. Each record
persists a small "cipher state header" (the C map snapshot at encode time,
plus the IV) alongside its ciphertext so that decoding is deterministic and
does not depend on replaying every prior document in the database. This
trades a few extra bytes per record for O(1) independent decode — a
deliberate space/time tradeoff documented in Section 2.4.

================================================================================
2. THE CRYPTOGRAPHIC PRIMITIVE — "EXPONENTIAL FREQUENCY SHIFTER" (EFS)
================================================================================

2.1 DESIGN INTENT

EFS is a custom stateful polyalphabetic stream cipher. Unlike a fixed
substitution cipher (vulnerable to single-frequency-table analysis), EFS's
substitution mapping for a given character continuously drifts as a function
of how many times that character has already been seen in the current
stream. This means "E" on its 1st occurrence and "E" on its 40th occurrence
map to different output values, flattening the naive unigram frequency
histogram an attacker would otherwise build.

2.2 BASE ALPHABET MAPPING

Each character ch in the supported input alphabet (A-Z, a-z, 0-9, and a
fixed punctuation/control table) is assigned a Base ID, B(ch), starting
at 2. This produces a deterministic, reversible lookup table BASE_ID[256]
and its inverse INVERSE_BASE_ID[256], both precomputed once at Engine init.

2.3 STATE MAP

The Engine maintains an in-memory Map<byte, uint32> called FREQ_STATE,
keyed by raw byte value, tracking historical occurrence count C(ch) within
the current stream. Reading C before incrementing guarantees the first
occurrence of any character always maps through the same base exponent
(1.0), which is required for deterministic replay from a serialized state
snapshot.

2.4 THE EXPONENTIAL SCALING EQUATION

RawOutput = B ^ (1 + C / 10), a floating-point exponentiation.

2.4.1 FLOATING-POINT -> BYTE REDUCTION

    IntermediateInt = floor(RawOutput * 1000)
    ByteValue = IntermediateInt mod 256

2.4.2 IV-DERIVED KEYSTREAM XOR

    KeystreamByte[i] = HASH_EXPAND(IV, i) mod 256
    CipherByte[i]    = ByteValue[i] XOR KeystreamByte[i]

2.4.3 IV LIFECYCLE — fresh random 16-byte IV per document write, stored in
cleartext alongside ciphertext (IVs are not secret; only the master key is).

2.5 DECODING (INVERSE TRANSFORM) — as originally specified, this step is
underspecified/circular (see docs/CIPHER.md for why, and the corrected
design).

================================================================================
3. THE EMBEDDED DATABASE ENGINE ("AegisDB")
================================================================================

3.1 RECORD LAYOUT (ON-DISK BINARY FORMAT)

    MAGIC(2B) | LEN(4B) | IV(16B) | STATE_HDR (varint-len) | CIPHERTEXT(var)

AegisDocument: { id, title, content, timestamp, linkedProjectId, version }

3.2 IN-MEMORY INDEX MAP — Map<id, {offset, length, version, deleted}>,
rebuilt from aegis.index (not aegis.data) on startup for O(1) lookup
without decrypting unrelated records.

3.3 ATOMIC WRITE STRATEGY (SHADOW PAGING) — append ciphertext, append index
entry via tmp+rename, fsync both, update in-memory IndexMap only after
rename succeeds. Recovery tail-scans for and discards orphaned/partial
trailing blocks.

3.4 CORE DB ENGINE INTERFACE

    interface AegisDBEngine {
      init(dataPath, indexPath): Promise<void>;
      get(id): Promise<AegisDocument | null>;
      put(doc): Promise<IndexEntry>;
      delete(id): Promise<boolean>;   // tombstone
      compact(): Promise<void>;
      listIds(linkedProjectId?): string[];
    }

================================================================================
4. API & MICROSERVICE ECOSYSTEM LAYER
================================================================================

4.1 REST SURFACE — POST /api/auth/unlock, POST/GET/DELETE /api/documents,
GET /api/telemetry/state (WS upgrade).

4.2 MASTER-KEY AUTHENTICATION — passphrase -> KDF (PBKDF2/scrypt) ->
MasterKey held only in server memory for session lifetime, mapped to an
opaque sessionToken; expiry zeroes the in-memory key.

4.3 PER-DOCUMENT KEY DERIVATION — DocumentKey = HKDF(MasterKey, salt=docId,
info="aegis-v1").

================================================================================
5. THE INTERACTIVE VISUALIZER UI
================================================================================

Next.js/Tailwind frontend over a WebSocket telemetry stream of
EngineStateFrame events (position, char, baseId, historicalCount, exponent,
rawOutput, byteValue, keystreamByte, cipherByte), throttled to a
configurable tick rate. Layout: header (tick-rate/play/pause/step), State
Matrix Map, Frequency Histogram, Exponent Curve Panel, Byte Output Strip,
Raw<->Cipher Diff View (color-coded by historical-count "band").

================================================================================
6. TESTING & BENCHMARKING HARNESS
================================================================================

Determinism tests (same input+IV+state -> same ciphertext; decode inverts
encode exactly; different IV -> different ciphertext), statistical
flattening validation (chi-squared vs. naive baseline), crash-recovery fuzz
tests (truncate at every structural byte boundary, assert clean recovery),
concurrent-read-during-write safety, throughput/tick-rate benchmarks across
a document-size sweep.

================================================================================
7. compact() — DATABASE COMPACTION ALGORITHM DEEP DIVE
================================================================================

Snapshot live entries, stream-copy live ciphertext blocks (no decrypt
needed — compaction changes position not content) to a new segment,
fsync, atomic double-rename (data then index), swap in-memory IndexMap
only after both renames succeed. Concurrency: compaction is "stop the
writes, allow the reads" — readers always see a consistent pre- or
post-compaction view, writers queue behind a compaction mutex. Generation
tagging in both files' headers lets recovery detect and resolve an
interrupted compaction without trusting file mtimes.

================================================================================
8. FRONTEND ENCRYPT/DECRYPT WORKBENCH & FILE INGESTION
================================================================================

Interactive workbench: type/paste/upload plaintext, encrypt, copy/paste
ciphertext back, decrypt. IV + FREQ_STATE snapshot must travel with
ciphertext (stateful cipher output is not self-describing) — exposed in
an "Advanced" expander for ad-hoc pasted text; automatic when working
against a saved document. File ingestion (.txt/.md/code -> utf8-direct,
.docx -> unzip -> parse document.xml -> concatenate run text) happens
server-side; only extracted text proceeds into the Engine, discarding
formatting by design.

================================================================================
9. ALWAYS-ON NETWORK LAYER & SOCIAL FEED APPLICATION
================================================================================

Turns AegisDB into the backing store for a small, always-reachable social
feed app without replacing the flat-file engine. Deployment: home machine
+ tunnel (Cloudflare/ngrok) OR a small owned VPS — same binary record
format either way, config-driven (`DeploymentConfig { mode, dataDir,
port, tunnel?, publicHost? }`). SocialPost extends AegisDocument
(linkedProjectId repurposed as threadId, title as subject line, plus
authorDisplayName/replyToId/likeCount). New endpoints: POST /api/posts,
GET /api/feed, POST /api/posts/:id/like, GET /api/posts/:id. Layer 3
decrypts before the response leaves the server — plaintext-on-frontend,
encrypted-at-rest; this protects the disk, not user-to-user secrecy.
Real-time updates reuse the WebSocket transport with a
post:created/post:liked event channel.

================================================================================
10. PROFILE-SHARDED STORAGE LAYOUT
================================================================================

Restructures the single global aegis.data/index pair into one folder per
user profile (ULID serial), each an independent instance of the same
atomic-write DB format. profiles.index is a small top-level registry
loaded fully at boot; each profile's shard.index is loaded lazily on
first access. AegisDocument gains `parentSerial` (a plain, self-describing
reference to the owning profile). Atomic writes, and compact(), are now
scoped per-shard — a crash or compaction in one profile's shard can never
touch another's. Feed fan-out for a shared thread resolves which profiles
posted into it via a small side-index, reads the relevant shards, and
merge-sorts by timestamp.

================================================================================
END OF SPECIFICATION (verbatim excerpt — see project conversation history
for the byte-exact original text of every field name, diagram, and code
sample if ever needed for a line-by-line audit)
================================================================================
