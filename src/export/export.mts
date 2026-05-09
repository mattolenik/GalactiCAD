
export const MESH_MDC_DEBUG_SAMPLE_STRIDE = 24

export interface MeshMdcDebugStats {
    totalSamples: number
    acceptedNone: number
    acceptedLine: number
    acceptedCorner: number
    acceptedSeam: number
    acceptedRing: number
    rejected: number
}

/** Floats per record in `MeshMdcDebugData.cellVertices`: xyz + reserved. */
export const MESH_MDC_CELL_VERTEX_STRIDE = 4
/** Floats per record in `MeshMdcDebugData.qefPlanes`: anchor.xyz + pad + normal.xyz + pad. */
export const MESH_MDC_QEF_PLANE_STRIDE = 8

export interface MeshMdcDebugData {
    /**
     * Packed sample records for mesh-viewer diagnostics.
     *
     * Layout per record (stride `MESH_MDC_DEBUG_SAMPLE_STRIDE`):
     * - `0..2`: crossing position xyz
     * - `3`: classification (`0` none, `1` line, `2` corner, `3` seam, `4` ring, `5` rejected)
     * - `4..6`: Hermite normal xyz
     * - `7`: feature normal count
     * - `8..10`: feature point xyz
     * - `11`: feature distance
     * - `12..14`: feature plane normal N1 xyz
     * - `15`: feature owner id A
     * - `16..18`: feature plane normal N2 xyz
     * - `19`: feature owner id B
     * - `20..22`: ring axisCenter xyz (only meaningful when classification == 4)
     * - `23`: reserved (currently 0)
     */
    samples: Float32Array<ArrayBuffer>
    /**
     * Per-cell-component vertex positions (pre-crease-split, one record per
     * distinct vertex referenced by the raw triangle list). Stride
     * `MESH_MDC_CELL_VERTEX_STRIDE`: `[x, y, z, _]`. Mesh viewer renders
     * markers at each position to expose the QEF-solved sub-vertex placements
     * before they get duplicated for shading.
     */
    cellVertices: Float32Array<ArrayBuffer>
    /**
     * Per-(cell, component) QEF input planes. Stride
     * `MESH_MDC_QEF_PLANE_STRIDE`: `[anchorX, anchorY, anchorZ, _, normalX,
     * normalY, normalZ, _]`. One record per non-zero face-bucket normal in
     * the component's `ComponentFeature`. Anchor is the component's mass /
     * feature point; mesh viewer renders a short line in the normal direction
     * starting at the anchor so the plane orientation is visible.
     */
    qefPlanes: Float32Array<ArrayBuffer>
    stats: MeshMdcDebugStats
}

export interface MeshData {
    verts: Float32Array<ArrayBuffer>
    tris: Uint32Array<ArrayBuffer>
    debug?: {
        mdc?: MeshMdcDebugData
    }
}