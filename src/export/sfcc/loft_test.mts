import assert from "node:assert/strict"
import test from "node:test"
import { Loft } from "../../scene/primitives/loft.mjs"
import { Polygon2D } from "../../scene/primitives/polygon2d.mjs"
import { compileCpuSdf, SfccUnsupportedError, type CpuSdfTree } from "./cpu-sdf.mjs"
import { runSfccPipeline, type SfccPipelineResult } from "./assemble.mjs"
import { DEFAULT_SFCC_TUNING, type SfccTuning } from "./sfcc-tuning.mjs"

const TUNING: SfccTuning = { ...DEFAULT_SFCC_TUNING, depthMin: 4, depthMax: 7, boundsPaddingMm: 0 }
const CUBE = { minX: -8, minY: -8, minZ: -8, size: 16 }

const SQUARE: [number, number][] = [
    [-2, -2],
    [2, -2],
    [2, 2],
    [-2, 2],
]

function scaled(verts: [number, number][], s: number): [number, number][] {
    return verts.map(([x, z]) => [x * s, z * s])
}

function rotated(verts: [number, number][], deg: number): [number, number][] {
    const a = (deg * Math.PI) / 180
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    return verts.map(([x, z]) => [ca * x - sa * z, sa * x + ca * z])
}

function maxAbsF(tree: CpuSdfTree, r: SfccPipelineResult): number {
    let m = 0
    for (let i = 0; i < r.verts.length; i += 8) {
        m = Math.max(m, Math.abs(tree.f(r.verts[i]!, r.verts[i + 1]!, r.verts[i + 2]!)))
    }
    return m
}

function hasVertexAt(r: SfccPipelineResult, x: number, y: number, z: number, tol: number): boolean {
    for (let i = 0; i < r.verts.length; i += 8) {
        if (Math.hypot(r.verts[i]! - x, r.verts[i + 1]! - y, r.verts[i + 2]! - z) < tol) return true
    }
    return false
}

test("cpu evaluator: loft distance parity (prism) and interval containment (morph)", () => {
    // Two identical squares = a plain prism: hand-checked exact distances.
    const prism = compileCpuSdf(new Loft([new Polygon2D(SQUARE), new Polygon2D(SQUARE)], { h: 2 }))
    assert.ok(Math.abs(prism.f(3, 0.5, 0) - 1) < 1e-12)
    assert.ok(Math.abs(prism.f(0, 3.5, 0) - 1.5) < 1e-12)
    assert.ok(Math.abs(prism.f(0, 0, 0) - -2) < 1e-12)
    assert.ok(prism.f(2.5, 0, 2.5) > 0.7) // outside the corner column

    // Morphing loft (square → rotated square): the field is not 1-Lipschitz in
    // y; the interval certificate must still contain all sampled values.
    const morph = compileCpuSdf(
        new Loft([new Polygon2D(SQUARE), new Polygon2D(rotated(SQUARE, 30))], { h: 2 }),
    )
    let seed = 424242
    const rnd = (): number => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        return seed / 0x7fffffff
    }
    for (let k = 0; k < 150; k++) {
        const cx = (rnd() - 0.5) * 7
        const cy = (rnd() - 0.5) * 7
        const cz = (rnd() - 0.5) * 7
        const hx = rnd() * 0.7 + 0.01
        const [lo, hi] = morph.intervalOverBox(cx, cy, cz, hx, hx, hx)
        for (let m = 0; m < 8; m++) {
            const v = morph.f(cx + (rnd() * 2 - 1) * hx, cy + (rnd() * 2 - 1) * hx, cz + (rnd() * 2 - 1) * hx)
            assert.ok(v >= lo - 1e-9 && v <= hi + 1e-9, `f=${v} outside [${lo}, ${hi}]`)
        }
    }
})

test("cpu evaluator: loft profiles with differing vertex counts are unsupported", () => {
    const tri: [number, number][] = [
        [0, 0],
        [2, 0],
        [1, 2],
    ]
    assert.throws(
        () => compileCpuSdf(new Loft([new Polygon2D(SQUARE), new Polygon2D(tri)], { h: 2 })),
        (e: unknown) => e instanceof SfccUnsupportedError,
    )
})

test("sfcc pipeline: prismatic loft → closed manifold, exact cap corners", () => {
    const tree = compileCpuSdf(new Loft([new Polygon2D(SQUARE), new Polygon2D(SQUARE)], { h: 2 }))
    const r = runSfccPipeline(tree, CUBE, TUNING)
    assert.equal(r.stats.failedCells, 0)
    assert.equal(r.stats.featureCellFallbacks, 0)
    assert.equal(r.stats.faceAuditFailures, 0)
    assert.ok(r.manifold.ok, JSON.stringify(r.manifold))
    assert.equal(r.manifold.components, 1)
    assert.deepEqual(r.manifold.eulerPerComponent, [2])
    assert.ok(maxAbsF(tree, r) <= TUNING.surfaceTolMm)
    for (const [vx, vz] of SQUARE) {
        assert.ok(hasVertexAt(r, vx, 2, vz, 1e-6), `top corner (${vx}, 2, ${vz}) missing`)
        assert.ok(hasVertexAt(r, vx, -2, vz, 1e-6), `bottom corner (${vx}, −2, ${vz}) missing`)
    }
})

/** Concave L-profile; the reflex vertex sits at the origin. */
const L_VERTS: [number, number][] = [
    [-2, -2],
    [2, -2],
    [2, 0],
    [0, 0],
    [0, 2],
    [-2, 2],
]

test("sfcc pipeline: rotating morph loft (L profile) → manifold, exact caps + stationary reflex column", () => {
    // Rotation about the reflex vertex: every cap rim stays fully alive and
    // the reflex column is a stationary, exactly-representable feature. The
    // moving convex columns have vertex-cone-blended flanks the v1 edge×edge
    // carrier model deliberately does not claim (their vertical curves are
    // validity-gated out and those cells contour as smooth surface).
    const deg = 15
    const top = rotated(L_VERTS, deg)
    const tree = compileCpuSdf(new Loft([new Polygon2D(L_VERTS), new Polygon2D(top)], { h: 2 }))
    const r = runSfccPipeline(tree, CUBE, TUNING)
    assert.equal(r.stats.failedCells, 0)
    assert.equal(r.stats.faceAuditFailures, 0)
    assert.ok(r.stats.featureCellFallbacks <= 4, `fallbacks: ${r.stats.featureCellFallbacks}`)
    assert.ok(r.manifold.ok, JSON.stringify(r.manifold))
    assert.equal(r.manifold.components, 1)
    assert.deepEqual(r.manifold.eulerPerComponent, [2])
    assert.ok(maxAbsF(tree, r) <= TUNING.surfaceTolMm, `max |f| = ${maxAbsF(tree, r)}`)

    // Cap corners: all are emitted and rim-wired; a corner whose cell also
    // contains an unsnapped moving column may fall back (roundover ≤ cell
    // size) — require the stationary reflex corner exact on both caps and at
    // most one miss among the other ten.
    assert.ok(hasVertexAt(r, 0, -2, 0, 1e-6), "bottom reflex corner missing")
    assert.ok(hasVertexAt(r, 0, 2, 0, 1e-6), "top reflex corner missing")
    let exact = 0
    for (let j = 0; j < L_VERTS.length; j++) {
        if (hasVertexAt(r, L_VERTS[j]![0], -2, L_VERTS[j]![1], 1e-6)) exact++
        if (hasVertexAt(r, top[j]![0], 2, top[j]![1], 1e-6)) exact++
    }
    assert.ok(exact >= 11, `cap corners exact: ${exact}/12`)

    // The stationary reflex column at (0, y, 0).
    let reflexVerts = 0
    for (let i = 0; i < r.verts.length; i += 8) {
        if (Math.hypot(r.verts[i]!, r.verts[i + 2]!) < 1e-6 && Math.abs(r.verts[i + 1]!) < 2 + 1e-6) reflexVerts++
    }
    assert.ok(reflexVerts >= 6, `reflex column chain: ${reflexVerts} vertices`)
})

test("sfcc pipeline: 3-profile bulge loft → junction crease ring + junction corners exact", () => {
    const tree = compileCpuSdf(
        new Loft(
            [new Polygon2D(SQUARE), new Polygon2D(scaled(SQUARE, 1.5)), new Polygon2D(SQUARE)],
            { h: 2 },
        ),
    )
    const r = runSfccPipeline(tree, CUBE, TUNING)
    assert.equal(r.stats.failedCells, 0)
    assert.equal(r.stats.faceAuditFailures, 0)
    assert.ok(r.stats.featureCellFallbacks <= 4, `fallbacks: ${r.stats.featureCellFallbacks}`)
    assert.ok(r.manifold.ok, JSON.stringify(r.manifold))
    assert.equal(r.manifold.components, 1)
    assert.deepEqual(r.manifold.eulerPerComponent, [2])
    assert.ok(maxAbsF(tree, r) <= TUNING.surfaceTolMm, `max |f| = ${maxAbsF(tree, r)}`)
    // Cap corners at ±2 exact; junction corners may share a cell with an
    // unsnapped moving column (fallback, roundover ≤ cell size) — require at
    // least half exact and all within a cell.
    let juncExact = 0
    for (const [vx, vz] of SQUARE) {
        assert.ok(hasVertexAt(r, vx, 2, vz, 1e-6), `top corner (${vx}, 2, ${vz}) missing`)
        assert.ok(hasVertexAt(r, vx, -2, vz, 1e-6), `bottom corner (${vx}, −2, ${vz}) missing`)
        if (hasVertexAt(r, vx * 1.5, 0, vz * 1.5, 1e-6)) juncExact++
        assert.ok(
            hasVertexAt(r, vx * 1.5, 0, vz * 1.5, 0.3),
            `junction corner (${vx * 1.5}, 0, ${vz * 1.5}) beyond cell-size roundover`,
        )
    }
    assert.ok(juncExact >= 2, `junction corners exact: ${juncExact}/4`)
    // The junction crease ring at y = 0: edge midpoints land exactly on the
    // snapped crease segments.
    for (let j = 0; j < 4; j++) {
        const [ax, az] = SQUARE[j]!
        const [bx, bz] = SQUARE[(j + 1) % 4]!
        assert.ok(
            hasVertexAt(r, ((ax + bx) / 2) * 1.5, 0, ((az + bz) / 2) * 1.5, 2e-2),
            `junction rim near edge ${j} midpoint missing`,
        )
    }
})
