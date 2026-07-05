# AegisDB HTTP API

This is the external contract other projects build against — most
notably the planned separate social-feed repo (see the project's task
notes), which is meant to consume AegisDB purely through this surface,
not by importing its internals. Treat breaking changes here as breaking
changes to that contract.

All request/response bodies are JSON. All routes below except
`/api/auth/unlock` require `Authorization: Bearer <token>`.

## Auth

### `POST /api/auth/unlock`

Unlocks a session: derives a master key from a passphrase (via scrypt)
and opens the document store with it. No session, no derivable key, no
readable data — see `docs/THREAT-MODEL.md`.

Request:
```json
{ "passphrase": "correct horse battery staple", "salt": "<hex, optional>" }
```
Omit `salt` to mint a brand-new profile (a fresh random salt is
generated and returned); pass a previously-returned `salt` back to
re-derive the same master key for an existing profile.

Response `200`:
```json
{ "token": "<opaque bearer token>", "expiresAt": 1730000000000, "salt": "<hex>" }
```

### `POST /api/auth/lock`

Revokes the current session's token and closes the store. `200 { "ok": true }`.

## Documents

Documents live in named **collections** — arbitrary strings you choose
(e.g. `notes`, `posts`, `comments`). There's no schema registration step;
a collection exists the moment you first write to it.

### `POST /api/collections/:collection/documents`

Request: `{ "data": <any JSON value> }`. Response `201`:
```json
{ "id": "<ULID>", "version": 1, "createdAt": 0, "updatedAt": 0, "data": <your data> }
```

### `GET /api/collections/:collection/documents/:id`

`200` with the same shape as above, or `404 { "error": "not found" }`.

### `PUT /api/collections/:collection/documents/:id`

Request: `{ "data": <any JSON value> }`. Replaces the document's `data`
and increments `version`; `createdAt` is preserved. `200` with the
updated record, or `404` if the document doesn't exist.

### `DELETE /api/collections/:collection/documents/:id`

`200 { "ok": true|false }` — `false` if the document didn't exist.

### `GET /api/collections/:collection/documents`

Lists every live document in the collection, decrypted. `200` with a
JSON array of records. This is a full scan-and-decrypt, not indexed
querying — fine at this project's scale, but a consumer with a large
collection and specific filter needs should filter client-side or
maintain its own derived index over the id list rather than assuming
server-side filtering exists here.

## Cipher workbench (spec Section 8)

These never persist anything — they're an ad-hoc "try it and watch it
happen" demo against the current session's master key, using a fixed
internal record id. Every trace step is also published to the WS
telemetry topic below.

### `POST /api/crypto/encode`

Request: `{ "text": string }`. Response `200`:
```json
{ "ciphertext": "<base64>", "iv": "<hex>", "trace": { "steps": [...] } }
```
The `iv` must travel with the ciphertext to decode it later — this is
the stateful-cipher-isn't-self-describing point spec 8.3.1 makes
explicit; there's no separate "state header" to also track (see
docs/CIPHER.md for why BPC doesn't need one).

### `POST /api/crypto/decode`

Request: `{ "ciphertext": "<base64>", "iv": "<hex>" }`. Response `200`:
`{ "text": string, "trace": { "steps": [...] } }`, or `400` if the
ciphertext/IV don't decode cleanly (BPC has no authentication tag, so a
wrong IV typically decodes to garbage text rather than throwing —
that's expected, not a bug, since BPC's job is pedagogy, not integrity).

## File ingestion (spec Section 8.4)

### `POST /api/ingest/file`

No multipart/form-data parsing — hand-rolling that parser would be a
meaningfully large sub-project on its own for limited benefit here.
Instead: the raw file bytes are the entire request body, and the
filename travels in a header.

Headers: `x-file-name: <name>` (required). Optional query param
`?collection=<name>` to also persist the extracted text as a real
document (`{ text, source }`) in that collection, same as
`POST /api/collections/:collection/documents`.

`.docx` files go through hand-parsed ZIP + `node:zlib` inflate + regex
run-text extraction (`extractionMethod: "docx-textract"`, with
`warnings` noting that formatting/images/tables were discarded).
Anything else is treated as plain text (`extractionMethod: "utf8-direct"`)
— there's no extension allowlist. Malformed archives, oversized
declared-uncompressed-sizes (decompression-bomb guard), and oversized
uploads all get a clean `400`/`413` rather than a crash.

Response `200` (or `201` if persisted):
```json
{ "fileName": "report.docx", "extractionMethod": "docx-textract", "extractedText": "...", "warnings": ["..."] }
```

## Admin

### `POST /api/admin/compact`

Triggers compaction on the currently unlocked store. `200` with
`{ "liveKeys": number, "bytesBefore": number, "bytesAfter": number }`.

## Real-time: WebSocket telemetry

### `GET /api/telemetry/state` (upgrade to WebSocket)

A hand-rolled WebSocket server (RFC 6455 — no `ws` package), attached to
the same HTTP server and port. Browsers' `WebSocket` constructor can't
set custom headers, so auth here is a query parameter instead of the
`Authorization: Bearer` header the REST routes use:

```
ws://host:port/api/telemetry/state?token=<the same bearer token from /api/auth/unlock>
```

A missing/invalid token, or any path other than this one, gets a plain
HTTP rejection (400/401/404) rather than completing the WS handshake.

Every message is JSON-encoded as `{ "topic": string, "data": <anything> }`.
There's currently exactly one topic, `"telemetry"` — every connected
client subscribes to it automatically on a successful handshake. Phase 6
publishes `CipherTrace` steps to it as the visualizer drives an
encode/decode; nothing else publishes to it yet. The server pings every
connected client every 30s and drops any connection that doesn't pong
back before the next ping.

## Errors

Every error response is `{ "error": "<message>" }` with an appropriate
status: `400` (bad request body), `401` (missing/invalid/expired
session), `404` (not found), `413` (request body over the size cap),
`500` (unexpected server error).

## What's not here yet

There is currently no rate limiting, no per-tenant isolation (that's
Phase 9), and no pagination on the list endpoint — a consumer building
against
this API today should assume all of those are coming, not already solid.
