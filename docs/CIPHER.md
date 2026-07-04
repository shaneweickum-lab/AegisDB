# The Banded Permutation Cipher (BPC)

Replaces the original spec's "Exponential Frequency Shifter" (EFS). This
document explains why EFS as originally specified doesn't reliably work,
and the corrected construction actually implemented in `src/crypto/bpc/`.

## Why EFS (as specified) doesn't round-trip

EFS's decode step needs to recover a character `ch` from an output byte,
using `ch`'s own historical occurrence count `C(ch)` to invert the
substitution. But `C(ch)` is indexed by `ch` — you can't look up the count
without already knowing the character you're trying to determine. That's
circular. Worse, `B(ch)^(1 + C(ch)/10)` is computed as an IEEE-754 double;
for a character repeated hundreds of times in a real document, the
exponent grows past the point where a `*1000`-scaled fixed-point reduction
still carries meaningful precision, so long documents can silently produce
non-invertible output. And because the transform crams an unbounded
`(character, count)` domain into a single output byte (256 possible
values), the pigeonhole principle guarantees collisions once counts grow —
there is no fix that makes the *original* per-byte scheme collision-free
for an unbounded count.

## The fix: band the count, partition the output space, keep everything integer

**Banding.** Instead of an unbounded, continuously-scaling exponent, bucket
a character's historical count into a small number of discrete bands:

```
band(count) = min( bitlen(count + 2) - 1, BAND_MAX )   // = floor(log2(count+2)), capped
```

This is integer-only and reproduces the spirit of the original curve —
early occurrences cluster in low bands, later occurrences drift into
higher bands — without floating point, and it reuses the spec's own
"band" vocabulary from the visualizer section (Section 5.2's diff view
already talks about coloring by "historical-count band").

**Disjoint output ranges per band, and why the alphabet is all 256 byte
values, not just printable ASCII.** The cipher has to transform an
arbitrary UTF-8 byte stream (`JSON.stringify(doc)` can contain braces,
quotes, control bytes, multi-byte Unicode — anything), so restricting the
alphabet to the spec's ~90 named symbols (letters/digits/punctuation)
would require an escape mechanism for every other byte, which is
avoidable complexity. Instead the alphabet is simply **all 256 byte
values** (`alphabetIndex(byte) = a fixed bijective reordering of
0..255`, built once — see `src/core/alphabet.ts`), which also simplifies
the band-slot math: the per-band slot width `A` is exactly `256`, so a
band occupies one high byte value and the in-band code is exactly one low
byte. With a 16-bit (2-byte) output, `65536 / 256 = 256` structurally
possible bands; `BAND_MAX` is capped at `31` for a rich but legible drift
(32 active bands), leaving bands 32-255 simply unused (encode never emits
them, so decode never needs to handle them).

A 1-byte "compact" mode was considered, but with a full 256-value
alphabet a disjoint band needs the *entire* 1-byte output space, leaving
zero room for a second band — i.e. 1-byte output can only ever support
band 0 (no drift at all). That's a real, discovered constraint of
choosing full-byte-alphabet correctness over the original spec's
implied ~90-symbol table — it means "1-byte, byte-parity-preserving BPC"
is out of scope, not a partial variant worth shipping. `bpc-2b` is the
only BPC engine implemented.

**Per-band keyed bijection.** Within band `b`, a permutation `π_b` over
`[0, 256)` maps each byte's alphabet index to an in-band code. `π_b` is
generated once per document key by seeded Fisher–Yates, with the shuffle's
randomness streamed from HKDF-Expand(`DocumentKey`, `"bpc-band-" + b`)
**using rejection sampling, not modulo**, to select unbiased indices —
modulo-biased shuffles would visibly skew the output histogram and
undermine the exact flattening effect the visualizer exists to demonstrate.

**Keystream application point — the one non-obvious trap.** The original
spec's IV-derived keystream is applied as a final full-width XOR. Doing
that here would XOR across the band bits too, scrambling which disjoint
range an output value falls into and destroying the very invariant decode
depends on. The fix is to apply the keystream **inside the band's slot
only** — XOR with a full keystream byte, which trivially stays within
`[0, 256)` since the slot width *is* 256:

```
encode(ch at position i):
  s      = alphabetIndex(ch)
  c      = count[ch]; count[ch] = c + 1        # read before increment
  b      = band(c)
  inband = permute(b, s) XOR keystreamByte(i)   # stays in [0, 256)
  out16  = b * 256 + inband                     # disjoint by construction

decode(out16 at position i):
  b      = out16 >> 8                            # exact, no search
  inband = out16 & 0xFF
  code   = inband XOR keystreamByte(i)
  s      = inversePermute(b, code)               # O(1) table lookup
  ch     = symbol(s); count[ch] += 1             # stays in lockstep with encoder
```

The IV keystream derivation (spec 2.4.2) and per-document HKDF key
derivation (spec 4.3) are otherwise unchanged from the original design.

## Why this is provably correct

- Band ranges are disjoint by construction → the band is recoverable from
  the output value alone, with no ambiguity and no search.
- Within a fixed band, `s -> permute(b, s) XOR keystreamByte(i)` is the
  composition of a permutation and a fixed-value XOR on `[0, A)` — both
  bijections, so the composition is injective and directly invertible by
  table lookup.
- Decode reconstructs `count[ch]` in lockstep with encode, one symbol at a
  time, in the same order — there's no chicken-and-egg, because decode
  never needs a character's count *before* determining that character;
  it always determines the character for position `i` using the counts
  built from positions `0..i-1`, which is exactly the count encode used.

This is validated empirically in `test/property/bpc-bijection.test.ts`
(exhaustive per-band permutation-and-disjointness checks) and
`test/property/cipher-roundtrip.test.ts` (round-trip across random input,
and specifically the pathological case that broke the original design: a
single character repeated thousands of times).

**Bonus: no stored state header needed.** The original spec (Section 1.3)
stores a "cipher state header" (a FREQ_STATE snapshot) alongside every
record specifically so decode doesn't have to replay prior state. BPC
doesn't need this at all — a symbol's band is stored directly in its own
ciphertext (the high byte), so decode reads it off with no external state.
Occurrence counts are still tracked during decode, but only to populate
the visualizer's trace output (`CipherTrace`), not because correctness
requires it.

## Engine interface

Both BPC and the real AES-256-GCM engine implement the same boundary
(see `src/crypto/engine.ts`):

```ts
interface CipherEngine {
  readonly id: 'aes-256-gcm' | 'bpc-2b';
  seal(plaintext: Uint8Array, ctx: SealContext): SealedRecord;
  open(sealed: SealedRecord, ctx: SealContext): Uint8Array;
}
```

See `docs/THREAT-MODEL.md` for which engine is actually responsible for
protecting data at rest.
