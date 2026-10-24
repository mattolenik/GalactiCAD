import assert from "node:assert/strict"
import { test } from "node:test"
import { classify, renderReport, type CaptureRow } from "./report.mjs"
import { CASES, viewsFor } from "./manifest.mjs"
import { diagnosticSummary, inspectMesh } from "./diagnostics.mjs"

function row(validation: Record<string, any>, ok = true): CaptureRow {
    return { id: "housing", name: "Housing | <bad>", status: "INCOMPLETE", reasons: [], views: [], mesh: {
        triangles: 123, vertices: 70, meshDigest: "abc", pipelineMs: 20,
        execution: { ok, exportMs: 12 }, stats: {}, validation,
    } }
}
test("exporter success cannot substitute for unmeasured full-scene acceptance", () => {
    const r = row({ status: "passed", localCoverage: { scope: "outsideScope" } })
    classify(r)
    assert.equal(r.status, "INCOMPLETE")
    assert.match(r.reasons.join(" "), /not established/)
})
test("compiled-curve and geometry failures stay failures despite a usable mesh", () => {
    for (const validation of [{ status: "failed" }, { featureChains: { status: "failed" } }, { invalidTriangles: 1 }, { edgeIncidence: "failed" }]) {
        const r = row(validation); classify(r); assert.equal(r.status, "FAIL")
    }
    const unresolved = row({ status: "incomplete", unresolvedCells: 5 }, false)
    classify(unresolved)
    assert.equal(unresolved.status, "INCOMPLETE")
    assert.match(unresolved.reasons.join(" "), /5 unresolved/)
})
test("missing metadata and execution failures cannot become zero-valued passes", () => {
    const r = row({ status: "passed" }); r.mesh!.execution = {}
    classify(r); assert.equal(r.status, "INCOMPLETE")
    const failure: CaptureRow = { id: "knob", name: "Knob", status: "TIMEOUT", reasons: ["export timed out"], views: [] }
    classify(failure); assert.equal(failure.status, "TIMEOUT")
    const report = renderReport({ runId: "x", commit: "abc" }, [r, failure])
    assert.match(report, /N\/A/)
    assert.match(report, /Unavailable/)
    assert.match(report, /NOT PASSED/)
    assert.match(report, /Timed out; see case log/)
    assert.match(report, /Housing \\\| &lt;bad&gt;/)
    assert.doesNotMatch(report, /undefined|NaN/)
})
test("all five original complex cases retain four deterministic view definitions", () => {
    assert.deepEqual(CASES.map(c => c.id), ["bracket", "housing", "knob", "mess1", "mess2"])
    const camera = { position: [0, 0, 1], rotation: [1, 0, 0, 0], translation: [0, 0, 0], dollyDistance: 30 } as any
    for (const c of CASES) {
        const views = viewsFor(camera, c)
        assert.equal(views.length, 4)
        assert.deepEqual(views[0].camera, camera)
        assert.notDeepEqual(views[2].camera.translation, views[3].camera.translation)
        assert.deepEqual(views[1].camera.rotation, [0, 0, 1, 0].map((v, i) => i < 2 ? -v : v))
    }
})
test("a geometric witness failure is shown separately from passing exporter checks", () => {
    const r = row({ status: "passed", invalidTriangles: 0, edgeIncidence: "passed", vertexLinks: "passed", faceSegments: "passed", triangleNondegeneracy: "passed", featureChains: { status: "passed", issues: [] } })
    const verts = new Float32Array(24); verts[8] = 1; verts[17] = 1
    r.mesh!.triangles = 1
    r.diagnostics = diagnosticSummary(inspectMesh(verts, new Uint32Array([0, 1, 2]), new Float64Array(), [], [{ id: "missing-corner", position: [0.2, 0.2, 1], tolerance: 0.02 }]))
    classify(r)
    assert.equal(r.status, "FAIL")
    assert.ok(r.reasons.some(s => s.includes("missing-corner")))
    assert.ok(!r.reasons.some(s => s.startsWith("SFCC validation failed")))
    const report = renderReport({ runId: "x", commit: "abc" }, [r])
    assert.match(report, /Separate acceptance dimensions/)
    assert.match(report, /Required geometric witnesses/)
    assert.match(report, /no minimum-area epsilon/)
})

test("regional GPU failure adds a failure while sampled pass cannot promote incomplete coverage", () => {
    for (const status of ["FAIL", "SAMPLED_REGIONS_ONLY", "ERROR"]) {
        const r = row({ status: "incomplete", unresolvedCells: 12 }, false)
        r.gpuCoverage = { status, coverageMs: 13, regions: [] }
        classify(r)
        assert.equal(r.status, status === "FAIL" ? "FAIL" : "INCOMPLETE")
        const report = renderReport({ runId: "x", commit: "abc" }, [r])
        assert.match(report, /gpu-coverage.json/)
        assert.match(report, /global Hausdorff/)
        assert.match(report, /separate from export time/)
    }
})

test("normal-search reasons and multiple crossings remain visible in Markdown", async () => {
    const { searchNormalBrackets, summarizeNormalSearches } = await import("./gpu-coverage.mjs")
    const searches = await searchNormalBrackets([{ point: [0, 0, 0], normal: [1, 0, 0] }], 0.04, async points => points.map(point => ({ point, normal: [1, 0, 0], field: (point[0] - 0.006) * (point[0] - 0.012) })))
    const meshProjection = summarizeNormalSearches(searches), r = row({ status: "incomplete" })
    r.gpuCoverage = { status: "INCOMPLETE", coverageMs: 2, regions: [{ id: "two-sheet-control", referencePoints: 2, surfaceToMesh: { status: "SAMPLED_PASS", worst: { distance: 0 } }, meshSamples: 1, residualFailures: 0, ambiguousProjections: 0, unresolvedProjectionBudget: 0, ambiguousSheetAssociations: 1, sameSignEdges: 1, zeroEndpoints: 0, referenceDiagnostics: { meshProjection, creaseProjection: summarizeNormalSearches([]), creaseSectionReasons: {}, tangentPlaneReasons: {} } }] }
    const report = renderReport({ runId: "x", commit: "abc" }, [r])
    assert.match(report, /MULTIPLE_STRICT_BRACKETS_OBSERVED/)
    assert.match(report, /Multiple crossings/)
    assert.match(report, /533 GPU samples per line/)
    assert.match(report, /do not select an incident sheet/)
    assert.doesNotMatch(report, /undefined|NaN/)
})
