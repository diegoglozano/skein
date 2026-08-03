#!/usr/bin/env node
// Generates the skein logo files in docs/ — see docs/BRAND.md for what they are
// and where each one is used.
//
//   node tools/logo.mjs        # or: npm run logo
//
// The mark is a trefoil knot — one continuous thread, tied in the simplest knot
// there is — with a node bead on each of its three lobes. It is generated rather
// than drawn because the geometry is exact: the strand is the parametric curve
// below, and the over/under interlacing sits at its real self-intersections,
// found here rather than eyeballed.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Palette, all of it already in web/src/ui/app.css.
const BG = '#0b0b12'; // app background
const STRAND_A = '#93a8ff';
const STRAND_B = '#4a5fd0';
const NODE = '#cfdcff';
const ACCENT = '#7fd4a3'; // the privacy badge green
const TEXT = '#e6e6ea';

const TAU = Math.PI * 2;
const r2 = (n) => Math.round(n * 100) / 100;

// ── the strand: the (2,3) torus knot ────────────────────────────────────────
// |r|^2 = 5 - 4cos(3t), so the three lobe tips are at t = pi/3, pi, 5pi/3.
const point = (t) => ({
  x: Math.sin(t) + 2 * Math.sin(2 * t),
  y: Math.cos(t) - 2 * Math.cos(2 * t),
});

/** Self-intersections of the closed curve, by brute force over a fine polyline. */
function crossings() {
  const N = 3000;
  const p = Array.from({ length: N }, (_, i) => point((i / N) * TAU));
  const found = [];
  for (let i = 0; i < N; i++) {
    const a = p[i];
    const b = p[(i + 1) % N];
    for (let j = i + 2; j < N; j++) {
      if (i === 0 && j === N - 1) continue; // adjacent across the wrap
      const c = p[j];
      const d = p[(j + 1) % N];
      const den = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
      if (Math.abs(den) < 1e-12) continue;
      const u = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / den;
      const v = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / den;
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      const hit = {
        ta: ((i + u) / N) * TAU,
        tb: ((j + v) / N) * TAU,
        x: a.x + u * (b.x - a.x),
        y: a.y + u * (b.y - a.y),
      };
      if (!found.some((o) => Math.hypot(o.x - hit.x, o.y - hit.y) < 1e-3)) found.push(hit);
    }
  }
  return found;
}

const cross = crossings();
if (cross.length !== 3) throw new Error(`expected 3 crossings, found ${cross.length}`);

// A knot diagram alternates: following the thread you pass over, then under,
// then over… so sorting the six passages by parameter and taking every other one
// gives the strand that lies on top. That is only a valid assignment if each
// crossing ends up with exactly one — assert it rather than assume it.
const passages = cross
  .flatMap((c, i) => [
    { t: c.ta, crossing: i },
    { t: c.tb, crossing: i },
  ])
  .sort((a, b) => a.t - b.t)
  .map((p, i) => ({ ...p, over: i % 2 === 0 }));
const over = passages.filter((p) => p.over);
if (new Set(over.map((p) => p.crossing)).size !== 3) {
  throw new Error('crossings do not alternate; the over/under assignment is wrong');
}

// ── projection into the 100x100 tile ────────────────────────────────────────
const SIZE = 100;
const PAD = 8;
const STRAND_W = 7.5;
const GAP = 3; // clearance either side of the strand that passes over
const CASING = STRAND_W + 2 * GAP;
const NODE_R = 8.5;

const LOBES = [Math.PI / 3, Math.PI, (5 * Math.PI) / 3]; // where the beads sit
const FINE = 6000;
const curve = Array.from({ length: FINE + 1 }, (_, i) => point((i / FINE) * TAU));

// Fit the ink — thread and beads, not the bare curve — to the tile. The knot's
// bounding box is neither square nor centred on the origin (it reaches 3 up and
// 2.06 down), so a hand-picked scale leaves it sitting visibly high.
function extents(s) {
  const box = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
  const add = (x, y, r) => {
    box.x0 = Math.min(box.x0, x * s - r);
    box.x1 = Math.max(box.x1, x * s + r);
    box.y0 = Math.min(box.y0, y * s - r);
    box.y1 = Math.max(box.y1, y * s + r);
  };
  for (const p of curve) add(p.x, p.y, STRAND_W / 2);
  for (const t of LOBES) add(point(t).x, point(t).y, NODE_R);
  return { ...box, w: box.x1 - box.x0, h: box.y1 - box.y0 };
}
let SCALE = 10;
for (let i = 0; i < 40; i++) {
  const e = extents(SCALE);
  SCALE *= (SIZE - 2 * PAD) / Math.max(e.w, e.h);
}
const INK = extents(SCALE);
const OX = (SIZE - INK.w) / 2 - INK.x0;
const OY = (SIZE - INK.h) / 2 - INK.y0;
const project = (p) => ({ x: OX + p.x * SCALE, y: OY + p.y * SCALE });

// Arc length, so the three over-segments can be placed with one dash pattern.
const fine = curve.map(project);
const cum = [0];
for (let i = 1; i <= FINE; i++) {
  cum.push(cum[i - 1] + Math.hypot(fine[i].x - fine[i - 1].x, fine[i].y - fine[i - 1].y));
}
const LENGTH = cum[FINE];
const arcAt = (t) => {
  const f = (t / TAU) * FINE;
  const i = Math.floor(f);
  return cum[i] + (cum[Math.min(i + 1, FINE)] - cum[i]) * (f - i);
};

// The curve has 3-fold rotational symmetry and one over-passage per copy, so the
// three of them are exactly a third of the thread apart. That is what lets a
// single repeating dash pattern land on all three at once.
const arcs = over.map((p) => arcAt(p.t)).sort((a, b) => a - b);
for (let i = 0; i < 3; i++) {
  const gap = arcs[(i + 1) % 3] - arcs[i] + (i === 2 ? LENGTH : 0);
  if (Math.abs(gap - LENGTH / 3) > 0.2) {
    throw new Error(`over-passages are not evenly spaced: gap ${gap} vs ${LENGTH / 3}`);
  }
}

// How much of the thread to redraw on top of each crossing. Long enough to cut
// the strand underneath clean through and no longer, or the under-strand loses
// a visible stretch of itself either side of the crossing. The two strands meet
// at `theta`, so the cut has to run (w + casing·cos theta) / sin theta along the
// one on top to sever a band of width w across it.
const tangent = (t) => {
  const d = { x: Math.cos(t) + 4 * Math.cos(2 * t), y: -Math.sin(t) + 4 * Math.sin(2 * t) };
  const n = Math.hypot(d.x, d.y);
  return { x: d.x / n, y: d.y / n };
};
const angles = cross.map((c) => {
  const [u, v] = [tangent(c.ta), tangent(c.tb)];
  return Math.acos(Math.min(1, Math.abs(u.x * v.x + u.y * v.y)));
});
if (Math.max(...angles) - Math.min(...angles) > 1e-3) {
  throw new Error('crossing angles differ; the mark is not 3-fold symmetric');
}
const theta = angles[0];
const OVER_LEN = (STRAND_W + CASING * Math.cos(theta)) / Math.sin(theta) + 1.5;

// `pathLength` renormalises the dash units to the path the renderer actually
// measures, so small differences between the bezier fit and the true curve
// cannot drift the dashes off the crossings.
const PATH_LEN = 3000;
const unit = PATH_LEN / LENGTH;
// Same centre, two lengths. The strand drawn on top overhangs the hole punched
// for it by half a unit at each end, so the two antialiased edges overlap
// instead of meeting — otherwise a hairline of background shows through the
// thread at every crossing.
const dashes = (len) => {
  const d = len * unit;
  return ` stroke-dasharray="${r2(d)} ${r2(PATH_LEN / 3 - d)}" stroke-dashoffset="${r2(d / 2 - arcs[0] * unit)}"`;
};
const CUT = dashes(OVER_LEN);
const TOP = dashes(OVER_LEN + 1);

// ── the curve as cubic beziers ──────────────────────────────────────────────
// Catmull-Rom through evenly spaced samples. 48 is where the fit stops
// improving visibly and the file is still small; the assert below is the real
// bound.
const SAMPLES = 48;
const pts = Array.from({ length: SAMPLES }, (_, i) => project(point((i / SAMPLES) * TAU)));
const at = (i) => pts[((i % SAMPLES) + SAMPLES) % SAMPLES];
let loop = `M${r2(at(0).x)} ${r2(at(0).y)}`;
for (let i = 0; i < SAMPLES; i++) {
  const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
  const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
  const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
  loop += `C${r2(c1.x)} ${r2(c1.y)} ${r2(c2.x)} ${r2(c2.y)} ${r2(p2.x)} ${r2(p2.y)}`;
}
loop += 'Z';

// Sanity-check the fit: the bezier chain's length must match the true arc
// length, or the dash offsets computed above land in the wrong place.
{
  const approx = pts.reduce(
    (acc, p, i) => acc + Math.hypot(p.x - at(i - 1).x, p.y - at(i - 1).y),
    0,
  );
  if (Math.abs(approx - LENGTH) / LENGTH > 0.01) {
    throw new Error(`bezier fit is ${((1 - approx / LENGTH) * 100).toFixed(1)}% short`);
  }
}

// The bead on each lobe. Ringed in the dark end of the strand gradient: on the
// app's background that only reads as a node's outline, but it is also what
// keeps the pale fills legible when the transparent mark lands on white.
const beads =
  `<g stroke="${STRAND_B}" stroke-width="3">` +
  LOBES.map((t) => project(point(t)))
    .map(
      (p, i) =>
        `<circle cx="${r2(p.x)}" cy="${r2(p.y)}" r="${NODE_R - 1.5}" fill="${i === 1 ? ACCENT : NODE}"/>`,
    )
    .join('') +
  '</g>';

// One path, referenced three times: masked (the thread, with the crossings
// punched out), dashed into the mask (the punch), and dashed on top (the strand
// that passes over). Identical geometry every time, so the seams are invisible.
const MARK = `<defs>\
<linearGradient id="s" x1="0" y1="0" x2="1" y2="1">\
<stop offset="0" stop-color="${STRAND_A}"/><stop offset="1" stop-color="${STRAND_B}"/>\
</linearGradient>\
<path id="k" d="${loop}" pathLength="${PATH_LEN}"/>\
<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="${SIZE}" height="${SIZE}">\
<rect width="${SIZE}" height="${SIZE}" fill="#fff"/>\
<use href="#k" fill="none" stroke="#000" stroke-width="${CASING}"${CUT}/>\
</mask>\
</defs>\
<g fill="none" stroke="url(#s)" stroke-width="${STRAND_W}">\
<use href="#k" mask="url(#m)"/>\
<use href="#k"${TOP}/>\
</g>${beads}`;

// ── the wordmark ────────────────────────────────────────────────────────────
// Drawn with the same monoline stroke as the thread, so the name reads as
// having been wound from it. Baseline y = 0, x-height 44, ascender 62. Letters
// are outlined rather than set in a font: an <img>-embedded SVG gets whatever
// the reader has installed, and a wordmark that reflows is not a wordmark.
const STEM = 8;
const LETTERS = [
  // s — two bowls, the upper opening right, the lower opening left
  [0, 'M30-33C30-40 24-44 17-44C10-44 4-40 4-34C4-28 9-25 17-23C25-21 30-17 30-11C30-5 24 0 17 0C10 0 4-4 4-11'],
  // k — ascender stem, then the two diagonals
  [46, 'M4 0V-62M32-44L9-21M15-27L33 0'],
  // e — crossbar, then the bowl, open at the lower right
  [91, 'M4-22H40M40-22A18 22 0 1 0 33-3'],
  // i — stem only; the tittle is a node, drawn after this
  [145, 'M4 0V-30'],
  // n — stem and shoulder
  [165, 'M4 0V-44M4-22A16 22 0 0 1 36-22V0'],
];
const WORDMARK = `<g fill="none" stroke="${TEXT}" stroke-width="${STEM}" stroke-linecap="round" stroke-linejoin="round">\
${LETTERS.map(([x, d]) => `<path transform="translate(${x} 0)" d="${d}"/>`).join('')}\
</g><circle cx="149" cy="-42" r="5.5" fill="${ACCENT}"/>`;
// Ink extents of the wordmark: half a stem left of `s`, half a stem right of
// `n`'s second stem, ascender to baseline. The banner is laid out from these
// rather than from numbers typed in twice.
const WORD_W = LETTERS.at(-1)[0] + 36 + STEM / 2;
const WORD_H = 62 + STEM / 2;

// ── the banner ──────────────────────────────────────────────────────────────
// Laid out from the two ink boxes, so nudging the knot or a letterform moves the
// plate with it instead of leaving the padding lopsided.
const MARK_X = (SIZE - INK.w) / 2;
const MARK_Y = (SIZE - INK.h) / 2;
const BAR = 18; // plate padding
const WORD_SCALE = r2((INK.h * 0.86) / WORD_H);
const WORD_X = r2(BAR + INK.w + 26);
const BANNER_H = Math.round(INK.h + 2 * BAR);
const BANNER_W = Math.round(WORD_X + WORD_W * WORD_SCALE + BAR);
// Sit the name on a baseline centred against the mark. Centring its box instead
// would read high, since the wordmark's box is mostly ascender.
const BASELINE = r2(BAR + INK.h / 2 + (WORD_H * WORD_SCALE) / 2);

// ── files ───────────────────────────────────────────────────────────────────
const svg = (x, y, w, h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(h)}" role="img" aria-label="skein">\n${body}\n</svg>\n`;
const plate = (w, h, rx) => `<rect width="${w}" height="${h}" rx="${rx}" fill="${BG}"/>`;

const files = {
  // The mark alone, transparent and cropped to its ink — for anywhere that
  // brings its own backdrop and its own spacing.
  'docs/logo.svg': svg(r2(MARK_X), r2(MARK_Y), r2(INK.w), r2(INK.h), MARK),
  // The app icon: the same mark, on the app's own background.
  'docs/logo-tile.svg': svg(0, 0, SIZE, SIZE, plate(SIZE, SIZE, 22) + MARK),
  // The README banner. Dark plate on purpose — an <img> cannot adapt to GitHub's
  // light and dark themes, so it carries its own and reads the same in both.
  'docs/logo-wordmark.svg': svg(
    0,
    0,
    BANNER_W,
    BANNER_H,
    `${plate(BANNER_W, BANNER_H, 24)}` +
      `<g transform="translate(${r2(BAR - MARK_X)} ${r2(BAR - MARK_Y)})">${MARK}</g>` +
      `<g transform="translate(${WORD_X} ${BASELINE}) scale(${WORD_SCALE})">${WORDMARK}</g>`,
  ),
};

for (const [rel, body] of Object.entries(files)) {
  const abs = join(ROOT, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  console.log(`wrote ${rel} — ${body.length} bytes`);
}

// web/index.html inlines the icon rather than fetching it, so the page still
// makes zero requests (§7). Rewrite it here rather than print it for someone to
// paste: two hand-synced copies of the mark is exactly the drift this file
// exists to avoid.
//
// Single-quoted attributes so the href can stay double-quoted, and only the
// characters that actually break a data: URI escaped — percent-encoding the
// whole thing costs another 1.1 kB, nearly all of it the path data's spaces.
const icon = svg(0, 0, SIZE, SIZE, plate(SIZE, SIZE, 22) + MARK)
  .replace(/ (role|aria-label)="[^"]*"/g, '')
  .replace(/\n/g, '')
  .replace(/"/g, "'")
  .replace(/%/g, '%25')
  .replace(/#/g, '%23')
  .replace(/</g, '%3C')
  .replace(/>/g, '%3E');

const INDEX = join(ROOT, 'web/index.html');
const LINK = /(<link\s+rel="icon"\s+href=")[^"]*(")/;
const html = readFileSync(INDEX, 'utf8');
if (!LINK.test(html)) throw new Error(`no <link rel="icon"> to rewrite in ${INDEX}`);
const patched = html.replace(LINK, `$1data:image/svg+xml,${icon}$2`);
writeFileSync(INDEX, patched);
console.log(
  `wrote web/index.html — favicon ${icon.length} bytes${patched === html ? ' (unchanged)' : ''}`,
);
