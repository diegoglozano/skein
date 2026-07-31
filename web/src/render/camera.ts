// 2D pan/zoom camera. Pure math, no DOM: the view layer feeds it pointer
// deltas and wheel events, it produces the world→clip transform. Zoom is
// anchored at the cursor. Deterministic — no inertia, no animation state.

import type { ViewTransform } from './types';

export class Camera {
  /** World coordinate at the viewport centre. */
  centerX = 0;
  centerY = 0;
  /** Device pixels per world unit. */
  zoom = 1;

  private widthPx = 1;
  private heightPx = 1;

  setViewport(widthPx: number, heightPx: number) {
    this.widthPx = Math.max(1, widthPx);
    this.heightPx = Math.max(1, heightPx);
  }

  /** Fit a world-space bounding box with a margin factor. */
  fit(minX: number, minY: number, maxX: number, maxY: number, margin = 1.1) {
    const spanX = Math.max(1e-6, maxX - minX) * margin;
    const spanY = Math.max(1e-6, maxY - minY) * margin;
    this.centerX = (minX + maxX) / 2;
    this.centerY = (minY + maxY) / 2;
    this.zoom = Math.min(this.widthPx / spanX, this.heightPx / spanY);
  }

  /** Pan by a screen-space delta in device pixels. */
  panBy(dxPx: number, dyPx: number) {
    this.centerX -= dxPx / this.zoom;
    this.centerY += dyPx / this.zoom; // screen y grows downward
  }

  /** Multiply zoom, keeping the world point under (xPx, yPx) fixed. */
  zoomAt(factor: number, xPx: number, yPx: number) {
    const clamped = Math.min(1e5, Math.max(1e-4, this.zoom * factor));
    const applied = clamped / this.zoom;
    if (applied === 1) return;
    const { x: worldX, y: worldY } = this.worldAt(xPx, yPx);
    this.zoom = clamped;
    this.centerX = worldX - (xPx - this.widthPx / 2) / this.zoom;
    this.centerY = worldY + (yPx - this.heightPx / 2) / this.zoom;
  }

  /** Inverse of the view transform: device pixels → world coordinates. */
  worldAt(xPx: number, yPx: number): { x: number; y: number } {
    return {
      x: this.centerX + (xPx - this.widthPx / 2) / this.zoom,
      y: this.centerY - (yPx - this.heightPx / 2) / this.zoom,
    };
  }

  /** World units spanned by one device pixel — the scale for a pick radius. */
  worldPerPixel(): number {
    return 1 / this.zoom;
  }

  view(pointSizePx: number): ViewTransform {
    // clip.x = (world.x - centerX) * zoom / (width/2)
    const scaleX = (2 * this.zoom) / this.widthPx;
    const scaleY = (2 * this.zoom) / this.heightPx;
    return {
      scaleX,
      scaleY,
      offsetX: -this.centerX * scaleX,
      offsetY: -this.centerY * scaleY,
      widthPx: this.widthPx,
      heightPx: this.heightPx,
      pointSizePx,
    };
  }
}
