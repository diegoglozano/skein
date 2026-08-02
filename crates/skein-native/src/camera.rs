//! 2D pan/zoom camera — a direct port of web/src/render/camera.ts.
//!
//! Pure math, no windowing: the event loop feeds it pointer deltas and scroll
//! events, it produces the world→clip transform. Zoom is anchored at the
//! cursor. Deterministic — no inertia, no animation state.
//!
//! Kept structurally identical to the TS original so the two front ends frame
//! a graph the same way; a camera divergence would otherwise masquerade as a
//! renderer difference when comparing N0's numbers against M2's.

/// Uniform block layout shared with `shader.wgsl`'s `View` struct.
#[repr(C)]
#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]
pub struct ViewTransform {
    pub scale_x: f32,
    pub scale_y: f32,
    pub offset_x: f32,
    pub offset_y: f32,
    pub width_px: f32,
    pub height_px: f32,
    pub point_size_px: f32,
    pub _pad: f32,
}

pub struct Camera {
    /// World coordinate at the viewport centre.
    pub center_x: f64,
    pub center_y: f64,
    /// Device pixels per world unit.
    pub zoom: f64,
    width_px: f64,
    height_px: f64,
}

impl Default for Camera {
    fn default() -> Self {
        Self {
            center_x: 0.0,
            center_y: 0.0,
            zoom: 1.0,
            width_px: 1.0,
            height_px: 1.0,
        }
    }
}

impl Camera {
    pub fn set_viewport(&mut self, width_px: f64, height_px: f64) {
        self.width_px = width_px.max(1.0);
        self.height_px = height_px.max(1.0);
    }

    /// Fit a world-space bounding box with a margin factor.
    pub fn fit(&mut self, min_x: f64, min_y: f64, max_x: f64, max_y: f64, margin: f64) {
        let span_x = (max_x - min_x).max(1e-6) * margin;
        let span_y = (max_y - min_y).max(1e-6) * margin;
        self.center_x = (min_x + max_x) / 2.0;
        self.center_y = (min_y + max_y) / 2.0;
        self.zoom = (self.width_px / span_x).min(self.height_px / span_y);
    }

    /// Pan by a screen-space delta in device pixels.
    pub fn pan_by(&mut self, dx_px: f64, dy_px: f64) {
        self.center_x -= dx_px / self.zoom;
        self.center_y += dy_px / self.zoom; // screen y grows downward
    }

    /// Multiply zoom, keeping the world point under (x_px, y_px) fixed.
    pub fn zoom_at(&mut self, factor: f64, x_px: f64, y_px: f64) {
        let clamped = (self.zoom * factor).clamp(1e-4, 1e5);
        if clamped == self.zoom {
            return;
        }
        let (world_x, world_y) = self.world_at(x_px, y_px);
        self.zoom = clamped;
        self.center_x = world_x - (x_px - self.width_px / 2.0) / self.zoom;
        self.center_y = world_y + (y_px - self.height_px / 2.0) / self.zoom;
    }

    /// Inverse of the view transform: device pixels → world coordinates.
    pub fn world_at(&self, x_px: f64, y_px: f64) -> (f64, f64) {
        (
            self.center_x + (x_px - self.width_px / 2.0) / self.zoom,
            self.center_y - (y_px - self.height_px / 2.0) / self.zoom,
        )
    }

    pub fn view(&self, point_size_px: f32) -> ViewTransform {
        // clip.x = (world.x - center_x) * zoom / (width/2)
        let scale_x = (2.0 * self.zoom) / self.width_px;
        let scale_y = (2.0 * self.zoom) / self.height_px;
        ViewTransform {
            scale_x: scale_x as f32,
            scale_y: scale_y as f32,
            offset_x: (-self.center_x * scale_x) as f32,
            offset_y: (-self.center_y * scale_y) as f32,
            width_px: self.width_px as f32,
            height_px: self.height_px as f32,
            point_size_px,
            _pad: 0.0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_centres_and_scales() {
        let mut cam = Camera::default();
        cam.set_viewport(800.0, 600.0);
        cam.fit(0.0, 0.0, 100.0, 100.0, 1.0);
        assert_eq!(cam.center_x, 50.0);
        assert_eq!(cam.center_y, 50.0);
        // Height is the binding dimension: 600/100 < 800/100.
        assert_eq!(cam.zoom, 6.0);
    }

    #[test]
    fn zoom_at_keeps_cursor_world_point_fixed() {
        let mut cam = Camera::default();
        cam.set_viewport(800.0, 600.0);
        cam.fit(0.0, 0.0, 100.0, 100.0, 1.0);
        let before = cam.world_at(200.0, 150.0);
        cam.zoom_at(2.5, 200.0, 150.0);
        let after = cam.world_at(200.0, 150.0);
        assert!((before.0 - after.0).abs() < 1e-9, "{before:?} {after:?}");
        assert!((before.1 - after.1).abs() < 1e-9, "{before:?} {after:?}");
    }

    #[test]
    fn pan_moves_world_opposite_to_screen() {
        let mut cam = Camera::default();
        cam.set_viewport(800.0, 600.0);
        cam.fit(0.0, 0.0, 100.0, 100.0, 1.0);
        let (cx, cy) = (cam.center_x, cam.center_y);
        cam.pan_by(60.0, 0.0);
        assert!(cam.center_x < cx);
        assert_eq!(cam.center_y, cy);
    }

    #[test]
    fn zoom_is_clamped() {
        let mut cam = Camera::default();
        cam.set_viewport(800.0, 600.0);
        for _ in 0..200 {
            cam.zoom_at(10.0, 400.0, 300.0);
        }
        assert!(cam.zoom <= 1e5);
        for _ in 0..400 {
            cam.zoom_at(0.1, 400.0, 300.0);
        }
        assert!(cam.zoom >= 1e-4);
    }
}
