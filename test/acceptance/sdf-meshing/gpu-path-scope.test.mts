import assert from "node:assert/strict"
import test from "node:test"
import { MeshQuery, measureCrease, type CreaseReference } from "./gpu-coverage.mjs"

function foldedStrip(options: { hole?: number; flat?: boolean; short?: boolean; arbitraryLabels?: boolean } = {}) {
    const positions: number[][] = [], triangles: number[] = [], labels: number[] = []
    for (let i = 0; i <= 100; i++) positions.push([i / 100, 0, 0], [i / 100, 0.1, options.flat ? 0 : 0.1], [i / 100, -0.1, options.flat ? 0 : 0.1])
    for (let i = 0; i < 100; i++) {
        if (i === options.hole) continue
        const a = 3 * i, b = a + 3
        triangles.push(a, b, b + 1, a, b + 1, a + 1, b, a, a + 2, b, a + 2, b + 2)
        labels.push(a, b, options.arbitraryLabels ? i : 0, i / 100, (i + 1) / 100)
    }
    const verts = new Float32Array(positions.length * 8)
    positions.forEach((p, i) => verts.set(p, i * 8))
    const references: CreaseReference[] = Array.from({ length: 9 }, (_, i) => {
        const x = options.short ? 0.42 + i * 0.02 : 0.05 + i * 0.1125
        return { station: i, seed: [x, 0, 0], point: [x, 0, 0], tangent: [1, 0, 0], status: "RESOLVED",
            normals: [[0, -Math.SQRT1_2, Math.SQRT1_2], [0, Math.SQRT1_2, Math.SQRT1_2]],
            contrast: Math.PI / 2, angularAllowance: Math.PI / 4 }
    })
    return measureCrease(references, new MeshQuery(verts, new Uint32Array(triangles)), new Float64Array(labels))
}

test("a continuous crease is incomplete when the graph omits inter-station connectors", () => {
    const result = foldedStrip()
    assert.ok(result.stations.every(s => s.status === "SAMPLED_PASS"))
    assert.equal(result.connected, false)
    assert.equal(result.status, "INCOMPLETE")
    assert.equal(result.connectionReason, "UNSEARCHED_INTERSTATION_CONNECTORS")
})

test("a path actually present in the candidate graph still has a sampled geometric pass", () => {
    const result = foldedStrip({ short: true })
    assert.equal(result.status, "SAMPLED_PASS")
    assert.equal(result.connected, true)
    assert.equal(result.connectionReason, "STATION_SUBGRAPH_PATH_FOUND")
})

test("a broken connector cannot be promoted by arbitrary feature labels", () => {
    const result = foldedStrip({ short: true, hole: 50, arbitraryLabels: true })
    assert.ok(result.stations.every(s => s.status === "SAMPLED_PASS"))
    assert.equal(result.status, "INCOMPLETE")
    assert.equal(result.connected, false)
    assert.equal(result.metadataScope, "localCandidateEdgeLabelsOnly")
})

test("a real local normal failure remains a failure despite the incomplete path search", () => {
    const result = foldedStrip({ flat: true })
    assert.ok(result.stations.some(s => s.status === "FAIL"))
    assert.equal(result.status, "FAIL")
    assert.equal(result.connectionReason, "LOCAL_SECTION_FAILED")
})

test("boundary subdivision alone can leave a normal failure within the surface budget", () => {
    // Analytic approximation control, not a scene evaluator: z = k*x*x/2.
    const length = 0.04, curvature = 25
    const worstVerticalDistance = curvature * length * length / 8
    const fanSlope = curvature * length / 2
    const centroidSlope = 2 * curvature * length / 3
    const errorDegrees = (Math.atan(centroidSlope) - Math.atan(fanSlope)) * 180 / Math.PI
    assert.ok(worstVerticalDistance < 0.01)
    assert.ok(errorDegrees > 5.869687125259935)
    for (const subdivisions of [1, 2, 16, 256]) {
        // Both boundary vertices have x=L; subdividing y leaves this plane unchanged.
        const a = [0, 0, 0], b = [length, 0, curvature * length * length / 2]
        const c = [length, 1 / subdivisions, curvature * length * length / 2]
        const nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1])
        const nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        assert.ok(Math.abs(-nx / nz - fanSlope) < 1e-15)
    }
})
