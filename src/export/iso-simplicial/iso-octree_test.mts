import assert from "node:assert/strict"
import test from "node:test"

import { IsoSimplicialConstants } from "./constants.mjs"
import { cubeEdge2Orient, cubeFace2Orient } from "./cube-tables.mjs"
import {
    IsoOctree,
    computeNodeQefResults,
    isoOctreeChangesSign,
    isoOctreeIsOutside,
    type IsoOctreeBatchFn,
    type QefWorkerPoolLike,
} from "./iso-octree.mjs"
import { unpackFgPlaneSourcesForCell } from "./iso-fg-shared-buffer.mjs"
import {
    FeatureGraphBuilder,
    FG_FLAG_CORNER,
    FG_FLAG_CREASE_ORIGINAL,
} from "../../scene/feature-graph-buffer.mjs"
import { Vec3f } from "../../vecmat/vector.mjs"
import { applyTransforms } from "../../feature-graph/feature-graph-gpu.mjs"
import { FeatureGraphSpatialIndex } from "../../feature-graph/feature-graph-spatial-index.mjs"

const MID_FEATURE_NONE = 0
const MID_FEATURE_LINE = 1

/** Build a mock mid-feature sampler returning constant (kind, dist) at every position. */
function mockMidFeatureConst(kind: number, dist: number): IsoOctreeBatchFn {
    return positions => {
        const n = positions.length / 3
        const out = new Float32Array(n * 28)
        const u = new Uint32Array(out.buffer)
        for (let i = 0; i < n; i++) {
            const base = i * 28
            u[base + 0] = kind
            out[base + 1] = dist
        }
        return Promise.resolve(out)
    }
}

/** Build a mock mid-feature sampler returning a full packed `SDFResultMid` at every position. */
function mockMidFeatureFull(opts: {
    kind: number
    dist: number
    normalCount: number
    point: readonly [number, number, number]
    n1: readonly [number, number, number]
    n2: readonly [number, number, number]
}): IsoOctreeBatchFn {
    return positions => {
        const n = positions.length / 3
        const out = new Float32Array(n * 28)
        const u = new Uint32Array(out.buffer)
        for (let i = 0; i < n; i++) {
            const base = i * 28
            u[base + 0] = opts.kind
            out[base + 1] = opts.dist
            u[base + 4] = opts.normalCount
            out[base + 8] = opts.point[0]
            out[base + 9] = opts.point[1]
            out[base + 10] = opts.point[2]
            out[base + 16] = opts.n1[0]
            out[base + 17] = opts.n1[1]
            out[base + 18] = opts.n1[2]
            out[base + 20] = opts.n2[0]
            out[base + 21] = opts.n2[1]
            out[base + 22] = opts.n2[2]
        }
        return Promise.resolve(out)
    }
}

/** Constant-negative SDF: no sign change anywhere. */
const mockSdfInside: IsoOctreeBatchFn = positions => {
    const n = positions.length / 3
    const out = new Float32Array(n * 4)
    for (let i = 0; i < n; i++) {
        out[i * 4 + 2] = 1
        out[i * 4 + 3] = -1
    }
    return Promise.resolve(out)
}

/** Horizontal plane `z = 0.5`; outward normal `(0,0,1)` (mock GPU layout). */
const mockPlaneHalfZ: IsoOctreeBatchFn = positions => {
    const n = positions.length / 3
    const out = new Float32Array(n * 4)
    for (let i = 0; i < n; i++) {
        const z = positions[i * 3 + 2]!
        out[i * 4] = 0
        out[i * 4 + 1] = 0
        out[i * 4 + 2] = 1
        out[i * 4 + 3] = z - 0.5
    }
    return Promise.resolve(out)
}

test("isoOctreeChangesSign matches reference pattern (verts[0] baseline)", () => {
    const verts = new Float32Array(32)
    const edges = new Float32Array(48)
    const faces = new Float32Array(24)
    const node = new Float32Array(4)
    for (let i = 0; i < 8; i++) verts[i * 4 + 3] = -1
    for (let i = 0; i < 12; i++) edges[i * 4 + 3] = -1
    for (let i = 0; i < 6; i++) faces[i * 4 + 3] = -1
    node[3] = -1
    verts[7 * 4 + 3] = 1
    assert.equal(isoOctreeChangesSign(verts, edges, faces, node), true)
    verts[7 * 4 + 3] = -1
    assert.equal(isoOctreeChangesSign(verts, edges, faces, node), false)
})

test("isoOctreeIsOutside: small cell protruding past normalized +x", () => {
    const verts = new Float32Array(32)
    writeCorner(verts, 0, 0.95, 0.2, 0.2, -1)
    writeCorner(verts, 7, 1.1, 0.4, 0.4, 1)
    assert.equal(isoOctreeIsOutside(verts), true)
})

function writeCorner(verts: Float32Array, i: number, x: number, y: number, z: number, w: number): void {
    const o = i * 4
    verts[o] = x
    verts[o + 1] = y
    verts[o + 2] = z
    verts[o + 3] = w
}

test("IsoOctree.build: mock sampler only, depthMax=0 yields single evaluated cell", async () => {
    const tree = await IsoOctree.build({
        sample: mockPlaneHalfZ,
        bounds: { min: [0, 0, 0], max: [1, 1, 1] },
        constants: { depthMax: 0 },
    })
    assert.equal(tree.treeCellCount, 1)
    assert.ok(tree.root.children.every(c => c === null))
})

test("IsoOctree.build: dual vertex stays in cell interior for non-unit worldBounds (unit-mismatch regression)", async () => {
    // Sphere of radius 30 centered at world origin; world cube spans [-50, 50]³. The sphere surface
    // crosses well inside the root cell, and varying gradients across samples make the cube QEF full
    // rank, so the unconstrained minimizer must pin to the sphere center: world (0,0,0) → normalized
    // (0.5, 0.5, 0.5). Returns world `d = |p|-30` and unit world normal `p/|p|`, matching the GPU
    // `iso_sample_batch.wgsl` contract.
    const RADIUS_WORLD = 30
    const sphereField: IsoOctreeBatchFn = positions => {
        const n = positions.length / 3
        const out = new Float32Array(n * 4)
        for (let i = 0; i < n; i++) {
            const x = positions[i * 3]!
            const y = positions[i * 3 + 1]!
            const z = positions[i * 3 + 2]!
            const r = Math.sqrt(x * x + y * y + z * z)
            const inv = r > 1e-12 ? 1 / r : 0
            out[i * 4] = x * inv
            out[i * 4 + 1] = y * inv
            out[i * 4 + 2] = z * inv
            out[i * 4 + 3] = r - RADIUS_WORLD
        }
        return Promise.resolve(out)
    }

    const tree = await IsoOctree.build({
        sample: sphereField,
        bounds: { min: [-50, -50, -50], max: [50, 50, 50] },
        constants: { depthMin: 0, depthMax: 0, qefRelativeErrorRefineThreshold: 1e30 },
    })

    // Root cube dual vertex must land near the sphere center in normalized coords (0.5, 0.5, 0.5),
    // not be clamped to {0,1} by the constrained-cascade fallback that fires when the unconstrained
    // QEF returns junk (which is what happens when world d is mixed with normalized positions).
    const nx = tree.root.node[0]!
    const ny = tree.root.node[1]!
    const nz = tree.root.node[2]!
    for (const [name, v] of [["x", nx], ["y", ny], ["z", nz]] as const) {
        assert.ok(
            v > 0.4 && v < 0.6,
            `root cube dual-vertex ${name}=${v} expected near 0.5 (sphere center, normalized); ` +
                `values near {0,1} indicate QEF unit mismatch (world d vs normalized p)`,
        )
    }
})

test("IsoOctree.build: deterministic treeCellCount for fixed mock + caps", async () => {
    const params = {
        sample: mockPlaneHalfZ,
        bounds: { min: [0, 0, 0], max: [1, 1, 1] } as const,
        constants: { depthMin: 2, depthMax: 4, qefRelativeErrorRefineThreshold: 1e30 },
    }
    const a = await IsoOctree.build(params)
    const b = await IsoOctree.build(params)
    assert.equal(a.treeCellCount, b.treeCellCount)
    assert.ok(a.treeCellCount > 1)
})

test("IsoOctree.build: skips standalone 8-corner batch; corners seeded from phase1 lattice", async () => {
    const O = IsoSimplicialConstants.oversampleQef
    const nodeCount = (O + 1) ** 3
    const totalPhase1 = nodeCount + 12 * (O + 1) + 6 * (O + 1) ** 2

    const batchSampleCounts: number[] = []
    const trackingSampler: IsoOctreeBatchFn = positions => {
        batchSampleCounts.push(positions.length / 3)
        return mockPlaneHalfZ(positions)
    }

    const tree = await IsoOctree.build({
        sample: trackingSampler,
        bounds: { min: [0, 0, 0], max: [1, 1, 1] },
        constants: { depthMin: 0, depthMax: 0, qefRelativeErrorRefineThreshold: 1e30 },
    })

    assert.equal(batchSampleCounts[0], totalPhase1, `first batch should be phase1 (${totalPhase1}); got ${batchSampleCounts[0]}`)
    assert.ok(
        !batchSampleCounts.includes(8),
        `root 8-corner batch should be eliminated; got batch sizes ${batchSampleCounts.join(",")}`,
    )

    // Corner SDF must match the mock plane (z - 0.5) at each corner position (b.z * 1).
    for (let i = 0; i < 8; i++) {
        const bz = (i >> 2) & 1
        const expected = bz - 0.5
        assert.equal(tree.root.verts[i * 4 + 3], expected, `root.verts corner ${i} d`)
    }
})

test("IsoOctree.build: sibling megabatch coalesces phase1 and reEval sample counts", async () => {
    const O = IsoSimplicialConstants.oversampleQef
    const nodeCount = (O + 1) ** 3
    const edgeSamples = O + 1
    const faceSamples = (O + 1) ** 2
    const totalPhase1 = nodeCount + 12 * edgeSamples + 6 * faceSamples

    const batchSampleCounts: number[] = []
    const trackingSampler: IsoOctreeBatchFn = positions => {
        batchSampleCounts.push(positions.length / 3)
        return mockPlaneHalfZ(positions)
    }

    await IsoOctree.build({
        sample: trackingSampler,
        bounds: { min: [0, 0, 0], max: [1, 1, 1] },
        constants: { depthMin: 2, depthMax: 4, qefRelativeErrorRefineThreshold: 1e30 },
    })

    assert.ok(
        batchSampleCounts.some(n => n === 8 * totalPhase1),
        `expected 8×phase1 megabatch (${8 * totalPhase1}), got ${batchSampleCounts.join(",")}`,
    )
    assert.ok(
        batchSampleCounts.some(n => n === 8 * 19),
        `expected 8×19 reEval megabatch (152), got ${batchSampleCounts.join(",")}`,
    )
})

test("featureRefine: mode='off' never calls sampleMidFeature", async () => {
    let midCalls = 0
    const trackingMid: IsoOctreeBatchFn = positions => {
        midCalls++
        return mockMidFeatureConst(MID_FEATURE_LINE, 0)(positions)
    }
    await IsoOctree.build({
        sample: mockPlaneHalfZ,
        bounds: { min: [0, 0, 0], max: [1, 1, 1] },
        constants: { depthMin: 0, depthMax: 1, qefRelativeErrorRefineThreshold: 1e30 },
        featureRefine: { mode: "off", proximityFactor: 2.0, sampleMidFeature: trackingMid },
    })
    assert.equal(midCalls, 0)
})

test("featureRefine: 'signchangeGated' subdivides when signchange + near feature, badqef off", async () => {
    const tree = await IsoOctree.build({
        sample: mockPlaneHalfZ,
        bounds: { min: [0, 0, 0], max: [1, 1, 1] },
        constants: { depthMin: 0, depthMax: 1, qefRelativeErrorRefineThreshold: 1e30 },
        featureRefine: {
            mode: "signchangeGated",
            proximityFactor: 2.0,
            sampleMidFeature: mockMidFeatureConst(MID_FEATURE_LINE, 0),
        },
    })
    assert.ok(tree.treeCellCount > 1, `expected subdivision (>1 cell), got ${tree.treeCellCount}`)
})

test("featureRefine: 'signchangeGated' does NOT subdivide when no signchange (cut-away feature)", async () => {
    const tree = await IsoOctree.build({
        sample: mockSdfInside,
        bounds: { min: [0, 0, 0], max: [1, 1, 1] },
        constants: { depthMin: 0, depthMax: 1, qefRelativeErrorRefineThreshold: 1e30 },
        featureRefine: {
            mode: "signchangeGated",
            proximityFactor: 2.0,
            sampleMidFeature: mockMidFeatureConst(MID_FEATURE_LINE, 0),
        },
    })
    assert.equal(tree.treeCellCount, 1, "signchangeGated must require signchange — no surface → no subdivide")
})

test("featureRefine: 'signchangeGated' does NOT subdivide when feature is far (dist > factor*cellSize)", async () => {
    const tree = await IsoOctree.build({
        sample: mockPlaneHalfZ,
        bounds: { min: [0, 0, 0], max: [1, 1, 1] },
        constants: { depthMin: 0, depthMax: 1, qefRelativeErrorRefineThreshold: 1e30 },
        featureRefine: {
            // cellSizeWorld = 1, threshold = 2 * 1 = 2; dist = 5 is outside → no subdivide
            mode: "signchangeGated",
            proximityFactor: 2.0,
            sampleMidFeature: mockMidFeatureConst(MID_FEATURE_LINE, 5.0),
        },
    })
    assert.equal(tree.treeCellCount, 1)
})

test("featureRefine: 'signchangeGated' kind=NONE never triggers, regardless of dist", async () => {
    const tree = await IsoOctree.build({
        sample: mockPlaneHalfZ,
        bounds: { min: [0, 0, 0], max: [1, 1, 1] },
        constants: { depthMin: 0, depthMax: 1, qefRelativeErrorRefineThreshold: 1e30 },
        featureRefine: {
            mode: "signchangeGated",
            proximityFactor: 2.0,
            sampleMidFeature: mockMidFeatureConst(MID_FEATURE_NONE, 0),
        },
    })
    assert.equal(tree.treeCellCount, 1)
})

test("featureRefine: mode != 'off' without sampleMidFeature throws", async () => {
    await assert.rejects(
        IsoOctree.build({
            sample: mockPlaneHalfZ,
            bounds: { min: [0, 0, 0], max: [1, 1, 1] },
            constants: { depthMin: 0, depthMax: 1 },
            featureRefine: { mode: "signchangeGated", proximityFactor: 2.0 },
        }),
        /sampleMidFeature/,
    )
})

// ────────────────────────────────────────────────────────────────────────────
// Feature-plane QEF injection (Option B)
//
// `mockPlaneHalfZ` has all-(0,0,1) normals, so the cube QEF only constrains
// V_z and V_w; V_x and V_y are underdetermined and border-clamped to
// `dualVertexBorderFraction = 0.0625`. Feature planes use a pure-3D encoding
// `[nx,ny,nz,0,-(n·p)]` (V_w coefficient 0), so they constrain V_x/V_y
// directly without SDF coupling. With planes through (0.3, 0.3, 0.5) and
// normals (1,0,0) and (0,1,0), the QEF gains independent X and Y constraints
// that pin V_x = 0.3 and V_y = 0.3 exactly.
// ────────────────────────────────────────────────────────────────────────────

/** Bounds {0..1}, cellSize=1, worldScale=1 — keeps the distance-gate math obvious. */
const UNIT_BOUNDS = { min: [0, 0, 0] as const, max: [1, 1, 1] as const }
const DEPTH0_CONSTS = { depthMin: 0, depthMax: 0, qefRelativeErrorRefineThreshold: 1e30 }
const NEAR_FEATURE = mockMidFeatureFull({
    kind: MID_FEATURE_LINE,
    dist: 0.6,
    normalCount: 2,
    point: [0.3, 0.3, 0.5],
    n1: [1, 0, 0],
    n2: [0, 1, 0],
})
/** Border fraction applied to unconstrained axes by `computeDualVertexCube`. */
const BORDER = 0.0625

test("featurePlane: disabled — x/y border-clamped (not pulled toward feature point)", async () => {
    const tree = await IsoOctree.build({
        sample: mockPlaneHalfZ,
        bounds: UNIT_BOUNDS,
        constants: DEPTH0_CONSTS,
        featureRefine: {
            mode: "signchangeGated",
            proximityFactor: 2.0,
            sampleMidFeature: NEAR_FEATURE,
            planeEnabled: false,
        },
    })
    const vx = tree.root.node[0]!
    const vy = tree.root.node[1]!
    // No feature planes → x/y underdetermined → border-clamped to BORDER (not near 0.3)
    assert.ok(Math.abs(vx - 0.3) > 0.1, `x without feature planes must NOT pull toward 0.3, got ${vx}`)
    assert.ok(Math.abs(vy - 0.3) > 0.1, `y without feature planes must NOT pull toward 0.3, got ${vy}`)
})

test("featurePlane: enabled — vertex pulls toward featurePoint x/y", async () => {
    const tree = await IsoOctree.build({
        sample: mockPlaneHalfZ,
        bounds: UNIT_BOUNDS,
        constants: DEPTH0_CONSTS,
        featureRefine: {
            mode: "signchangeGated",
            proximityFactor: 2.0,
            sampleMidFeature: NEAR_FEATURE,
            planeEnabled: true,
            planeDistFactor: 2.0,
        },
    })
    const vx = tree.root.node[0]!
    const vy = tree.root.node[1]!
    const vz = tree.root.node[2]!
    // Feature planes pin V_x = 0.3, V_y = 0.3; lattice pins V_z near 0.25 (z=0.5 surface)
    assert.ok(Math.abs(vx - 0.3) < 0.05, `x should pull toward 0.3, got ${vx}`)
    assert.ok(Math.abs(vy - 0.3) < 0.05, `y should pull toward 0.3, got ${vy}`)
    assert.ok(vz > BORDER && vz < 1 - BORDER, `z should stay inside cell, got ${vz}`)
})

test("featurePlane: distance gate suppresses far-feature planes", async () => {
    const farFeature = mockMidFeatureFull({
        kind: MID_FEATURE_LINE,
        dist: 5.0,
        normalCount: 2,
        point: [0.3, 0.3, 0.5],
        n1: [1, 0, 0],
        n2: [0, 1, 0],
    })
    const tree = await IsoOctree.build({
        sample: mockPlaneHalfZ,
        bounds: UNIT_BOUNDS,
        constants: DEPTH0_CONSTS,
        featureRefine: {
            mode: "signchangeGated",
            proximityFactor: 16, // keep subdivision gate from firing
            sampleMidFeature: farFeature,
            planeEnabled: true,
            planeDistFactor: 1.0, // threshold = 1.0 × 1 × 1 = 1; dist=5 → gated out
        },
    })
    const vx = tree.root.node[0]!
    const vy = tree.root.node[1]!
    // Far feature must not inject planes → x/y remain border-clamped
    assert.ok(Math.abs(vx - 0.3) > 0.1, `far feature must NOT pull x toward 0.3, got ${vx}`)
    assert.ok(Math.abs(vy - 0.3) > 0.1, `far feature must NOT pull y toward 0.3, got ${vy}`)
})

test("featurePlane: kind=NONE corners contribute no planes", async () => {
    const noFeature = mockMidFeatureFull({
        kind: MID_FEATURE_NONE,
        dist: 0,
        normalCount: 2,
        point: [0.3, 0.3, 0.5],
        n1: [1, 0, 0],
        n2: [0, 1, 0],
    })
    const tree = await IsoOctree.build({
        sample: mockPlaneHalfZ,
        bounds: UNIT_BOUNDS,
        constants: DEPTH0_CONSTS,
        featureRefine: {
            mode: "signchangeGated",
            proximityFactor: 2.0,
            sampleMidFeature: noFeature,
            planeEnabled: true,
            planeDistFactor: 16,
        },
    })
    const vx = tree.root.node[0]!
    const vy = tree.root.node[1]!
    // kind=NONE → injector skips → x/y remain border-clamped
    assert.ok(Math.abs(vx - 0.3) > 0.1, `kind=NONE must NOT pull x toward 0.3, got ${vx}`)
    assert.ok(Math.abs(vy - 0.3) > 0.1, `kind=NONE must NOT pull y toward 0.3, got ${vy}`)
})

test("featurePlane: single-normal feature constrains its axis only", async () => {
    const oneNormal = mockMidFeatureFull({
        kind: MID_FEATURE_LINE,
        dist: 0.6,
        normalCount: 1,
        point: [0.3, 0.3, 0.5],
        n1: [1, 0, 0],
        n2: [0, 1, 0], // ignored when normalCount=1
    })
    const tree = await IsoOctree.build({
        sample: mockPlaneHalfZ,
        bounds: UNIT_BOUNDS,
        constants: DEPTH0_CONSTS,
        featureRefine: {
            mode: "signchangeGated",
            proximityFactor: 2.0,
            sampleMidFeature: oneNormal,
            planeEnabled: true,
            planeDistFactor: 2.0,
        },
    })
    const vx = tree.root.node[0]!
    const vy = tree.root.node[1]!
    // n1=(1,0,0) pins V_x = 0.3; n2 ignored (normalCount=1) → V_y border-clamped
    assert.ok(Math.abs(vx - 0.3) < 0.05, `x constrained by n1=(1,0,0) toward 0.3, got ${vx}`)
    assert.ok(Math.abs(vy - 0.3) > 0.1, `y must NOT be pulled (n2 ignored), got ${vy}`)
})

// ────────────────────────────────────────────────────────────────────────────
// Feature-plane QEF injection: edge & face dual vertices
//
// `mockPlaneHalfZ` gradients are (0,0,1), so axis-aligned edges and faces are
// underdetermined in the in-plane directions and border-clamp without feature
// help. Feature planes with normals (1,0,0) and (0,1,0) through (0.3, 0.3, 0.5)
// then constrain:
//   – x-axis edges (orient=0) toward x = 0.3 via n1
//   – y-axis edges (orient=1) toward y = 0.3 via n2
//   – z-axis edges (orient=2) — both normals lie *along* the face containing
//     the edge axis, so n[zi]=0 → skipped → remain border-clamped
//   – faces toward whichever of (x=0.3, y=0.3) lies within their varying axes
// ────────────────────────────────────────────────────────────────────────────

test("featurePlane (edge): x-axis edges pull toward feature x, z-axis edges do not", async () => {
    const tree = await IsoOctree.build({
        sample: mockPlaneHalfZ,
        bounds: UNIT_BOUNDS,
        constants: DEPTH0_CONSTS,
        featureRefine: {
            mode: "signchangeGated",
            proximityFactor: 2.0,
            sampleMidFeature: NEAR_FEATURE,
            planeEnabled: true,
            planeDistFactor: 2.0,
        },
    })
    for (let e = 0; e < 12; e++) {
        const orient = cubeEdge2Orient[e]!
        const ex = tree.root.edges[e * 4]!
        const ey = tree.root.edges[e * 4 + 1]!
        if (orient === 0) {
            assert.ok(Math.abs(ex - 0.3) < 0.05, `x-axis edge ${e}: x should be near 0.3, got ${ex}`)
        } else if (orient === 1) {
            assert.ok(Math.abs(ey - 0.3) < 0.05, `y-axis edge ${e}: y should be near 0.3, got ${ey}`)
        } else {
            // z-axis edge: feature normals (1,0,0) and (0,1,0) have nXi=0 → injector skips them
            assert.ok(Math.abs(ex - 0.3) > 0.1, `z-axis edge ${e}: x should NOT pull to 0.3, got ${ex}`)
            assert.ok(Math.abs(ey - 0.3) > 0.1, `z-axis edge ${e}: y should NOT pull to 0.3, got ${ey}`)
        }
    }
})

test("featurePlane (edge): disabled — no edges pull toward feature", async () => {
    const tree = await IsoOctree.build({
        sample: mockPlaneHalfZ,
        bounds: UNIT_BOUNDS,
        constants: DEPTH0_CONSTS,
        featureRefine: {
            mode: "signchangeGated",
            proximityFactor: 2.0,
            sampleMidFeature: NEAR_FEATURE,
            planeEnabled: false,
        },
    })
    for (let e = 0; e < 12; e++) {
        const orient = cubeEdge2Orient[e]!
        const ex = tree.root.edges[e * 4]!
        const ey = tree.root.edges[e * 4 + 1]!
        if (orient === 0) {
            assert.ok(Math.abs(ex - 0.3) > 0.1, `disabled: x-axis edge ${e} must NOT pull to 0.3, got ${ex}`)
        } else if (orient === 1) {
            assert.ok(Math.abs(ey - 0.3) > 0.1, `disabled: y-axis edge ${e} must NOT pull to 0.3, got ${ey}`)
        }
    }
})

test("featurePlane (edge): distance gate suppresses far features", async () => {
    const farFeature = mockMidFeatureFull({
        kind: MID_FEATURE_LINE,
        dist: 5.0,
        normalCount: 2,
        point: [0.3, 0.3, 0.5],
        n1: [1, 0, 0],
        n2: [0, 1, 0],
    })
    const tree = await IsoOctree.build({
        sample: mockPlaneHalfZ,
        bounds: UNIT_BOUNDS,
        constants: DEPTH0_CONSTS,
        featureRefine: {
            mode: "signchangeGated",
            proximityFactor: 16,
            sampleMidFeature: farFeature,
            planeEnabled: true,
            planeDistFactor: 1.0, // threshold 1 < dist 5 → skipped
        },
    })
    for (let e = 0; e < 12; e++) {
        const orient = cubeEdge2Orient[e]!
        const ex = tree.root.edges[e * 4]!
        const ey = tree.root.edges[e * 4 + 1]!
        if (orient === 0) assert.ok(Math.abs(ex - 0.3) > 0.1, `far feature: x-edge ${e} not pulled, got ${ex}`)
        if (orient === 1) assert.ok(Math.abs(ey - 0.3) > 0.1, `far feature: y-edge ${e} not pulled, got ${ey}`)
    }
})

test("featurePlane (face): in-face axes pull toward feature; out-of-face axis untouched", async () => {
    const tree = await IsoOctree.build({
        sample: mockPlaneHalfZ,
        bounds: UNIT_BOUNDS,
        constants: DEPTH0_CONSTS,
        featureRefine: {
            mode: "signchangeGated",
            proximityFactor: 2.0,
            sampleMidFeature: NEAR_FEATURE,
            planeEnabled: true,
            planeDistFactor: 2.0,
        },
    })
    for (let f = 0; f < 6; f++) {
        const orient = cubeFace2Orient[f]!
        const fx = tree.root.faces[f * 4]!
        const fy = tree.root.faces[f * 4 + 1]!
        if (orient === 2) {
            // z-fixed: both x and y vary; both normals contribute → pull toward (0.3, 0.3)
            assert.ok(Math.abs(fx - 0.3) < 0.05, `z-face ${f}: x should be near 0.3, got ${fx}`)
            assert.ok(Math.abs(fy - 0.3) < 0.05, `z-face ${f}: y should be near 0.3, got ${fy}`)
        } else if (orient === 1) {
            // y-fixed: x and z vary; only n1=(1,0,0) projects into the face → x pulled
            assert.ok(Math.abs(fx - 0.3) < 0.05, `y-face ${f}: x should be near 0.3, got ${fx}`)
        } else {
            // x-fixed: y and z vary; only n2=(0,1,0) projects into the face → y pulled
            assert.ok(Math.abs(fy - 0.3) < 0.05, `x-face ${f}: y should be near 0.3, got ${fy}`)
        }
    }
})

test("featurePlane (face): disabled — faces border-clamp, no feature pull", async () => {
    const tree = await IsoOctree.build({
        sample: mockPlaneHalfZ,
        bounds: UNIT_BOUNDS,
        constants: DEPTH0_CONSTS,
        featureRefine: {
            mode: "signchangeGated",
            proximityFactor: 2.0,
            sampleMidFeature: NEAR_FEATURE,
            planeEnabled: false,
        },
    })
    for (let f = 0; f < 6; f++) {
        const fx = tree.root.faces[f * 4]!
        const fy = tree.root.faces[f * 4 + 1]!
        assert.ok(Math.abs(fx - 0.3) > 0.05 || Math.abs(fy - 0.3) > 0.05, `disabled: face ${f} must not pull both axes`)
    }
})

test("featurePlane (edge/face): normal parallel to edge axis → no constraint (no NaN)", async () => {
    // Feature normal (0, 0, 1) is parallel to z-axis edges and perpendicular to x/y edges.
    // For x and y edges: nXi = 0 → injector skips. For z edges: nXi = 1 but the edge sample
    // gradients are also (0,0,1), so the constraint is consistent — no NaN expected anywhere.
    const parallel = mockMidFeatureFull({
        kind: MID_FEATURE_LINE,
        dist: 0.6,
        normalCount: 1,
        point: [0.3, 0.3, 0.5],
        n1: [0, 0, 1],
        n2: [0, 0, 0],
    })
    const tree = await IsoOctree.build({
        sample: mockPlaneHalfZ,
        bounds: UNIT_BOUNDS,
        constants: DEPTH0_CONSTS,
        featureRefine: {
            mode: "signchangeGated",
            proximityFactor: 2.0,
            sampleMidFeature: parallel,
            planeEnabled: true,
            planeDistFactor: 2.0,
        },
    })
    for (let e = 0; e < 12; e++) {
        for (let k = 0; k < 4; k++) {
            assert.ok(Number.isFinite(tree.root.edges[e * 4 + k]!), `edge ${e} slot ${k} not finite`)
        }
    }
    for (let f = 0; f < 6; f++) {
        for (let k = 0; k < 4; k++) {
            assert.ok(Number.isFinite(tree.root.faces[f * 4 + k]!), `face ${f} slot ${k} not finite`)
        }
    }
})

// ────────────────────────────────────────────────────────────────────────────
// FeatureGraph-plane QEF injection (Phase IS-3 — cube QEF, soft mode)
//
// Same mechanism as the GPU mid-feature `featurePlane` tests above, but the
// planes are sourced from a hand-built FeatureGraph instead of `sampleMidFeature`.
// `mockPlaneHalfZ` leaves V_x/V_y underdetermined; an FG corner at (0.3,0.3,0.5)
// with normals (1,0,0) and (0,1,0) pins V_x = V_y = 0.3.
// ────────────────────────────────────────────────────────────────────────────

/** Build a one-corner FeatureGraph + spatial index for the iso-simplicial FG path. */
function fgWithCorner(
    pos: readonly [number, number, number],
    normals: ReadonlyArray<readonly [number, number, number]>,
    indexCellSize = 0.5,
) {
    const builder = new FeatureGraphBuilder()
    builder.beginNode(0)
    builder.emitVertex(new Vec3f([pos[0], pos[1], pos[2]]), FG_FLAG_CORNER, normals.map(n => new Vec3f([n[0], n[1], n[2]])))
    builder.endNode()
    const cpu = builder.finish()
    const world = applyTransforms(cpu)
    const index = FeatureGraphSpatialIndex.build(cpu, world, indexCellSize)
    return { featureGraphCpu: cpu, featureGraphWorldPositions: world, featureGraphSpatialIndex: index }
}

/** Build a one-crease-edge FeatureGraph + spatial index. */
function fgWithCrease(
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    normals: ReadonlyArray<readonly [number, number, number]>,
    indexCellSize = 0.5,
) {
    const builder = new FeatureGraphBuilder()
    builder.beginNode(0)
    const ns = normals.map(n => new Vec3f([n[0], n[1], n[2]]))
    const va = builder.emitVertex(new Vec3f([a[0], a[1], a[2]]), FG_FLAG_CREASE_ORIGINAL, ns)
    const vb = builder.emitVertex(new Vec3f([b[0], b[1], b[2]]), FG_FLAG_CREASE_ORIGINAL, ns)
    builder.emitEdge(va, vb, FG_FLAG_CREASE_ORIGINAL)
    builder.endNode()
    const cpu = builder.finish()
    const world = applyTransforms(cpu)
    const index = FeatureGraphSpatialIndex.build(cpu, world, indexCellSize)
    return { featureGraphCpu: cpu, featureGraphWorldPositions: world, featureGraphSpatialIndex: index }
}

test("featureGraphPlane: enabled — cube dual vertex pulls toward FG corner x/y", async () => {
    const fg = fgWithCorner([0.3, 0.3, 0.5], [[1, 0, 0], [0, 1, 0]])
    const tree = await IsoOctree.build({
        sample: mockPlaneHalfZ,
        bounds: UNIT_BOUNDS,
        constants: DEPTH0_CONSTS,
        featureRefine: {
            mode: "off",
            proximityFactor: 2.0,
            fgPlaneEnabled: true,
            fgPlaneDistFactor: 2.0,
            ...fg,
        },
    })
    const vx = tree.root.node[0]!
    const vy = tree.root.node[1]!
    const vz = tree.root.node[2]!
    assert.ok(Math.abs(vx - 0.3) < 0.05, `x should pull toward FG corner 0.3, got ${vx}`)
    assert.ok(Math.abs(vy - 0.3) < 0.05, `y should pull toward FG corner 0.3, got ${vy}`)
    assert.ok(vz > BORDER && vz < 1 - BORDER, `z should stay inside cell, got ${vz}`)
})

test("featureGraphPlane: disabled — x/y border-clamped (no FG pull)", async () => {
    const fg = fgWithCorner([0.3, 0.3, 0.5], [[1, 0, 0], [0, 1, 0]])
    const tree = await IsoOctree.build({
        sample: mockPlaneHalfZ,
        bounds: UNIT_BOUNDS,
        constants: DEPTH0_CONSTS,
        featureRefine: {
            mode: "off",
            proximityFactor: 2.0,
            fgPlaneEnabled: false,
            ...fg,
        },
    })
    const vx = tree.root.node[0]!
    const vy = tree.root.node[1]!
    assert.ok(Math.abs(vx - 0.3) > 0.1, `disabled: x must NOT pull to 0.3, got ${vx}`)
    assert.ok(Math.abs(vy - 0.3) > 0.1, `disabled: y must NOT pull to 0.3, got ${vy}`)
})

test("featureGraphPlane: distance gate suppresses far FG corner", async () => {
    // Corner well outside the unit cell; tight gate → no planes injected.
    const fg = fgWithCorner([20, 20, 20], [[1, 0, 0], [0, 1, 0]])
    const tree = await IsoOctree.build({
        sample: mockPlaneHalfZ,
        bounds: UNIT_BOUNDS,
        constants: DEPTH0_CONSTS,
        featureRefine: {
            mode: "off",
            proximityFactor: 2.0,
            fgPlaneEnabled: true,
            fgPlaneDistFactor: 1.0, // threshold = 1·1·1 = 1; corner ~33 away → gated
            ...fg,
        },
    })
    const vx = tree.root.node[0]!
    const vy = tree.root.node[1]!
    assert.ok(Math.abs(vx - 20) > 1, `far FG corner must NOT pull x, got ${vx}`)
    assert.ok(vx >= 0 && vx <= 1, `x stays in cell, got ${vx}`)
    assert.ok(vy >= 0 && vy <= 1, `y stays in cell, got ${vy}`)
})

test("featureGraphPlane: FG crease edge pulls cube dual vertex toward the crease", async () => {
    // A short crease segment near (0.3,0.3,*) with the two face normals (1,0,0)
    // and (0,1,0) — its closest point to the cell centre pins V_x = V_y = 0.3.
    const fg = fgWithCrease([0.3, 0.3, 0.4], [0.3, 0.3, 0.6], [[1, 0, 0], [0, 1, 0]])
    const tree = await IsoOctree.build({
        sample: mockPlaneHalfZ,
        bounds: UNIT_BOUNDS,
        constants: DEPTH0_CONSTS,
        featureRefine: {
            mode: "off",
            proximityFactor: 2.0,
            fgPlaneEnabled: true,
            fgPlaneDistFactor: 2.0,
            ...fg,
        },
    })
    const vx = tree.root.node[0]!
    const vy = tree.root.node[1]!
    assert.ok(Math.abs(vx - 0.3) < 0.05, `x should pull toward crease 0.3, got ${vx}`)
    assert.ok(Math.abs(vy - 0.3) < 0.05, `y should pull toward crease 0.3, got ${vy}`)
})

// ────────────────────────────────────────────────────────────────────────────
// FeatureGraph-plane QEF injection: edge & face dual vertices (Phase IS-4)
//
// Same projection mechanism as the GPU mid-feature edge/face tests above. An FG
// corner at (0.3,0.3,0.5) with normals (1,0,0) and (0,1,0) projects:
//   – onto x-axis edges → x = 0.3 (via n1); y-axis edges → y = 0.3 (via n2)
//   – z-axis edges: both normals have n[zi]=0 → skipped
//   – onto faces toward whichever of (x=0.3, y=0.3) lies within their axes
// ────────────────────────────────────────────────────────────────────────────

test("featureGraphPlane (edge): x/y-axis edges pull toward FG corner, z-axis edges do not", async () => {
    const fg = fgWithCorner([0.3, 0.3, 0.5], [[1, 0, 0], [0, 1, 0]])
    const tree = await IsoOctree.build({
        sample: mockPlaneHalfZ,
        bounds: UNIT_BOUNDS,
        constants: DEPTH0_CONSTS,
        featureRefine: {
            mode: "off", proximityFactor: 2.0,
            fgPlaneEnabled: true, fgPlaneDistFactor: 2.0, fgEdgeFacePlanes: true, ...fg,
        },
    })
    for (let e = 0; e < 12; e++) {
        const orient = cubeEdge2Orient[e]!
        const ex = tree.root.edges[e * 4]!
        const ey = tree.root.edges[e * 4 + 1]!
        if (orient === 0) {
            assert.ok(Math.abs(ex - 0.3) < 0.05, `x-axis edge ${e}: x near 0.3, got ${ex}`)
        } else if (orient === 1) {
            assert.ok(Math.abs(ey - 0.3) < 0.05, `y-axis edge ${e}: y near 0.3, got ${ey}`)
        } else {
            assert.ok(Math.abs(ex - 0.3) > 0.1, `z-axis edge ${e}: x NOT pulled, got ${ex}`)
            assert.ok(Math.abs(ey - 0.3) > 0.1, `z-axis edge ${e}: y NOT pulled, got ${ey}`)
        }
    }
})

test("featureGraphPlane (edge): disabled — no edges pull toward the FG corner", async () => {
    const fg = fgWithCorner([0.3, 0.3, 0.5], [[1, 0, 0], [0, 1, 0]])
    const tree = await IsoOctree.build({
        sample: mockPlaneHalfZ,
        bounds: UNIT_BOUNDS,
        constants: DEPTH0_CONSTS,
        featureRefine: { mode: "off", proximityFactor: 2.0, fgPlaneEnabled: false, ...fg },
    })
    for (let e = 0; e < 12; e++) {
        const orient = cubeEdge2Orient[e]!
        const ex = tree.root.edges[e * 4]!
        const ey = tree.root.edges[e * 4 + 1]!
        if (orient === 0) assert.ok(Math.abs(ex - 0.3) > 0.1, `disabled: x-edge ${e} not pulled, got ${ex}`)
        if (orient === 1) assert.ok(Math.abs(ey - 0.3) > 0.1, `disabled: y-edge ${e} not pulled, got ${ey}`)
    }
})

test("featureGraphPlane (face): in-face axes pull toward FG corner; out-of-face axis untouched", async () => {
    const fg = fgWithCorner([0.3, 0.3, 0.5], [[1, 0, 0], [0, 1, 0]])
    const tree = await IsoOctree.build({
        sample: mockPlaneHalfZ,
        bounds: UNIT_BOUNDS,
        constants: DEPTH0_CONSTS,
        featureRefine: {
            mode: "off", proximityFactor: 2.0,
            fgPlaneEnabled: true, fgPlaneDistFactor: 2.0, fgEdgeFacePlanes: true, ...fg,
        },
    })
    for (let f = 0; f < 6; f++) {
        const orient = cubeFace2Orient[f]!
        const fx = tree.root.faces[f * 4]!
        const fy = tree.root.faces[f * 4 + 1]!
        if (orient === 2) {
            assert.ok(Math.abs(fx - 0.3) < 0.05, `z-face ${f}: x near 0.3, got ${fx}`)
            assert.ok(Math.abs(fy - 0.3) < 0.05, `z-face ${f}: y near 0.3, got ${fy}`)
        } else if (orient === 1) {
            assert.ok(Math.abs(fx - 0.3) < 0.05, `y-face ${f}: x near 0.3, got ${fx}`)
        } else {
            assert.ok(Math.abs(fy - 0.3) < 0.05, `x-face ${f}: y near 0.3, got ${fy}`)
        }
    }
})

test("featureGraphPlane (edge): FG crease pulls edge dual vertices along the crease", async () => {
    // A crease running in z at (x,y)=(0.3,0.3) with the two face normals. Its
    // planes project onto x/y-axis edges toward x=0.3 / y=0.3.
    const fg = fgWithCrease([0.3, 0.3, 0.1], [0.3, 0.3, 0.9], [[1, 0, 0], [0, 1, 0]])
    const tree = await IsoOctree.build({
        sample: mockPlaneHalfZ,
        bounds: UNIT_BOUNDS,
        constants: DEPTH0_CONSTS,
        featureRefine: {
            mode: "off", proximityFactor: 2.0,
            fgPlaneEnabled: true, fgPlaneDistFactor: 2.0, fgEdgeFacePlanes: true, ...fg,
        },
    })
    for (let e = 0; e < 12; e++) {
        const orient = cubeEdge2Orient[e]!
        const ex = tree.root.edges[e * 4]!
        const ey = tree.root.edges[e * 4 + 1]!
        if (orient === 0) assert.ok(Math.abs(ex - 0.3) < 0.05, `x-axis edge ${e}: x near 0.3, got ${ex}`)
        if (orient === 1) assert.ok(Math.abs(ey - 0.3) < 0.05, `y-axis edge ${e}: y near 0.3, got ${ey}`)
    }
})

test("featureGraphPlane (edge): default (fgEdgeFacePlanes off) leaves edge dual vertices unconstrained", async () => {
    // Cube-only is the default — edges must NOT pull toward the FG corner.
    const fg = fgWithCorner([0.3, 0.3, 0.5], [[1, 0, 0], [0, 1, 0]])
    const tree = await IsoOctree.build({
        sample: mockPlaneHalfZ,
        bounds: UNIT_BOUNDS,
        constants: DEPTH0_CONSTS,
        featureRefine: { mode: "off", proximityFactor: 2.0, fgPlaneEnabled: true, fgPlaneDistFactor: 2.0, ...fg },
    })
    // Cube vertex still snaps (cube injection is unconditional)…
    assert.ok(Math.abs(tree.root.node[0]! - 0.3) < 0.05, "cube x still pulls")
    // …but edges stay border-clamped (no edge/face FG injection by default).
    for (let e = 0; e < 12; e++) {
        const orient = cubeEdge2Orient[e]!
        const ex = tree.root.edges[e * 4]!
        const ey = tree.root.edges[e * 4 + 1]!
        if (orient === 0) assert.ok(Math.abs(ex - 0.3) > 0.1, `default: x-edge ${e} not pulled, got ${ex}`)
        if (orient === 1) assert.ok(Math.abs(ey - 0.3) > 0.1, `default: y-edge ${e} not pulled, got ${ey}`)
    }
})

test("featureGraphPlane (edge/face): distance gate suppresses a far FG corner", async () => {
    const fg = fgWithCorner([20, 20, 20], [[1, 0, 0], [0, 1, 0]])
    const tree = await IsoOctree.build({
        sample: mockPlaneHalfZ,
        bounds: UNIT_BOUNDS,
        constants: DEPTH0_CONSTS,
        featureRefine: { mode: "off", proximityFactor: 2.0, fgPlaneEnabled: true, fgPlaneDistFactor: 1.0, ...fg },
    })
    for (let e = 0; e < 12; e++) {
        for (let k = 0; k < 4; k++) assert.ok(Number.isFinite(tree.root.edges[e * 4 + k]!), `edge ${e}[${k}] finite`)
    }
    for (let f = 0; f < 6; f++) {
        const fx = tree.root.faces[f * 4]!
        const fy = tree.root.faces[f * 4 + 1]!
        assert.ok(fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1, `face ${f} dual vertex stays in cell`)
    }
})

// ────────────────────────────────────────────────────────────────────────────
// FeatureGraph-plane QEF injection: worker-pool path (Phase IS-5)
//
// `mockQefPool` runs `computeNodeQefResults` synchronously, decoding the FG
// sidecar exactly as the real QEF worker does. With workerCount 1 every
// frontier (N ≥ 1) takes the worker-pool path, so building with this pool
// exercises packFgPlaneSources → sidecar → unpackFgPlaneSourcesForCell →
// computeNodeQefResults FG injection.
// ────────────────────────────────────────────────────────────────────────────

const QEF_OUT_STRIDE_TEST = 134

/** Synchronous stand-in for `QefWorkerPool` — mirrors the real worker's decode. */
const mockQefPool: QefWorkerPoolLike = {
    workerCount: 1,
    processBatch(inputs) {
        const VERTS_STRIDE = 32
        const P1 = inputs.scratchProto.totalPhase1 * 4
        const verts = new Float32Array(inputs.sharedVerts)
        const normPts = new Float32Array(inputs.sharedNormPts)
        const sdf = new Float32Array(inputs.sharedSdf)
        const out = new Float32Array(inputs.sharedOut)
        const fgData = inputs.sharedFgData ? new Float32Array(inputs.sharedFgData) : undefined
        const fgOffsets = inputs.sharedFgOffsets ? new Uint32Array(inputs.sharedFgOffsets) : undefined
        for (let i = 0; i < inputs.nodeCount; i++) {
            const scratch = {
                normPts: normPts.subarray(i * P1, (i + 1) * P1),
                edgeOffs: inputs.scratchProto.edgeOffs,
                faceOffs: inputs.scratchProto.faceOffs,
                totalPhase1: inputs.scratchProto.totalPhase1,
                nodeCount: inputs.scratchProto.nodeCount,
                edgeSamples: inputs.scratchProto.edgeSamples,
                faceSamples: inputs.scratchProto.faceSamples,
            }
            const fgSources = fgData && fgOffsets
                ? unpackFgPlaneSourcesForCell(fgData, fgOffsets, i, inputs.fgStrideFloats ?? 0)
                : undefined
            const r = computeNodeQefResults(
                verts.subarray(i * VERTS_STRIDE, (i + 1) * VERTS_STRIDE),
                scratch,
                sdf.subarray(i * P1, (i + 1) * P1),
                inputs.oversampleQef,
                inputs.dualVertexBorderFraction,
                inputs.invWorldScale,
                undefined,
                fgSources,
            )
            const o = i * QEF_OUT_STRIDE_TEST
            out[o] = r.nodePos[0]!
            out[o + 1] = r.nodePos[1]!
            out[o + 2] = r.nodePos[2]!
            out[o + 3] = r.nodePos[3]!
            out.set(r.edges, o + 4)
            out.set(r.faces, o + 52)
            out.set(r.reEvalNorm, o + 76)
            out[o + 133] = r.qefError
        }
        return Promise.resolve()
    },
}

test("featureGraphPlane: worker-pool path pulls cube dual vertex toward FG corner", async () => {
    const fg = fgWithCorner([0.3, 0.3, 0.5], [[1, 0, 0], [0, 1, 0]])
    const refine = { mode: "off" as const, proximityFactor: 2.0, fgPlaneEnabled: true, fgPlaneDistFactor: 2.0, ...fg }
    const tree = await IsoOctree.build({
        sample: mockPlaneHalfZ,
        bounds: UNIT_BOUNDS,
        constants: DEPTH0_CONSTS,
        featureRefine: refine,
        qefWorkerPool: mockQefPool,
    })
    const vx = tree.root.node[0]!
    const vy = tree.root.node[1]!
    assert.ok(Math.abs(vx - 0.3) < 0.05, `worker path: x pulls toward 0.3, got ${vx}`)
    assert.ok(Math.abs(vy - 0.3) < 0.05, `worker path: y pulls toward 0.3, got ${vy}`)
})

test("featureGraphPlane: worker-pool path matches the inline path", async () => {
    const fg = fgWithCorner([0.35, 0.6, 0.5], [[1, 0, 0], [0, 1, 0]])
    const refine = { mode: "off" as const, proximityFactor: 2.0, fgPlaneEnabled: true, fgPlaneDistFactor: 2.0, ...fg }
    const inline = await IsoOctree.build({
        sample: mockPlaneHalfZ, bounds: UNIT_BOUNDS, constants: DEPTH0_CONSTS, featureRefine: refine,
    })
    const worker = await IsoOctree.build({
        sample: mockPlaneHalfZ, bounds: UNIT_BOUNDS, constants: DEPTH0_CONSTS, featureRefine: refine,
        qefWorkerPool: mockQefPool,
    })
    // Identical up to the FG sidecar's Float32 packing of plane-source points.
    for (let k = 0; k < 3; k++) {
        assert.ok(
            Math.abs(worker.root.node[k]! - inline.root.node[k]!) < 1e-3,
            `node[${k}]: worker ${worker.root.node[k]} ≈ inline ${inline.root.node[k]}`,
        )
    }
})

test("featureGraphPlane: worker-pool path with FG disabled leaves the dual vertex unconstrained", async () => {
    const fg = fgWithCorner([0.3, 0.3, 0.5], [[1, 0, 0], [0, 1, 0]])
    const tree = await IsoOctree.build({
        sample: mockPlaneHalfZ,
        bounds: UNIT_BOUNDS,
        constants: DEPTH0_CONSTS,
        featureRefine: { mode: "off", proximityFactor: 2.0, fgPlaneEnabled: false, ...fg },
        qefWorkerPool: mockQefPool,
    })
    const vx = tree.root.node[0]!
    const vy = tree.root.node[1]!
    assert.ok(Math.abs(vx - 0.3) > 0.1, `disabled: x not pulled, got ${vx}`)
    assert.ok(Math.abs(vy - 0.3) > 0.1, `disabled: y not pulled, got ${vy}`)
})
