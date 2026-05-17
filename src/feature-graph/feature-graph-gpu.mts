/**
 * FeatureGraph orchestrator — phase A scaffold.
 *
 * Owns the lifecycle of the GPU-resident FeatureGraph (vertices, edges, cap
 * loops, transforms) across scene rebuilds. Phase A keeps this as a stub that
 * accepts the CPU snapshot from {@link FeatureGraphBuilder.finish} and logs
 * counts so the end-to-end plumbing (trigger → extract → orchestrator) can be
 * exercised before any actual GPU work lands.
 *
 * Future phases will:
 *  - Phase C: own `fgVertices` / `fgEdges` / `fgLoops` / `fgTransforms` GPU
 *    storage buffers (grow-on-demand pattern from {@link IsoSampleBatch}),
 *    dispatch the apply-transform pass (stage 2) and the subdivide pass
 *    (stage 3) here.
 *  - Phase D: dispatch the survival-test pass against the scene SDF via
 *    `IsoSampleBatch`, build the CPU spatial hash (stage 5) for downstream
 *    mesher consumption.
 */

import type { FeatureGraphCpu } from "../scene/feature-graph-buffer.mjs"
import { log } from "../logging/debug-log.mjs"

/**
 * Result returned to the caller after a build. Phase A is empty other than
 * counts — downstream meshers can't consume this yet. Phase D will add the
 * spatial-index handle plus surviving-vertex counts.
 */
export interface FeatureGraphBuildResult {
    vertexCount: number
    edgeCount: number
    loopCount: number
    transformCount: number
    nonAffineSubtrees: number
}

/**
 * Phase A stub. Constructor takes no GPU resources yet — phase C wires in the
 * `GPUHelper`, `IsoSampleBatch`, and bind-group setup for the compute passes.
 */
export class FeatureGraphGpu {
    /**
     * Run stages 2–5 against the CPU snapshot. Phase A: counts + log only.
     *
     * @param cpu CPU snapshot from {@link FeatureGraphBuilder.finish}.
     * @param cellSize Mesher cell size (mm); subdivision target = `0.5 * cellSize` (phase C).
     */
    build(cpu: FeatureGraphCpu, cellSize: number): FeatureGraphBuildResult {
        // Count transforms flagged as living under a non-affine ancestor —
        // useful sanity signal in phase A (proves the warp gate is firing).
        let nonAffineSubtrees = 0
        // Slot 0 is the implicit-root identity; skip it.
        for (let i = 1; i < cpu.transformCount; i++) {
            if ((cpu.transformFlags[i] ?? 0) !== 0) nonAffineSubtrees++
        }

        log("FeatureGraph").debug("build (phase A: extract-only)", {
            vertexCount: cpu.vertexCount,
            edgeCount: cpu.edgeCount,
            loopCount: cpu.loopCount,
            transformCount: cpu.transformCount,
            nonAffineSubtrees,
            cellSize,
        })

        return {
            vertexCount: cpu.vertexCount,
            edgeCount: cpu.edgeCount,
            loopCount: cpu.loopCount,
            transformCount: cpu.transformCount,
            nonAffineSubtrees,
        }
    }

    destroy(): void {
        // Nothing to release in phase A.
    }
}
