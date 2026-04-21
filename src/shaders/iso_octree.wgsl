// Stage 4 (Manson & Schaefer §5.1) — adaptive octree GPU kernels.
//
// PLACEHOLDER FOR SESSION 2. This file is intentionally empty in Session 1: the octree
// is built CPU-side (see `src/export/iso-octree.mts`) from the per-cube QEF residual
// that `placeCubeDuals_Pass5` writes. Once Session 2 starts the multi-resolution dual
// placement and Marching Tetrahedra integration, the kernels described below will live
// here.
//
// Session 2 plan (multi-resolution Marching Tetrahedra):
//
//   1. `markCubeForSubdivide`: per-leaf at current depth, set a u32 flag based on
//      QEF residual + sign-change presence + depth < maxDepth.
//   2. `allocateChildren`:    per-marked-leaf, atomic-allocate 8 child slots in the
//      next-level node array; write child Morton codes; clear parent's leaf bit.
//   3. `placeChildCubeDual`:  per-newly-allocated child, sample sceneSDF_mid at the
//      sub-cube's 8 corners directly (no need for a sub-resolution corner buffer),
//      build the 4D QEF on the 12 sub-edges' iso-crossings, solve, clamp, write.
//
// Session 3 plan (multi-resolution edge / face dual placement):
//
//   4. Extend the sparse hash key from `(cellType, linearIdx)` to
//      `(cellType, depth, mortonIdx)` so minimal edges/faces at deeper levels can be
//      uniquely identified. Required for the multi-resolution MT to walk between cubes
//      at different depths.
//   5. Per-leaf-cube enumeration of minimal edges/faces using neighbor-depth comparison
//      (the deepest cube touching an edge/face owns its dual placement).
//
// Session 4 plan (depth-aware Pass 6 / improvement passes):
//
//   6. Rewrite Pass 6's tet emission to walk minimal edges (rather than all base-grid
//      edges) and look up the appropriate cube/face/edge duals at varying depths.
//   7. Extend Pass 8/9/10's topology safety tests to handle T-junctions on cube/face
//      boundaries (extra edges in the simplicial-decomposition graph between
//      different-depth neighbors).
//
// Session 5 plan (2:1 balance + memory layout cleanup):
//
//   8. Enforce 2:1 balance during construction: if a cube subdivides, none of its 26
//      neighbors may be at a depth more than 1 shallower. One propagation pass per
//      refinement step. Bounds the worst-case minimal-cell complexity.
//   9. Move the per-level dispatches to a single GPU-side indirect dispatch chain so
//      we don't pay a CPU readback per level (the per-level marker count tells us
//      whether to continue).
//
// Session 6+ (polish / dev-tools):
//
//  10. Optional debug overlay: render octree leaf cubes as wireframes in the mesh
//      viewer, color-coded by depth. Helps visualize where adaptivity is happening.
//  11. Per-cube benchmarking: log time / triangle count for adaptive vs uniform on
//      reference scenes.
