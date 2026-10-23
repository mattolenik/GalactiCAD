import assert from "node:assert/strict"
import { test } from "node:test"
import { inspectMesh } from "./diagnostics.mjs"
import { witnessesFor } from "./manifest.mjs"

function vertices(points: number[][]) { const out = new Float32Array(points.length * 8); points.forEach((p, i) => out.set(p, i * 8)); return out }
test("exact audit accepts a subnormal valid face and identifies coincident versus collinear corners", () => {
    const tiny = 2 ** -149
    const v = vertices([[0, 0, 0], [tiny, 0, 0], [0, tiny, 0], [2 * tiny, 0, 0], [0, 0, 0]])
    const a = inspectMesh(v, new Uint32Array([0, 1, 2, 0, 1, 3, 0, 4, 2]), new Float64Array())
    assert.equal(a.invalidTriangles, 2)
    assert.deepEqual(a.defectKinds, { collinear: 1, coincidentCorners: 1 })
    assert.deepEqual(a.defects.map(d => d.triangle), [1, 2])
    assert.equal(a.exactPositionWeld.openEdges, 3)
})
test("geometric chain continuity is distinguished from split vertex identities", () => {
    const v = vertices([[0, 0, 0], [1, 0, 0], [1, 0, 0], [2, 0, 0]])
    const a = inspectMesh(v, new Uint32Array(), new Float64Array([0, 1, 7, 0, 0.4, 2, 3, 7, 0.6, 1]), [{ curveId: 7, kind: "parameterGap", range: [0.4, 0.6] }])
    assert.equal(a.curveConnectivity[0].indexedComponents, 2)
    assert.equal(a.curveConnectivity[0].geometricComponents, 1)
    assert.equal(a.parameterGaps[0].endpointChord, 0)
})
test("nonfinite coordinates and invalid indices are not disguised as zero-area faces", () => {
    const v = vertices([[0, 0, 0], [1, 0, 0], [NaN, 1, 0]])
    const a = inspectMesh(v, new Uint32Array([0, 1, 2, 0, 1, 9]), new Float64Array())
    assert.deepEqual(a.defectKinds, { nonfinite: 1, invalidIndex: 1 })
})
test("a labeled parameter gap can have complete geometric edge coverage under another curve ID", () => {
    const v = vertices([[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0], [0, 1, 0]])
    const features = new Float64Array([0, 1, 7, 0, 1, 2, 3, 7, 2, 3, 1, 2, 9, 0, 1])
    const a = inspectMesh(v, new Uint32Array([0, 1, 4, 1, 2, 4, 2, 3, 4]), features, [{ curveId: 7, kind: "parameterGap", range: [1, 2] }])
    assert.deepEqual(a.parameterGaps[0].straightSegmentCoverage, { fullyCovered: true, uncovered: [], coveringCurveIds: [9] })
})
test("point witnesses measure triangle interiors and detect a missing surface despite valid topology data", () => {
    const v = vertices([[0, 0, 0], [1, 0, 0], [0, 1, 0]])
    const a = inspectMesh(v, new Uint32Array([0, 1, 2]), new Float64Array(), [], [
        { id: "close", position: [0.2, 0.2, 0.01], tolerance: 0.02 },
        { id: "missing", position: [0.2, 0.2, 1], tolerance: 0.02 },
    ])
    assert.equal(a.pointWitnesses[0].distance, 0.01)
    assert.equal(a.pointWitnesses[0].passed, true)
    assert.equal(a.pointWitnesses[1].distance, 1)
    assert.equal(a.pointWitnesses[1].passed, false)
    assert.throws(() => witnessesFor("bracket", "changed-source"), /source changed/)
})
