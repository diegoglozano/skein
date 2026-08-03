# The skein mark

![skein](logo-wordmark.svg)

A skein is one continuous length of yarn, wound so it does not tangle. The mark
is that literally: a single closed thread tied in a **trefoil knot** — the
simplest knot that cannot be pulled undone — with a **node bead** on each of its
three lobes. It reads as a graph (three nodes, edges between them) and as a
skein at the same time, which is the whole of the idea.

The green bead is the same green as the privacy badge, and it sits at the top.

## Files

| File | What it is | Where it is used |
|---|---|---|
| `logo.svg` | the mark alone, transparent, cropped to its ink | anywhere that brings its own backdrop and its own spacing |
| `logo-tile.svg` | the mark on the app's background, rounded square | app icon; inlined as the favicon in `web/index.html` |
| `logo-wordmark.svg` | mark plus the name, on a dark plate | the banner at the top of `README.md` |

The plate on the banner is deliberate. GitHub renders a README image inside an
`<img>`, which cannot react to the reader's light or dark theme, so the banner
carries its own background and looks identical in both. `logo.svg` is the
opposite trade: transparent, and legible on either — the beads are ringed in the
dark end of the strand gradient precisely so their pale fills still read when
the mark lands on white.

## Palette

Every colour is already in `web/src/ui/app.css`; the mark introduces none.

| | |
|---|---|
| `#0b0b12` | background — the app's canvas |
| `#93a8ff` → `#4a5fd0` | the thread, as a diagonal gradient |
| `#cfdcff` | node beads |
| `#7fd4a3` | the accent bead, and the tittle on the `i` — the privacy-badge green |
| `#e6e6ea` | the wordmark |

## The wordmark

Drawn as monoline paths at the same stroke weight as the thread, so the name
reads as having been wound from it. It is outlined rather than set in a font on
purpose: an SVG embedded through `<img>` gets whatever fonts the reader happens
to have installed, and a wordmark that reflows on someone else's machine is not
a wordmark. The tittle on the `i` is a node bead.

## Regenerating

```sh
npm run logo        # node tools/logo.mjs
```

That rewrites all three SVGs **and** the inlined favicon in `web/index.html`, so
there is no second copy of the mark to keep in step by hand. Commit the result;
the SVGs are checked in, unlike fixtures.

The knot is generated rather than drawn, because its geometry is exact and worth
keeping exact. `tools/logo.mjs` evaluates the (2,3) torus knot
`x = sin t + 2 sin 2t`, `y = cos t − 2 cos 2t`, finds the curve's three real
self-intersections numerically, and places the over/under interlacing on them.
It asserts what it assumes rather than trusting it:

- there are exactly **three** crossings;
- following the thread, the crossings **alternate** over-under-over, so taking
  every other passage is a valid over/under assignment;
- the three crossing **angles** are equal and the three over-passages are
  exactly a third of the thread apart — that 3-fold symmetry is what lets one
  repeating dash pattern land on all three crossings at once, which is why the
  whole mark is a single `<path>` referenced three times and only 2.6 kB;
- the bezier fit's length matches the true arc length to within 1%, since the
  dash offsets are computed from the latter.

Change a parameter and the fit, the centring and the banner's proportions follow
from the ink's bounding box; nothing is a hand-tuned constant that has to be
re-tuned alongside.
