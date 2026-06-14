/**
 * SFCC build-time performance instrumentation. Opt-in via `tuning.profile`
 * (default off → no tree wrapping, no timers; the default export path stays
 * byte-identical and allocation-free).
 *
 * Mirrors iso-simplicial's {@link IsoOctreeBuildPerf}: coarse phase wall-times
 * plus octree-refinement sub-buckets and SDF call counts, so the CPU↔GPU
 * offload decision rests on measured numbers — where deep refinement actually
 * spends time — rather than estimates. The single question this answers: during
 * deep refinement, what fraction is GPU-movable field/normal sampling
 * (`sampleMs`) vs the certified interval cull (`intervalMs`) vs symbolic
 * feature-set work (`classifyMs`, which never moves) vs meshing.
 *
 * Timers wrap O(cells) call sites (`certifiedEmpty`, `classifyCellFeatures`,
 * `needsSplitSmooth`) — never a raw per-sample SDF call — but `performance.now()`
 * at that granularity still adds measurable overhead. Treat absolute totals as
 * inflated and read the SPLIT between buckets, not the sum.
 */

import type { CpuSdfTree } from "./cpu-sdf.mjs"

/**
 * Octree-refinement sub-buckets written from inside {@link buildOctree}. A
 * narrow slice of {@link SfccPerf} so `octree.mts` needn't import the full type.
 */
export interface OctreeSamplePerf {
    /** Accumulated ms in `tree.intervalOverBox` — the certified empty-cull. */
    intervalMs: number
    /** Accumulated ms in `tree.f` memo-MISS evaluations (unique corner/leaf samples). */
    sampleMs: number
    /** Count of memo-miss `tree.f` evaluations — the distinct points a GPU batch would dispatch. */
    sampleEvals: number
}

/**
 * `classifyCellFeatures` sub-buckets, written from inside refine-criteria.mts.
 * Narrow slice of {@link SfccPerf} so refine-criteria needn't import the full
 * type. The three should roughly sum to `classifyMs`; the remainder is glue
 * (AABB build, in-box predicates, branching, the total==0 containment probe).
 */
export interface ClassifyPerf {
    /** `features.index.cornersInBox` + `curvesInBox` — hash-grid spatial queries. */
    classifyIndexMs: number
    /** `curve.axisPlaneCrossings` — O(polyline) walk + per-crossing bisection + alloc. */
    classifyCrossingsMs: number
    /** Pin-visibility certificate — per-adjacent-stratum 4-corner `st.f` sign tests. */
    classifyStratumMs: number
}

/**
 * `contourAllFaces` sub-buckets, written from inside face-contour.mts. Narrow
 * slice of {@link SfccPerf}. The three should roughly sum to a large fraction of
 * `faceContourMs`; the remainder is the boundary walk + segment pairing.
 */
export interface FaceContourPerf {
    /** `findRoot` — per-sub-edge iso-crossing 60-iter bisection on `tree.f` (deduped via the point table). */
    faceRootMs: number
    /** `recoveredCrossingsFor` — hidden-arc per-stratum carrier bisection near features (cached per sub-edge). */
    faceRecoverMs: number
    /** `axisPlaneCrossings` feature pinning (post-cache: mostly cache hits). */
    facePinMs: number
    /** Boundary walk: `sampleAt` / interior discovery / node building, EXCLUDING the root/recover/tag kernels (subtracted out — disjoint). */
    faceWalkMs: number
    /** `stratumTagFor` — per-visible-crossing `curvesInBox` query + per-stratum carrier sign/normal flank test. */
    faceTagMs: number
    /** Pin-block overhead EXCLUDING `axisPlaneCrossings` (facePinMs): the `curvesInBox` query + in-rect filter + averaged-normal `getOrCreateStr`. */
    facePinQueryMs: number
    /** Two-pass pairing (stratum tally + run rule + collinear split) + pin-anchored splice — the matching that builds `record.segments`. */
    facePairMs: number
    /** Global duplicate-segment repair in `contourAllFaces` (cross-face dedup walk + per-collision `splitMidpoint`). */
    faceDedupMs: number
    /** `recoveredCrossingsFor` cache-MISS invocations (the sub-edges that actually run detection). */
    recoverCalls: number
    /** `st.f` evals in the SUBDIV=8 detection SCAN (per stratum, runs even with no crossing). */
    recoverScanEvals: number
    /** `st.f` evals in the per-bracket 50-iter carrier BISECTION (only on sign-change brackets). */
    recoverBisectEvals: number
}

/**
 * `needsSplitSmooth` sub-buckets, written from inside refine-criteria.mts.
 * Narrow slice of {@link SfccPerf}. activeStrata (owner queries) vs the
 * per-stratum normal-variation / edge-crossing certificates.
 */
export interface SmoothCritPerf {
    /** `activeStrata` — `tree.activeOwnersAt` at the 9 probe points + per-owner carrier scan. */
    smoothActiveStrataMs: number
    /** Per-stratum `stratumNormalVariationOk` + `stratumEdgeCrossingsOk` (st.normal / st.f). */
    smoothStratumCertMs: number
    /** `st.f` evals in activeStrata's per-owner closest-stratum scan (vs the `activeOwnersAt` lookup itself). */
    smoothCarrierEvals: number
}

export interface SfccPerf extends OctreeSamplePerf, ClassifyPerf, FaceContourPerf, SmoothCritPerf {
    // --- phase wall times (ms), summed across re-refine rounds ---------------
    /** S1: `compileFeatureSet` (analytic strata + trimmed feature curves/corners). */
    featureCompileMs: number
    /** S2: `buildOctree` certified refinement (includes `intervalMs` + `sampleMs` + `classifyMs` + `smoothCritMs`). */
    octreeBuildMs: number
    /** S3a: `contourAllFaces`. */
    faceContourMs: number
    /** S3b: `meshAllCells`. */
    cellMeshMs: number
    /** S4: audits, debris/sliver filters, weld, manifold check. */
    assembleMs: number
    /** Whole `runSfccPipeline` wall time (phases + uninstrumented glue). */
    totalMs: number

    // --- octree-refinement sub-buckets (ms) — see also OctreeSamplePerf ------
    /** `classifyCellFeatures` — symbolic feature-set spatial queries; NO raw SDF, never GPU-movable. */
    classifyMs: number
    /** `makeProbe` center eval + `needsSplitSmooth` (activeStrata / grad / per-stratum carriers). */
    smoothCritMs: number
    // classify sub-buckets (classifyIndexMs / classifyCrossingsMs / classifyStratumMs) come from ClassifyPerf.

    // --- assemble (S4) sub-buckets (ms) — written directly from assemble.mts;
    //     sum to a large fraction of assembleMs (remainder = histogram + stats + overlays).
    /** Face-segment consumption audit (the CMS closedness check over every face/segment). */
    assembleAuditMs: number
    /** `dropCoincidentTrianglePairs` — BOTH calls combined; sorted-vertex string-keyed pancake removal. */
    assembleCoincidentMs: number
    /** `dropDebrisComponents` — union-find + per-component bounds + feature-hug `curvesInBox`. */
    assembleDebrisMs: number
    /** `flipSliverTriangles` — long-thin sliver edge flips. */
    assembleSliverMs: number
    /** `points.buildMesh` weld + `checkManifold` edge audit. */
    assembleManifoldMs: number

    // --- call counts across ALL phases (via the counting wrapper) -----------
    /** Total `tree.f` calls (build memo-misses + center evals + meshing root-finding + feature compile). */
    fCalls: number
    /** Total `tree.grad` calls. */
    gradCalls: number
    /** Total `tree.intervalOverBox` calls (build only). */
    intervalCalls: number
    /** Total `tree.activeOwnersAt` calls. */
    ownersCalls: number

    /** Re-refinement rounds run (octree rebuilt with forced splits). */
    rounds: number
}

export function createSfccPerf(): SfccPerf {
    return {
        intervalMs: 0,
        sampleMs: 0,
        sampleEvals: 0,
        featureCompileMs: 0,
        octreeBuildMs: 0,
        faceContourMs: 0,
        cellMeshMs: 0,
        assembleMs: 0,
        totalMs: 0,
        classifyMs: 0,
        smoothCritMs: 0,
        assembleAuditMs: 0,
        assembleCoincidentMs: 0,
        assembleDebrisMs: 0,
        assembleSliverMs: 0,
        assembleManifoldMs: 0,
        classifyIndexMs: 0,
        classifyCrossingsMs: 0,
        classifyStratumMs: 0,
        faceRootMs: 0,
        faceRecoverMs: 0,
        facePinMs: 0,
        faceWalkMs: 0,
        faceTagMs: 0,
        facePinQueryMs: 0,
        facePairMs: 0,
        faceDedupMs: 0,
        recoverCalls: 0,
        recoverScanEvals: 0,
        recoverBisectEvals: 0,
        smoothActiveStrataMs: 0,
        smoothStratumCertMs: 0,
        smoothCarrierEvals: 0,
        fCalls: 0,
        gradCalls: 0,
        intervalCalls: 0,
        ownersCalls: 0,
        rounds: 0,
    }
}

/** High-resolution clock (mirrors iso-octree's `nowMs`; falls back in non-DOM envs). */
export function nowMs(): number {
    return globalThis.performance?.now ? globalThis.performance.now() : Date.now()
}

/**
 * Wrap a {@link CpuSdfTree} so every TOP-LEVEL field/owner query bumps a counter.
 * Only the four entry points are wrapped — the internal `evalNode`/`intervalNode`
 * recursion is untouched — so the cost is one indirection + increment per CALL
 * (O(cells) in the build, O(Newton steps) in meshing), never per recursion node.
 * `activeStrataAt`, `blendSeamDisplacement`, `leaves`, `strata`, `gradBound`,
 * `hasBlend` are forwarded unchanged.
 */
export function makeCountingTree(tree: CpuSdfTree, perf: SfccPerf): CpuSdfTree {
    return {
        ...tree,
        f: (px, py, pz) => {
            perf.fCalls++
            return tree.f(px, py, pz)
        },
        grad: (px, py, pz, out, off) => {
            perf.gradCalls++
            tree.grad(px, py, pz, out, off)
        },
        intervalOverBox: (cx, cy, cz, hx, hy, hz) => {
            perf.intervalCalls++
            return tree.intervalOverBox(cx, cy, cz, hx, hy, hz)
        },
        activeOwnersAt: (px, py, pz, tol) => {
            perf.ownersCalls++
            return tree.activeOwnersAt(px, py, pz, tol)
        },
    }
}
