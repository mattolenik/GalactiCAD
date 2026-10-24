import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { associateWithinSurfaceBudget, searchNormalBrackets, verifyCreaseReferences, verifyShrinkingSamples,
    type CreaseReference, type NormalSearchReceipt, type Point, type Root, type Sampler } from "./gpu-coverage.mjs"

// Synthetic controls calibrate branch selection; they are not a scene reference.
const target = { point: [0, 0, 0] as Point, normal: [1, 0, 0] as Point }
const pair = (a: number, b: number): Sampler => async points => points.map(point => ({ point,
    field: (point[0] - a) * (point[0] - b), normal: [2 * point[0] - a - b < 0 ? -1 : 1, 0, 0] }))

test("a far observed crossing remains recorded without vetoing one local forward crossing", async () => {
    const [search] = await searchNormalBrackets([target], 0.03, pair(-0.025, 0.002))
    const before = structuredClone(search)
    assert.equal(search.status, "MULTIPLE_OBSERVED_CROSSINGS")
    assert.equal(search.association.eligible, false)
    const local = associateWithinSurfaceBudget(search)
    assert.equal(local.eligible, true)
    assert.equal(local.budgetMm, 0.01)
    assert.deepEqual(local.rootBounds.map(r => r.classification), ["OUTSIDE", "INSIDE"])
    assert.ok(search.roots[local.rootIndex!].point[0] > 0)
    assert.deepEqual(search, before, "contextual interpretation must not erase broad-search evidence")
})

test("two observed roots within the surface budget retain ambiguity", async () => {
    const [search] = await searchNormalBrackets([target], 0.03, pair(-0.006, 0.006))
    const local = associateWithinSurfaceBudget(search)
    assert.equal(local.eligible, false)
    assert.equal(local.reason, "MULTIPLE_OBSERVED_CROSSINGS_WITHIN_SURFACE_BUDGET")
})

test("a second bracket straddling the budget boundary is not excluded", async () => {
    const [search] = await searchNormalBrackets([target], 0.03, pair(-0.01, 0.002))
    const local = associateWithinSurfaceBudget(search)
    assert.equal(local.eligible, false)
    assert.equal(local.reason, "SURFACE_BUDGET_BOUNDARY_UNRESOLVED")
})

test("zero or backward normals cannot provide a local association", async () => {
    const sample: Sampler = async points => points.map(point => ({ point, normal: [1, 0, 0], field: point[0] - 0.002 }))
    const [search] = await searchNormalBrackets([target], 0.03, sample)
    for (const normal of [[0, 0, 0], [-1, 0, 0]] as Point[]) {
        const changed = structuredClone(search); changed.roots[0].normal = normal
        assert.equal(associateWithinSurfaceBudget(changed).eligible, false)
    }
    const invalid = structuredClone(search)
    invalid.roots[0].bracket[0].field = invalid.roots[0].bracket[1].field
    assert.equal(associateWithinSurfaceBudget(invalid).reason, "INVALID_ROOT_BOUNDS")
})

test("unresolved plateau width is not converted into a local normal", async () => {
    const sample: Sampler = async points => points.map(point => ({ point, normal: [1, 0, 0], field: Math.abs(point[0]) < 0.001 ? 0 : point[0] }))
    const [search] = await searchNormalBrackets([target], 0.03, sample)
    const local = associateWithinSurfaceBudget(search)
    assert.equal(local.eligible, false)
    assert.equal(local.reason, "BRACKET_WIDTH_UNRESOLVED")
})

test("full sharp-wedge verification uses all shrinking offsets without increasing angular allowance", async () => {
    const length = Math.hypot(1, 0.2), side: Point = [1 / length, 0, -0.2 / length], cap: Point = [0, 0, 1]
    const support = (point: Point, normal: Point): Root => ({ point, normal, width: 0, allowance: 2 ** -21,
        bracket: [{ point, normal, field: -1 }, { point, normal, field: 1 }] })
    const ref: CreaseReference = { station: 0, seed: [0, 0, 0], point: [0, 0, 0], tangent: [0, 1, 0], status: "RESOLVED",
        normals: [side, cap], supports: [support([-0.004, 0, -0.02], side), support([-0.02, 0, 0], cap)] }
    const sample: Sampler = async points => points.map(point => {
        const a = point[0] * side[0] + point[2] * side[2], b = point[2]
        return { point, field: Math.max(a, b), normal: a > b ? side : cap }
    })
    const [result] = await verifyCreaseReferences([ref], sample)
    assert.equal(result.status, "RESOLVED")
    assert.deepEqual(result.verification!.offsets, [0.02, 0.01, 0.005])
    assert.equal(result.angularAllowance, Math.max(2 * Math.PI / 180, result.contrast! / 2))
    assert.ok(result.verification!.surfaceAssociations!.every(a => a.eligible))
    assert.ok(result.searchAttempts!.at(-1)!.searches.some(s => s.roots.length > 1), "far crossings remain visible")
})

test("authentic housing receipts resolve local flange references while retaining loft station5 normals", async () => {
    const fixture = JSON.parse(await readFile(new URL("./housing-crease-surface-window.json", import.meta.url), "utf8"))
    assert.equal(fixture.sourceSha256, "54964141fea0ed055f5392837c5e524f4a358e1c610f0b11a90857b8b57ad4a5")
    for (const region of fixture.regions) for (const saved of region.references) {
        const ref = structuredClone(saved.reference) as CreaseReference
        const searches = saved.searches as NormalSearchReceipt[]
        verifyShrinkingSamples(ref, searches, saved.center)
        assert.equal(ref.status, "RESOLVED")
        assert.ok(ref.verification!.surfaceAssociations!.every(a => a.eligible))
        if (region.id === "flange-rim") {
            assert.equal(saved.reference.status, "AMBIGUOUS")
            assert.ok(searches.some(s => s.roots.length > 1))
        } else {
            assert.equal(ref.station, 5)
            assert.deepEqual(ref.normals, saved.reference.normals)
            assert.equal(ref.contrast, saved.reference.contrast)
            assert.equal(ref.angularAllowance, saved.reference.angularAllowance)
        }
    }
})

test("authentic flange centroid searches retain far crossings but supply the sole in-budget normal", async () => {
    const fixture = JSON.parse(await readFile(new URL("./housing-crease-surface-window.json", import.meta.url), "utf8"))
    assert.equal(fixture.ambiguousFlangeCentroids.length, 2)
    for (const row of fixture.ambiguousFlangeCentroids) {
        const search = row.search as NormalSearchReceipt
        assert.equal(search.association.eligible, false)
        const bounded = associateWithinSurfaceBudget(search)
        assert.equal(bounded.eligible, true)
        assert.equal(bounded.rootBounds.filter(r => r.classification === "INSIDE").length, 1)
        assert.ok(bounded.rootBounds.some(r => r.classification === "OUTSIDE"))
        assert.equal(search.association.eligible, false)
    }
})
