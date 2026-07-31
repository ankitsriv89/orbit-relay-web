# 20 — Wave 5: terrain LOD (geometry clipmap)

**Goal (from `05_mars_colony_phase_next.md`):** clipmap rings around the active unit;
CPU sampler stays fixed-res. Purely a rendering/perf prerequisite for Hellas-scale
(>10 km) maps — render cost becomes independent of `worldSize`. Not content.

## Why the swap is clean

Everything that makes the terrain LOOK right is already decoupled from the mesh:
heights AND relief normals are sampled from the heightmap texture in the shader, the
albedo/detail blend keys off `vUv`, and every gameplay ground query goes through the
CPU-side `sampleHeight` grid. Nothing raycasts `terrain.mesh`. So geometry density can
change per-ring with zero shading seams — lighting is texture-derived and identical at
every LOD.

## Design

**Concentric levels, overlap-stitched.** Level 0 = m×m quads at the site's fine step
`s0 = worldSize / segments` (per-site `segments` semantics unchanged — it still means
"full-map-equivalent fine density"). Rings k=1..K double the step each level: m×m outer
footprint with an (m/2−4)-quad hole. `K = ceil(log2(segments / m))`, so the outermost
ring reaches `worldSize`. m = 96 desktop / 64 mobile (`clipQuads` in `qualityFor`).

- **Stitching: overlap + polygonOffset, no skirts, no L-fillers.** The hole is 2 parent
  quads smaller per side than the child's extent, so the child always overlaps the ring
  regardless of snap offset (max relative offset 1.5·s_k < 2·s_k). Coarser levels get
  increasing `polygonOffset` so the finer surface wins in the overlap band; cracks at
  T-junctions show the near-coplanar other level behind them, never a hole.
- **Snapping:** level k snaps to multiples of 2·s_k. Level 0 therefore stays on the CPU
  grid lattice (multiples of s0), which preserves the no-sink invariant exactly: near
  the active unit the rendered triangles ARE the CPU sampler's triangles (same lattice,
  same GL-exact bilinear fetch, same a-b-d/b-c-d diagonal split).
- **World-anchored UV:** the vertex shader computes `uv` from `modelMatrix`-transformed
  world position instead of geometry UVs (`u = x/W + 0.5`, `v = 0.5 − z/W`, matching
  flipY textures and the CPU's image-space convention). Meshes move; the surface
  doesn't. Vertices past the map edge clamp to ±W/2 (degenerate zero-area edge quads).
- **CPU sampler untouched.** `sampleHeight`/`sampleNormal`/micro-relief/rocks/fog
  hillshade all keep the fixed `(seg+1)²` grid. A fixed-res Float32Array scales fine to
  20 km maps (~7 MB at 15 m step) — only GPU triangles needed LOD.
- **frustumCulled = false** on every level mesh — local geometry is flat at y=0 but
  renders displaced to areoid elevation (y ≈ −2500 at Jezero); the stale bounds would
  cull small patches. (The old single 6-km plane got away with it by sheer size.)
- **Materials:** one ShaderMaterial per level (polygonOffset is a material property)
  all SHARING the single `uniforms` object — `uSunDir` in-place mutation and the fog
  uniform keep working. `terrain.mesh` becomes a Group named 'terrain'; main.js touches
  `terrain.uniforms` instead of `terrain.mesh.material.uniforms`.
- **main.js:** one per-frame `terrain.update(active.unit.position.x, .z)` call.

## Triangle budget

| Site | Before | After | Cut |
|---|---|---|---|
| Jezero desktop (384², 6 km) | 295k | ~48k (K=2) | 6.2× |
| Gale desktop (512², 9 km) | 524k | ~62k (K=3) | 8.4× |
| Hellas-scale (24 km @ 15.6 m near-field) | 4.7M (hypothetical) | ~77k (K=4) | map-size-independent |

## Accepted tradeoffs

- Idle units parked far from the active unit stand on a coarser ring — their CPU height
  (fine lattice) can differ from the rendered coarse surface by a wheel's height at
  km distances. Fog + distance hide it; the active unit is always on level 0.
- Ring triangulation pops by one quad on snap boundaries — heights are world-anchored
  so the surface itself never swims, only the piecewise-linear approximation shifts.

## Status

Plan approved 2026-07-18 (roadmap sequence: Wave 5 → Gale HiRISE res bump → Wave 2
site expansion). Built same day — see build log.
