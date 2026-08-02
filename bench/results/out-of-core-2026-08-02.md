# Out-of-core hierarchy build (D16) — 2026-08-02

Not the reference laptop. These were taken in a Linux dev container — 4 cores,
15 GB RAM, no swap, ext4 on a virtio disk — because the claim under test is a
*threshold* (how much RAM a run requires) and a *ratio*, not an absolute
wall-clock number. D3/D5 still apply to timings: nothing here is evidence about
§9's budgets, which are the M3 Air's to state.

Harness: `cargo run --release --example out_of_core -- <csv> [--scratch heap|mmap]`,
one storage tier per process because peak RSS is a process-lifetime high-water
mark. "pre-D16" is commit `890187a` with the same harness adapted to its API.

Fixtures are generated, never committed: `node bench/generate-fixtures.mjs medium huge`.

## `medium` — 1M nodes / 10M edges

| | pre-D16 | D16 heap | D16 mmap |
|---|---|---|---|
| hierarchy | 4.71 s | 4.66 s | 5.35–5.63 s |
| peak RSS | 512 MB | 496 MB | 517 MB |
| **anonymous memory required** | **650 MB** | **500 MB** | **80 MB** |
| (largest limit that still aborted) | 600 MB | 400 MB | 60 MB |

**8.1× less RAM required.**

## `huge` — 10M nodes / 100M edges (1.72 GB CSV)

| | pre-D16 | D16 heap | D16 mmap |
|---|---|---|---|
| ingest (CSV → CSR) | 61.8 s | — | 61.6 s |
| hierarchy | 110.0 s | — | 112.7 s |
| peak RSS | 5471 MB | — | 4397 MB |
| **anonymous memory required** | **6500 MB** | **5500 MB** | **700 MB** |
| (largest limit that still aborted) | 6000 MB | 4500 MB | 600 MB |

**9.3× less RAM required**, and ~440 MB of that 700 MB is the input CSR the
harness holds on the heap — `skein-native` maps `<source>.skein` instead, so the
hierarchy build itself needs on the order of 260 MB to coarsen a 200M-arc level.

Floors are bracketed by the probe steps above, not bisected to the megabyte: each
figure is the smallest limit tried at which the build completed, with the largest
one that still aborted underneath it. Timings for the D16 heap tier at this size
were not taken — the tiers to compare here are the one that shipped before and
the one this adds.

Hierarchy shape, identical on both:

```
L0   10000000 nodes    199997776 arcs   checksum ef4b62f5bceebd4e
L1     700443 nodes    180392218 arcs   checksum ff1c9809ebbc8fe4
L2     175873 nodes     88695938 arcs   checksum a5805bee7d0513e9
L3     149942 nodes      4155626 arcs   checksum babe3cda56e80407
```

## How "anonymous memory required" is measured, and why RSS is not the number

Run unconstrained, the tiers look identical: with 15 GB free the kernel has no
reason to evict anything, so mapped pages stay resident and count toward RSS
exactly as anonymous pages do. Peak RSS answers "how much *was* resident"; the
question this change is about is "how much *has to be*".

`RLIMIT_DATA` bounds anonymous mappings and, since Linux 4.7, deliberately does
**not** bound file-backed ones — exactly the discriminator. The harness's
`--limit-mb N` sets it *after* ingest and after `malloc_trim(0)`, so the figure
describes the hierarchy build rather than the whole pipeline. That matters: at
the 100M tier ingest's own transient is larger than anything the hierarchy needs
out-of-core, so a process-wide `ulimit -d` would measure ingest and report the
tiers as equal. Each figure is the smallest limit at which the build completes
instead of aborting in the allocator.

```sh
./out_of_core bench/fixtures/medium.csv --scratch heap --limit-mb 400   # aborts
./out_of_core bench/fixtures/medium.csv --scratch mmap --limit-mb 400   # completes
```

The out-of-core figures are over-estimates for `skein-native` by roughly
`4 * (nodes + edges)` bytes: this harness holds the *input* CSR on the heap
because `skein-core` has no store, where the native binary maps
`<source>.skein` and pays nothing anonymous for it.

## Determinism (D2)

Per-level FNV-1a checksums over `offsets`, `targets` and `weights` bits are
identical across pre-D16, the D16 heap path and the D16 mmap path, at both
`medium` and `huge`. A changed `f32` summation order would be a different
layout, so this is the result that gates the change; the unit tests assert the
same thing against the pre-counting-sort reference implementation across forced
band sizes.

## Caveat that would invalidate a rerun

The scratch directory must not be tmpfs. `/tmp` is tmpfs on most Linux installs
and its pages are swap-backed, so a scratch file there reclaims nothing while
appearing to work — on this container `/tmp` is on the real disk, and the
harness defaults the scratch beside the input file regardless.
