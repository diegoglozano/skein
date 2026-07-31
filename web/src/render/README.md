# render/

Our own render path — the M0 spike rejected wrapping cosmos.gl at the 1M/10M
tier (docs/DECISIONS.md D7). `webgpu.ts` is the primary backend (vertex pulling
from storage buffers, instanced node quads, line-list edges); `webgl2.ts` is a
fallback over the same flat buffers, with positions in an RG32F texture and
endpoints as uint attributes. `camera.ts` is the shared pan/zoom.

Edge drawing is fill-bound, so large graphs draw a seeded sample (D8).

`setHighlight` overlays the M4 hover/selection subset on top of the base
passes, so unhighlighted frames cost nothing extra and the base buffers are
never rewritten. The two backends implement it separately — storage buffers on
WebGPU, instanced attributes on WebGL2 — and a bad GL draw call raises no
exception, so `tests/explore.spec.ts` asserts the overlay in *pixels* rather
than trusting the upload.

