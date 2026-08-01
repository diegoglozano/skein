// Backend selection (§8): WebGPU when available, WebGL2 otherwise. The user
// is told which path they got — GPU variance is real and silent fallbacks
// hide performance cliffs.

import type { Renderer } from './types';
import { createWebGpuRenderer } from './webgpu';
import { createWebGl2Renderer } from './webgl2';

export type { Backend, DrawLimits, RenderGraph, Renderer, ViewTransform } from './types';
export { Camera } from './camera';
export {
  DEFAULT_BUDGET,
  lodLimits,
  screenCoverage,
  shuffleEdgePairs,
  shuffledOrder,
  type LodBudget,
} from './lod';
export {
  HIDDEN_SIZE_CODE,
  NEUTRAL_SIZE_CODE,
  packStyle,
  sizeCode,
} from './style';

export async function createRenderer(canvas: HTMLCanvasElement): Promise<Renderer> {
  try {
    const gpu = await createWebGpuRenderer(canvas);
    if (gpu) return gpu;
  } catch (err) {
    console.warn('WebGPU unavailable, falling back to WebGL2:', err);
  }
  const gl2 = createWebGl2Renderer(canvas);
  if (gl2) return gl2;
  throw new Error('Neither WebGPU nor WebGL2 is available in this browser.');
}
