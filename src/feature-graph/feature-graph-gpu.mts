/**
 * FeatureGraph orchestrator — phase C (CPU subdivision + bisection).
 *
 * Stages:
 *  - **Stage 2** (CPU, {@link applyTransformsCpu}): apply the affine transform
 *    chain to each local-space vertex.
 *  - **Stage 3** (CPU, {@link subdivideEdgesCpu}): split edges so every
 *    segment is ≤ ½ × cell_size in world space. New vertices inherit the
 *    parent edge's crease lineage; new edges are `crease_subdivided | alive`.
 *  - **Stage 4** (GPU via {@link IsoSampleBatch}, then CPU bookkeeping):
 *    query the scene SDF at each world position, mark `|d| < ε` alive,
 *    {@link bisectMixedEdgesCpu} mixed-alive edges by linear-interp surface
 *    crossing, cascade to edge + loop survival.
 *  - **Stage 5** (CPU, {@link FeatureGraphSpatialIndex.build}): bin alive
 *    features by cell.
 *
 * GPU promotion: stages 2 + 3 each have a direct compute-shader target
 * (`feature_graph_apply_transform.wgsl`, `feature_graph_subdivide.wgsl`).
 * They live as deferred work because at current vertex counts the CPU path
 * is faster than the GPU dispatch + readback overhead.
 */

import type { FeatureGraphCpu } from "../scene/feature-graph-buffer.mjs"
import { FG_FLAG_ALIVE, FG_FLAG_NON_AFFINE_ANCESTOR } from "../scene/feature-graph-buffer.mjs"
import type { IsoSampleBatch } from "../export/iso-simplicial/iso-sample-batch.mjs"
import { FeatureGraphSpatialIndex } from "./feature-graph-spatial-index.mjs"
import {
    applyTransformsCpu,
    bisectMixedEdgesCpu,
    subdivideEdgesCpu,
    type FeatureGraphWorldPositions,
} from "./feature-graph-stages.mjs"
import { log } from "../logging/debug-log.mjs"

export type { FeatureGraphWorldPositions } from "./feature-graph-stages.mjs"

export interface FeatureGraphBuildResult {
    /** Pre-subdivision counts from the extractor — useful for instrumentation. */
    extractedVertexCount: number
    extractedEdgeCount: number
    /** Post-stage-3 counts (input to stage 4 SDF query). */
    subdividedVertexCount: number
    subdividedEdgeCount: number
    /** Final counts after stage 4 bisection (includes boundary vertices). */
    finalVertexCount: number
    finalEdgeCount: number
    loopCount: number
    transformCount: number
    nonAffineSubtrees: number
    aliveVertexCount: number
    aliveEdgeCount: number
    aliveLoopCount: number
    /** World positions for the final vertex set (post-bisection). */
    worldPositions: FeatureGraphWorldPositions
    spatialIndex: FeatureGraphSpatialIndex
    /**
     * Final extended CPU snapshot — exposes `vertexFlags`, `edgeFlags`,
     * `vertexOwnerNodeId`, etc., so adapters (e.g. SHREC's `ContourBufferView`
     * feed) can read alive bits + owner ids without going through the
     * spatial index. World-space positions live in {@link worldPositions};
     * the snapshot's `vertexPositions` agrees with that for indices ≥ the
     * original extraction count (newly inserted vertices have identity
     * transformIdx, so local ≡ world).
     */
    cpu: import("../scene/feature-graph-buffer.mjs").FeatureGraphCpu
}

function emptyResult(cpu: FeatureGraphCpu, cellSize: number): FeatureGraphBuildResult {
    return {
        extractedVertexCount: 0,
        extractedEdgeCount: 0,
        subdividedVertexCount: 0,
        subdividedEdgeCount: 0,
        finalVertexCount: 0,
        finalEdgeCount: 0,
        loopCount: 0,
        transformCount: cpu.transformCount,
        nonAffineSubtrees: 0,
        aliveVertexCount: 0,
        aliveEdgeCount: 0,
        aliveLoopCount: 0,
        worldPositions: { positions: new Float32Array(0), count: 0 },
        spatialIndex: FeatureGraphSpatialIndex.empty(cellSize),
        cpu,
    }
}

export class FeatureGraphGpu {
    /**
     * Run stages 2 → 5 against the CPU snapshot. Async because stage 4
     * dispatches a GPU compute pass and waits on a `mapAsync` readback.
     */
    async build(
        cpu: FeatureGraphCpu,
        cellSize: number,
        isoBatch: IsoSampleBatch,
        isoSampleModule: GPUShaderModule,
        signal?: AbortSignal,
    ): Promise<FeatureGraphBuildResult> {
        let nonAffineSubtrees = 0
        for (let i = 1; i < cpu.transformCount; i++) {
            if (((cpu.transformFlags[i] ?? 0) & FG_FLAG_NON_AFFINE_ANCESTOR) !== 0) nonAffineSubtrees++
        }

        const extractedVertexCount = cpu.vertexCount
        const extractedEdgeCount = cpu.edgeCount

        if (cpu.vertexCount === 0) {
            log("FeatureGraph").debug("build (phase C: empty extraction)", {
                vertexCount: 0,
                transformCount: cpu.transformCount,
                nonAffineSubtrees,
                cellSize,
            })
            return emptyResult(cpu, cellSize)
        }

        // Stage 2: local → world.
        let world = applyTransformsCpu(cpu)

        // Stage 3: subdivide edges so every segment is ≤ ½ × cell_size.
        let current = subdivideEdgesCpu(cpu, world, cellSize)
        cpu = current.cpu
        world = current.world

        const subdividedVertexCount = cpu.vertexCount
        const subdividedEdgeCount = cpu.edgeCount

        // Stage 4: SDF query at every world position. IsoSampleBatch returns
        // interleaved `[nx, ny, nz, d, …]`; only `d` is read for survival,
        // but the rest is preserved for stage-D2 bisection input.
        const result = await isoBatch.run(
            isoSampleModule,
            world.positions as Float32Array<ArrayBuffer>,
            cellSize,
            { signal },
        )

        const epsilon = 0.5 * cellSize
        for (let i = 0; i < cpu.vertexCount; i++) {
            const d = result.sdf[i * 4 + 3]!
            if (Math.abs(d) >= epsilon) {
                cpu.vertexFlags[i] = (cpu.vertexFlags[i] ?? 0) & ~FG_FLAG_ALIVE
            }
        }

        // Stage 4b: bisect mixed-alive edges (only meaningful after stage 3
        // has shortened edges enough that the linear-interp crossing is a
        // good approximation of the true SDF surface).
        current = bisectMixedEdgesCpu(cpu, world, result.sdf, epsilon)
        cpu = current.cpu
        world = current.world

        // Cascade survival to remaining edges + loops (the bisection step
        // already marked the original mixed edges dead and emitted alive
        // partial replacements, so this final pass only handles edges where
        // both endpoints are dead).
        let aliveVertexCount = 0
        for (let i = 0; i < cpu.vertexCount; i++) {
            if ((cpu.vertexFlags[i]! & FG_FLAG_ALIVE) !== 0) aliveVertexCount++
        }
        let aliveEdgeCount = 0
        for (let e = 0; e < cpu.edgeCount; e++) {
            if ((cpu.edgeFlags[e]! & FG_FLAG_ALIVE) === 0) continue
            const va = cpu.edgeEndpoints[e * 2]!
            const vb = cpu.edgeEndpoints[e * 2 + 1]!
            const aAlive = (cpu.vertexFlags[va]! & FG_FLAG_ALIVE) !== 0
            const bAlive = (cpu.vertexFlags[vb]! & FG_FLAG_ALIVE) !== 0
            if (aAlive && bAlive) {
                aliveEdgeCount++
            } else {
                cpu.edgeFlags[e] = cpu.edgeFlags[e]! & ~FG_FLAG_ALIVE
            }
        }
        let aliveLoopCount = 0
        for (let l = 0; l < cpu.loopCount; l++) {
            const start = cpu.loopIndexStart[l]!
            const count = cpu.loopIndexCount[l]!
            let allAlive = true
            for (let i = 0; i < count; i++) {
                const vi = cpu.loopVertexIndices[start + i]!
                if ((cpu.vertexFlags[vi]! & FG_FLAG_ALIVE) === 0) {
                    allAlive = false
                    break
                }
            }
            if (allAlive) {
                aliveLoopCount++
            } else {
                cpu.loopFlags[l] = cpu.loopFlags[l]! & ~FG_FLAG_ALIVE
            }
        }

        // Stage 5: bin alive features.
        const spatialIndex = FeatureGraphSpatialIndex.build(cpu, world, cellSize)

        log("FeatureGraph").debug("build (phase C: extract + transform + subdivide + survive + bin)", {
            extractedVertexCount,
            extractedEdgeCount,
            subdividedVertexCount,
            subdividedEdgeCount,
            finalVertexCount: cpu.vertexCount,
            finalEdgeCount: cpu.edgeCount,
            aliveVertexCount,
            aliveEdgeCount,
            loopCount: cpu.loopCount,
            aliveLoopCount,
            transformCount: cpu.transformCount,
            nonAffineSubtrees,
            cellSize,
            cellsOccupied: spatialIndex.cellCount,
        })

        return {
            extractedVertexCount,
            extractedEdgeCount,
            subdividedVertexCount,
            subdividedEdgeCount,
            finalVertexCount: cpu.vertexCount,
            finalEdgeCount: cpu.edgeCount,
            loopCount: cpu.loopCount,
            transformCount: cpu.transformCount,
            nonAffineSubtrees,
            aliveVertexCount,
            aliveEdgeCount,
            aliveLoopCount,
            worldPositions: world,
            spatialIndex,
            cpu,
        }
    }

    destroy(): void {
        // Nothing to release in phase C.
    }
}

/** @deprecated Use {@link applyTransformsCpu} from `./feature-graph-stages.mjs`. */
export { applyTransformsCpu as applyTransforms } from "./feature-graph-stages.mjs"
