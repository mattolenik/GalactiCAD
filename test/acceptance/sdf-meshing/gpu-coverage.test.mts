import { readFile } from "node:fs/promises"
import test from "node:test"
import assert from "node:assert/strict"
import { AcceptanceSourceGuard } from "../../../src/agent-autotest/acceptance-source-guard.mjs"
import { MeshQuery, measureReference, regionsFor, type Reference } from "./gpu-coverage.mjs"

test("GPU source identity rejects edits before and during a sample, failed builds and stale bodies", () => {
    const guard = new AcceptanceSourceGuard()
    assert.throws(() => guard.begin("A"), /stale/)
    guard.built("A", guard.epoch)
    const token = guard.begin("A")
    assert.throws(() => guard.begin("B"), /stale/)
    guard.invalidate()
    assert.throws(() => guard.begin("A"), /stale/)
    assert.throws(() => guard.check("A", token), /stale/)
    const epoch = guard.epoch
    guard.invalidate()
    guard.built("A", epoch)
    assert.throws(() => guard.begin("A"), /stale/)
    guard.built("A", guard.epoch)
    assert.doesNotThrow(() => guard.check("A", guard.begin("A")))
})

test("GPU regional references are pinned to full model source", () => {
    assert.throws(() => regionsFor("housing", "changed"), /source changed/)
    assert.throws(() => regionsFor("bracket", "changed"), /source changed/)
    assert.deepEqual(regionsFor("knob", "unknown"), [])
})

test("nearest-triangle query includes triangle interiors, remote candidates, and empty meshes", () => {
    const verts = new Float32Array(24)
    verts.set([0, 0, 0], 0); verts.set([1, 0, 0], 8); verts.set([0, 1, 0], 16)
    const query = new MeshQuery(verts, new Uint32Array([0, 1, 2]))
    assert.equal(query.nearest([0.25, 0.25, 0.5]).distance, 0.5)
    assert.ok(query.nearest([10, 10, 10]).distance > 10)
    assert.equal(new MeshQuery(verts, new Uint32Array()).nearest([0, 0, 0]).distance, Infinity)
})

test("no roots and unresolved brackets cannot be reported as sampled coverage passes", () => {
    const region = { id: "empty", center: [0, 0, 0] as [number, number, number], half: 1, spacing: 1 }
    const reference: Reference = { region, roots: [], sampledPoints: 27, sameSignEdges: 54, zeroEndpoints: 0, unrefinedBrackets: 0 }
    const mesh = new MeshQuery(new Float32Array(), new Uint32Array())
    assert.equal(measureReference(reference, mesh).status, "INCOMPLETE")
})


test("failed or superseded source builds never authorize stale GPU buffers", () => {
    const guard = new AcceptanceSourceGuard()
    guard.built("old", guard.buildStarted())
    const failed = guard.buildStarted()
    assert.throws(() => guard.begin("old"), /stale/)
    guard.built("new", failed, false)
    assert.throws(() => guard.begin("new"), /stale/)
    guard.built("new", guard.buildStarted(), true)
    assert.doesNotThrow(() => guard.begin("new"))
})


test("authentic GPU sign bracket detects the original closed bracket omission and passes repaired geometry", async () => {
    const fixture = JSON.parse(await readFile(new URL("./bracket-gpu-counterexample.json", import.meta.url), "utf8"))
    assert.equal(fixture.sourceSha256, "10f9049a0e3828edb19274b8137525ce1392916032078161adaafa4d58a99508")
    assert.ok(fixture.root.bracket[0].field * fixture.root.bracket[1].field < 0)
    const region = regionsFor("bracket", fixture.sourceSha256)[0]
    const reference: Reference = { region, roots: [fixture.root], sampledPoints: 0, sameSignEdges: 0, zeroEndpoints: 0, unrefinedBrackets: 0 }
    for (const [name, expected] of [["old", "FAIL"], ["current", "SAMPLED_PASS"]]) {
        const data = fixture[name], verts = new Float32Array(data.positions.length * 8)
        data.positions.forEach((p: number[], i: number) => verts.set(p, i * 8))
        const measured = measureReference(reference, new MeshQuery(verts, new Uint32Array(data.triangles.flat())))
        assert.equal(measured.status, expected)
        assert.ok(Math.abs(measured.worst!.distance - fixture.fullMeshDistances[name].distance) < 1e-12)
        assert.ok(measured.worst!.distance < data.omittedTriangleAabbLowerBoundMm)
    }
})

test("authentic housing GPU normals detect lost labels and flattened geometry independently", async () => {
    const { measureCrease } = await import("./gpu-coverage.mjs")
    const fixture = JSON.parse(await readFile(new URL("./housing-gpu-crease.json", import.meta.url), "utf8"))
    assert.equal(fixture.sourceSha256, "54964141fea0ed055f5392837c5e524f4a358e1c610f0b11a90857b8b57ad4a5")
    const mesh = (positions: number[][]) => { const verts = new Float32Array(positions.length * 8); positions.forEach((p, i) => verts.set(p, i * 8)); return new MeshQuery(verts, new Uint32Array(fixture.triangles.flat())) }
    const query = mesh(fixture.positions), features = new Float64Array(fixture.features)
    const baseline = measureCrease(fixture.references, query, features, new Map(fixture.centroidNormals))
    assert.ok(baseline.stations.some(s => s.status === "SAMPLED_PASS"))
    assert.ok(baseline.stations.some(s => s.status === "FAIL"), "retain the existing failed section")
    const noLabels = measureCrease(fixture.references, query, new Float64Array(), new Map(fixture.centroidNormals))
    assert.equal(noLabels.status, baseline.status)
    assert.ok(noLabels.missingLabelStations > baseline.missingLabelStations)
    const flattened = measureCrease(fixture.references, mesh(fixture.flattenedPositions), features, new Map(fixture.centroidNormals))
    assert.ok(flattened.stations.filter(s => s.status === "FAIL").length > baseline.stations.filter(s => s.status === "FAIL").length)
})
