/**
 * Single source of truth for iso-simplicial exporter tuning.
 *
 * Reference mapping (docs/reference_impl/isosurf/isosurf):
 * - `oversampleQef` → global `OVERSAMPLE_QEF` (declared in iso_common.h, defined in main.cpp).
 * - `dualVertexBorderFraction` → global `BORDER` (double): in TNode QEF solvers the interior
 *   clamp margin is `border = BORDER * (cellMax - cellMin)` along an axis — keeps dual vertices
 *   off the cell boundary (“epsilon shrink” for the dual feasible region).
 * - `depthMin` / `depthMax` → `DEPTH_MIN` / `DEPTH_MAX` (octree subdivision bounds).
 * - `findRootDepth` → `FIND_ROOT_DEPTH` (rootfind.h / main.cpp; Phase 6 isosurface snap budget).
 * - `qefRelativeErrorRefineThreshold` → hard-coded `1e-3` ratio `qef_error/cellsize` for `badqef`
 *   in TNode::eval (iso_method_ours.cpp) — subdivide when QEF error is large relative to cell size.
 */
export const IsoSimplicialConstants = {
    oversampleQef: 4,
    dualVertexBorderFraction: 1 / 16,
    depthMin: 4,
    depthMax: 7,
    findRootDepth: 0,
    qefRelativeErrorRefineThreshold: 1e-3,
} as const

export type IsoSimplicialConstantsKey = keyof typeof IsoSimplicialConstants
