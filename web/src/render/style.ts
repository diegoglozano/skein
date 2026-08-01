// Per-node styling (M4 attributes): one u32 per node carrying colour, size and
// visibility together, so colour-by, size-by and filtering are a single buffer
// and a single upload rather than three (§4.2 — flat typed arrays, no per-node
// objects).
//
//   bits  0..7   red
//   bits  8..15  green
//   bits 16..23  blue
//   bits 24..31  size code — 0 hides the node *and* every edge touching it
//
// The byte order is the one both backends already decode for free:
// `unpack4x8unorm` in WGSL takes byte 0 as x, and a little-endian u32 uploaded
// as RGBA8 texture data puts byte 0 in .r. So the same array feeds both paths
// with no repacking.

/** Size multiplier at size code 1; code 0 is reserved for "hidden". */
export const SIZE_MIN = 0.5;
/** Size multiplier at size code 255. */
export const SIZE_MAX = 3.0;

/** A node whose size code is this is drawn at the unstyled point size. */
export const NEUTRAL_SIZE_CODE = 52;

/** Size code for a node the current filter excludes. */
export const HIDDEN_SIZE_CODE = 0;

/** Map a normalized 0..1 magnitude onto the visible size codes (1..255). */
export function sizeCode(t: number): number {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return 1 + Math.round(clamped * 254);
}

/** Pack one node's style. `r`, `g`, `b` are 0..255. */
export function packStyle(r: number, g: number, b: number, size: number): number {
  return ((r & 255) | ((g & 255) << 8) | ((b & 255) << 16) | ((size & 255) << 24)) >>> 0;
}

/**
 * The shared shader source for decoding a packed style. Both backends inline
 * this so the mapping cannot drift between them — it is written once here, in
 * the two shading languages, next to the TypeScript that produces the bytes.
 */
/**
 * Interpolate a number into shader source as a float literal. `${3.0}` is the
 * string "3" in JavaScript, and both shading languages read that as an integer
 * — GLSL then refuses to assign it to a float and the whole program fails to
 * compile.
 */
const f = (n: number) => n.toFixed(4);

export const STYLE_DECODE_WGSL = /* wgsl */ `
const SIZE_MIN: f32 = ${f(SIZE_MIN)};
const SIZE_MAX: f32 = ${f(SIZE_MAX)};

// .xyz is the colour in 0..1; .w is the size code, also in 0..1 (i.e. code/255).
fn styleSize(w: f32) -> f32 {
  return SIZE_MIN + (w * 255.0 - 1.0) / 254.0 * (SIZE_MAX - SIZE_MIN);
}
`;

export const STYLE_DECODE_GLSL = /* glsl */ `
  const float SIZE_MIN = ${f(SIZE_MIN)};
  const float SIZE_MAX = ${f(SIZE_MAX)};

  float styleSize(float w) {
    return SIZE_MIN + (w * 255.0 - 1.0) / 254.0 * (SIZE_MAX - SIZE_MIN);
  }
`;
