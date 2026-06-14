import assert from "node:assert/strict"
import test from "node:test"
import type { Node } from "../../scene/base.mjs"
import { Sphere } from "../../scene/primitives/sphere.mjs"
import { Box } from "../../scene/primitives/box.mjs"
import { Union } from "../../scene/operators/union.mjs"
import { Subtract } from "../../scene/operators/subtract.mjs"
import { compileCpuSdf } from "./cpu-sdf.mjs"
import { runSfccPipeline, type SfccPipelineResult } from "./assemble.mjs"
import { DEFAULT_SFCC_TUNING, type SfccTuning } from "./sfcc-tuning.mjs"
import { meshesEquivalent } from "./mesh-canonical.mjs"

const TUNING: SfccTuning = { ...DEFAULT_SFCC_TUNING, depthMin: 5, depthMax: 8, boundsPaddingMm: 0 }

/** Compile + mesh a FRESH scene tree so no per-run cache can be reused. */
function meshFresh(makeScene: () => Node, size: number): SfccPipelineResult {
    const tree = compileCpuSdf(makeScene())
    return runSfccPipeline(tree, { minX: -size / 2, minY: -size / 2, minZ: -size / 2, size }, TUNING)
}

/**
 * The contract a parallel meshing pass must keep: identical scene → identical
 * surface, every run. Array order may change; geometry and topology may not.
 *
 * posEps = 0 (exact) is correct here — a deterministic pipeline is bit-identical
 * across runs of the SAME implementation. Relax to a small posEps only when
 * comparing ACROSS implementations (e.g. the TS reference vs the Rust port),
 * where f64 results may legitimately differ by a few ULPs.
 */
function assertDeterministic(makeScene: () => Node, size: number): void {
    const a = meshFresh(makeScene, size)
    const b = meshFresh(makeScene, size)
    assert.ok(a.tris.length > 0, "produced triangles (comparison is meaningful)")
    const eq = meshesEquivalent(a, b, { compareNormals: true, posEps: 0 })
    assert.ok(eq.equal, `nondeterministic mesh: ${eq.reason}`)
}

test("sfcc determinism: smooth sphere is bit-identical across runs", () => {
    assertDeterministic(() => new Sphere([0.13, -0.21, 0.07], { r: 8 }), 24)
})

test("sfcc determinism: boolean subtract (seam features) is bit-identical across runs", () => {
    // A boolean seam exercises feature classification + face-pin welding — the
    // code paths most prone to order-dependence once parallelized.
    assertDeterministic(() => new Subtract(new Box([0, 0, 0], [10, 10, 10]), new Sphere([5, 5, 5], { r: 6 })), 28)
})

test("sfcc determinism: overlapping smooth union is bit-identical across runs", () => {
    assertDeterministic(
        () => new Union([new Sphere([-1.4, 0.2, 0.1], { r: 3 }), new Sphere([1.5, -0.3, 0.2], { r: 3 })]),
        16,
    )
})
