# Multi-Tenant Profile Sharding

Implements spec Section 10: one independent `Shard`/`DocumentStore` per
user profile instead of a single global one. `src/tenancy/profile-registry.ts`
and `src/tenancy/shard-manager.ts` are the subsystem; see the note at the
end of this document on why they aren't yet wired into the HTTP layer.

## The registry is never encrypted with a profile's own key

`ProfileRegistry` stores `{ serial, displayName, saltHex, createdAt }` per
profile in a plain `Shard` (raw KV, not a `DocumentStore`) — deliberately
**not** sealed through any `CipherEngine`. The reason is structural, not
an oversight: you need a profile's salt to derive its master key, and you
need the registry to find that salt in the first place. Encrypting the
registry with the very key it exists to help derive would be circular.

## No password verification, by design

`unlockProfile(serial, passphrase)` re-derives a master key from the
stored salt and the given passphrase — there is no stored password hash
or verifier record to check the result against. A wrong passphrase
silently produces a wrong (but well-formed) key; the first operation
against that profile's real data then fails to decrypt (AES-GCM throws
on its auth tag; BPC — never used for anything but the demo workbench —
would just produce garbage, since it has no authentication tag at all).

This matches the rest of the project's posture (see
`docs/THREAT-MODEL.md`): "no session, no derivable key" rather than a
distinct authentication primitive. Adding real password verification
would mean storing *something* derived from the passphrase purely to
check it — which is both extra attack surface and a bigger scope than
this project's single-operator framing calls for.

## Isolation is structural, not just logical

Every path derived from a profile goes through `validateSerial` first,
which accepts only the exact 26-character Crockford-base32 shape
`generateUlid()` produces — this is the guard against path traversal
that matters the moment a serial is ever accepted from outside this
process (an HTTP request body, say). Given a valid serial, its shard
lives at `profiles/PROFILE-<serial>/`, entirely separate files with
entirely separate `AppendLog`/mutex state from every other profile — a
crash or compaction in one profile's shard structurally cannot touch
another's, because they don't share a file handle, a rename target, or
any in-memory state.

## Lazy loading and LRU eviction

`ShardManager` doesn't open anything until a profile is actually
accessed (`profiles.index`/the registry itself stays small and is the
only thing scanned in full at boot — spec 10.5's actual goal). A
JS `Map`'s insertion order does double duty as an LRU queue: a cache hit
deletes-then-reinserts a key to bump it to the most-recently-used end,
so the least-recently-used entry is always whatever key iterates first;
eviction closes that entry's underlying files before dropping it,
bounding how many shards' file handles stay open at once regardless of
how many profiles exist in total.

## Not yet wired into the HTTP layer

`AppContext` (Phase 4) still exposes exactly one `DocumentStore` — the
single-tenant model Phases 4-7 were built and tested against — and this
subsystem isn't yet plugged into `/api/auth/unlock`. That integration
(new endpoints, sessions carrying a profile serial, `getStore()` needing
to know *which* tenant's store to hand back) is real additional surface
area, and doing it well means touching already-solid, already-tested
routes rather than bolting it on carelessly. `ProfileRegistry` and
`ShardManager` are implemented and tested as a complete, correct,
standalone subsystem here; wiring them into the HTTP API is the natural
next step, deliberately sequenced after the rest of the core is stable
rather than done as a rushed pass through working code.
