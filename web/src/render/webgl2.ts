// WebGL2 fallback (§8: not optional). Same flat buffers as the WebGPU path:
// positions live in an RG32F texture indexed by texelFetch (GL2 has no vertex
// storage buffers), edge endpoints are a plain uint vertex attribute, node
// instances read their position through the seeded draw order (D13). No
// per-frame uploads.

import { STYLE_DECODE_GLSL } from './style';
import type { DrawLimits, RenderGraph, Renderer, ViewTransform } from './types';

/** Texture width for the position store; height grows with node count. */
const TEX_W = 2048;

const POSITION_FETCH = /* glsl */ `
  uniform highp sampler2D positions;
  vec2 fetchPosition(uint index) {
    ivec2 at = ivec2(int(index % ${TEX_W}u), int(index / ${TEX_W}u));
    return texelFetch(positions, at, 0).rg;
  }
`;

// The packed style is an RGBA8 texture rather than a vertex attribute: it is
// indexed by node, and both the node pass (through the seeded draw order) and
// the edge pass (through either endpoint) need random access to it.
const STYLE_FETCH = /* glsl */ `
  uniform float styled;
  uniform highp sampler2D nodeStyle;
  vec4 fetchStyle(uint index) {
    ivec2 at = ivec2(int(index % ${TEX_W}u), int(index / ${TEX_W}u));
    return texelFetch(nodeStyle, at, 0);
  }
  ${STYLE_DECODE_GLSL}
`;

/** Filtered-out geometry is pushed outside the clip volume. */
const CULL = /* glsl */ `
  gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
  vColor = vec4(0.0);
  return;
`;

// `node` is the seeded draw order (D13), a per-instance attribute rather than
// gl_InstanceID: capping the instance count then samples the graph instead of
// dropping whatever the interner numbered last.
const NODE_VS = /* glsl */ `#version 300 es
  uniform vec2 scale;
  uniform vec2 offset;
  uniform vec2 viewportPx;
  uniform float pointSizePx;
  uniform vec4 color;
  in highp uint node;
  out vec4 vColor;
  ${POSITION_FETCH}
  ${STYLE_FETCH}
  void main() {
    vec4 tint = color;
    float sizeScale = 1.0;
    if (styled > 0.5) {
      vec4 s = fetchStyle(node);
      if (s.a == 0.0) { ${CULL} }
      tint = vec4(s.rgb, color.a);
      sizeScale = styleSize(s.a);
    }
    vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
    vec2 clip = fetchPosition(node) * scale + offset
      + corner * (pointSizePx * sizeScale) / viewportPx;
    gl_Position = vec4(clip, 0.0, 1.0);
    vColor = tint;
  }
`;

// The unstyled edge pass: one flat line list over the endpoint buffer, exactly
// as it was before per-node style existed. Kept as its own program so a session
// with no attributes draws precisely what every committed benchmark measured —
// the styled path below changes the draw call, and that change is not something
// an attribute-free graph should pay for or be measured on.
const EDGE_FLAT_VS = /* glsl */ `#version 300 es
  uniform vec2 scale;
  uniform vec2 offset;
  uniform vec4 color;
  in highp uint endpoint;
  out vec4 vColor;
  ${POSITION_FETCH}
  void main() {
    gl_Position = vec4(fetchPosition(endpoint) * scale + offset, 0.0, 1.0);
    vColor = color;
  }
`;

// The styled edge pass: one instance per edge, carrying *both* endpoints, so a
// filtered node can take its edges with it. Culling only the vertex whose own
// endpoint is hidden would leave the other end drawing a segment to the near
// plane, and GL2 has no way to reach the partner vertex's attribute — hence the
// instanced pair rather than a flat line list.
const EDGE_VS = /* glsl */ `#version 300 es
  uniform vec2 scale;
  uniform vec2 offset;
  uniform vec4 color;
  in highp uvec2 edge;
  out vec4 vColor;
  ${POSITION_FETCH}
  ${STYLE_FETCH}
  void main() {
    if (styled > 0.5 && (fetchStyle(edge.x).a == 0.0 || fetchStyle(edge.y).a == 0.0)) {
      ${CULL}
    }
    uint self = gl_VertexID == 0 ? edge.x : edge.y;
    gl_Position = vec4(fetchPosition(self) * scale + offset, 0.0, 1.0);
    vColor = color;
  }
`;

// Highlight overlay (M4). The node index comes from a per-instance attribute
// rather than gl_InstanceID, so only the highlighted subset is drawn. The
// overlay is exempt from styling: a selected node stays visible and keeps its
// accent colour even when the filter would have hidden it.
const HI_NODE_VS = /* glsl */ `#version 300 es
  uniform vec2 scale;
  uniform vec2 offset;
  uniform vec2 viewportPx;
  uniform float pointSizePx;
  uniform vec4 color;
  in highp uint node;
  out vec4 vColor;
  ${POSITION_FETCH}
  void main() {
    vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
    vec2 clip = fetchPosition(node) * scale + offset
      + corner * max(pointSizePx * 2.5, 6.0) / viewportPx;
    gl_Position = vec4(clip, 0.0, 1.0);
    vColor = color;
  }
`;

const FS = /* glsl */ `#version 300 es
  precision highp float;
  in vec4 vColor;
  out vec4 fragColor;
  void main() {
    fragColor = vec4(vColor.rgb * vColor.a, vColor.a);
  }
`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`shader compile: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`program link: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}

export function createWebGl2Renderer(canvas: HTMLCanvasElement): Renderer | null {
  const gl = canvas.getContext('webgl2', { antialias: false });
  if (!gl) return null;

  const nodeProgram = link(gl, NODE_VS, FS);
  const edgeProgram = link(gl, EDGE_VS, FS);
  const edgeFlatProgram = link(gl, EDGE_FLAT_VS, FS);
  const hiNodeProgram = link(gl, HI_NODE_VS, FS);
  const uniforms = (program: WebGLProgram) => ({
    scale: gl.getUniformLocation(program, 'scale'),
    offset: gl.getUniformLocation(program, 'offset'),
    viewportPx: gl.getUniformLocation(program, 'viewportPx'),
    pointSizePx: gl.getUniformLocation(program, 'pointSizePx'),
    color: gl.getUniformLocation(program, 'color'),
    positions: gl.getUniformLocation(program, 'positions'),
    nodeStyle: gl.getUniformLocation(program, 'nodeStyle'),
    styled: gl.getUniformLocation(program, 'styled'),
  });
  const nodeU = uniforms(nodeProgram);
  const edgeU = uniforms(edgeProgram);
  const edgeFlatU = uniforms(edgeFlatProgram);
  const hiNodeU = uniforms(hiNodeProgram);

  // Attribute locations are fixed at link time; setHighlight runs at hover
  // rate, so don't re-query the driver for them there.
  const edgeLoc = gl.getAttribLocation(edgeProgram, 'edge');
  const endpointLoc = gl.getAttribLocation(edgeFlatProgram, 'endpoint');
  const hiNodeLoc = gl.getAttribLocation(hiNodeProgram, 'node');
  const nodeOrderLoc = gl.getAttribLocation(nodeProgram, 'node');

  const positionTex = gl.createTexture();
  const styleTex = gl.createTexture();
  const endpointBuf = gl.createBuffer();
  const nodeOrderBuf = gl.createBuffer();
  const edgeVao = gl.createVertexArray();
  const edgeFlatVao = gl.createVertexArray();
  const nodeVao = gl.createVertexArray();
  const hiNodeBuf = gl.createBuffer();
  const hiEdgeBuf = gl.createBuffer();
  const hiNodeVao = gl.createVertexArray();
  const hiEdgeVao = gl.createVertexArray();

  let nodeCount = 0;
  let edgeCount = 0;
  let hiNodeCount = 0;
  let hiEdgeCount = 0;
  let styled = false;

  const uploadPositions = (positions: Float32Array) => {
    const rows = Math.max(1, Math.ceil(nodeCount / TEX_W));
    const padded = new Float32Array(TEX_W * rows * 2);
    padded.set(positions);
    gl.bindTexture(gl.TEXTURE_2D, positionTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, TEX_W, rows, 0, gl.RG, gl.FLOAT, padded);
  };

  // The sampler is declared unconditionally, so an unstyled graph still needs a
  // complete texture bound to unit 1 or the draw is a GL error.
  const uploadStyle = (style: Uint32Array | null) => {
    const rows = style ? Math.max(1, Math.ceil(nodeCount / TEX_W)) : 1;
    const padded = new Uint8Array(TEX_W * rows * 4);
    if (style) padded.set(new Uint8Array(style.buffer, style.byteOffset, style.byteLength));
    gl.bindTexture(gl.TEXTURE_2D, styleTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, TEX_W, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, padded);
  };
  uploadStyle(null);

  return {
    backend: 'webgl2',

    updatePositions(positions: Float32Array) {
      uploadPositions(positions);
    },

    setNodeStyle(style: Uint32Array | null) {
      styled = style !== null;
      uploadStyle(style);
    },

    setGraph(graph: RenderGraph) {
      nodeCount = graph.nodeCount;
      edgeCount = graph.edgeCount;
      uploadPositions(graph.positions);

      // One buffer, two readings of it: a flat stream of endpoints for the
      // unstyled pass, and endpoint *pairs* per instance for the styled one.
      gl.bindBuffer(gl.ARRAY_BUFFER, endpointBuf);
      gl.bufferData(gl.ARRAY_BUFFER, graph.endpoints, gl.STATIC_DRAW);

      gl.bindVertexArray(edgeFlatVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, endpointBuf);
      gl.enableVertexAttribArray(endpointLoc);
      gl.vertexAttribIPointer(endpointLoc, 1, gl.UNSIGNED_INT, 0, 0);
      gl.bindVertexArray(null);

      gl.bindVertexArray(edgeVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, endpointBuf);
      gl.enableVertexAttribArray(edgeLoc);
      gl.vertexAttribIPointer(edgeLoc, 2, gl.UNSIGNED_INT, 0, 0);
      gl.vertexAttribDivisor(edgeLoc, 1); // one endpoint pair per line instance
      gl.bindVertexArray(null);

      gl.bindVertexArray(nodeVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, nodeOrderBuf);
      gl.bufferData(gl.ARRAY_BUFFER, graph.nodeOrder, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(nodeOrderLoc);
      gl.vertexAttribIPointer(nodeOrderLoc, 1, gl.UNSIGNED_INT, 0, 0);
      gl.vertexAttribDivisor(nodeOrderLoc, 1); // one index per quad instance
      gl.bindVertexArray(null);

      hiNodeCount = 0;
      hiEdgeCount = 0;
      // A new graph's node indices mean nothing to the old style texture.
      styled = false;
      uploadStyle(null);
    },

    setHighlight(nodes: Uint32Array, edges: Uint32Array) {
      hiNodeCount = nodes.length;
      hiEdgeCount = edges.length >> 1;

      gl.bindVertexArray(hiNodeVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, hiNodeBuf);
      gl.bufferData(gl.ARRAY_BUFFER, nodes, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(hiNodeLoc);
      gl.vertexAttribIPointer(hiNodeLoc, 1, gl.UNSIGNED_INT, 0, 0);
      gl.vertexAttribDivisor(hiNodeLoc, 1); // one index per quad instance
      gl.bindVertexArray(null);

      // The overlay is exempt from styling — a selected node stays visible even
      // when the filter hides it — so it uses the flat pass regardless.
      gl.bindVertexArray(hiEdgeVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, hiEdgeBuf);
      gl.bufferData(gl.ARRAY_BUFFER, edges, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(endpointLoc);
      gl.vertexAttribIPointer(endpointLoc, 1, gl.UNSIGNED_INT, 0, 0);
      gl.bindVertexArray(null);
    },

    render(view: ViewTransform, limits?: DrawLimits) {
      if (nodeCount === 0) return;
      const drawnEdges = Math.min(edgeCount, limits?.edgeLimit ?? edgeCount);
      const drawnNodes = Math.min(nodeCount, limits?.nodeLimit ?? nodeCount);
      gl.viewport(0, 0, view.widthPx, view.heightPx);
      gl.clearColor(0.043, 0.043, 0.07, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, positionTex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, styleTex);

      const styleFlag = styled ? 1 : 0;

      if (drawnEdges > 0 && styled) {
        gl.useProgram(edgeProgram);
        gl.uniform2f(edgeU.scale, view.scaleX, view.scaleY);
        gl.uniform2f(edgeU.offset, view.offsetX, view.offsetY);
        gl.uniform4f(edgeU.color, 0.45, 0.55, 0.95, 0.08);
        gl.uniform1i(edgeU.positions, 0);
        gl.uniform1i(edgeU.nodeStyle, 1);
        gl.uniform1f(edgeU.styled, 1);
        gl.bindVertexArray(edgeVao);
        gl.drawArraysInstanced(gl.LINES, 0, 2, drawnEdges);
        gl.bindVertexArray(null);
      } else if (drawnEdges > 0) {
        gl.useProgram(edgeFlatProgram);
        gl.uniform2f(edgeFlatU.scale, view.scaleX, view.scaleY);
        gl.uniform2f(edgeFlatU.offset, view.offsetX, view.offsetY);
        gl.uniform4f(edgeFlatU.color, 0.45, 0.55, 0.95, 0.08);
        gl.uniform1i(edgeFlatU.positions, 0);
        gl.bindVertexArray(edgeFlatVao);
        gl.drawArrays(gl.LINES, 0, 2 * drawnEdges);
        gl.bindVertexArray(null);
      }

      gl.useProgram(nodeProgram);
      gl.uniform2f(nodeU.scale, view.scaleX, view.scaleY);
      gl.uniform2f(nodeU.offset, view.offsetX, view.offsetY);
      gl.uniform2f(nodeU.viewportPx, view.widthPx, view.heightPx);
      gl.uniform1f(nodeU.pointSizePx, view.pointSizePx);
      gl.uniform4f(nodeU.color, 0.85, 0.87, 0.95, 0.9);
      gl.uniform1i(nodeU.positions, 0);
      gl.uniform1i(nodeU.nodeStyle, 1);
      gl.uniform1f(nodeU.styled, styleFlag);
      gl.bindVertexArray(nodeVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, drawnNodes);
      gl.bindVertexArray(null);

      // The overlay uses the unstyled programs throughout: a hovered or selected
      // node stays on screen in the accent colour even when the filter excludes
      // it, and at its own point size.
      if (hiEdgeCount > 0) {
        gl.useProgram(edgeFlatProgram);
        gl.uniform2f(edgeFlatU.scale, view.scaleX, view.scaleY);
        gl.uniform2f(edgeFlatU.offset, view.offsetX, view.offsetY);
        gl.uniform1i(edgeFlatU.positions, 0);
        gl.uniform4f(edgeFlatU.color, 1.0, 0.72, 0.28, 0.5);
        gl.bindVertexArray(hiEdgeVao);
        gl.drawArrays(gl.LINES, 0, 2 * hiEdgeCount);
        gl.bindVertexArray(null);
      }
      if (hiNodeCount > 0) {
        gl.useProgram(hiNodeProgram);
        gl.uniform2f(hiNodeU.scale, view.scaleX, view.scaleY);
        gl.uniform2f(hiNodeU.offset, view.offsetX, view.offsetY);
        gl.uniform2f(hiNodeU.viewportPx, view.widthPx, view.heightPx);
        gl.uniform1f(hiNodeU.pointSizePx, view.pointSizePx);
        gl.uniform4f(hiNodeU.color, 1.0, 0.72, 0.28, 1.0);
        gl.uniform1i(hiNodeU.positions, 0);
        gl.bindVertexArray(hiNodeVao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, hiNodeCount);
        gl.bindVertexArray(null);
      }
    },

    resize(widthPx: number, heightPx: number) {
      canvas.width = widthPx;
      canvas.height = heightPx;
    },

    dispose() {
      gl.deleteTexture(positionTex);
      gl.deleteTexture(styleTex);
      gl.deleteBuffer(endpointBuf);
      gl.deleteBuffer(nodeOrderBuf);
      gl.deleteBuffer(hiNodeBuf);
      gl.deleteBuffer(hiEdgeBuf);
      gl.deleteVertexArray(edgeVao);
      gl.deleteVertexArray(edgeFlatVao);
      gl.deleteVertexArray(nodeVao);
      gl.deleteVertexArray(hiNodeVao);
      gl.deleteVertexArray(hiEdgeVao);
      gl.deleteProgram(nodeProgram);
      gl.deleteProgram(edgeProgram);
      gl.deleteProgram(edgeFlatProgram);
      gl.deleteProgram(hiNodeProgram);
    },
  };
}
