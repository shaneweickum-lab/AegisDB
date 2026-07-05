# AegisDB

A cryptographic micro-database built with zero runtime dependencies —
a hand-designed stream cipher, a crash-safe flat-file storage engine, a
hand-rolled HTTP + WebSocket server, and a live browser visualizer of
the cipher's internals, built end to end on Node.js built-ins.

This started from a detailed product spec for a portfolio/learning
project, built with Claude Code. The point of documenting it this way
isn't the code volume — it's the process: the spec's own cipher design
had a real bug, and the most interesting part of this repo is finding
it, understanding *why* it was broken, and fixing it with something
provably correct instead of shipping it as written.

## The one thing worth reading first: the cipher bug

The original spec's cipher ("EFS") made each character's substitution
drift based on how many times it had already occurred in the stream —
a nice idea for flattening frequency analysis. But decoding it requires
knowing a character to look up *that character's own* occurrence count,
which is circular, and its floating-point exponentiation loses the
precision it depends on once a character repeats more than a few dozen
times. It's not a "this isn't real crypto" problem (the spec was
upfront about that) — it's that the described transform doesn't
reliably round-trip at all.

The fix (`docs/CIPHER.md`) buckets the count into discrete integer
*bands*, partitions the output space into disjoint per-band ranges (so
decode reads the band directly off the ciphertext with zero search and
zero collisions), and — the one truly non-obvious part — moves the
IV keystream from a final full-width XOR to *inside* each band's slot,
because applying it across the band bits would silently break the very
disjointness decode depends on. It's validated with property tests
that exhaustively check every band's permutation is bijective, plus the
specific case that broke the original design: a single character
repeated 50,000 times.

The real primitive protecting data at rest is AES-256-GCM
(`docs/THREAT-MODEL.md`) — the redesigned cipher is the pedagogical,
visualizer-facing one, and the codebase is explicit about which is
which rather than blurring the line.

## What's actually in here

| Layer | What it is | From scratch? |
| --- | --- | --- |
| Crypto (`src/crypto/`) | AES-256-GCM (real) + the Banded Permutation Cipher (pedagogical) behind one interface | Cipher design + ULID + unbiased Fisher–Yates shuffle |
| Storage (`src/storage/`) | Append-only data+index log, crash recovery, generation-tagged compaction | Entire engine — record framing, WAL, recovery, compaction |
| Documents (`src/storage/store.ts`) | Generic encrypted JSON collections on top of the storage engine | — |
| HTTP (`src/server/`) | Router, static file server, JSON body parsing, session auth | Entire server — no Express |
| WebSocket (`src/server/ws/`) | RFC 6455 handshake, framing, fragmentation, ping/pong | Entire protocol — no `ws` package |
| Visualizer (`public/`) | Canvas-drawn histogram, band-drift curve, cipher diff view | No charting library, no bundler |
| Ingestion (`src/ingest/`) | `.docx` text extraction | ZIP container parsing + regex XML text extraction (DEFLATE itself is `node:zlib`) |
| Tenancy (`src/tenancy/`) | One isolated shard per user profile, lazily opened, LRU-evicted | — |
| Deploy (`src/deploy/`) | One config object for local-tunnel vs. VPS modes | — |

Everything above runs on `node:http`, `node:crypto`, `node:fs`,
`node:zlib`, and `node:test` — no framework, no charting library, no
WebSocket package, no ZIP/XML parser. TypeScript is the one accepted
devDependency (dev-only; the dev loop runs source directly via Node's
`--experimental-strip-types`, so there's no build step in the way).

See `docs/SPEC.md` for the original product spec this was built from,
and the rest of `docs/` for the design decisions made along the way
(`CIPHER.md`, `THREAT-MODEL.md`, `STORAGE.md`, `TENANCY.md`, `API.md`,
`DEPLOYMENT.md`).

## Testing philosophy

189 tests, all exercising real behavior rather than mocks wherever it
was practical to do so — a real HTTP server on a real socket, a real
WebSocket handshake via Node's own `WebSocket` client, a genuinely
valid hand-built ZIP archive rather than a simplified stand-in. The
headline test truncates a written log at *every single byte offset*
and asserts recovery always yields exactly the largest valid prefix;
a second suite hand-constructs each of the four possible crash windows
in compaction's rename dance (including the one — a promoted data file
paired with an unpromoted index — that a naive "is the file missing"
check wouldn't catch) and asserts recovery always resolves to one
consistent generation.

Two real bugs were caught this way, not by inspection: `Shard.open()`
assumed its directory already existed (true in every test, since
`mkdtemp` pre-creates it — false on an actual first run, caught by
manually driving the app in a real browser), and the compaction report
computed "bytes reclaimed" from the wrong number, silently reporting
zero for the most common case (many overwrites of the same few keys)
instead of a compaction that was, in fact, doing real work.

## Benchmarks

From `npm run bench`, run on the same machine this was built on — not a
promise these numbers hold everywhere, just real measurements instead
of none:

```
Sealed-write throughput (AES-256-GCM vs BPC):
  aes-256-gcm     1024B x  200 ->      6.9ms  (28.35 MB/s, 29026 ops/s)
  bpc-2b          1024B x  200 ->     88.6ms  (2.20 MB/s, 2257 ops/s)
  aes-256-gcm   102400B x   20 ->      1.2ms  (1615.92 MB/s, 16547 ops/s)
  bpc-2b        102400B x   20 ->    110.3ms  (17.70 MB/s, 181 ops/s)

DocumentStore insert/get throughput:
  insert       500 docs -> 1115.7ms  (448 docs/s)
  get (by id)  500 docs -> 59.6ms  (8393 docs/s)

Compaction time vs. live-set size:
    500 writes (50 live) -> 98.3ms, reclaimed 143919 bytes
   2000 writes (200 live) -> 362.6ms, reclaimed 576819 bytes

WebSocket telemetry throughput:
  5000 messages -> 43.8ms  (114204 msgs/s)
```

BPC is roughly an order of magnitude slower than AES-256-GCM per byte —
expected and not a problem: it processes a symbol at a time through a
keyed permutation table plus an HKDF-driven keystream, versus AES-NI's
hardware-accelerated block cipher. It's the visualizer's engine, not
the one anything real depends on. `insert` throughput (448 docs/s) is
lower than it might look at first — each write does two `fsync` calls
(data, then index) by design, since that ordering is exactly what makes
the crash-recovery guarantee hold; that's the throughput cost of the
durability guarantee, not an accident.

## Development

```
npm run dev         # run the server directly from TS source (no build step)
npm test            # node:test, run directly against TS source
npm run typecheck   # tsc, full project including tests
npm run build       # tsc -> dist/
npm run bench       # the numbers above
```

Requires Node >= 22.6 (uses `--experimental-strip-types`).

## What's not in this repo

The spec's "faux social media platform" (Section 9) is being built as a
**separate repository** that consumes AegisDB purely through its
documented REST/WS API (`docs/API.md`) — proving the API is a real,
reusable boundary rather than internal glue code, and giving it its own
genuine business-logic layer rather than being a thin pass-through.
Multi-tenant profile sharding (`src/tenancy/`) is implemented and
thoroughly tested as a standalone subsystem but not yet wired into the
HTTP session layer (`docs/TENANCY.md` explains why, and what "wired in"
would involve).
