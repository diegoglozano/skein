// WebGL2 fallback (§8: not optional). Same flat buffers as the WebGPU path:
// positions live in an RG32F texture indexed by texelFetch (GL2 has no vertex
// storage buffers), edge endpoints are a plain uint vertex attribute, node
// instances read their position by gl_InstanceID. No per-frame uploads.

import type { RenderGraph, Renderer, ViewTransform } from './types';

/** Texture width for the position store; height grows with node count. */
const TEX_W = 2048;

const POSITION_FETCH = /* glsl */ `
  uniform highp sampler2D positions;
  vec2 fetchPosition(uint index) {
    ivec2 at = ivec2(int(index % ${TEX_W}u), int(index / ${TEX_W}u));
    return texelFetch(positions, at, 0).rg;
  }
`;

const NODE_VS = /* glsl */ `#version 300 es
  uniform vec2 scale;
  uniform vec2 offset;
  uniform vec2 viewportPx;
  uniform float pointSizePx;
  ${POSITION_FETCH}
  void main() {
    vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
    vec2 clip = fetchPosition(uint(gl_InstanceID)) * scale + offset
      + corner * pointSizePx / viewportPx;
    gl_Position = vec4(clip, 0.0, 1.0);
  }
`;

const EDGE_VS = /* glsl */ `#version 300 es
  uniform vec2 scale;
  uniform vec2 offset;
  in highp uint endpoint;
  ${POSITION_FETCH}
  void main() {
    gl_Position = vec4(fetchPosition(endpoint) * scale + offset, 0.0, 1.0);
  }
`;

const FS = /* glsl */ `#version 300 es
  precision highp float;
  uniform vec4 color;
  out vec4 fragColor;
  void main() {
    fragColor = vec4(color.rgb * color.a, color.a);
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
  const uniforms = (program: WebGLProgram) => ({
    scale: gl.getUniformLocation(program, 'scale'),
    offset: gl.getUniformLocation(program, 'offset'),
    viewportPx: gl.getUniformLocation(program, 'viewportPx'),
    pointSizePx: gl.getUniformLocation(program, 'pointSizePx'),
    color: gl.getUniformLocation(program, 'color'),
    positions: gl.getUniformLocation(program, 'positions'),
  });
  const nodeU = uniforms(nodeProgram);
  const edgeU = uniforms(edgeProgram);

  const positionTex = gl.createTexture();
  const endpointBuf = gl.createBuffer();
  const edgeVao = gl.createVertexArray();
  const nodeVao = gl.createVertexArray(); // attribute-less; VAO keeps state tidy

  let nodeCount = 0;
  let edgeCount = 0;

  const uploadPositions = (positions: Float32Array) => {
    const rows = Math.max(1, Math.ceil(nodeCount / TEX_W));
    const padded = new Float32Array(TEX_W * rows * 2);
    padded.set(positions);
    gl.bindTexture(gl.TEXTURE_2D, positionTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, TEX_W, rows, 0, gl.RG, gl.FLOAT, padded);
  };

  return {
    backend: 'webgl2',

    updatePositions(positions: Float32Array) {
      uploadPositions(positions);
    },

    setGraph(graph: RenderGraph) {
      nodeCount = graph.nodeCount;
      edgeCount = graph.edgeCount;
      uploadPositions(graph.positions);

      gl.bindVertexArray(edgeVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, endpointBuf);
      gl.bufferData(gl.ARRAY_BUFFER, graph.endpoints, gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(edgeProgram, 'endpoint');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribIPointer(loc, 1, gl.UNSIGNED_INT, 0, 0);
      gl.bindVertexArray(null);
    },

    render(view: ViewTransform, edgeLimit?: number) {
      if (nodeCount === 0) return;
      const drawnEdges = Math.min(edgeCount, edgeLimit ?? edgeCount);
      gl.viewport(0, 0, view.widthPx, view.heightPx);
      gl.clearColor(0.043, 0.043, 0.07, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, positionTex);

      if (drawnEdges > 0) {
        gl.useProgram(edgeProgram);
        gl.uniform2f(edgeU.scale, view.scaleX, view.scaleY);
        gl.uniform2f(edgeU.offset, view.offsetX, view.offsetY);
        gl.uniform4f(edgeU.color, 0.45, 0.55, 0.95, 0.08);
        gl.uniform1i(edgeU.positions, 0);
        gl.bindVertexArray(edgeVao);
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
      gl.bindVertexArray(nodeVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nodeCount);
      gl.bindVertexArray(null);
    },

    resize(widthPx: number, heightPx: number) {
      canvas.width = widthPx;
      canvas.height = heightPx;
    },

    dispose() {
      gl.deleteTexture(positionTex);
      gl.deleteBuffer(endpointBuf);
      gl.deleteVertexArray(edgeVao);
      gl.deleteVertexArray(nodeVao);
      gl.deleteProgram(nodeProgram);
      gl.deleteProgram(edgeProgram);
    },
  };
}
