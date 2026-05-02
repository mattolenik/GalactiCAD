/** CPU timings for ASC mesh export stages (render worker / profiling). */
export interface AscExportCpuTimingMs {
    /** `runAscLayerSweep` wall time (ms). */
    ascLayerSweepMs: number
    /** `applyAscHermiteQef` wall time (ms). */
    ascHermiteMs: number
}
