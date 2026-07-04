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

## Admin

### `POST /api/admin/compact`

Triggers compaction on the currently unlocked store. `200` with
`{ "liveKeys": number, "bytesBefore": number, "bytesAfter": number }`.

## Errors

Every error response is `{ "error": "<message>" }` with an appropriate
status: `400` (bad request body), `401` (missing/invalid/expired
session), `404` (not found), `413` (request body over the size cap),
`500` (unexpected server error).

## What's not here yet

Real-time updates (a WebSocket telemetry/event stream) land in Phase 5;
this document will grow a corresponding section once that exists. There
is currently no rate limiting, no per-tenant isolation (that's Phase 9),
and no pagination on the list endpoint — a consumer building against
this API today should assume all of those are coming, not already solid.
