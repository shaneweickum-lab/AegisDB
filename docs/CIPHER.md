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

**Disjoint output ranges per band.** Pick a per-band slot width `A`, a
power of two, at least as large as the alphabet (`A = 128` for a ~90-symbol
alphabet). With a 16-bit output (2 bytes per input symbol), the 65536-value
space splits into up to 512 disjoint bands of width 128 — cap `BAND_MAX`
around 32 for a rich but legible drift. Band `b` owns exactly the range
`[b*A, (b+1)*A)`. Because the ranges never overlap, **the band is a pure
function of the output value** — decode reads it directly (`out16 >> 7`),
no search required.

A 1-byte "compact" mode is also offered, but the same pigeonhole math caps
it at 2–3 usable bands (`256 / 128`), since a full alphabet-sized disjoint
band needs at least 128 slots. Default engine id is `bpc-2b`; `bpc-1b` is
available for anyone who wants the coarser, byte-parity-preserving variant.

**Per-band keyed bijection.** Within band `b`, a permutation `π_b` over
`[0, A)` maps each alphabet symbol's index to an in-band code. `π_b` is
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
only** — XOR with a 7-bit keystream byte, which by construction stays
within `[0, A)` since `A` is a power of two:

```
encode(ch at position i):
  s      = alphabetIndex(ch)
  c      = count[ch]; count[ch] = c + 1        # read before increment
  b      = band(c)
  inband = permute(b, s) XOR keystreamByte(i)   # stays in [0, A)
  out16  = b * A + inband                       # disjoint by construction

decode(out16 at position i):
  b      = out16 >> 7                            # exact, no search
  inband = out16 & (A - 1)
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

## Engine interface

Both BPC and the real AES-256-GCM engine implement the same boundary
(see `src/crypto/engine.ts`):

```ts
interface CipherEngine {
  readonly id: 'aes-256-gcm' | 'bpc-2b' | 'bpc-1b';
  seal(plaintext: Uint8Array, ctx: SealContext): SealedRecord;
  open(sealed: SealedRecord, ctx: SealContext): Uint8Array;
}
```

See `docs/THREAT-MODEL.md` for which engine is actually responsible for
protecting data at rest.
