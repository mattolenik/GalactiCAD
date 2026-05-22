/**
 * CPU implementations of FeatureGraph pipeline stages.
 *
 * Stages are functional: each takes a `(cpu, world)` pair and returns a new
 * `(cpu, world)` with the typed arrays grown to fit. The orchestrator
 * ({@link FeatureGraphGpu}) chains them. Mutating in-place would avoid the
 * reallocations but complicates ownership; for v1 vertex counts in the
 * hundreds, throwaway typed arrays are cheap.
 *
 * GPU promotion path: each of these has a direct compute-shader analogue
 * (`feature_graph_apply_transform.wgsl`, `_subdivide.wgsl`,
 * `_survive.wgsl`). When vertex counts cross the threshold where the GPU
 * dispatch + readback amortises, swap them in one at a time without
 * touching the orchestrator's interface.
 */

import type { FeatureGraphCpu } from "../scene/feature-graph-buffer.mjs"
import {
    FG_FLAG_ALIVE,
    FG_FLAG_CORNER,
    FG_FLAG_CREASE_ORIGINAL,
    FG_FLAG_CREASE_SUBDIVIDED,
    FG_FLAG_NON_AFFINE_ANCESTOR,
    FG_MAX_NORMALS_PER_VERTEX,
} from "../scene/feature-graph-buffer.mjs"

/** Stride 3 floats per world-space vertex position. */
export interface FeatureGraphWorldPositions {
    positions: Float32Array
    count: number
}

// ---------------------------------------------------------------------------
// Stage 2 — apply the affine transform chain (local → world)
// ---------------------------------------------------------------------------

/**
 * Per-transform cofactor matrix of the upper-left 3×3, packed stride-9
 * (row-major). The cofactor matrix equals `(M⁻¹)ᵀ` up to the scalar `det(M)`,
 * so multiplying a local normal by it and renormalising yields the correct
 * world-space normal even under non-uniform scale. The determinant is
 * discarded by the renormalise step. Slot `t` corresponds to `transforms[t]`.
 */
function buildNormalCofactors(cpu: FeatureGraphCpu): Float32Array {
    const out = new Float32Array(cpu.transformCount * 9)
    const m = cpu.transforms
    for (let t = 0; t < cpu.transformCount; t++) {
        const b = t * 16
        // Upper-left 3×3, rows a..i (column-major mat4 layout).
        const a = m[b + 0]!, bb = m[b + 4]!, c = m[b + 8]!
        const d = m[b + 1]!, e = m[b + 5]!, f = m[b + 9]!
        const g = m[b + 2]!, h = m[b + 6]!, i = m[b + 10]!
        const o = t * 9
        out[o + 0] = e * i - f * h
        out[o + 1] = -(d * i - f * g)
        out[o + 2] = d * h - e * g
        out[o + 3] = -(bb * i - c * h)
        out[o + 4] = a * i - c * g
        out[o + 5] = -(a * h - bb * g)
        out[o + 6] = bb * f - c * e
        out[o + 7] = -(a * f - c * d)
        out[o + 8] = a * e - bb * d
    }
    return out
}

/**
 * For each vertex, multiply its local position by the column-major 4x4 the
 * transform stack interned at emission time, and rotate its source-face
 * normals into world space (in place on `cpu.vertexNormals`) via the
 * transform's cofactor matrix so normals stay correct under rotation and
 * non-uniform scale. Baking the normals here — before subdivision — means the
 * stage-3 / stage-4b normal-copy steps inherit world-space normals directly
 * (subdivided/bisected vertices carry `transformIdx = 0`, so a later transform
 * pass would otherwise mis-apply identity to parent-local normals).
 *
 * Vertices that emitted under a non-affine ancestor get the
 * {@link FG_FLAG_NON_AFFINE_ANCESTOR} bit OR'd in here (the builder already
 * sets it at emit-time, but we re-confirm so the GPU promotion path with a
 * separate stage-2 compute pass produces an identical result).
 */
export function applyTransformsCpu(cpu: FeatureGraphCpu): FeatureGraphWorldPositions {
    const out = new Float32Array(cpu.vertexCount * 3)
    const cof = buildNormalCofactors(cpu)
    for (let i = 0; i < cpu.vertexCount; i++) {
        const lx = cpu.vertexPositions[i * 3 + 0]!
        const ly = cpu.vertexPositions[i * 3 + 1]!
        const lz = cpu.vertexPositions[i * 3 + 2]!
        const tIdx = cpu.vertexTransformIdx[i]!
        const t = tIdx * 16
        const m = cpu.transforms
        out[i * 3 + 0] = m[t + 0]! * lx + m[t + 4]! * ly + m[t + 8]! * lz + m[t + 12]!
        out[i * 3 + 1] = m[t + 1]! * lx + m[t + 5]! * ly + m[t + 9]! * lz + m[t + 13]!
        out[i * 3 + 2] = m[t + 2]! * lx + m[t + 6]! * ly + m[t + 10]! * lz + m[t + 14]!

        // Rotate the vertex's source-face normals into world space.
        const co = tIdx * 9
        const c0 = cof[co + 0]!, c1 = cof[co + 1]!, c2 = cof[co + 2]!
        const c3 = cof[co + 3]!, c4 = cof[co + 4]!, c5 = cof[co + 5]!
        const c6 = cof[co + 6]!, c7 = cof[co + 7]!, c8 = cof[co + 8]!
        const nc = cpu.vertexNormalCount[i]!
        const nBase = i * 3 * FG_MAX_NORMALS_PER_VERTEX
        for (let n = 0; n < nc; n++) {
            const nb = nBase + n * 3
            const nx = cpu.vertexNormals[nb + 0]!
            const ny = cpu.vertexNormals[nb + 1]!
            const nz = cpu.vertexNormals[nb + 2]!
            let wx = c0 * nx + c1 * ny + c2 * nz
            let wy = c3 * nx + c4 * ny + c5 * nz
            let wz = c6 * nx + c7 * ny + c8 * nz
            const len = Math.sqrt(wx * wx + wy * wy + wz * wz)
            if (len > 1e-12) {
                const inv = 1 / len
                wx *= inv; wy *= inv; wz *= inv
            }
            cpu.vertexNormals[nb + 0] = wx
            cpu.vertexNormals[nb + 1] = wy
            cpu.vertexNormals[nb + 2] = wz
        }

        const transformFlags = cpu.transformFlags[tIdx] ?? 0
        if ((transformFlags & FG_FLAG_NON_AFFINE_ANCESTOR) !== 0) {
            cpu.vertexFlags[i] = (cpu.vertexFlags[i] ?? 0) | FG_FLAG_NON_AFFINE_ANCESTOR
        }
    }
    return { positions: out, count: cpu.vertexCount }
}

// ---------------------------------------------------------------------------
// Stage 3 — adaptive subdivision in world space
// ---------------------------------------------------------------------------

/**
 * Split each edge into `ceil(worldLen / targetSeg)` segments by inserting
 * linearly-interpolated vertices. `targetSeg = 0.5 * cellSize` so that any
 * downstream stage 4 CSG cut affects at least one endpoint of the resulting
 * short segments (and the linear-interp bisection in
 * {@link bisectMixedEdgesCpu} is then a good approximation of the true
 * iso-surface crossing).
 *
 * New vertices inherit the `FG_FLAG_CREASE_SUBDIVIDED` flag plus the
 * original edge's `FG_FLAG_CREASE_ORIGINAL` (so downstream code can tell
 * "subdivided sample of an original crease" from "boundary vertex from
 * bisection"). Source-face normals are copied from the edge's `va` endpoint
 * — both endpoints of a feature edge share the same source faces (modulo cap
 * normals on cap edges; for v1 that approximation is acceptable since the
 * mid-segment sample is along the crease).
 *
 * The original edge is marked not-alive; new edges (`FG_FLAG_CREASE_SUBDIVIDED
 * | FG_FLAG_ALIVE`) are appended in sequence between the original endpoints
 * via the freshly inserted intermediate vertices.
 *
 * @returns A new `(cpu, world)` pair with grown typed arrays.
 */
export function subdivideEdgesCpu(
    cpu: FeatureGraphCpu,
    world: FeatureGraphWorldPositions,
    cellSize: number,
): { cpu: FeatureGraphCpu; world: FeatureGraphWorldPositions } {
    const targetSeg = 0.5 * cellSize

    // Pass 1: compute per-edge segment count and the upper-bound for growth.
    // We allocate exactly — no over-allocation since this is a one-shot pass
    // (not iterative) and the count is known up-front from edge lengths.
    const segCounts = new Uint32Array(cpu.edgeCount)
    let extraVertices = 0
    let extraEdges = 0
    for (let e = 0; e < cpu.edgeCount; e++) {
        const va = cpu.edgeEndpoints[e * 2]!
        const vb = cpu.edgeEndpoints[e * 2 + 1]!
        const ax = world.positions[va * 3]!,    ay = world.positions[va * 3 + 1]!, az = world.positions[va * 3 + 2]!
        const bx = world.positions[vb * 3]!,    by = world.positions[vb * 3 + 1]!, bz = world.positions[vb * 3 + 2]!
        const dx = bx - ax, dy = by - ay, dz = bz - az
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
        const nSegs = Math.max(1, Math.ceil(len / targetSeg))
        segCounts[e] = nSegs
        if (nSegs > 1) {
            // `nSegs - 1` new intermediate vertices; `nSegs` new edges (the
            // original edge slot stays but is marked dead, so total edge slot
            // count grows by exactly `nSegs`).
            extraVertices += nSegs - 1
            extraEdges += nSegs
        }
    }

    if (extraVertices === 0) {
        // No edge needed splitting — return the inputs unchanged.
        return { cpu, world }
    }

    const newVertexCount = cpu.vertexCount + extraVertices
    const newEdgeCount = cpu.edgeCount + extraEdges
    const next = growSnapshot(cpu, world, newVertexCount, newEdgeCount)

    // Pass 2: write new vertices and new edges, mark originals.
    let nextVertexSlot = cpu.vertexCount
    let nextEdgeSlot = cpu.edgeCount
    for (let e = 0; e < cpu.edgeCount; e++) {
        const nSegs = segCounts[e]!
        if (nSegs <= 1) continue

        const va = cpu.edgeEndpoints[e * 2]!
        const vb = cpu.edgeEndpoints[e * 2 + 1]!
        const ax = world.positions[va * 3]!,    ay = world.positions[va * 3 + 1]!, az = world.positions[va * 3 + 2]!
        const bx = world.positions[vb * 3]!,    by = world.positions[vb * 3 + 1]!, bz = world.positions[vb * 3 + 2]!

        const originalFlags = cpu.edgeFlags[e]!
        const originalTransformIdx = cpu.edgeTransformIdx[e]!
        const originalOwner = cpu.edgeOwnerNodeId[e]!
        const inheritCreaseOriginal = originalFlags & FG_FLAG_CREASE_ORIGINAL

        // Insert nSegs - 1 intermediate vertices along va→vb.
        // Each intermediate gets its world position written; the local-space
        // position is set to the world value too (transformIdx = 0 ⇒ identity
        // applies on any future re-transform pass — see header comment).
        const firstNewVertexSlot = nextVertexSlot
        for (let k = 1; k < nSegs; k++) {
            const t = k / nSegs
            const px = ax + (bx - ax) * t
            const py = ay + (by - ay) * t
            const pz = az + (bz - az) * t
            const slot = nextVertexSlot++
            next.world.positions[slot * 3 + 0] = px
            next.world.positions[slot * 3 + 1] = py
            next.world.positions[slot * 3 + 2] = pz
            next.cpu.vertexPositions[slot * 3 + 0] = px
            next.cpu.vertexPositions[slot * 3 + 1] = py
            next.cpu.vertexPositions[slot * 3 + 2] = pz
            // Inherit crease lineage; never set FG_FLAG_CORNER (a 0D feature
            // by definition doesn't show up mid-segment).
            next.cpu.vertexFlags[slot] =
                FG_FLAG_ALIVE | FG_FLAG_CREASE_SUBDIVIDED | inheritCreaseOriginal
            next.cpu.vertexTransformIdx[slot] = 0
            next.cpu.vertexOwnerNodeId[slot] = originalOwner
            // Source-face normals: copy from `va` (both endpoints share the
            // same source faces along a feature edge).
            const nc = cpu.vertexNormalCount[va]!
            next.cpu.vertexNormalCount[slot] = nc
            const srcBase = va * 3 * FG_MAX_NORMALS_PER_VERTEX
            const dstBase = slot * 3 * FG_MAX_NORMALS_PER_VERTEX
            for (let n = 0; n < 3 * FG_MAX_NORMALS_PER_VERTEX; n++) {
                next.cpu.vertexNormals[dstBase + n] = cpu.vertexNormals[srcBase + n]!
            }
        }

        // Mark the original edge dead and lay down nSegs new edges between
        // (va, mid1, mid2, …, mid_{n-1}, vb).
        next.cpu.edgeFlags[e] = (next.cpu.edgeFlags[e]! & ~FG_FLAG_ALIVE)
        const newEdgeFlags = FG_FLAG_ALIVE | FG_FLAG_CREASE_SUBDIVIDED | inheritCreaseOriginal
        let prev = va
        for (let k = 1; k < nSegs; k++) {
            const mid = firstNewVertexSlot + (k - 1)
            const slot = nextEdgeSlot++
            next.cpu.edgeEndpoints[slot * 2 + 0] = prev
            next.cpu.edgeEndpoints[slot * 2 + 1] = mid
            next.cpu.edgeFlags[slot] = newEdgeFlags
            next.cpu.edgeTransformIdx[slot] = originalTransformIdx
            next.cpu.edgeOwnerNodeId[slot] = originalOwner
            prev = mid
        }
        // Final segment: last mid → vb.
        const finalSlot = nextEdgeSlot++
        next.cpu.edgeEndpoints[finalSlot * 2 + 0] = prev
        next.cpu.edgeEndpoints[finalSlot * 2 + 1] = vb
        next.cpu.edgeFlags[finalSlot] = newEdgeFlags
        next.cpu.edgeTransformIdx[finalSlot] = originalTransformIdx
        next.cpu.edgeOwnerNodeId[finalSlot] = originalOwner
    }

    return next
}

// ---------------------------------------------------------------------------
// Stage 4b — bisect mixed-alive edges
// ---------------------------------------------------------------------------

/**
 * For every edge with one alive endpoint and one dead endpoint, insert a
 * boundary vertex at the linear-interp surface crossing (`t = d_alive /
 * (d_alive - d_dead)`) and emit a new alive edge from `alive → boundary`.
 * The original edge is marked not-alive.
 *
 * This relies on edges being short enough (after stage 3) that the SDF is
 * approximately linear across them — without subdivision, the boundary
 * estimate is poor for long edges crossing complex CSG regions.
 *
 * `sdfPerVertex` is the interleaved `[nx, ny, nz, d, …]` result from
 * {@link IsoSampleBatch.run}; only the `d` field is read here.
 *
 * @returns A new `(cpu, world)` pair with grown typed arrays.
 */
export function bisectMixedEdgesCpu(
    cpu: FeatureGraphCpu,
    world: FeatureGraphWorldPositions,
    sdfPerVertex: Float32Array,
    epsilon: number,
): { cpu: FeatureGraphCpu; world: FeatureGraphWorldPositions } {
    // Pass 1: count mixed-alive edges to size the growth exactly.
    let mixedCount = 0
    for (let e = 0; e < cpu.edgeCount; e++) {
        if ((cpu.edgeFlags[e]! & FG_FLAG_ALIVE) === 0) continue
        const va = cpu.edgeEndpoints[e * 2]!
        const vb = cpu.edgeEndpoints[e * 2 + 1]!
        const aAlive = (cpu.vertexFlags[va]! & FG_FLAG_ALIVE) !== 0
        const bAlive = (cpu.vertexFlags[vb]! & FG_FLAG_ALIVE) !== 0
        if (aAlive !== bAlive) mixedCount++
    }

    if (mixedCount === 0) return { cpu, world }

    const newVertexCount = cpu.vertexCount + mixedCount
    const newEdgeCount = cpu.edgeCount + mixedCount
    const next = growSnapshot(cpu, world, newVertexCount, newEdgeCount)

    // Pass 2: insert boundary vertex + alive partial edge per mixed edge.
    let nextVertexSlot = cpu.vertexCount
    let nextEdgeSlot = cpu.edgeCount
    for (let e = 0; e < cpu.edgeCount; e++) {
        if ((cpu.edgeFlags[e]! & FG_FLAG_ALIVE) === 0) continue
        const va = cpu.edgeEndpoints[e * 2]!
        const vb = cpu.edgeEndpoints[e * 2 + 1]!
        const aAlive = (cpu.vertexFlags[va]! & FG_FLAG_ALIVE) !== 0
        const bAlive = (cpu.vertexFlags[vb]! & FG_FLAG_ALIVE) !== 0
        if (aAlive === bAlive) continue

        const aliveV = aAlive ? va : vb
        const deadV = aAlive ? vb : va
        const dAlive = sdfPerVertex[aliveV * 4 + 3]!
        const dDead = sdfPerVertex[deadV * 4 + 3]!
        // Standard linear-interp surface crossing. Guard against divide-by-
        // zero when the two endpoints have nearly equal d — the boundary is
        // ill-defined there, so fall back to a midpoint (closer to alive).
        let t = 0.5
        const denom = dAlive - dDead
        if (Math.abs(denom) > 1e-9) {
            t = dAlive / denom
            // Clamp into (0, 1) — `t` should naturally fall there for a true
            // sign change, but numerical noise plus the alive band's
            // `|d|<eps` rule can produce slightly out-of-range values.
            if (t < 0) t = 0
            else if (t > 1) t = 1
        }

        const ax = world.positions[aliveV * 3]!,    ay = world.positions[aliveV * 3 + 1]!, az = world.positions[aliveV * 3 + 2]!
        const bx = world.positions[deadV * 3]!,     by = world.positions[deadV * 3 + 1]!, bz = world.positions[deadV * 3 + 2]!
        const px = ax + (bx - ax) * t
        const py = ay + (by - ay) * t
        const pz = az + (bz - az) * t

        const slot = nextVertexSlot++
        next.world.positions[slot * 3 + 0] = px
        next.world.positions[slot * 3 + 1] = py
        next.world.positions[slot * 3 + 2] = pz
        next.cpu.vertexPositions[slot * 3 + 0] = px
        next.cpu.vertexPositions[slot * 3 + 1] = py
        next.cpu.vertexPositions[slot * 3 + 2] = pz
        // Boundary vertex is by construction on the iso-surface (d ≈ 0):
        // alive, subdivided (a stage-4 split is structurally similar to a
        // stage-3 subdivision sample). Inherit crease-original lineage from
        // the parent edge.
        const originalEdgeFlags = cpu.edgeFlags[e]!
        const inheritCreaseOriginal = originalEdgeFlags & FG_FLAG_CREASE_ORIGINAL
        next.cpu.vertexFlags[slot] = FG_FLAG_ALIVE | FG_FLAG_CREASE_SUBDIVIDED | inheritCreaseOriginal
        next.cpu.vertexTransformIdx[slot] = 0
        next.cpu.vertexOwnerNodeId[slot] = cpu.edgeOwnerNodeId[e]!
        // Source-face normals: copy from the alive endpoint (the dead
        // endpoint's normals may have been pulled into a CSG cutter's
        // interior and lost their geometric meaning).
        const nc = cpu.vertexNormalCount[aliveV]!
        next.cpu.vertexNormalCount[slot] = nc
        const srcBase = aliveV * 3 * FG_MAX_NORMALS_PER_VERTEX
        const dstBase = slot * 3 * FG_MAX_NORMALS_PER_VERTEX
        for (let n = 0; n < 3 * FG_MAX_NORMALS_PER_VERTEX; n++) {
            next.cpu.vertexNormals[dstBase + n] = cpu.vertexNormals[srcBase + n]!
        }

        // Original mixed edge dies; new alive edge from alive → boundary.
        next.cpu.edgeFlags[e] = next.cpu.edgeFlags[e]! & ~FG_FLAG_ALIVE
        const newEdgeSlot = nextEdgeSlot++
        next.cpu.edgeEndpoints[newEdgeSlot * 2 + 0] = aliveV
        next.cpu.edgeEndpoints[newEdgeSlot * 2 + 1] = slot
        next.cpu.edgeFlags[newEdgeSlot] =
            FG_FLAG_ALIVE | FG_FLAG_CREASE_SUBDIVIDED | inheritCreaseOriginal
        next.cpu.edgeTransformIdx[newEdgeSlot] = cpu.edgeTransformIdx[e]!
        next.cpu.edgeOwnerNodeId[newEdgeSlot] = cpu.edgeOwnerNodeId[e]!
    }

    return next
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Allocate new typed arrays sized for the post-growth counts and copy the
 * existing prefix into them. Returns the new `(cpu, world)` pair; callers
 * fill the suffix beyond `cpu.vertexCount` / `cpu.edgeCount`.
 *
 * Loops and transforms pass through unchanged — subdivision and bisection
 * only touch vertices and edges.
 */
function growSnapshot(
    cpu: FeatureGraphCpu,
    world: FeatureGraphWorldPositions,
    newVertexCount: number,
    newEdgeCount: number,
): { cpu: FeatureGraphCpu; world: FeatureGraphWorldPositions } {
    const v = newVertexCount
    const e = newEdgeCount
    const nv = FG_MAX_NORMALS_PER_VERTEX * 3
    const nextVertexPositions = new Float32Array(v * 3)
    const nextWorldPositions = new Float32Array(v * 3)
    const nextVertexFlags = new Uint32Array(v)
    const nextVertexNormalCount = new Uint32Array(v)
    const nextVertexNormals = new Float32Array(v * nv)
    const nextVertexTransformIdx = new Uint32Array(v)
    const nextVertexOwnerNodeId = new Uint32Array(v)
    const nextEdgeEndpoints = new Uint32Array(e * 2)
    const nextEdgeFlags = new Uint32Array(e)
    const nextEdgeTransformIdx = new Uint32Array(e)
    const nextEdgeOwnerNodeId = new Uint32Array(e)

    nextVertexPositions.set(cpu.vertexPositions.subarray(0, cpu.vertexCount * 3))
    nextWorldPositions.set(world.positions.subarray(0, world.count * 3))
    nextVertexFlags.set(cpu.vertexFlags.subarray(0, cpu.vertexCount))
    nextVertexNormalCount.set(cpu.vertexNormalCount.subarray(0, cpu.vertexCount))
    nextVertexNormals.set(cpu.vertexNormals.subarray(0, cpu.vertexCount * nv))
    nextVertexTransformIdx.set(cpu.vertexTransformIdx.subarray(0, cpu.vertexCount))
    nextVertexOwnerNodeId.set(cpu.vertexOwnerNodeId.subarray(0, cpu.vertexCount))
    nextEdgeEndpoints.set(cpu.edgeEndpoints.subarray(0, cpu.edgeCount * 2))
    nextEdgeFlags.set(cpu.edgeFlags.subarray(0, cpu.edgeCount))
    nextEdgeTransformIdx.set(cpu.edgeTransformIdx.subarray(0, cpu.edgeCount))
    nextEdgeOwnerNodeId.set(cpu.edgeOwnerNodeId.subarray(0, cpu.edgeCount))

    const nextCpu: FeatureGraphCpu = {
        vertexPositions: nextVertexPositions,
        vertexFlags: nextVertexFlags,
        vertexNormalCount: nextVertexNormalCount,
        vertexNormals: nextVertexNormals,
        vertexTransformIdx: nextVertexTransformIdx,
        vertexOwnerNodeId: nextVertexOwnerNodeId,
        vertexCount: v,
        edgeEndpoints: nextEdgeEndpoints,
        edgeFlags: nextEdgeFlags,
        edgeTransformIdx: nextEdgeTransformIdx,
        edgeOwnerNodeId: nextEdgeOwnerNodeId,
        edgeCount: e,
        // Loops + transforms pass through (subdivision/bisection don't touch).
        loopVertexIndices: cpu.loopVertexIndices,
        loopIndexStart: cpu.loopIndexStart,
        loopIndexCount: cpu.loopIndexCount,
        loopNormals: cpu.loopNormals,
        loopTransformIdx: cpu.loopTransformIdx,
        loopOwnerNodeId: cpu.loopOwnerNodeId,
        loopFlags: cpu.loopFlags,
        loopCount: cpu.loopCount,
        transforms: cpu.transforms,
        transformFlags: cpu.transformFlags,
        transformCount: cpu.transformCount,
    }
    const nextWorld: FeatureGraphWorldPositions = {
        positions: nextWorldPositions,
        count: v,
    }
    return { cpu: nextCpu, world: nextWorld }
}

// Re-export shared flag for tests that want to assert on the corner classifier.
export { FG_FLAG_ALIVE, FG_FLAG_CORNER, FG_FLAG_CREASE_ORIGINAL, FG_FLAG_CREASE_SUBDIVIDED }
