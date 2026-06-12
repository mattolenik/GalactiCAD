import assert from "node:assert/strict"
import test from "node:test"
import { Sphere } from "../../scene/primitives/sphere.mjs"
import { Box } from "../../scene/primitives/box.mjs"
import { Union } from "../../scene/operators/union.mjs"
import { Subtract } from "../../scene/operators/subtract.mjs"
import { Intersect } from "../../scene/operators/intersect.mjs"
import { compileCpuSdf, type CpuSdfTree } from "./cpu-sdf.mjs"
import { smin, sminGradWeights, type SminMode } from "./cpu-sdf-primitives.mjs"
import { compileFeatureSet } from "./feature-set.mjs"
import { resolveTolerances } from "./tolerances.mjs"
import { runSfccPipeline, type SfccPipelineResult } from "./assemble.mjs"
import { DEFAULT_SFCC_TUNING, type SfccTuning } from "./sfcc-tuning.mjs"

const TUNING: SfccTuning = { ...DEFAULT_SFCC_TUNING, depthMin: 4, depthMax: 6, boundsPaddingMm: 0 }
const BOUNDS = { minX: -8, minY: -8, minZ: -8, size: 16 }
const MODES: SminMode[] = ["round", "soft", "chamfer", "stairs"]

/** Deterministic LCG (Date.now/Math.random are unavailable to workflows). */
function makeRnd(seed: number): () => number {
    let s = seed
    return () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff
        return s / 0x7fffffff
    }
}

function maxAbsF(tree: CpuSdfTree, r: SfccPipelineResult): number {
    let m = 0
    for (let i = 0; i < r.verts.length; i += 8) {
        m = Math.max(m, Math.abs(tree.f(r.verts[i]!, r.verts[i + 1]!, r.verts[i + 2]!)))
    }
    return m
}

test("smin formulas: shader parity spot values", () => {
    // round: a = b = 0, r = 1 → max(1, 0) − |(1,1)| = 1 − √2.
    assert.ok(Math.abs(smin("round", 0, 0, 1, 4) - (1 - Math.SQRT2)) < 1e-15)
    // round: one operand out of band reduces to the other operand.
    assert.equal(smin("round", 2, 0.5, 1, 4), 0.5)
    // soft: min − e²/4r with e = 1.
    assert.equal(smin("soft", 0, 0, 1, 4), -0.25)
    assert.ok(Math.abs(smin("soft", 0.5, 0.2, 1, 4) - 0.0775) < 1e-15)
    // chamfer: min(0, −√½).
    assert.ok(Math.abs(smin("chamfer", 0, 0, 1, 4) - -Math.SQRT1_2) < 1e-15)
    // stairs: s = ½, u = −1 → term = ½(−1 + 0 + 0) = −½ (hand-traced).
    assert.equal(smin("stairs", 0, 0, 1, 2), -0.5)
    // stairs is symmetric for integer n (the step lattice is centered).
    assert.ok(Math.abs(smin("stairs", 0, 0.3, 1, 2) - smin("stairs", 0.3, 0, 1, 2)) < 1e-15)
    assert.ok(Math.abs(smin("stairs", 0, 0.3, 1, 2) - -0.2) < 1e-15)
})

test("smin formulas: monotone nondecreasing in both operands (the interval certificate)", () => {
    const rnd = makeRnd(1234567)
    const delta = 1e-4
    for (const mode of MODES) {
        for (let k = 0; k < 400; k++) {
            const a = (rnd() - 0.5) * 6
            const b = (rnd() - 0.5) * 6
            const r = 0.2 + rnd() * 1.3
            const n = 2 + Math.floor(rnd() * 3)
            const f = smin(mode, a, b, r, n)
            assert.ok(smin(mode, a + delta, b, r, n) >= f - 1e-12, `${mode} not monotone in a at (${a}, ${b}, ${r}, ${n})`)
            assert.ok(smin(mode, a, b + delta, r, n) >= f - 1e-12, `${mode} not monotone in b at (${a}, ${b}, ${r}, ${n})`)
        }
    }
})

test("smin formulas: negation identity matches the shader's intersection forms", () => {
    // smax(a, b) = −smin(−a, −b) must reproduce fOpIntersection{Round,Chamfer}
    // verbatim — this is what lets the CSG walk's negation-parity fold absorb
    // smooth subtract/intersect. (Stairs intersection is DEFINED by negation
    // in the shader; soft has no intersection form.)
    const round = (a: number, b: number, r: number): number =>
        Math.min(-r, Math.max(a, b)) + Math.hypot(Math.max(r + a, 0), Math.max(r + b, 0))
    const chamfer = (a: number, b: number, r: number): number =>
        Math.max(Math.max(a, b), (a + r + b) * Math.SQRT1_2)
    const rnd = makeRnd(7654321)
    for (let k = 0; k < 400; k++) {
        const a = (rnd() - 0.5) * 6
        const b = (rnd() - 0.5) * 6
        const r = 0.2 + rnd() * 1.3
        assert.ok(Math.abs(-smin("round", -a, -b, r, 4) - round(a, b, r)) < 1e-12)
        assert.ok(Math.abs(-smin("chamfer", -a, -b, r, 4) - chamfer(a, b, r)) < 1e-12)
    }
})

test("sminGradWeights: direction matches finite differences of the scalar field", () => {
    const rnd = makeRnd(24681357)
    const d = 1e-6
    for (const mode of MODES) {
        let checked = 0
        for (let k = 0; k < 600 && checked < 200; k++) {
            const a = (rnd() - 0.5) * 4
            const b = (rnd() - 0.5) * 4
            const r = 0.3 + rnd() * 1.2
            const n = 2 + Math.floor(rnd() * 3)
            const fd = (da: number, step: number): number =>
                da === 0
                    ? (smin(mode, a, b + step, r, n) - smin(mode, a, b - step, r, n)) / (2 * step)
                    : (smin(mode, a + step, b, r, n) - smin(mode, a, b, r, n) + (smin(mode, a, b, r, n) - smin(mode, a - step, b, r, n))) / (2 * step)
            const pa = fd(1, d)
            const pb = fd(0, d)
            // Kink self-detection: a coarser step must agree, else skip.
            if (Math.abs(pa - fd(1, d * 8)) > 1e-4 || Math.abs(pb - fd(0, d * 8)) > 1e-4) continue
            const [wa, wb] = sminGradWeights(mode, a, b, r, n)
            const wl = Math.hypot(wa, wb)
            const pl = Math.hypot(pa, pb)
            if (pl < 1e-9) continue
            const dot = (pa * wa + pb * wb) / (wl * pl)
            assert.ok(dot > 0.9999, `${mode} weights ≠ FD at (${a}, ${b}, ${r}, ${n}): w=(${wa}, ${wb}) fd=(${pa}, ${pb})`)
            checked++
        }
        assert.ok(checked >= 200, `${mode}: only ${checked} kink-free samples`)
    }
})

const S1 = (): Sphere => new Sphere([-1.5, 0, 0], { r: 2 })
const S2 = (): Sphere => new Sphere([1.5, 0, 0], { r: 2 })

/** f of a child compiled alone (leaf field, exact). */
function leafF(node: Sphere | Box): (p: [number, number, number]) => number {
    const t = compileCpuSdf(node)
    return p => t.f(...p)
}

function randPts(seed: number, count: number, extent: number): [number, number, number][] {
    const rnd = makeRnd(seed)
    const out: [number, number, number][] = []
    for (let i = 0; i < count; i++) {
        out.push([(rnd() - 0.5) * extent, (rnd() - 0.5) * extent, (rnd() - 0.5) * extent])
    }
    return out
}

test("compiled blend trees match manual composition (union/subtract/intersect + negation fold)", () => {
    const f1 = leafF(S1())
    const f2 = leafF(S2())
    const box = (): Box => new Box([0, 0, 0], [3, 3, 3])
    const fBox = leafF(box())
    const pts = randPts(11111, 200, 10)
    for (const mode of MODES) {
        const n = 3
        const union = compileCpuSdf(new Union([S1(), S2()], 0.8, mode, n))
        const subtract = compileCpuSdf(new Subtract(box(), S2(), 0.8, mode === "soft" ? undefined : mode, n))
        const intersect = compileCpuSdf(new Intersect(box(), S2(), 0.8, mode === "soft" ? undefined : mode, n))
        for (const p of pts) {
            assert.ok(Math.abs(union.f(...p) - smin(mode, f1(p), f2(p), 0.8, n)) < 1e-12, `union ${mode} at ${p}`)
            if (mode === "soft") continue // soft is a union-only mode
            // Difference: smax(a, −b) = −smin(−a, b); intersection: −smin(−a, −b).
            assert.ok(
                Math.abs(subtract.f(...p) - -smin(mode, -fBox(p), f2(p), 0.8, n)) < 1e-12,
                `subtract ${mode} at ${p}`,
            )
            assert.ok(
                Math.abs(intersect.f(...p) - -smin(mode, -fBox(p), -f2(p), 0.8, n)) < 1e-12,
                `intersect ${mode} at ${p}`,
            )
        }
    }
    // Negation fold: a smooth union as the SUBTRAHEND of a hard subtract — the
    // blend node compiles under negated parity (kind = smax over negated leaf
    // fields) and must still reproduce max(a, −sminRound(b1, b2)).
    const nested = compileCpuSdf(new Subtract(box(), new Union([S1(), S2()], 0.5)))
    for (const p of pts) {
        const expected = Math.max(fBox(p), -smin("round", f1(p), f2(p), 0.5, 4))
        assert.ok(Math.abs(nested.f(...p) - expected) < 1e-12, `negated blend at ${p}`)
    }
})

test("3+ children: nearest-pair fold blends only the two closest fields", () => {
    const s3 = new Sphere([0, 3, 0], { r: 1.5 })
    const f1 = leafF(S1())
    const f2 = leafF(S2())
    const f3 = leafF(new Sphere([0, 3, 0], { r: 1.5 }))
    const tree = compileCpuSdf(new Union([S1(), S2(), s3], 0.7))
    for (const p of randPts(22222, 300, 12)) {
        const ds = [f1(p), f2(p), f3(p)].sort((x, y) => x - y)
        const expected = smin("round", ds[0]!, ds[1]!, 0.7, 4)
        assert.ok(Math.abs(tree.f(...p) - expected) < 1e-12, `nearest-pair at ${p}`)
    }
})

test("intervalOverBox contains all sampled values on a mixed smooth tree", () => {
    const tree = compileCpuSdf(
        new Subtract(
            new Union([new Box([0, 0, 0], [2, 2, 2]), S2()], 0.6, "chamfer"),
            new Sphere([0, 1, 0], { r: 1.2 }),
            0.4,
            "stairs",
            3,
        ),
    )
    const rnd = makeRnd(424242)
    for (let k = 0; k < 200; k++) {
        const cx = (rnd() - 0.5) * 8
        const cy = (rnd() - 0.5) * 8
        const cz = (rnd() - 0.5) * 8
        const hx = rnd() * 0.8 + 0.01
        const [lo, hi] = tree.intervalOverBox(cx, cy, cz, hx, hx, hx)
        for (let m = 0; m < 8; m++) {
            const v = tree.f(cx + (rnd() * 2 - 1) * hx, cy + (rnd() * 2 - 1) * hx, cz + (rnd() * 2 - 1) * hx)
            assert.ok(v >= lo - 1e-9 && v <= hi + 1e-9, `f=${v} outside [${lo}, ${hi}]`)
        }
    }
})

/** Bisect f to a surface point along the +z ray from (0, 0, zLo). */
function bisectSurfaceZ(tree: CpuSdfTree, zLo: number, zHi: number): [number, number, number] {
    let lo = zLo
    let hi = zHi
    assert.ok(tree.f(0, 0, lo) < 0 && tree.f(0, 0, hi) > 0, "bracket")
    for (let i = 0; i < 80; i++) {
        const mid = (lo + hi) / 2
        if (tree.f(0, 0, mid) < 0) lo = mid
        else hi = mid
    }
    return [0, 0, (lo + hi) / 2]
}

test("grad: matches finite differences inside the blend band; gradBound advisory", () => {
    const tree = compileCpuSdf(new Union([S1(), S2()], 0.8))
    assert.equal(tree.gradBound, Math.SQRT2)
    assert.equal(compileCpuSdf(new Union([S1(), S2()], 0.8, "soft")).gradBound, 1)
    assert.equal(compileCpuSdf(new Union([S1(), S2()])).gradBound, 1)
    assert.ok(
        Math.abs(
            compileCpuSdf(new Union([new Union([S1(), S2()], 0.5), new Sphere([0, 3, 0], { r: 1 })], 0.5))
                .gradBound - 2,
        ) < 1e-12,
        "nested round blends compound the bound",
    )

    // The fillet bulge over the waist plane x = 0: surface lies on neither
    // sphere (hard min there is ≈ +0.234), strictly inside the blend band.
    const p = bisectSurfaceZ(tree, 1.0, 3.0)
    const g = new Float64Array(3)
    tree.grad(...p, g)
    const h = 1e-6
    const fd = [
        (tree.f(p[0] + h, p[1], p[2]) - tree.f(p[0] - h, p[1], p[2])) / (2 * h),
        (tree.f(p[0], p[1] + h, p[2]) - tree.f(p[0], p[1] - h, p[2])) / (2 * h),
        (tree.f(p[0], p[1], p[2] + h) - tree.f(p[0], p[1], p[2] - h)) / (2 * h),
    ]
    const fl = Math.hypot(fd[0]!, fd[1]!, fd[2]!)
    const dot = (g[0]! * fd[0]! + g[1]! * fd[1]! + g[2]! * fd[2]!) / fl
    assert.ok(dot > 0.9999, `grad ≠ FD: grad=(${g.join(", ")}) fd=(${fd.join(", ")})`)
    assert.ok(Math.abs(Math.hypot(g[0]!, g[1]!, g[2]!) - 1) < 1e-12, "grad is unit")
})

test("activeOwnersAt: empty on the fillet bulge, hard winner away from the band", () => {
    const tree = compileCpuSdf(new Union([S1(), S2()], 0.8))
    const bulge = bisectSurfaceZ(tree, 1.0, 3.0)
    assert.ok(Math.abs(tree.f(...bulge)) < 1e-9)
    // The blend surface lies on no carrier: no owners.
    assert.equal(tree.activeOwnersAt(...bulge, 1e-3).length, 0)
    // Far side of sphere 1 is untouched by the blend: exactly one owner.
    const far: [number, number, number] = [-3.5, 0, 0]
    assert.ok(Math.abs(tree.f(...far)) < 1e-12)
    const owners = tree.activeOwnersAt(...far, 1e-3)
    assert.equal(owners.length, 1)
})

test("sfcc pipeline: smooth union of overlapping spheres → certified manifold, zero feature curves", () => {
    const tree = compileCpuSdf(new Union([S1(), S2()], 0.8))
    const tol = resolveTolerances(TUNING, Math.hypot(16, 16, 16))
    const fs = compileFeatureSet(tree, tol)
    // The hard seam ring lies ≈ 0.33 inside the blended surface — trim's
    // on-surface check must kill the whole traced carrier-pair circle.
    assert.equal(fs.curves.length, 0, `expected no curves, got ${fs.curves.length}`)
    assert.equal(fs.corners.length, 0)

    const r = runSfccPipeline(tree, BOUNDS, TUNING)
    assert.equal(r.stats.failedCells, 0)
    assert.equal(r.stats.faceAuditFailures, 0)
    assert.ok(r.manifold.ok, JSON.stringify(r.manifold))
    assert.equal(r.manifold.components, 1)
    assert.deepEqual(r.manifold.eulerPerComponent, [2])
    assert.ok(maxAbsF(tree, r) <= TUNING.surfaceTolMm, `max |f| = ${maxAbsF(tree, r)}`)
})

test("sfcc pipeline: smooth subtract dent → certified manifold sphere, zero feature curves", () => {
    const tree = compileCpuSdf(new Subtract(new Sphere([0, 0, 0], { r: 3 }), new Sphere([0, 0, 3], { r: 2 }), 0.6))
    const tol = resolveTolerances(TUNING, Math.hypot(16, 16, 16))
    const fs = compileFeatureSet(tree, tol)
    assert.equal(fs.curves.length, 0)

    const r = runSfccPipeline(tree, BOUNDS, TUNING)
    assert.equal(r.stats.failedCells, 0)
    assert.equal(r.stats.faceAuditFailures, 0)
    assert.ok(r.manifold.ok, JSON.stringify(r.manifold))
    assert.equal(r.manifold.components, 1)
    assert.deepEqual(r.manifold.eulerPerComponent, [2])
    assert.ok(maxAbsF(tree, r) <= TUNING.surfaceTolMm, `max |f| = ${maxAbsF(tree, r)}`)
})

test("blendRadiusBetween: lowest-common-combiner radius per leaf pair", () => {
    const hard = compileCpuSdf(new Union([S1(), S2()]))
    assert.equal(hard.blendRadiusBetween(0, 1), 0)
    const smooth = compileCpuSdf(new Union([S1(), S2()], 0.8))
    assert.equal(smooth.blendRadiusBetween(0, 1), 0.8)
    assert.equal(smooth.blendRadiusBetween(1, 0), 0.8)
    // Mixed nesting: (s1, s2) meet at the inner blend; either with the box
    // meets at the hard outer union.
    const mixed = compileCpuSdf(new Union([new Union([S1(), S2()], 0.5), new Box([0, -4, 0], [1, 1, 1])]))
    const boxIdx = mixed.leaves.findIndex(l => l.shapeType === "box")
    const sphereIdx = mixed.leaves.map((l, i) => (l.shapeType === "sphere" ? i : -1)).filter(i => i >= 0)
    assert.equal(mixed.blendRadiusBetween(sphereIdx[0]!, sphereIdx[1]!), 0.5)
    assert.equal(mixed.blendRadiusBetween(sphereIdx[0]!, boxIdx), 0)
    assert.equal(mixed.blendRadiusBetween(sphereIdx[1]!, boxIdx), 0)
})

test("seam-trace skip: blended pairs are not traced; near-hard blends keep their seam", () => {
    const tol = resolveTolerances(TUNING, Math.hypot(16, 16, 16))
    // r = 0.8 ≫ 4·surfaceTol: the pair is skipped outright.
    const smooth = compileFeatureSet(compileCpuSdf(new Union([S1(), S2()], 0.8)), tol)
    assert.equal(smooth.seamDiagnostics.pairsConsidered, 0)
    assert.equal(smooth.curves.length, 0)
    // r = 2·surfaceTol < 4·surfaceTol: traced, and trim keeps it — the
    // surface deviates only 0.41·r < surfaceTol from the hard seam, so the
    // sharp curve is the better description within tolerance.
    const nearHard = compileFeatureSet(
        compileCpuSdf(new Union([S1(), S2()], 2 * TUNING.surfaceTolMm)),
        tol,
    )
    assert.equal(nearHard.seamDiagnostics.pairsConsidered, 1)
    assert.ok(nearHard.curves.length >= 1, "near-hard seam ring must survive")
})

test("sfcc pipeline: native crease fading into a union fillet → valence-1 fade corners, certified", () => {
    // Sphere centered ON the box edge (2, 2, z): the edge's crease is exact
    // away from the sphere, fades where the fillet takes over (|z| < 1.7),
    // and trim ends the runs at the aliveness boundary — each fade endpoint
    // becomes a valence-1 corner that the corner-fan path meshes.
    const tree = compileCpuSdf(new Union([new Box([0, 0, 0], [2, 2, 2]), new Sphere([2, 2, 0], { r: 1.2 })], 0.5))
    const tol = resolveTolerances(TUNING, Math.hypot(16, 16, 16))
    const fs = compileFeatureSet(tree, tol)
    const fadeCorners = fs.corners.filter(c => c.curveEnds.length === 1)
    assert.equal(fadeCorners.length, 2, `expected 2 fade corners, got valences ${fs.corners.map(c => c.curveEnds.length)}`)
    for (const c of fadeCorners) {
        // Fade corners sit on the surface (at the aliveness boundary) on the
        // box edge line, inside the blend influence zone.
        assert.ok(Math.abs(tree.f(c.x, c.y, c.z)) <= tol.surfaceTol * 1.2)
        assert.ok(Math.abs(c.x - 2) < 0.05 && Math.abs(c.y - 2) < 0.05 && Math.abs(c.z) < 1.75)
    }

    const r = runSfccPipeline(tree, BOUNDS, TUNING)
    assert.equal(r.stats.failedCells, 0)
    assert.equal(r.stats.featureCellFallbacks, 0)
    assert.equal(r.stats.faceAuditFailures, 0)
    assert.ok(r.manifold.ok, JSON.stringify(r.manifold))
    assert.deepEqual(r.manifold.eulerPerComponent, [2])
    // The fade corner itself sits AT |f| = surfaceTol by construction (the
    // bisected aliveness boundary), so allow a small margin over surfaceTol.
    assert.ok(maxAbsF(tree, r) <= TUNING.surfaceTolMm * 1.5, `max |f| = ${maxAbsF(tree, r)}`)
    // Away from the blend the crease must stay exact: vertices ON the edge
    // line at |z| > 1.75, short of the true box corner.
    let onEdge = 0
    for (let i = 0; i < r.verts.length; i += 8) {
        if (
            Math.abs(r.verts[i]! - 2) < 1e-9 &&
            Math.abs(r.verts[i + 1]! - 2) < 1e-9 &&
            Math.abs(r.verts[i + 2]!) > 1.75 &&
            Math.abs(r.verts[i + 2]!) < 2 - 1e-9
        ) {
            onEdge++
        }
    }
    assert.ok(onEdge >= 1, "sharp portion of the faded edge must keep exact on-edge vertices")
})

test("sfcc pipeline: native crease cut by a smooth-subtract scallop → certified, fade corners", () => {
    // Sphere scallop excavated from the vertical edge (2, y, 2) with a round
    // blend: the edge fades into the excavation fillet from both sides.
    const tree = compileCpuSdf(
        new Subtract(new Box([0, 0, 0], [2, 2, 2]), new Sphere([2, 0, 2], { r: 1 }), 0.4),
    )
    const tol = resolveTolerances(TUNING, Math.hypot(16, 16, 16))
    const fs = compileFeatureSet(tree, tol)
    assert.ok(
        fs.corners.filter(c => c.curveEnds.length === 1).length >= 2,
        `expected fade corners, got valences ${fs.corners.map(c => c.curveEnds.length)}`,
    )

    const r = runSfccPipeline(tree, BOUNDS, TUNING)
    assert.equal(r.stats.failedCells, 0)
    assert.equal(r.stats.faceAuditFailures, 0)
    assert.ok(r.manifold.ok, JSON.stringify(r.manifold))
    assert.deepEqual(r.manifold.eulerPerComponent, [2])
    assert.ok(maxAbsF(tree, r) <= TUNING.surfaceTolMm * 1.5, `max |f| = ${maxAbsF(tree, r)}`)
})

test("sfcc pipeline: stairs-mode union → certified manifold (steps contour as smooth ridges, v1 envelope)", () => {
    // Stairs zero sets have real creases the carrier model does not represent
    // in v1; they mesh at lattice resolution on a certified closed manifold.
    const tree = compileCpuSdf(new Union([S1(), S2()], 0.8, "stairs", 3))
    const r = runSfccPipeline(tree, BOUNDS, TUNING)
    assert.equal(r.stats.failedCells, 0)
    assert.equal(r.stats.faceAuditFailures, 0)
    assert.ok(r.manifold.ok, JSON.stringify(r.manifold))
    assert.deepEqual(r.manifold.eulerPerComponent, [2])
})
