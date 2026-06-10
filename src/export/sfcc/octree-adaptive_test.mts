import assert from "node:assert/strict"
import test from "node:test"
import { Sphere } from "../../scene/primitives/sphere.mjs"
import { Union } from "../../scene/operators/union.mjs"
import { compileCpuSdf, type CpuSdfTree } from "./cpu-sdf.mjs"
import { runSfccPipeline, type SfccPipelineResult } from "./assemble.mjs"
import { DEFAULT_SFCC_TUNING, type SfccTuning } from "./sfcc-tuning.mjs"
import { buildOctree } from "./octree.mjs"
import { makeLattice, strideAtLevel } from "./lattice.mjs"
import { makeProbe, needsSplitSmooth } from "./refine-criteria.mjs"

/** Big + small sphere: the small one must refine deeper than the big one. */
function mixedScene(): CpuSdfTree {
    return compileCpuSdf(new Union([new Sphere([-2.1, 0.3, 0.2], { r: 6 }), new Sphere([7.3, -0.4, 0.1], { r: 1.1 })]))
}

// depthMin 4 (1.5 mm cells in the 24 mm cube): the small sphere's diameter
// (2.2 mm) exceeds the cell size, so it cannot hide between corner samples —
// geometry below depthMin resolution is invisible by design (see the (iii-a)
// note in refine-criteria.mts).
const TUNING: SfccTuning = {
    ...DEFAULT_SFCC_TUNING,
    depthMin: 4,
    depthMax: 7,
    boundsPaddingMm: 0,
    normalVariationCos: Math.cos((30 * Math.PI) / 180),
}

test("adaptive build: mixed leaf levels, 2:1 face+edge balance holds", () => {
    const tree = mixedScene()
    const lat = makeLattice(7, -12, -12, -12, 24)
    const oct = buildOctree(tree, lat, {
        depthMin: 4,
        depthMax: 7,
        enforceEdgeBalance: true,
        needsSplit: (cell, sampleAt) =>
            needsSplitSmooth(tree, makeProbe(lat, tree, sampleAt, cell.level, cell.ix, cell.iy, cell.iz), {
                normalVariationCos: TUNING.normalVariationCos,
            }),
    })
    const levels = new Set(oct.leaves.map(c => c.level))
    assert.ok(levels.size >= 2, `expected mixed levels, got ${[...levels].join(",")}`)

    // 2:1 balance: no leaf has a face- or edge-adjacent leaf 2+ levels finer.
    // Check via lattice interval overlap between leaves on each axis.
    let violations = 0
    for (const a of oct.leaves) {
        const sa = strideAtLevel(lat, a.level)
        for (const b of oct.leaves) {
            if (b.level <= a.level + 1) continue
            const sb = strideAtLevel(lat, b.level)
            // Overlap/adjacency test in lattice units: closed intervals touch?
            const ax0 = a.ix * sa
            const ay0 = a.iy * sa
            const az0 = a.iz * sa
            const bx0 = b.ix * sb
            const by0 = b.iy * sb
            const bz0 = b.iz * sb
            const sepX = bx0 > ax0 + sa || ax0 > bx0 + sb
            const sepY = by0 > ay0 + sa || ay0 > by0 + sb
            const sepZ = bz0 > az0 + sa || az0 > bz0 + sb
            const sepCount = (sepX ? 1 : 0) + (sepY ? 1 : 0) + (sepZ ? 1 : 0)
            // Face adjacency: separated on 0 axes... touching counts as overlap
            // here; face/edge adjacency = sharing a 2D face or 1D edge = not
            // separated on any axis (touching allowed on ≤2 axes).
            if (!sepX && !sepY && !sepZ) {
                // They touch (share face, edge, or corner). Corner-only contact
                // is exempt from the balance guarantee: count touching axes.
                const touchX = bx0 === ax0 + sa || ax0 === bx0 + sb
                const touchY = by0 === ay0 + sa || ay0 === by0 + sb
                const touchZ = bz0 === az0 + sa || az0 === bz0 + sb
                const touches = (touchX ? 1 : 0) + (touchY ? 1 : 0) + (touchZ ? 1 : 0)
                if (touches <= 1) violations++ // shares a face (1 touching axis) or overlaps (0) — must not happen
                if (touches === 2) violations++ // shares an edge — edge balance enforced
            }
        }
    }
    assert.equal(violations, 0, `${violations} balance violations`)
})

test("adaptive pipeline: mixed-depth smooth scene → closed 2-manifold, two χ=2 components", () => {
    const tree = mixedScene()
    const r: SfccPipelineResult = runSfccPipeline(tree, { minX: -12, minY: -12, minZ: -12, size: 24 }, TUNING)
    assert.ok(r.stats.levelHistogram.filter(n => n > 0).length >= 2, `levels: ${r.stats.levelHistogram.join(",")}`)
    assert.equal(r.stats.failedCells, 0)
    assert.equal(r.stats.faceAuditFailures, 0)
    assert.ok(r.manifold.ok, JSON.stringify(r.manifold))
    assert.equal(r.manifold.components, 2)
    assert.deepEqual(r.manifold.eulerPerComponent, [2, 2])

    // Vertices on surface; winding outward.
    const g = new Float64Array(3)
    let maxAbsF = 0
    for (let i = 0; i < r.verts.length; i += 8) {
        maxAbsF = Math.max(maxAbsF, Math.abs(tree.f(r.verts[i]!, r.verts[i + 1]!, r.verts[i + 2]!)))
    }
    assert.ok(maxAbsF <= TUNING.surfaceTolMm, `max |f| = ${maxAbsF}`)
    let flipped = 0
    for (let t = 0; t < r.tris.length; t += 3) {
        const a = r.tris[t]! * 8
        const b = r.tris[t + 1]! * 8
        const c = r.tris[t + 2]! * 8
        const nx =
            (r.verts[b + 1]! - r.verts[a + 1]!) * (r.verts[c + 2]! - r.verts[a + 2]!) -
            (r.verts[b + 2]! - r.verts[a + 2]!) * (r.verts[c + 1]! - r.verts[a + 1]!)
        const ny =
            (r.verts[b + 2]! - r.verts[a + 2]!) * (r.verts[c]! - r.verts[a]!) -
            (r.verts[b]! - r.verts[a]!) * (r.verts[c + 2]! - r.verts[a + 2]!)
        const nz =
            (r.verts[b]! - r.verts[a]!) * (r.verts[c + 1]! - r.verts[a + 1]!) -
            (r.verts[b + 1]! - r.verts[a + 1]!) * (r.verts[c]! - r.verts[a]!)
        tree.grad(
            (r.verts[a]! + r.verts[b]! + r.verts[c]!) / 3,
            (r.verts[a + 1]! + r.verts[b + 1]! + r.verts[c + 1]!) / 3,
            (r.verts[a + 2]! + r.verts[b + 2]! + r.verts[c + 2]!) / 3,
            g,
        )
        if (nx * g[0]! + ny * g[1]! + nz * g[2]! < 0) flipped++
    }
    assert.equal(flipped, 0, `${flipped} inward triangles`)
})
