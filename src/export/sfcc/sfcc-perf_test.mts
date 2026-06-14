import assert from "node:assert/strict"
import test from "node:test"
import { Sphere } from "../../scene/primitives/sphere.mjs"
import { Union } from "../../scene/operators/union.mjs"
import { compileCpuSdf, type CpuSdfTree } from "./cpu-sdf.mjs"
import { runSfccPipeline } from "./assemble.mjs"
import { DEFAULT_SFCC_TUNING, type SfccTuning } from "./sfcc-tuning.mjs"

/** Two spheres: enough refinement + meshing to populate every perf bucket. */
function scene(): CpuSdfTree {
    return compileCpuSdf(new Union([new Sphere([-2.1, 0.3, 0.2], { r: 6 }), new Sphere([7.3, -0.4, 0.1], { r: 1.1 })]))
}
const CUBE = { minX: -12, minY: -12, minZ: -12, size: 24 }
const TUNING: SfccTuning = { ...DEFAULT_SFCC_TUNING, depthMin: 4, depthMax: 7, boundsPaddingMm: 0, normalVariationDeg: 30 }

test("profile off: no perf payload (default path unchanged)", () => {
    const r = runSfccPipeline(scene(), CUBE, TUNING)
    assert.equal(r.perf, undefined)
})

test("profile on: perf buckets + counts populate, sub-buckets are consistent", () => {
    const r = runSfccPipeline(scene(), CUBE, { ...TUNING, profile: true })
    const p = r.perf
    assert.ok(p, "perf present when profile is on")

    // The build actually evaluated the field and the certified cull.
    assert.ok(p.sampleEvals > 0, `sampleEvals=${p.sampleEvals}`)
    assert.ok(p.intervalCalls > 0, `intervalCalls=${p.intervalCalls}`)
    assert.ok(p.fCalls > 0, `fCalls=${p.fCalls}`)
    // Build memo-misses are a subset of all tree.f calls (meshing adds more).
    assert.ok(p.sampleEvals <= p.fCalls, `sampleEvals ${p.sampleEvals} > fCalls ${p.fCalls}`)

    // Every wall-time bucket is non-negative and the disjoint phases don't
    // exceed the whole (timer jitter slack only).
    for (const k of ["featureCompileMs", "octreeBuildMs", "faceContourMs", "cellMeshMs", "assembleMs", "totalMs",
        "intervalMs", "sampleMs", "classifyMs", "smoothCritMs",
        "classifyIndexMs", "classifyCrossingsMs", "classifyStratumMs",
        "faceRootMs", "faceRecoverMs", "facePinMs",
        "faceWalkMs", "faceTagMs", "facePinQueryMs", "facePairMs", "faceDedupMs",
        "assembleAuditMs", "assembleCoincidentMs", "assembleDebrisMs", "assembleSliverMs", "assembleManifoldMs"] as const) {
        assert.ok(p[k] >= 0, `${k}=${p[k]}`)
    }
    const phaseSum = p.featureCompileMs + p.octreeBuildMs + p.faceContourMs + p.cellMeshMs + p.assembleMs
    assert.ok(phaseSum <= p.totalMs + 5, `phaseSum ${phaseSum} > totalMs ${p.totalMs}`)
    // Octree sub-buckets are charged inside the octree-build phase.
    assert.ok(p.intervalMs + p.sampleMs + p.classifyMs + p.smoothCritMs <= p.octreeBuildMs + 5)
    // classify sub-buckets are charged inside classifyMs (remainder = glue/branching).
    assert.ok(p.classifyIndexMs + p.classifyCrossingsMs + p.classifyStratumMs <= p.classifyMs + 5,
        `classify subbuckets ${p.classifyIndexMs + p.classifyCrossingsMs + p.classifyStratumMs} > classifyMs ${p.classifyMs}`)
    // faceContour sub-buckets are DISJOINT and charged inside faceContourMs
    // (walk/pinQuery subtract the root/recover/tag/pin kernels nested in them;
    // remainder = the contourAllFaces enumeration glue). They must sum to ≤ the
    // phase total.
    const faceSub =
        p.faceRootMs + p.faceRecoverMs + p.facePinMs +
        p.faceWalkMs + p.faceTagMs + p.facePinQueryMs + p.facePairMs + p.faceDedupMs
    assert.ok(faceSub <= p.faceContourMs + 5,
        `face subbuckets ${faceSub} > faceContourMs ${p.faceContourMs}`)
    // assemble sub-buckets are charged inside assembleMs (remainder = histogram + stats + overlays).
    const asmSub =
        p.assembleAuditMs + p.assembleCoincidentMs + p.assembleDebrisMs + p.assembleSliverMs + p.assembleManifoldMs
    assert.ok(asmSub <= p.assembleMs + 5, `assemble subbuckets ${asmSub} > assembleMs ${p.assembleMs}`)
})

test("profile on vs off: identical mesh (instrumentation is inert)", () => {
    const off = runSfccPipeline(scene(), CUBE, TUNING)
    const on = runSfccPipeline(scene(), CUBE, { ...TUNING, profile: true })
    assert.deepEqual(on.verts, off.verts, "vertices changed under profiling")
    assert.deepEqual(on.tris, off.tris, "triangles changed under profiling")
    assert.equal(on.stats.leaves, off.stats.leaves)
    assert.equal(on.stats.tris, off.stats.tris)
})
