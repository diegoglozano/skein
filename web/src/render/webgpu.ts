// WebGPU render path: vertex pulling from storage buffers, so the graph
// lives on the GPU exactly in its flat §4.2 layout — positions once, edge
// endpoints once, zero expansion or per-frame uploads. Nodes are instanced
// quads; edges are a line-list drawn straight from the endpoint indices.

import type { DrawLimits, RenderGraph, Renderer, ViewTransform } from './types';

const SHADER = /* wgsl */ `
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
// Seeded node draw order (D13): the base node pass reads positions through
// this, so capping the instance count samples the graph instead of slicing off
// whatever the interner numbered last.
@group(0) @binding(5) var<storage, read> nodeOrder: array<u32>;

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
  let clip = toClip(positions[nodeOrder[ii]]) + corner * view.pointSizePx / view.viewportPx;
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
`;

export async function createWebGpuRenderer(canvas: HTMLCanvasElement): Promise<Renderer | null> {
  const gpu = navigator.gpu;
  if (!gpu) return null;
  const adapter = await gpu.requestAdapter();
  if (!adapter) return null;
  // 10M edges = 80 MB of endpoint indices; raise the storage binding limit if
  // the default (128 MB) is below what the adapter can give us anyway.
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: Math.min(
        adapter.limits.maxStorageBufferBindingSize,
        1 << 30,
      ),
      maxBufferSize: Math.min(adapter.limits.maxBufferSize, 1 << 30),
    },
  });
  const context = canvas.getContext('webgpu');
  if (!context) return null;

  const format = gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  const module = device.createShaderModule({ code: SHADER });
  const blend: GPUBlendState = {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
  };
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 4, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 5, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
    ],
  });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });

  const nodePipeline = device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: { module, entryPoint: 'nodeVs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format, blend }] },
    primitive: { topology: 'triangle-strip' },
  });
  const edgePipeline = device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: { module, entryPoint: 'edgeVs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format, blend }] },
    primitive: { topology: 'line-list' },
  });
  const hiNodePipeline = device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: { module, entryPoint: 'hiNodeVs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format, blend }] },
    primitive: { topology: 'triangle-strip' },
  });
  const hiEdgePipeline = device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: { module, entryPoint: 'hiEdgeVs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format, blend }] },
    primitive: { topology: 'line-list' },
  });

  const uniform = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const uniformData = new Float32Array(8);

  let positionsBuf: GPUBuffer | null = null;
  let endpointsBuf: GPUBuffer | null = null;
  let nodeOrderBuf: GPUBuffer | null = null;
  let bindGroup: GPUBindGroup | null = null;
  let nodeCount = 0;
  let edgeCount = 0;

  // Highlight buffers are grown, never shrunk: hover rewrites them on every
  // pointer move that changes the picked node, and reallocating there would
  // also force a bind-group rebuild each time.
  const storage = (size: number) =>
    device.createBuffer({
      size: Math.max(4, size),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  let hiNodesBuf = storage(0);
  let hiEdgesBuf = storage(0);
  let hiNodeCount = 0;
  let hiEdgeCount = 0;

  const rebuildBindGroup = () => {
    if (!positionsBuf || !endpointsBuf || !nodeOrderBuf) return;
    bindGroup = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: positionsBuf } },
        { binding: 2, resource: { buffer: endpointsBuf } },
        { binding: 3, resource: { buffer: hiNodesBuf } },
        { binding: 4, resource: { buffer: hiEdgesBuf } },
        { binding: 5, resource: { buffer: nodeOrderBuf } },
      ],
    });
  };

  return {
    backend: 'webgpu',
    device,

    positionsGpuBuffer() {
      return positionsBuf;
    },

    updatePositions(positions: Float32Array) {
      if (positionsBuf) {
        device.queue.writeBuffer(positionsBuf, 0, positions as Float32Array<ArrayBuffer>);
      }
    },

    setGraph(graph: RenderGraph) {
      positionsBuf?.destroy();
      endpointsBuf?.destroy();
      nodeOrderBuf?.destroy();
      nodeCount = graph.nodeCount;
      edgeCount = graph.edgeCount;

      positionsBuf = device.createBuffer({
        size: graph.positions.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      });
      device.queue.writeBuffer(positionsBuf, 0, graph.positions as Float32Array<ArrayBuffer>);
      // Storage bindings must be non-empty; keep a 4-byte stub for edgeless graphs.
      endpointsBuf = device.createBuffer({
        size: Math.max(4, graph.endpoints.byteLength),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(endpointsBuf, 0, graph.endpoints as Uint32Array<ArrayBuffer>);
      nodeOrderBuf = device.createBuffer({
        size: Math.max(4, graph.nodeOrder.byteLength),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(nodeOrderBuf, 0, graph.nodeOrder as Uint32Array<ArrayBuffer>);

      hiNodeCount = 0;
      hiEdgeCount = 0;
      rebuildBindGroup();
    },

    setHighlight(nodes: Uint32Array, edges: Uint32Array) {
      hiNodeCount = nodes.length;
      hiEdgeCount = edges.length >> 1;
      let regrown = false;
      if (nodes.byteLength > hiNodesBuf.size) {
        hiNodesBuf.destroy();
        hiNodesBuf = storage(nodes.byteLength);
        regrown = true;
      }
      if (edges.byteLength > hiEdgesBuf.size) {
        hiEdgesBuf.destroy();
        hiEdgesBuf = storage(edges.byteLength);
        regrown = true;
      }
      if (regrown) rebuildBindGroup();
      if (hiNodeCount > 0) {
        device.queue.writeBuffer(hiNodesBuf, 0, nodes as Uint32Array<ArrayBuffer>);
      }
      if (hiEdgeCount > 0) {
        device.queue.writeBuffer(hiEdgesBuf, 0, edges as Uint32Array<ArrayBuffer>);
      }
    },

    render(view: ViewTransform, limits?: DrawLimits) {
      if (!bindGroup) return;
      const drawnEdges = Math.min(edgeCount, limits?.edgeLimit ?? edgeCount);
      const drawnNodes = Math.min(nodeCount, limits?.nodeLimit ?? nodeCount);
      uniformData.set([
        view.scaleX,
        view.scaleY,
        view.offsetX,
        view.offsetY,
        view.widthPx,
        view.heightPx,
        view.pointSizePx,
        0,
      ]);
      device.queue.writeBuffer(uniform, 0, uniformData);

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            clearValue: { r: 0.043, g: 0.043, b: 0.07, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      pass.setBindGroup(0, bindGroup);
      if (drawnEdges > 0) {
        pass.setPipeline(edgePipeline);
        pass.draw(2 * drawnEdges);
      }
      pass.setPipeline(nodePipeline);
      pass.draw(4, drawnNodes);
      if (hiEdgeCount > 0) {
        pass.setPipeline(hiEdgePipeline);
        pass.draw(2 * hiEdgeCount);
      }
      if (hiNodeCount > 0) {
        pass.setPipeline(hiNodePipeline);
        pass.draw(4, hiNodeCount);
      }
      pass.end();
      device.queue.submit([encoder.finish()]);
    },

    resize(widthPx: number, heightPx: number) {
      canvas.width = widthPx;
      canvas.height = heightPx;
    },

    dispose() {
      positionsBuf?.destroy();
      endpointsBuf?.destroy();
      nodeOrderBuf?.destroy();
      hiNodesBuf.destroy();
      hiEdgesBuf.destroy();
      uniform.destroy();
      device.destroy();
    },
  };
}
