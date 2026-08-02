//! wgpu render path — the native port of web/src/render/webgpu.ts (D13/N0).
//!
//! Same strategy as the browser original, deliberately: vertex pulling from
//! storage buffers, so the graph lives on the GPU in its flat §4.2 layout —
//! positions once, edge endpoints once, zero expansion or per-frame uploads.
//! Nodes are instanced quads; edges are a line-list drawn straight from the
//! endpoint indices. The WGSL is `shader.wgsl`, a verbatim copy of the TS one.
//!
//! What is *not* the same, and is the point of D13: there is no canvas and no
//! compositor between this and the display. wgpu presents to a CAMetalLayer
//! owned by the winit window.

use std::sync::Arc;

use wgpu::util::DeviceExt;
use winit::window::Window;

use crate::camera::ViewTransform;

pub struct Renderer {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,

    bind_group_layout: wgpu::BindGroupLayout,
    node_pipeline: wgpu::RenderPipeline,
    edge_pipeline: wgpu::RenderPipeline,
    hi_node_pipeline: wgpu::RenderPipeline,
    hi_edge_pipeline: wgpu::RenderPipeline,

    uniform: wgpu::Buffer,
    positions: Option<wgpu::Buffer>,
    endpoints: Option<wgpu::Buffer>,
    bind_group: Option<wgpu::BindGroup>,

    // Highlight buffers are grown, never shrunk: hover rewrites them on every
    // pointer move that changes the picked node, and reallocating there would
    // also force a bind-group rebuild each time.
    hi_nodes: wgpu::Buffer,
    hi_edges: wgpu::Buffer,
    hi_node_count: u32,
    hi_edge_count: u32,

    node_count: u32,
    edge_count: u32,

    /// Block until the GPU has finished each frame before returning.
    ///
    /// Off, the swapchain lets the CPU run several frames ahead, so the wall
    /// time between frames measures queue occupancy, not rendering: you get
    /// bursts of ~2000 fps followed by a long stall, and a median that means
    /// nothing. Benchmarks must set this; interactive use must not, because it
    /// throws away the pipelining that makes the app feel smooth.
    pub wait_for_gpu: bool,

    pub adapter_name: String,
    pub backend: String,
}

impl Renderer {
    pub async fn new(window: Arc<Window>, present_mode: wgpu::PresentMode) -> anyhow::Result<Self> {
        let size = window.inner_size();
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let surface = instance.create_surface(window.clone())?;

        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                compatible_surface: Some(&surface),
                // Report the adapter's true limits rather than the bucketed
                // ones; we want to know what the M3 can actually give us.
                apply_limit_buckets: false,
            })
            .await?;

        let info = adapter.get_info();
        let adapter_name = info.name.clone();
        let backend = format!("{:?}", info.backend).to_lowercase();

        // 10M edges = 80 MB of endpoint indices; raise the storage binding
        // limit if the default is below what the adapter can give us anyway.
        // Mirrors the same clamp in webgpu.ts.
        let limits = adapter.limits();
        eprintln!(
            "adapter limits: max_buffer {} MB, max_storage_binding {} MB",
            limits.max_buffer_size / (1 << 20),
            limits.max_storage_buffer_binding_size / (1 << 20),
        );
        let required = wgpu::Limits {
            max_storage_buffer_binding_size: limits.max_storage_buffer_binding_size.min(1 << 30),
            max_buffer_size: limits.max_buffer_size.min(1 << 31),
            ..Default::default()
        };

        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("skein"),
                required_features: wgpu::Features::empty(),
                required_limits: required,
                experimental_features: wgpu::ExperimentalFeatures::default(),
                memory_hints: wgpu::MemoryHints::Performance,
                trace: wgpu::Trace::Off,
            })
            .await?;

        // A rejected draw raises no exception and no surface error — it just
        // produces an empty, very fast frame, which reads as a spectacular fps
        // number. D12 hit the same failure mode on WebGL2. Make it loud.
        device.on_uncaptured_error(std::sync::Arc::new(|e| {
            eprintln!("\n*** wgpu error: {e}\n");
        }));
        device.set_device_lost_callback(|reason, msg| {
            eprintln!("\n*** wgpu device lost ({reason:?}): {msg}\n");
        });

        let mut config = surface
            .get_default_config(&adapter, size.width.max(1), size.height.max(1))
            .ok_or_else(|| anyhow::anyhow!("surface is not supported by this adapter"))?;
        config.present_mode = present_mode;
        config.alpha_mode = wgpu::CompositeAlphaMode::Opaque;
        let format = config.format;
        surface.configure(&device, &config);

        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("skein-shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shader.wgsl").into()),
        });

        let storage_entry = |binding: u32| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::VERTEX,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only: true },
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("skein-bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                storage_entry(1),
                storage_entry(2),
                storage_entry(3),
                storage_entry(4),
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("skein-pl"),
            bind_group_layouts: &[Some(&bind_group_layout)],
            immediate_size: 0,
        });

        // Premultiplied-alpha blending, matching webgpu.ts's `blend`.
        let blend = wgpu::BlendState {
            color: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::One,
                dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                operation: wgpu::BlendOperation::Add,
            },
            alpha: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::One,
                dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                operation: wgpu::BlendOperation::Add,
            },
        };

        let make_pipeline = |entry: &str, topology: wgpu::PrimitiveTopology| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(entry),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &module,
                    entry_point: Some(entry),
                    compilation_options: Default::default(),
                    buffers: &[],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &module,
                    entry_point: Some("fs"),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format,
                        blend: Some(blend),
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                primitive: wgpu::PrimitiveState {
                    topology,
                    ..Default::default()
                },
                depth_stencil: None,
                multisample: Default::default(),
                multiview_mask: None,
                cache: None,
            })
        };

        let node_pipeline = make_pipeline("nodeVs", wgpu::PrimitiveTopology::TriangleStrip);
        let edge_pipeline = make_pipeline("edgeVs", wgpu::PrimitiveTopology::LineList);
        let hi_node_pipeline = make_pipeline("hiNodeVs", wgpu::PrimitiveTopology::TriangleStrip);
        let hi_edge_pipeline = make_pipeline("hiEdgeVs", wgpu::PrimitiveTopology::LineList);

        let uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("view"),
            size: std::mem::size_of::<ViewTransform>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        // Storage bindings must be non-empty; keep a 4-byte stub, as in the
        // browser path.
        let stub = |device: &wgpu::Device, label| {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: 4,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            })
        };
        let hi_nodes = stub(&device, "hiNodes");
        let hi_edges = stub(&device, "hiEdges");

        Ok(Self {
            surface,
            device,
            queue,
            config,
            bind_group_layout,
            node_pipeline,
            edge_pipeline,
            hi_node_pipeline,
            hi_edge_pipeline,
            uniform,
            positions: None,
            endpoints: None,
            bind_group: None,
            hi_nodes,
            hi_edges,
            hi_node_count: 0,
            hi_edge_count: 0,
            node_count: 0,
            edge_count: 0,
            wait_for_gpu: false,
            adapter_name,
            backend,
        })
    }

    pub fn set_graph(&mut self, positions: &[f32], endpoints: &[u32]) {
        self.node_count = (positions.len() / 2) as u32;
        self.edge_count = (endpoints.len() / 2) as u32;

        self.positions = Some(
            self.device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("positions"),
                    contents: bytemuck::cast_slice(positions),
                    usage: wgpu::BufferUsages::STORAGE
                        | wgpu::BufferUsages::COPY_DST
                        | wgpu::BufferUsages::COPY_SRC,
                }),
        );
        let endpoint_bytes: &[u8] = if endpoints.is_empty() {
            &[0u8; 4]
        } else {
            bytemuck::cast_slice(endpoints)
        };
        self.endpoints = Some(
            self.device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("endpoints"),
                    contents: endpoint_bytes,
                    usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
                }),
        );

        self.hi_node_count = 0;
        self.hi_edge_count = 0;
        self.rebuild_bind_group();
    }

    /// The renderer's device and queue, cloned for the layout thread.
    ///
    /// Sharing one device rather than creating a second is what lets the force
    /// sim and the renderer address the same GPU memory — the zero-copy
    /// layout→render handoff D13 was built around. Both handles are internally
    /// reference-counted and `Send`, so the clone is a refcount bump.
    pub fn gpu_handles(&self) -> (wgpu::Device, wgpu::Queue) {
        (self.device.clone(), self.queue.clone())
    }

    /// Overwrite node positions in place, keeping the same buffer and bind
    /// group. This is the layout preview path: the sim produces a new position
    /// array every few iterations and nothing else about the graph changes.
    ///
    /// Silently ignores an array that does not match the current node count —
    /// coarse levels of the multilevel hierarchy have fewer nodes, and only the
    /// finest level is previewable (the browser does the same).
    pub fn update_positions(&self, positions: &[f32]) {
        let Some(buffer) = &self.positions else {
            return;
        };
        if positions.len() != self.node_count as usize * 2 {
            return;
        }
        self.queue
            .write_buffer(buffer, 0, bytemuck::cast_slice(positions));
    }

    /// Ported alongside the rest of the renderer so the two front ends stay
    /// diffable, but nothing drives it until the explore surface comes across.
    /// Deliberately kept rather than deleted-and-rewritten later.
    #[allow(dead_code)]
    pub fn set_highlight(&mut self, nodes: &[u32], edges: &[u32]) {
        self.hi_node_count = nodes.len() as u32;
        self.hi_edge_count = (edges.len() / 2) as u32;
        let mut regrown = false;

        let need_nodes = (nodes.len() * 4).max(4) as u64;
        if need_nodes > self.hi_nodes.size() {
            self.hi_nodes = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("hiNodes"),
                size: need_nodes,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            regrown = true;
        }
        let need_edges = (edges.len() * 4).max(4) as u64;
        if need_edges > self.hi_edges.size() {
            self.hi_edges = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("hiEdges"),
                size: need_edges,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            regrown = true;
        }
        if regrown {
            self.rebuild_bind_group();
        }
        if !nodes.is_empty() {
            self.queue
                .write_buffer(&self.hi_nodes, 0, bytemuck::cast_slice(nodes));
        }
        if !edges.is_empty() {
            self.queue
                .write_buffer(&self.hi_edges, 0, bytemuck::cast_slice(edges));
        }
    }

    fn rebuild_bind_group(&mut self) {
        let (Some(positions), Some(endpoints)) = (&self.positions, &self.endpoints) else {
            return;
        };
        self.bind_group = Some(self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("skein-bg"),
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: self.uniform.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: positions.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: endpoints.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: self.hi_nodes.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: self.hi_edges.as_entire_binding(),
                },
            ],
        }));
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        self.config.width = width.max(1);
        self.config.height = height.max(1);
        self.surface.configure(&self.device, &self.config);
    }

    /// Draw one frame. Surface loss is handled here rather than surfaced to
    /// the caller: on macOS it happens routinely on display or scale changes,
    /// and the only sane response at every call site is "reconfigure and skip
    /// this frame".
    ///
    /// Returns whether a frame was actually presented. **Benchmarks must only
    /// count `true`**: an occluded or outdated surface returns immediately,
    /// and counting those as frames reports thousands of fps for a window that
    /// drew nothing. That is not hypothetical — it is what the first N0 sweep
    /// did before this return value existed.
    #[must_use]
    pub fn render(&mut self, view: ViewTransform, edge_limit: Option<u32>) -> bool {
        let Some(bind_group) = &self.bind_group else {
            return false;
        };
        let drawn_edges = edge_limit.unwrap_or(self.edge_count).min(self.edge_count);
        self.queue
            .write_buffer(&self.uniform, 0, bytemuck::bytes_of(&view));

        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t)
            | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                self.surface.configure(&self.device, &self.config);
                return false;
            }
            wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => {
                return false
            }
            other => {
                eprintln!("surface unavailable: {other:?}");
                return false;
            }
        };
        let target = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("skein-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &target,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: 0.043,
                            g: 0.043,
                            b: 0.07,
                            a: 1.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_bind_group(0, bind_group, &[]);
            if drawn_edges > 0 {
                pass.set_pipeline(&self.edge_pipeline);
                pass.draw(0..2 * drawn_edges, 0..1);
            }
            pass.set_pipeline(&self.node_pipeline);
            pass.draw(0..4, 0..self.node_count);
            if self.hi_edge_count > 0 {
                pass.set_pipeline(&self.hi_edge_pipeline);
                pass.draw(0..2 * self.hi_edge_count, 0..1);
            }
            if self.hi_node_count > 0 {
                pass.set_pipeline(&self.hi_node_pipeline);
                pass.draw(0..4, 0..self.hi_node_count);
            }
        }
        self.queue.submit(Some(encoder.finish()));
        if self.wait_for_gpu {
            if let Err(e) = self.device.poll(wgpu::PollType::wait_indefinitely()) {
                eprintln!("poll failed: {e:?}");
            }
        }
        self.queue.present(frame);
        true
    }
}
