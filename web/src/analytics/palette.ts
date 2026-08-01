// Colour assignment for attribute-driven node styling (M4).
//
// A graph layout is a scatter: any two categories can end up as neighbouring
// pixels, so the palette has to hold under the *all-pairs* gate, not the
// adjacent-pairs one a bar chart gets away with. Against this canvas
// (#0b0b12) that caps the categorical palette at three hues — measured, not
// guessed, with the data-viz validator:
//
//   3 slots  PASS  worst all-pairs CVD ΔE 9.4, normal-vision ΔE 20.9
//   4 slots  FAIL  every candidate fourth hue lands under the ΔE 15
//                  normal-vision floor (violet↔blue 9.8, yellow↔orange 10.6,
//                  magenta↔orange 11.6, green↔aqua 11.9, red↔orange 7.1)
//
// So a categorical column colours its three most common values and groups the
// rest into a neutral "other". Fewer colours than a hairball wants, but the
// alternative is hues nobody can tell apart, which is not an encoding.
//
// The assignment is computed **once per column, from the whole column**, and
// never recomputed: filtering must not repaint the values that survive it.

/** Categorical hues, in fixed order. Never cycled, never extended. */
export const CATEGORY_COLORS = ['#3987e5', '#d95926', '#199e70'] as const;

/** Values outside the top `CATEGORY_COLORS.length`, and nodes with no row. */
export const NEUTRAL_COLOR = '#6b6b78';

/**
 * Sequential ramp for numeric columns: one hue, dark→light as the value rises,
 * so low values recede toward the canvas. Six steps is the most this hue's
 * scale supports here — eight puts adjacent steps under the ΔL 0.06 gap and
 * they stop reading as distinct. The dark end is the ramp's ordinal floor
 * step, not its darkest: below it a node stops being visible at all.
 */
export const SEQUENTIAL_STEPS = [
  '#184f95',
  '#256abf',
  '#3987e5',
  '#6da7ec',
  '#9ec5f4',
  '#cde2fb',
] as const;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

const CATEGORY_RGB = CATEGORY_COLORS.map(hexToRgb);
const NEUTRAL_RGB = hexToRgb(NEUTRAL_COLOR);
const SEQUENTIAL_RGB = SEQUENTIAL_STEPS.map(hexToRgb);

/** How many distinct values of a categorical column get their own hue. */
export const MAX_CATEGORIES = CATEGORY_COLORS.length;

/** Colour for category slot `i`; anything past the palette is the neutral. */
export function categoryRgb(i: number): Rgb {
  return i >= 0 && i < CATEGORY_RGB.length ? CATEGORY_RGB[i] : NEUTRAL_RGB;
}

export function neutralRgb(): Rgb {
  return NEUTRAL_RGB;
}

/** Step of the sequential ramp for a normalized 0..1 magnitude. */
export function sequentialRgb(t: number): Rgb {
  if (!Number.isFinite(t)) return NEUTRAL_RGB;
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return SEQUENTIAL_RGB[Math.min(SEQUENTIAL_RGB.length - 1, Math.floor(clamped * SEQUENTIAL_RGB.length))];
}

/** The hex a legend swatch should show for category slot `i`. */
export function categoryHex(i: number): string {
  return i >= 0 && i < CATEGORY_COLORS.length ? CATEGORY_COLORS[i] : NEUTRAL_COLOR;
}
