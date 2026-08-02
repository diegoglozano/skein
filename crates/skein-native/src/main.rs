//! skein-native — the macOS front end that has no browser in it (D15).
//!
//! N0 scope: prove the render path natively and measure it. The window is
//! winit's, the surface is wgpu's, the graph comes from `skein-core`'s ingest
//! exactly as the browser's does. No UI yet (that is N4), no layout yet (N1) —
//! positions are the same deterministic seeded scatter M2 used before M3
//! existed, which is also the right worst case for a fill-rate measurement:
//! random positions make edges long, and D8 established that edge drawing is
//! fragment-bound.
//!
//! Usage:
//!   skein-native <edges.csv> [--seed N] [--edges N]   interactive, vsync
//!   skein-native <edges.csv> --sweep                  edge-cap sweep, no vsync

mod camera;
mod gpu_layout;
mod layout;
mod render;
mod store;

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use camera::Camera;
use skein_core::{seed_disc_positions, EdgeIngest, IngestConfig, Mulberry32, WORLD_SIZE};
use winit::application::ApplicationHandler;
use winit::event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::window::{Window, WindowId};

/// Fixed edge-draw cap. Applied by default for the reason D8 gives — edge
/// drawing is fill-bound — plus one the browser does not have: the force sim
/// shares this GPU with the renderer, so an uncapped draw starves the compute
/// queue. With no cap, a 1M/10M layout took 513 s against 19 s on the CPU
/// engine; the shader was never the problem.
///
/// **This is behind the web tier.** D13/D13a replaced the fixed cap there with
/// a budget that follows the camera: `budget / f` scaled by a coverage term,
/// with `maxEdges` 300k at this tier. So 300k matches the web's *ceiling* and
/// the fit view draws exactly what the browser draws — but the web also scales
/// *down* when zoomed out past fit, which D13a measured as a collapse from 57
/// to 7.8 fps with drawn counts unchanged. This renderer has no such term and
/// will hit that trough. Porting `web/src/render/lod.ts` is the fix; it needs
/// the pick grid's cell prefix sums, which this crate does not have yet.
const BROWSER_EDGE_CAP: u32 = 300_000;
/// Edge counts the sweep steps through, in the D8 idiom.
const SWEEP_STEPS: &[u32] = &[300_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000];
/// Frames measured per sweep step, after a warmup of the same length.
const SWEEP_FRAMES: usize = 240;
const POINT_SIZE_PX: f32 = 2.0;

/// Mirrors `HIERARCHY_TARGET_NODES` / `HIERARCHY_MAX_LEVELS` in
/// web/src/workers/ingest.ts. Kept identical so a native layout and a browser
/// layout of the same file are comparable rather than merely similar.
const HIERARCHY_TARGET_NODES: u32 = 10_000;
const HIERARCHY_MAX_LEVELS: usize = 12;

struct GraphData {
    positions: Vec<f32>,
    endpoints: Vec<u32>,
    node_count: u32,
    /// Every edge in the file — what the HUD reports.
    edge_count: u32,
    /// How many are actually resident and drawable. At the 100M tier the two
    /// differ by three orders of magnitude, which is the point (D8/D15).
    drawn_edges: u32,
    /// The memory-mapped adjacency. Shared with the layout thread, which
    /// coarsens straight out of the mapping rather than a heap copy.
    store: Arc<store::Store>,
}

/// Choose `k` distinct edge indices out of `m`, seeded and unbiased.
///
/// A partial Fisher–Yates over a *virtual* identity array: `slot[i]` is `i`
/// unless a previous swap moved it, and only moved positions are stored. So
/// this is O(k) in both time and memory no matter how large `m` is.
///
/// This replaces expanding and shuffling all `m` edges (D8's approach, which
/// GraphView.tsx still uses because in the browser `m` is bounded anyway). At
/// 100M edges that array was 800 MB of `u32` pairs, built and permuted in full,
/// so that a 300k prefix could be drawn — the rest was never read.
///
/// **This changes which edges get drawn** for a given seed, because a partial
/// front-to-back shuffle selects a different (equally uniform) subset than the
/// back-to-front full shuffle it replaces. Same file + seed still gives the same
/// picture (D2); it is not the same picture previous builds gave.
fn sample_edge_indices(m: usize, k: usize, seed: u32) -> Vec<u32> {
    let k = k.min(m);
    let mut rand = Mulberry32::new(seed);
    let mut moved: std::collections::HashMap<usize, u32> = std::collections::HashMap::new();
    let mut out = Vec::with_capacity(k);
    for i in 0..k {
        let j = i + (rand.next_f64() * (m - i) as f64) as usize;
        let j = j.min(m - 1);
        let at_j = moved.get(&j).copied().unwrap_or(j as u32);
        let at_i = moved.get(&i).copied().unwrap_or(i as u32);
        out.push(at_j);
        // Only position j needs recording; i is never revisited.
        moved.insert(j, at_i);
    }
    out
}

/// Row containing edge index `e`, by binary search over the CSR offsets.
/// `partition_point` handles empty rows (repeated offsets) correctly.
fn source_of(offsets: &[u32], e: u32) -> u32 {
    (offsets.partition_point(|&o| o <= e) - 1) as u32
}

/// Stream a CSV through `EdgeIngest` and persist the result as a store.
///
/// Streaming rather than `fs::read` matters at the target scale: a 100M-edge
/// CSV is ~1.5 GB, and holding it whole while the interner and edge buffers
/// grow alongside is two copies of the input for no reason. The chunk loop is
/// also what the browser's worker does with `File.stream()`, so the same
/// chunk-boundary paths get exercised.
fn ingest_to_store(source: &Path, store_at: &Path) -> anyhow::Result<()> {
    let file = File::open(source)?;
    let mut reader = BufReader::with_capacity(1 << 20, file);
    let mut ingest = EdgeIngest::new(IngestConfig::default(), 1 << 16);
    let mut buf = vec![0u8; 1 << 22];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        ingest.push_chunk(&buf[..n]);
    }
    let out = ingest.finish();
    store::write(store_at, &out.csr, &out.id_bytes, &out.id_offsets)?;
    Ok(())
}

fn load(path: &str, seed: u32, use_store: bool, draw_cap: usize) -> anyhow::Result<GraphData> {
    let source = Path::new(path);
    let store_at = store::store_path(source);

    let t0 = Instant::now();
    let reused = use_store && store::is_fresh(&store_at, source);
    if !reused {
        ingest_to_store(source, &store_at)?;
    }
    let ingest_ms = t0.elapsed().as_secs_f64() * 1e3;

    let t1 = Instant::now();
    let store = Arc::new(store::Store::open(&store_at)?);
    let open_ms = t1.elapsed().as_secs_f64() * 1e3;

    let node_count = store.node_count();
    let edge_count = store.edge_count() as u32;

    // Materialise interleaved endpoint pairs [s0,t0,s1,t1,...] for the
    // line-list vertex shader — but only for the sampled edges. Targets come
    // straight from the mapping; sources by binary search over the offsets.
    let t2 = Instant::now();
    let (offsets, targets) = (store.offsets(), store.targets());
    let sample = sample_edge_indices(store.edge_count(), draw_cap, seed);
    let mut endpoints = Vec::with_capacity(sample.len() * 2);
    for &e in &sample {
        endpoints.push(source_of(offsets, e));
        endpoints.push(targets[e as usize]);
    }
    let expand_ms = t2.elapsed().as_secs_f64() * 1e3;

    let positions = seed_disc_positions(node_count as usize, seed);

    eprintln!(
        "loaded {}: {} nodes, {} edges, {} sampled  ({} {:.0} ms, mmap {:.0} ms, sample {:.0} ms)",
        path,
        node_count,
        edge_count,
        endpoints.len() / 2,
        if reused { "store reused," } else { "ingest," },
        ingest_ms,
        open_ms,
        expand_ms
    );
    let drawn_edges = (endpoints.len() / 2) as u32;
    Ok(GraphData {
        positions,
        endpoints,
        node_count,
        edge_count,
        drawn_edges,
        store,
    })
}

/// Sanity summary of a finished layout. A compute shader that is wrong is
/// usually *fast* and wrong — a no-op dispatch, a bad binding, or NaNs from a
/// division all produce a quick empty-looking result rather than an error.
/// Printing the extent and the spread makes that visible: a collapsed layout
/// has near-zero extent, a broken one has NaNs or is pinned to the world edge.
fn position_stats(positions: &[f32]) -> String {
    if positions.is_empty() {
        return "positions: empty".into();
    }
    let (mut min_x, mut min_y) = (f32::MAX, f32::MAX);
    let (mut max_x, mut max_y) = (f32::MIN, f32::MIN);
    let mut nan = 0usize;
    let (mut sum_x, mut sum_y) = (0f64, 0f64);
    for xy in positions.chunks_exact(2) {
        let (x, y) = (xy[0], xy[1]);
        if !x.is_finite() || !y.is_finite() {
            nan += 1;
            continue;
        }
        min_x = min_x.min(x);
        max_x = max_x.max(x);
        min_y = min_y.min(y);
        max_y = max_y.max(y);
        sum_x += f64::from(x);
        sum_y += f64::from(y);
    }
    let n = (positions.len() / 2) as f64;
    let extent_x = max_x - min_x;
    let extent_y = max_y - min_y;
    let health = if nan > 0 {
        "  ** NON-FINITE **"
    } else if extent_x < 1.0 || extent_y < 1.0 {
        "  ** COLLAPSED **"
    } else {
        ""
    };
    format!(
        "positions: {} nodes, extent {extent_x:.0}x{extent_y:.0} of {WORLD_SIZE:.0}, \
         centroid ({:.0},{:.0}), non-finite {nan}{health}",
        n as u64,
        sum_x / n,
        sum_y / n,
    )
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((sorted.len() - 1) as f64 * p).round() as usize;
    sorted[idx]
}

struct Sweep {
    step: usize,
    warmup_left: usize,
    frames: Vec<f64>,
    /// Frames the surface refused (occluded, outdated). Reported, never
    /// silently dropped — a step measured mostly from skipped frames is not a
    /// measurement, and the first N0 run reported 64,000 fps by counting them.
    skipped: usize,
}

struct State {
    window: Arc<Window>,
    renderer: render::Renderer,
    camera: Camera,
    edge_limit: Option<u32>,

    dragging: bool,
    cursor: (f64, f64),

    last_frame: Instant,
    window_start: Instant,
    window_frames: u32,
    fps: f64,

    sweep: Option<Sweep>,
    /// Scripted camera motion for the sweep, so every step measures the same
    /// path rather than whatever the cursor happened to do.
    script_t: f64,
    /// None once the layout has finished or was never started.
    layout: Option<layout::LayoutHandle>,
    /// Last line published by the layout thread, shown in the title bar.
    status: String,
    /// The sweep does not start until the window is frontmost. An occluded
    /// window on macOS both throttles and refuses surfaces, so measuring one
    /// reports numbers that describe the compositor, not the renderer.
    focused: bool,
}

struct App {
    graph: GraphData,
    seed: u32,
    edge_limit: Option<u32>,
    sweep: bool,
    serialize: bool,
    no_layout: bool,
    cpu_layout: bool,
    exit_after_layout: bool,
    state: Option<State>,
}

impl ApplicationHandler for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.state.is_some() {
            return;
        }
        let attrs = Window::default_attributes()
            .with_title("skein (native)")
            .with_inner_size(winit::dpi::LogicalSize::new(1440.0, 900.0));
        let window = Arc::new(event_loop.create_window(attrs).unwrap());
        // Launched from a terminal this opens behind it, and an occluded
        // window on macOS refuses surfaces — which is exactly what corrupted
        // the first sweep. Ask for the front.
        window.focus_window();

        // Vsync off for the sweep: we want true frame throughput, not the
        // display's cadence. Interactive use keeps vsync on.
        let present_mode = if self.sweep {
            wgpu::PresentMode::AutoNoVsync
        } else {
            wgpu::PresentMode::AutoVsync
        };
        let mut renderer =
            pollster::block_on(render::Renderer::new(window.clone(), present_mode)).unwrap();
        renderer.set_graph(&self.graph.positions, &self.graph.endpoints);
        // Opt-in: --serialize measures GPU work per frame; the default measures
        // pipelined throughput, which is what the browser's rAF-driven numbers
        // in D8 measure and therefore the only mode comparable to them.
        renderer.wait_for_gpu = self.serialize;

        // Taken before `renderer` moves into State below. Cloning the
        // renderer's own device is the point: the sim writes GPU memory the
        // renderer can read without a round trip through the CPU.
        let gpu = (!self.cpu_layout).then(|| renderer.gpu_handles());

        let size = window.inner_size();
        let mut cam = Camera::default();
        cam.set_viewport(size.width as f64, size.height as f64);
        cam.fit(0.0, 0.0, WORLD_SIZE as f64, WORLD_SIZE as f64, 1.1);

        eprintln!(
            "adapter: {} ({})  |  {} nodes, {} edges  |  vsync {}",
            renderer.adapter_name,
            renderer.backend,
            self.graph.node_count,
            self.graph.edge_count,
            if self.sweep { "off" } else { "on" }
        );
        if self.sweep {
            eprintln!(
                "\nsweep: {SWEEP_FRAMES} frames per step after {SWEEP_FRAMES} warmup, scripted pan, D8 browser cap = {BROWSER_EDGE_CAP}\n"
            );
        }

        self.state = Some(State {
            window,
            renderer,
            camera: cam,
            edge_limit: self.edge_limit,
            dragging: false,
            cursor: (0.0, 0.0),
            last_frame: Instant::now(),
            window_start: Instant::now(),
            window_frames: 0,
            fps: 0.0,
            sweep: self.sweep.then(|| Sweep {
                step: 0,
                warmup_left: SWEEP_FRAMES,
                frames: Vec::with_capacity(SWEEP_FRAMES),
                skipped: 0,
            }),
            script_t: 0.0,
            focused: false,
            // Never during a sweep: the sim would compete for the GPU and the
            // moving positions would change the fill cost mid-measurement.
            layout: match !self.sweep && !self.no_layout {
                true => Some(layout::spawn(
                    self.graph.store.clone(),
                    self.seed,
                    HIERARCHY_TARGET_NODES,
                    HIERARCHY_MAX_LEVELS,
                    gpu,
                )),
                false => None,
            },
            status: String::from("laying out…"),
        });
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        let Some(state) = self.state.as_mut() else {
            return;
        };
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::Focused(f) => {
                if f && !state.focused && state.sweep.is_some() {
                    eprintln!("window frontmost — starting sweep\n");
                }
                state.focused = f;
                // Don't carry a stale timestamp across the gap.
                state.last_frame = Instant::now();
            }
            WindowEvent::Resized(size) => {
                state.renderer.resize(size.width, size.height);
                state
                    .camera
                    .set_viewport(size.width as f64, size.height as f64);
            }
            WindowEvent::MouseInput {
                state: s, button, ..
            } => {
                if button == MouseButton::Left {
                    state.dragging = s == ElementState::Pressed;
                }
            }
            WindowEvent::CursorMoved { position, .. } => {
                let (px, py) = (position.x, position.y);
                if state.dragging {
                    state
                        .camera
                        .pan_by(px - state.cursor.0, py - state.cursor.1);
                }
                state.cursor = (px, py);
            }
            WindowEvent::MouseWheel { delta, .. } => {
                let dy = match delta {
                    MouseScrollDelta::LineDelta(_, y) => y as f64 * 20.0,
                    MouseScrollDelta::PixelDelta(p) => p.y,
                };
                let factor = (dy * 0.002_f64).exp();
                let (cx, cy) = state.cursor;
                state.camera.zoom_at(factor, cx, cy);
            }
            WindowEvent::RedrawRequested => {
                // Drain everything the layout thread has published. Draining
                // rather than taking one keeps the preview on the newest
                // positions when the sim outruns the frame rate, instead of
                // walking a backlog several seconds stale.
                let mut newest: Option<Vec<f32>> = None;
                let mut finished = false;
                if let Some(handle) = &state.layout {
                    while let Ok(msg) = handle.rx.try_recv() {
                        match msg {
                            layout::LayoutMsg::Hierarchy {
                                levels,
                                secs,
                                engine,
                            } => {
                                eprintln!(
                                    "hierarchy: {levels} levels in {secs:.2} s | engine: {}",
                                    engine.label()
                                );
                                state.status = format!("{} layout", engine.label());
                            }
                            layout::LayoutMsg::Progress {
                                level,
                                levels,
                                iter,
                                iters,
                                nodes,
                                positions,
                            } => {
                                if let Some(p) = positions {
                                    newest = Some(p);
                                }
                                state.status = format!(
                                    "layout L{level}/{levels} {iter}/{iters} ({nodes} nodes)"
                                );
                            }
                            layout::LayoutMsg::Done {
                                positions,
                                secs,
                                hierarchy_secs,
                            } => {
                                eprintln!(
                                    "layout done: {secs:.2} s total ({hierarchy_secs:.2} s hierarchy)"
                                );
                                eprintln!("{}", position_stats(&positions));
                                state.status = format!("layout {secs:.1} s");
                                newest = Some(positions);
                                finished = true;
                            }
                        }
                    }
                }
                if let Some(positions) = newest {
                    state.renderer.update_positions(&positions);
                }
                if finished {
                    // Drops the handle, which signals cancel; the thread has
                    // already returned.
                    state.layout = None;
                    // Benchmark mode: a clean exit so the process's peak RSS
                    // is attributable to one complete run.
                    if self.exit_after_layout {
                        event_loop.exit();
                        return;
                    }
                }

                // Scripted camera path during the sweep: a slow orbit, so each
                // step measures identical work.
                if state.sweep.is_some() {
                    state.script_t += 1.0 / 60.0;
                    let t = state.script_t;
                    let c = WORLD_SIZE as f64 / 2.0;
                    state.camera.center_x = c + (t * 0.7).cos() * (WORLD_SIZE as f64 * 0.15);
                    state.camera.center_y = c + (t * 0.7).sin() * (WORLD_SIZE as f64 * 0.15);
                }

                let limit = state
                    .sweep
                    .as_ref()
                    .map(|s| SWEEP_STEPS[s.step])
                    .or(state.edge_limit);
                let presented = state
                    .renderer
                    .render(state.camera.view(POINT_SIZE_PX), limit);

                if !presented {
                    if let Some(sweep) = state.sweep.as_mut() {
                        sweep.skipped += 1;
                        // Whether the window is *focused* is the wrong gate —
                        // a visible-but-unfocused window presents fine. But a
                        // fully occluded one never will, and silently spinning
                        // looks identical to a slow graph. Say so.
                        if sweep.skipped % 2000 == 0 {
                            eprintln!(
                                "warning: {} frames refused by the surface — is the window \
                                 occluded? bring it to the front for a valid measurement",
                                sweep.skipped
                            );
                        }
                    }
                    // Do not advance the clock: the next real frame's dt must
                    // not absorb the time spent on refused ones.
                    state.last_frame = Instant::now();
                    state.window.request_redraw();
                    return;
                }

                let now = Instant::now();
                let dt = now.duration_since(state.last_frame).as_secs_f64();
                state.last_frame = now;

                // Rolling fps over a 500 ms window, as the browser HUD does.
                state.window_frames += 1;
                let elapsed = now.duration_since(state.window_start).as_secs_f64();
                if elapsed >= 0.5 {
                    state.fps = state.window_frames as f64 / elapsed;
                    state.window_frames = 0;
                    state.window_start = now;
                    if state.sweep.is_none() {
                        let drawn = state
                            .edge_limit
                            .unwrap_or(self.graph.drawn_edges)
                            .min(self.graph.drawn_edges);
                        let sampled = if drawn < self.graph.edge_count {
                            format!(" (drawing {drawn} of {})", self.graph.edge_count)
                        } else {
                            String::new()
                        };
                        state.window.set_title(&format!(
                            "skein — {:.0} fps — {} nodes, {} edges{} — {}",
                            state.fps,
                            self.graph.node_count,
                            self.graph.edge_count,
                            sampled,
                            state.status,
                        ));
                    }
                }

                if let Some(sweep) = state.sweep.as_mut() {
                    if sweep.warmup_left > 0 {
                        sweep.warmup_left -= 1;
                    } else if dt > 0.0 {
                        sweep.frames.push(dt * 1e3);
                        if sweep.frames.len() >= SWEEP_FRAMES {
                            let mut sorted = sweep.frames.clone();
                            sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
                            let edges = SWEEP_STEPS[sweep.step].min(self.graph.drawn_edges);
                            println!(
                                "{:>10} edges   median {:>6.1} fps   worst(p95) {:>6.1} fps   best {:>6.1} fps   [{} skipped]",
                                edges,
                                1e3 / percentile(&sorted, 0.5),
                                1e3 / percentile(&sorted, 0.95),
                                1e3 / sorted[0],
                                sweep.skipped,
                            );
                            let done = SWEEP_STEPS[sweep.step] >= self.graph.drawn_edges;
                            sweep.step += 1;
                            sweep.frames.clear();
                            sweep.skipped = 0;
                            sweep.warmup_left = SWEEP_FRAMES;
                            if done || sweep.step >= SWEEP_STEPS.len() {
                                println!("\nsweep complete.");
                                event_loop.exit();
                                return;
                            }
                        }
                    }
                }

                if self.exit_after_layout && state.layout.is_none() && state.sweep.is_none() {
                    // Nothing to wait for (--no-layout): one frame is enough to
                    // have exercised the load and upload path.
                    event_loop.exit();
                    return;
                }

                state.window.request_redraw();
            }
            _ => {}
        }
    }
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut path = None;
    let mut seed = 42u32;
    let mut edge_limit = None;
    let mut sweep = false;
    let mut serialize = false;
    let mut no_layout = false;
    let mut cpu_layout = false;
    let mut no_store = false;
    let mut exit_after_layout = false;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--sweep" => sweep = true,
            "--serialize" => serialize = true,
            "--no-layout" => no_layout = true,
            "--cpu-layout" => cpu_layout = true,
            "--no-store" => no_store = true,
            "--exit-after-layout" => exit_after_layout = true,
            "--seed" => {
                i += 1;
                seed = args[i].parse()?;
            }
            "--edges" => {
                i += 1;
                edge_limit = Some(args[i].parse()?);
            }
            other => path = Some(other.to_string()),
        }
        i += 1;
    }
    let Some(path) = path else {
        eprintln!("usage: skein-native <edges.csv> [--seed N] [--edges N] [--sweep]");
        std::process::exit(2);
    };

    // How many edges to make resident. The sweep needs its largest step; normal
    // runs need only what will be drawn (D8's cap unless --edges raises it).
    let draw_cap = if sweep {
        SWEEP_STEPS
            .iter()
            .copied()
            .max()
            .unwrap_or(BROWSER_EDGE_CAP) as usize
    } else {
        edge_limit.unwrap_or(BROWSER_EDGE_CAP) as usize
    };
    let graph = load(&path, seed, !no_store, draw_cap)?;
    // Default to D8's cap; --edges overrides it in either direction.
    let edge_limit = edge_limit.or(Some(BROWSER_EDGE_CAP));
    let event_loop = EventLoop::new()?;
    event_loop.set_control_flow(ControlFlow::Poll);
    let mut app = App {
        graph,
        seed,
        edge_limit,
        sweep,
        serialize,
        no_layout,
        cpu_layout,
        exit_after_layout,
        state: None,
    };
    event_loop.run_app(&mut app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn sample_is_distinct_and_in_range() {
        for &(m, k) in &[(10usize, 3usize), (1000, 50), (1_000_000, 1000), (7, 7)] {
            let got = sample_edge_indices(m, k, 42);
            assert_eq!(got.len(), k.min(m), "m={m} k={k}");
            let unique: HashSet<u32> = got.iter().copied().collect();
            assert_eq!(unique.len(), got.len(), "m={m} k={k}: duplicate indices");
            assert!(got.iter().all(|&e| (e as usize) < m), "m={m} k={k}");
        }
    }

    #[test]
    fn sample_is_deterministic_and_seed_dependent() {
        let a = sample_edge_indices(100_000, 500, 42);
        let b = sample_edge_indices(100_000, 500, 42);
        assert_eq!(a, b, "same seed must give the same sample (D2)");
        let c = sample_edge_indices(100_000, 500, 43);
        assert_ne!(a, c, "a different seed should give a different sample");
    }

    #[test]
    fn sampling_everything_is_a_permutation() {
        let got = sample_edge_indices(500, 500, 7);
        let mut sorted = got.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, (0..500u32).collect::<Vec<_>>());
    }

    #[test]
    fn sample_never_exceeds_available_edges() {
        // Asking for more than exist must clamp, not panic or repeat.
        let got = sample_edge_indices(5, 100, 1);
        assert_eq!(got.len(), 5);
    }

    /// Roughly uniform coverage — a sampler biased toward the front would fail
    /// this badly, and a front-biased sample would silently draw only the
    /// low-numbered nodes' edges.
    #[test]
    fn sample_covers_the_range() {
        let m = 1_000_000;
        let got = sample_edge_indices(m, 10_000, 42);
        let in_first_tenth = got.iter().filter(|&&e| (e as usize) < m / 10).count();
        assert!(
            (700..=1300).contains(&in_first_tenth),
            "expected ~1000 of 10000 in the first tenth, got {in_first_tenth}"
        );
    }

    #[test]
    fn source_of_matches_a_linear_scan() {
        // Rows: 0 -> [0,2), 1 -> empty, 2 -> [2,5), 3 -> empty, 4 -> [5,6)
        let offsets = [0u32, 2, 2, 5, 5, 6];
        let expect = [0u32, 0, 2, 2, 2, 4];
        for (e, &want) in expect.iter().enumerate() {
            assert_eq!(source_of(&offsets, e as u32), want, "edge {e}");
        }
    }

    #[test]
    fn source_of_handles_leading_empty_rows() {
        let offsets = [0u32, 0, 0, 3];
        for e in 0..3u32 {
            assert_eq!(source_of(&offsets, e), 2, "edge {e}");
        }
    }
}
