/**
 * SFCC — Stratified Feature-Conforming Contouring exporter.
 *
 * A CPU-side, f64, primal, per-cell certificate-driven contouring method.
 * Feature topology comes symbolically from the CSG tree (no cell-local
 * classifier); manifoldness comes from structural assembly invariants (shared
 * face segments + per-cell disk patches). Design:
 * `docs/research/sfcc-algorithm-design.md`.
 *
 * Pipeline: S1 feature compilation (CPU SDF evaluator + analytic strata +
 * trimmed feature curves/corners) → S2 certified octree refinement → S3
 * stratified per-cell primal meshing → S4 certification & assembly.
 */

import type { MeshExportContext, MeshExporter } from "../mesh-exporter.mjs"
import type { MeshData } from "../export.mjs"
import {
    DEFAULT_SFCC_TUNING,
    normalizeSfccTuning,
    SFCC_DISPLAY_NAME,
    type SfccTuning,
} from "./sfcc-tuning.mjs"
import { compileCpuSdf } from "./cpu-sdf.mjs"
import { runSfccPipeline } from "./assemble.mjs"
import { log } from "../../logging/debug-log.mjs"

async function runSfcc(ctx: MeshExportContext, tuning: SfccTuning): Promise<MeshData> {
    // S1a: compile the CPU evaluator (throws SfccUnsupportedError with the
    // full offending-node list on unsupported scenes — no degradation).
    const tree = compileCpuSdf(ctx.scene.root)

    const cube = ctx.worldBoundsCube()
    const result = runSfccPipeline(
        tree,
        {
            minX: cube.min[0],
            minY: cube.min[1],
            minZ: cube.min[2],
            size: cube.max[0] - cube.min[0],
        },
        tuning,
        ctx.signal,
    )
    if (!result.ok) {
        // failurePolicy === "partial": ship the mesh, surface the diagnostics.
        console.warn("[sfcc] certification failed", result.stats, {
            openEdges: result.manifold.openEdges,
            nonManifoldEdges: result.manifold.nonManifoldEdges,
            misorientedEdges: result.manifold.misorientedEdges,
        })
    }
    // Always-on stats line: fallback/degenerate counts are quality signals
    // (cell-scale chips) even when certification passes.
    log("MeshExport").info("sfcc stats", { ...result.stats, euler: result.manifold.eulerPerComponent })
    // Return the INDEXED mesh (shared PointTable vertices), NOT a pre-exploded
    // flat-normal soup. The unified render-worker post-pass needs welded
    // topology to simplify — meshoptimizer can't collapse an unwelded soup
    // (every edge reads as a border) — so exploding here silently disabled
    // mesh simplification for SFCC. The post-pass already applies flat face
    // normals afterward (renormalizeTriangles, default on), so the default
    // (no-simplify) appearance is unchanged; enabling simplify now works.
    const mesh: MeshData = { verts: result.verts, tris: result.tris }
    mesh.debug = {
        sfcc: {
            stats: { ...result.stats } as Record<string, number | number[]>,
            failedCellBoxes: result.failedCellBoxes,
            featurePolylines: result.featurePolylines,
        },
    }
    return mesh
}

export const sfccExporter: MeshExporter<SfccTuning> = {
    displayName: SFCC_DISPLAY_NAME,
    defaultTuning: DEFAULT_SFCC_TUNING,
    normalizeTuning: normalizeSfccTuning,
    run: runSfcc,
}
