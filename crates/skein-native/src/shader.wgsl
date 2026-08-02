// Ported verbatim from web/src/render/webgpu.ts's SHADER constant (D15/N0).
// Kept byte-comparable to the browser original on purpose: wgpu consumes WGSL
// natively, so any visual divergence between the two front ends is a pipeline
// setup bug, not a shader bug. Diff this against the TS file before debugging
// anything else.

struct View {
  scale: vec2f,
  offset: vec2f,
  viewportPx: vec2f,
  pointSizePx: f32,
  _pad: f32,
}

@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var<storage, read> positions: array<vec2f>;
@group(0) @binding(2) var<storage, read> endpoints: array<u32>;
// Highlight overlay (M4): node indices and endpoint pairs for the hovered or
// selected neighbourhood. Drawn after the base passes.
@group(0) @binding(3) var<storage, read> hiNodes: array<u32>;
@group(0) @binding(4) var<storage, read> hiEdges: array<u32>;

fn toClip(world: vec2f) -> vec2f {
  return world * view.scale + view.offset;
}

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) color: vec4f,
}

@vertex
fn nodeVs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VsOut {
  let corner = vec2f(f32(vi & 1u), f32(vi >> 1u)) * 2.0 - 1.0;
  let clip = toClip(positions[ii]) + corner * view.pointSizePx / view.viewportPx;
  var out: VsOut;
  out.pos = vec4f(clip, 0.0, 1.0);
  out.color = vec4f(0.85, 0.87, 0.95, 0.9);
  return out;
}

@vertex
fn edgeVs(@builtin(vertex_index) vi: u32) -> VsOut {
  let clip = toClip(positions[endpoints[vi]]);
  var out: VsOut;
  out.pos = vec4f(clip, 0.0, 1.0);
  out.color = vec4f(0.45, 0.55, 0.95, 0.08);
  return out;
}

@vertex
fn hiNodeVs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VsOut {
  let corner = vec2f(f32(vi & 1u), f32(vi >> 1u)) * 2.0 - 1.0;
  let sizePx = max(view.pointSizePx * 2.5, 6.0);
  let clip = toClip(positions[hiNodes[ii]]) + corner * sizePx / view.viewportPx;
  var out: VsOut;
  out.pos = vec4f(clip, 0.0, 1.0);
  out.color = vec4f(1.0, 0.72, 0.28, 1.0);
  return out;
}

@vertex
fn hiEdgeVs(@builtin(vertex_index) vi: u32) -> VsOut {
  let clip = toClip(positions[hiEdges[vi]]);
  var out: VsOut;
  out.pos = vec4f(clip, 0.0, 1.0);
  out.color = vec4f(1.0, 0.72, 0.28, 0.5);
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  return vec4f(in.color.rgb * in.color.a, in.color.a);
}
