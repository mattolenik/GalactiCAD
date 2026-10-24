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
    const region = regionsFor("housing", fixture.sourceSha256)[0]
    const baseline = measureCrease(fixture.references, query, features, new Map(fixture.centroidNormals), region)
    assert.ok(baseline.stations.some(s => s.status === "SAMPLED_PASS"))
    assert.equal(baseline.status, "FAIL", "unrelated ambiguous edges cannot hide the identified failure")
    assert.ok(baseline.identifiedGeometry!.some(s => s.status === "FAIL"), "retain the existing failed physical crease section")
    const noLabels = measureCrease(fixture.references, query, new Float64Array(), new Map(fixture.centroidNormals), region)
    assert.equal(noLabels.status, baseline.status)
    assert.ok(noLabels.missingLabelStations > baseline.missingLabelStations)
    const flattened = measureCrease(fixture.references, mesh(fixture.flattenedPositions), features, new Map(fixture.centroidNormals), region)
    assert.ok(flattened.stations.filter(s => s.status === "FAIL").length > baseline.stations.filter(s => s.status === "FAIL").length)
})

// These are harness controls for finite searches, not a CPU scene evaluator.
import { searchNormalBrackets, NORMAL_SEARCH_BUDGET, verifyCreaseReferences, type Point, type Sampler, type CreaseReference, type Root } from "./gpu-coverage.mjs"
const control = (field: (p: Point) => number): Sampler => async points => points.map(point => ({ point, normal: [1, 0, 0], field: field(point) }))
const target = { point: [0, 0, 0] as Point, normal: [1, 0, 0] as Point }

test("nested probes retain two crossings hidden by equal outer endpoint signs", async () => {
    const [receipt] = await searchNormalBrackets([target], 0.04, control(p => (p[0] - 0.006) * (p[0] - 0.012)))
    assert.equal(receipt.attempts[0].reason, "SAME_SIGN_UNRESOLVED")
    assert.equal(receipt.status, "MULTIPLE_OBSERVED_CROSSINGS")
    assert.equal(receipt.roots.length, 2)
    assert.ok(receipt.roots[0].point[0] < receipt.roots[1].point[0])
    for (const root of receipt.roots) {
        assert.ok(root.bracket[0].field * root.bracket[1].field < 0)
        assert.ok(root.refinement!.attempts.length <= NORMAL_SEARCH_BUDGET.refinementIterations)
        assert.ok(root.refinement!.attempts.every(a => a.before.length === 2 && a.after.length === 2 && Number.isFinite(a.midpoint.field)))
    }
})

test("a nearby plane retains strict endpoints and a finite search budget", async () => {
    let sampled = 0
    const plane = control(p => p[0] - 0.003)
    const [receipt] = await searchNormalBrackets([target], 0.04, async p => { sampled += p.length; return plane(p) })
    assert.equal(receipt.status, "ONE_OBSERVED_CROSSING")
    assert.ok(receipt.roots[0].point[0] + receipt.roots[0].width / 2 + receipt.roots[0].allowance < 0.01)
    assert.equal(receipt.probes.length, NORMAL_SEARCH_BUDGET.samplesPerTarget)
    assert.equal(receipt.attempts.length, NORMAL_SEARCH_BUDGET.radii)
    assert.ok(sampled <= NORMAL_SEARCH_BUDGET.samplesPerTarget + NORMAL_SEARCH_BUDGET.maxRefinementSamplesPerBracket)
})

test("rounded-zero plateau preserves strict brackets and its unresolved width", async () => {
    const [receipt] = await searchNormalBrackets([target], 0.04, control(p => Math.abs(p[0]) <= 0.001 ? 0 : p[0]))
    assert.equal(receipt.status, "ONE_OBSERVED_CROSSING")
    assert.ok(receipt.zeroSamples > 0)
    assert.equal(receipt.unrefinedBrackets, 1)
    assert.ok(receipt.roots[0].width >= 0.002)
    assert.equal(receipt.roots[0].refinement!.stopReason, "REFINEMENT_BUDGET_EXHAUSTED")
    assert.ok(receipt.roots[0].refinement!.attempts.some(a => a.reason === "ROUNDED_ZERO_RETAINED_STRICT_ENDPOINTS"))
})

test("tangent roots and hidden thin pairs never become absence or resolved-root claims", async () => {
    const [tangent] = await searchNormalBrackets([target], 0.04, control(p => p[0] ** 2))
    assert.equal(tangent.status, "NO_STRICT_BRACKET")
    assert.ok(tangent.zeroSamples > 0)
    assert.equal(tangent.reason, "ZERO_SAMPLES_WITHOUT_STRICT_BRACKET")
    const [thin] = await searchNormalBrackets([target], 0.04, control(p => (p[0] - 0.0062) * (p[0] - 0.0064)))
    assert.equal(thin.status, "NO_STRICT_BRACKET")
    assert.equal(thin.reason, "FINITE_SEARCH_NO_STRICT_BRACKET")
    assert.ok(thin.intervals.some(a => a.reason === "SAME_SIGN_UNSEARCHED_INTERIOR"))
})

test("float32-collapsed probes and a zero direction retain specific causes", async () => {
    const [collapsed] = await searchNormalBrackets([{ point: [1e9, 0, 0], normal: [1, 0, 0] }], 0.04, control(p => p[0] - 1e9))
    assert.equal(collapsed.status, "NO_STRICT_BRACKET")
    assert.equal(collapsed.collapsedProbePositions, 14)
    assert.ok(collapsed.attempts.every(a => a.reason === "FLOAT32_COLLAPSED_PROBES"))
    const [zero] = await searchNormalBrackets([{ point: [0, 0, 0], normal: [0, 0, 0] }], 0.04, async () => { throw new Error("No queries expected") })
    assert.equal(zero.status, "INVALID_DIRECTION")
    assert.equal(zero.reason, "ZERO_NORMAL")
})

test("bad sample values, missing results and product-underflow signs cannot invent references", async () => {
    await assert.rejects(searchNormalBrackets([target], 0.04, control(() => NaN)), /Invalid GPU sample/)
    await assert.rejects(searchNormalBrackets([target], 0.04, async () => []), /Invalid GPU sample/)
    const [tiny] = await searchNormalBrackets([target], 0.04, control(p => p[0] * 1e-200))
    assert.equal(tiny.status, "ONE_OBSERVED_CROSSING")
    assert.ok(tiny.roots[0].bracket[0].field < 0 && tiny.roots[0].bracket[1].field > 0)
})

test("failed crease verification retains both bracket and field-agreement evidence", async () => {
    const root = (point: Point, normal: Point): Root => ({ point, normal, bracket: [{ point, normal, field: -1 }, { point, normal, field: 1 }], width: 0, allowance: 1e-6 })
    const reference = (): CreaseReference => ({ station: 0, seed: [0, 0, 0], point: [0, 0, 0], tangent: [0, 0, 1], normals: [[1, 0, 0], [0, 1, 0]], supports: [root([0, 0.02, 0], [1, 0, 0]), root([0.02, 0, 0], [0, 1, 0])], contrast: Math.PI / 2, angularAllowance: 0.1, status: "RESOLVED" })
    const [both] = await verifyCreaseReferences([reference()], control(() => 1))
    assert.equal(both.status, "AMBIGUOUS")
    assert.equal(both.reason, "SIDE_BRACKETS_AND_CANDIDATE_FIELD_UNRESOLVED")
    assert.equal(both.verification!.center!.field, 1)
    assert.equal(both.verification!.failedTargets!.length, 6)
    assert.equal(both.refinementStops![0].reason, "MISSING_UNAMBIGUOUS_SIDE_BRACKET")
    assert.ok(both.searchAttempts!.every(stage => stage.searches.every(search => search.probes.length === 15)))
    const [sides] = await verifyCreaseReferences([reference()], control(() => 0.001))
    assert.equal(sides.reason, "SIDE_BRACKETS_UNRESOLVED")
    assert.equal(sides.verification!.candidateField, 0.001)
})

// Positive controls adapted from independent candidate C's calibration tests.
test("opposite outer signs can still hide three distinct observed crossings", async () => {
    const [receipt] = await searchNormalBrackets([target], 0.04, control(p => (p[0] + 0.02) * p[0] * (p[0] - 0.02)))
    assert.ok(receipt.attempts[0].endpoints[0].field * receipt.attempts[0].endpoints[1].field < 0)
    assert.equal(receipt.roots.length, 3)
    assert.equal(receipt.status, "MULTIPLE_OBSERVED_CROSSINGS")
    assert.equal(receipt.association.eligible, false)
    assert.equal(receipt.association.reason, "MULTIPLE_OBSERVED_CROSSINGS")
})

function wedgeReference(): CreaseReference {
    const support = (point: Point, normal: Point): Root => ({ point, normal, width: 0, allowance: 2 ** -21,
        bracket: [{ point, normal, field: -1 }, { point, normal, field: 1 }] })
    return { station: 0, seed: [0, 0, 0], point: [0, 0, 0], tangent: [0, 0, 1],
        normals: [[1, 0, 0], [0, 1, 0]], status: "RESOLVED", contrast: Math.PI / 2,
        supports: [support([0, -0.02, 0], [1, 0, 0]), support([-0.02, 0, 0], [0, 1, 0])] }
}

test("known sharp wedge preserves shrinking-offset contrast and failed alternate-side probes", async () => {
    const sample: Sampler = async points => points.map(point => ({ point,
        field: Math.max(point[0], point[1]), normal: point[0] >= point[1] ? [1, 0, 0] : [0, 1, 0] }))
    const [reference] = await verifyCreaseReferences([wedgeReference()], sample)
    assert.equal(reference.status, "RESOLVED")
    assert.deepEqual(reference.verification!.offsets, [0.02, 0.01, 0.005])
    assert.ok(reference.verification!.contrasts.every(c => Math.abs(c - Math.PI / 2) < 1e-8))
    const sideStage = reference.searchAttempts!.find(s => s.stage === "SHRINKING_SIDE_VERIFICATION")!
    assert.equal(sideStage.searches.length, 6)
    assert.ok(sideStage.searches.every(s => s.association.eligible))
    assert.ok(reference.searchAttempts!.some(stage => stage.searches.some(s => s.status === "NO_STRICT_BRACKET")))
})

test("good planar region passes unchanged budgets and preserves requested versus sampled positions", async () => {
    const { runCoverage } = await import("./gpu-coverage.mjs")
    const vertices = new Float32Array(4 * 8)
    ;[[-0.1, -0.1, 0], [0.1, -0.1, 0], [0.1, 0.1, 0], [-0.1, 0.1, 0]].forEach((p, i) => vertices.set(p, 8 * i))
    const triangles = new Uint32Array([0, 1, 2, 0, 2, 3]), before = vertices.slice()
    const sample: Sampler = async points => points.map(requested => {
        const point = requested.map(Math.fround) as Point
        return { point, normal: [0, 0, 1], field: point[2] }
    })
    const result = await runCoverage([{ id: "plane", center: [0, 0, 0], half: 0.01, spacing: 0.01 }], new MeshQuery(vertices, triangles), new Float64Array(), sample)
    assert.equal(result.toleranceMm, 0.01)
    assert.equal(result.status, "SAMPLED_REGIONS_ONLY")
    assert.deepEqual(vertices, before)
    const region = result.regions[0]
    assert.equal(region.meshToField.ambiguousProjections, 0)
    assert.equal(region.meshToField.ambiguousSheetAssociations, 0)
    assert.ok(region.referenceDiagnostics.meshProjection.associationReasons.EMPIRICAL_FORWARD_NORMAL_ASSOCIATION > 0)
    assert.ok(region.meshToField.residuals.some(s => s.kind === "triangle-interior" && s.point.some((x, axis) => x !== s.sampledPoint[axis])))
    assert.ok(region.meshToField.residuals.every(s => s.sampledPoint.every((x, axis) => x === Math.fround(s.point[axis]))))
})

test("reply shape, missing results and wrong initial or refinement positions fail closed", async () => {
    const plane = control(p => p[0] - 0.003)
    const badPosition: Sampler = async points => (await plane(points)).map(s => ({ ...s, point: [s.point[0] + 1, s.point[1], s.point[2]] }))
    await assert.rejects(searchNormalBrackets([target], 0.04, badPosition), /position does not match/)
    for (const corrupt of [
        (s: unknown[]) => s.slice(1),
        (s: unknown[]) => { s[0] = { point: [0, 0], normal: [1, 0, 0], field: -1 }; return s },
        (s: unknown[]) => { s[0] = { point: [0, 0, 0], normal: [1, 0], field: -1 }; return s },
        (s: unknown[]) => { s[0] = undefined; return s },
    ]) {
        const malformed: Sampler = async points => corrupt(await plane(points)) as Awaited<ReturnType<Sampler>>
        await assert.rejects(searchNormalBrackets([target], 0.04, malformed), /Invalid GPU sample/)
    }
    let calls = 0
    const badRefinement: Sampler = async points => {
        const samples = await plane(points)
        if (++calls === 2) samples[0] = { ...samples[0], point: [123, 0, 0] }
        return samples
    }
    await assert.rejects(searchNormalBrackets([target], 0.04, badRefinement), /position does not match/)
})

test("sample association accepts numerical signed-zero equivalence without changing requests", async () => {
    const negativeZero = { point: [0, -0, 0] as Point, normal: [1, 0, 0] as Point }
    const [receipt] = await searchNormalBrackets([negativeZero], 0.04, async points => points.map(p => ({ point: p.map(x => x === 0 ? 0 : x) as Point, normal: [1, 0, 0], field: p[0] - 0.003 })))
    assert.equal(receipt.association.eligible, true)
    assert.equal(Object.is(negativeZero.point[1], -0), true)
})

test("zero or opposed root normals preserve position witnesses but reject normal association", async () => {
    for (const [normal, reason] of [
        [[0, 0, 0], "ZERO_OR_INVALID_ROOT_NORMAL"],
        [[-1, 0, 0], "NON_FORWARD_ROOT_NORMAL"],
        [[0, 1, 0], "NON_FORWARD_ROOT_NORMAL"],
    ] as Array<[Point, string]>) {
        const [receipt] = await searchNormalBrackets([target], 0.04, async points => points.map(point => ({ point, normal, field: point[0] - 0.003 })))
        assert.equal(receipt.status, "ONE_OBSERVED_CROSSING")
        assert.equal(receipt.roots.length, 1)
        assert.ok(Math.abs(receipt.roots[0].point[0] - 0.003) < 1e-6)
        assert.equal(receipt.association.eligible, false)
        assert.equal(receipt.association.reason, reason)
    }
})

test("quarter and final-center refinement replies are bound to their requested positions", async () => {
    const { refineBrackets } = await import("./gpu-coverage.mjs")
    const bracket = (extent: number): [Root["bracket"][0], Root["bracket"][1]] => [
        { point: [-extent, 0, 0], normal: [1, 0, 0], field: -extent },
        { point: [extent, 0, 0], normal: [1, 0, 0], field: extent },
    ]
    for (const [extent, corruptCall] of [[0.01, 2], [1e-8, 3]]) {
        let calls = 0
        const sampler: Sampler = async points => {
            const samples = points.map(point => ({ point, normal: [1, 0, 0] as Point, field: point[0] }))
            if (++calls === corruptCall) samples[0] = { ...samples[0], point: [1, 0, 0] }
            return samples
        }
        await assert.rejects(refineBrackets([bracket(extent)], sampler, true), /position does not match/)
        assert.equal(calls, corruptCall)
    }
})

test("same-side projected normals cannot establish corresponding incident patch references", async () => {
    const { measureCrease } = await import("./gpu-coverage.mjs")
    const n = (a: number): Point => [-Math.sin(a), -Math.cos(a), 0]
    const positions = [[0, 0, -0.01], [0, 0, 0.01], [0.01, 0, 0], [-0.01 * Math.cos(0.11), 0.01 * Math.sin(0.11), 0]]
    const verts = new Float32Array(32); positions.forEach((p, i) => verts.set(p, i * 8))
    const mesh = new MeshQuery(verts, new Uint32Array([0, 2, 1, 0, 1, 3]))
    const reference: CreaseReference[] = [{ station: 0, seed: [0, 0, 0], point: [0, 0, 0], tangent: [0, 0, 1], normals: [n(0), n(0.2)], contrast: 0.2, angularAllowance: 0.1, status: "RESOLVED" }]
    const features = new Float64Array([0, 1, 7, 0, 1])
    const wrongSides = measureCrease(reference, mesh, features, new Map([[0, n(0.055)], [1, n(0.055)]]))
    assert.equal(wrongSides.status, "INCOMPLETE")
    assert.equal(wrongSides.stations[0].centroidSideMismatchPairs, 1)
    const distinctSides = measureCrease(reference, mesh, features, new Map([[0, n(0)], [1, n(0.2)]]))
    assert.equal(distinctSides.status, "SAMPLED_PASS")
})


test("equal bisector reference normals do not establish distinct incident support sides", async () => {
    const { measureCrease } = await import("./gpu-coverage.mjs")
    const n = (a: number): Point => [-Math.sin(a), -Math.cos(a), 0]
    const verts = new Float32Array(32)
    ;[[0, 0, -0.01], [0, 0, 0.01], [0.01, 0, 0], [-0.01 * Math.cos(0.11), 0.01 * Math.sin(0.11), 0]].forEach((p, i) => verts.set(p, 8 * i))
    const mesh = new MeshQuery(verts, new Uint32Array([0, 2, 1, 0, 1, 3]))
    const reference: CreaseReference[] = [{ station: 0, seed: [0, 0, 0], point: [0, 0, 0], tangent: [0, 0, 1], normals: [n(-0.02), n(0.18)], contrast: 0.2, angularAllowance: 0.1, status: "RESOLVED" }]
    const result = measureCrease(reference, mesh, new Float64Array([0, 1, 7, 0, 1]), new Map([[0, n(0.08)], [1, n(0.08)]]))
    assert.equal(result.status, "INCOMPLETE")
    assert.equal(result.stations[0].ambiguousSupportPairs, 1)
    assert.equal(result.stations[0].edgeDiagnostics[0].centroidSupportPairStatus, "INCOMPLETE")
})
