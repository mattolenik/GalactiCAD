import test from "node:test"
import assert from "node:assert/strict"
import { measureCrease, measureCreaseMemberships, MeshQuery, type Point, type Region } from "./gpu-coverage.mjs"

function flatLabeledMesh(end = 1) {
    const vertices = new Float32Array(4 * 8)
    ;[[0, 0, 0], [0, end, 0], [-1, 0.5, 0], [1, 0.5, 0]].forEach((p, i) => vertices.set(p, 8 * i))
    return new MeshQuery(vertices, new Uint32Array([0, 1, 2, 1, 0, 3]))
}
const region: Region = { id: "metadata-control", center: [0, 0.5, 0], half: 1, spacing: 0.1, crease: [[0, 0, 0], [0, 1, 0]], creaseMemberships: { ids: [1, 2], range: [0, 1], endpointMode: "curve-ends" } }
const labels = new Float64Array([0, 1, 1, 0, 1, 1, 0, 2, 1, 0])

test("both memberships, their own parameter direction, indexed path and physical endpoints are separate obligations", () => {
    const measured = measureCreaseMemberships(region, flatLabeledMesh(), labels)!
    assert.equal(measured.membershipStatus, "SAMPLED_PASS")
    assert.equal(measured.orderedPathStatus, "SAMPLED_PASS")
    assert.equal(measured.endpointStatus, "SAMPLED_PASS")
    const wrongLabel = labels.slice(); wrongLabel[7] = 99
    assert.equal(measureCreaseMemberships(region, flatLabeledMesh(), wrongLabel)!.membershipStatus, "FAIL")
    const shiftedEndpoint = measureCreaseMemberships(region, flatLabeledMesh(0.9), labels)!
    assert.equal(shiftedEndpoint.membershipStatus, "SAMPLED_PASS")
    assert.equal(shiftedEndpoint.endpointStatus, "FAIL")
    const wrongChart = labels.slice(); wrongChart[9] = 0.1
    assert.equal(measureCreaseMemberships(region, flatLabeledMesh(), wrongChart)!.orderedPathStatus, "FAIL")
})

test("complete labels and indexed connectivity do not turn flattened geometry into a sharp crease", () => {
    const reference = [{ station: 0, seed: [0, 0.5, 0] as Point, point: [0, 0.5, 0] as Point, status: "RESOLVED" as const,
        normals: [[0, 0, 1], [Math.sin(0.3), 0, Math.cos(0.3)]] as [Point, Point], contrast: 0.3, angularAllowance: 0.1 }]
    const result = measureCrease(reference, flatLabeledMesh(), labels, new Map([[0, [0, 0, 1] as Point], [1, [0, 0, 1] as Point]]), region)
    assert.equal(result.metadataStatus, "SAMPLED_PASS")
    assert.equal(result.sourceMemberships!.orderedPathStatus, "SAMPLED_PASS")
    assert.equal(result.status, "FAIL")
    assert.equal(result.identifiedGeometry![0].status, "FAIL")
    assert.ok(result.stations[0].edgeDiagnostics.length > 0)
    const withoutCentroidReferences = measureCrease(reference, flatLabeledMesh(), labels, new Map(), region)
    assert.equal(withoutCentroidReferences.status, "FAIL", "known loss of normal jump is not hidden by unavailable centroid references")
})
