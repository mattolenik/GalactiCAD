
export const MESH_MDC_DEBUG_SAMPLE_STRIDE = 20

export interface MeshMdcDebugStats {
    totalSamples: number
    acceptedNone: number
    acceptedLine: number
    acceptedCorner: number
    acceptedSeam: number
    rejected: number
}

export interface MeshMdcDebugData {
    /**
     * Packed sample records for mesh-viewer diagnostics.
     *
     * Layout per record (stride `MESH_MDC_DEBUG_SAMPLE_STRIDE`):
     * - `0..2`: crossing position xyz
     * - `3`: classification (`0` none, `1` line, `2` corner, `3` seam, `4` rejected)
     * - `4..6`: Hermite normal xyz
     * - `7`: feature normal count
     * - `8..10`: feature point xyz
     * - `11`: feature distance
     * - `12..14`: feature plane normal N1 xyz
     * - `15`: feature owner id A
     * - `16..18`: feature plane normal N2 xyz
     * - `19`: feature owner id B
     */
    samples: Float32Array<ArrayBuffer>
    stats: MeshMdcDebugStats
}

export interface MeshData {
    verts: Float32Array<ArrayBuffer>
    tris: Uint32Array<ArrayBuffer>
    debug?: {
        mdc?: MeshMdcDebugData
    }
}