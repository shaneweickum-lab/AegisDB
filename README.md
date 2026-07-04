# AegisDB

A zero-runtime-dependency cryptographic micro-database, built end to end
on Node.js built-ins: a hand-designed stream cipher, an append-only
flat-file storage engine with crash recovery and compaction, a hand-rolled
HTTP + WebSocket server (no Express, no `ws`), a live browser visualizer
of the cipher's internals, file ingestion with hand-parsed `.docx`
extraction, a small social feed app, and multi-tenant profile-sharded
storage — all built with Claude Code as an AI-assisted-engineering
learning exercise.

## Why zero runtime dependencies

Everything runs on `node:http`, `node:crypto`, `node:fs`, `node:zlib`, and
`node:test`. No framework, no charting library, no WebSocket package, no
ZIP/XML parser. TypeScript is the one accepted devDependency (compiled
with `tsc`; the dev loop uses Node's native `--experimental-strip-types`
so there's no build wait). See `docs/SPEC.md` for the original product
spec and `docs/CIPHER.md` / `docs/THREAT-MODEL.md` for the corrected
cipher design and how its two engines (a real AES-256-GCM engine and a
pedagogical custom cipher) are honestly scoped.

## Status

Early scaffold. Build phases are tracked in-repo as the project
progresses; see `docs/` for design docs as they land.

## Development

```
npm run dev         # run the server directly from TS source (no build step)
npm test            # node:test, run directly against TS source
npm run typecheck   # tsc --noEmit
npm run build       # tsc -> dist/
```

Requires Node >= 22.6 (uses `--experimental-strip-types`).
