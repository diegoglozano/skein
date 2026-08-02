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
| **anonymous memory required** | **700 MB** | **600 MB** | **200 MB** |

## `huge` — 10M nodes / 100M edges (1.72 GB CSV)

| | pre-D16 | D16 mmap |
|---|---|---|
| ingest (CSV → CSR) | 61.8 s | 61.6 s |
| hierarchy | 110.0 s | 112.7 s |
| peak RSS | 5471 MB | 4397 MB |

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
exactly as anonymous pages do. Peak RSS answers "how much *was* resident", and
the question this change is about is "how much *has to be*".

`ulimit -d` sets `RLIMIT_DATA`, which since Linux 4.7 bounds anonymous mappings
and deliberately does **not** bound file-backed ones. So it is exactly the
discriminator: the reported figure is the smallest limit at which the run
completes instead of aborting in the allocator, bisected over the values in
`/tmp/floors.sh`-style sweeps.

```sh
( ulimit -d 300000; ./out_of_core bench/fixtures/medium.csv --scratch heap )  # aborts
( ulimit -d 300000; ./out_of_core bench/fixtures/medium.csv --scratch mmap )  # completes
```

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
