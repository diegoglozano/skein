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

/**
 * The colour an unstyled node draws in, 0..255 — interpolated into both
 * shaders, so it is stated once. It has to be reachable from TypeScript
 * because hiding nodes is a property of this buffer and nothing else: a graph
 * with no attributes attached still needs a style array the moment the user
 * isolates a subgraph, and filling it with anything else would repaint the
 * whole graph as a side effect of hiding part of it.
 */
export const UNSTYLED_NODE_RGB = { r: 217, g: 222, b: 242 } as const;

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
 * Hide every node the mask excludes (§10 "isolate subgraph"), keeping whatever
 * colour the surviving nodes already had — zeroing the top byte is exactly
 * `HIDDEN_SIZE_CODE`, and the renderer takes those nodes' edges with them.
 *
 * `style` may be null, which is the ordinary case: a graph with no attributes
 * attached has no style buffer at all until something needs to hide part of
 * it. The array built for that case is uniform `UNSTYLED_NODE_RGB` at the
 * neutral size, so isolating changes visibility and nothing else.
 *
 * Returns a new array rather than mutating: the attribute style is the panel's
 * to own and re-issue, and isolating must not consume it.
 */
export function applyVisibilityMask(
  style: Uint32Array | null,
  mask: Uint8Array,
  nodeCount: number,
): Uint32Array {
  const out = style ? Uint32Array.from(style) : new Uint32Array(nodeCount);
  if (!style) {
    const { r, g, b } = UNSTYLED_NODE_RGB;
    out.fill(packStyle(r, g, b, NEUTRAL_SIZE_CODE));
  }
  for (let i = 0; i < nodeCount; i++) {
    if (!mask[i]) out[i] = out[i] & 0x00ffffff;
  }
  return out;
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

/** `UNSTYLED_NODE_RGB` as a shader-source rgb triple, 0..1. */
const unstyledRgb = [UNSTYLED_NODE_RGB.r, UNSTYLED_NODE_RGB.g, UNSTYLED_NODE_RGB.b]
  .map((c) => f(c / 255))
  .join(', ');

export const STYLE_DECODE_WGSL = /* wgsl */ `
const SIZE_MIN: f32 = ${f(SIZE_MIN)};
const SIZE_MAX: f32 = ${f(SIZE_MAX)};
const UNSTYLED_NODE: vec3f = vec3f(${unstyledRgb});

// .xyz is the colour in 0..1; .w is the size code, also in 0..1 (i.e. code/255).
fn styleSize(w: f32) -> f32 {
  return SIZE_MIN + (w * 255.0 - 1.0) / 254.0 * (SIZE_MAX - SIZE_MIN);
}
`;

// The GLSL side has no matching constant: WebGL2 passes the unstyled colour in
// as a uniform, so it reads `UNSTYLED_NODE_RGB` from TypeScript directly.
export const STYLE_DECODE_GLSL = /* glsl */ `
  const float SIZE_MIN = ${f(SIZE_MIN)};
  const float SIZE_MAX = ${f(SIZE_MAX)};

  float styleSize(float w) {
    return SIZE_MIN + (w * 255.0 - 1.0) / 254.0 * (SIZE_MAX - SIZE_MIN);
  }
`;
