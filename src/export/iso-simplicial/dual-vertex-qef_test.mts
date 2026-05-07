import assert from "node:assert/strict"
import test from "node:test"
import {
    computeDualVertexCube,
    computeDualVertexEdge,
    computeDualVertexFace,
    encodeCubeHermitePlane,
    encodeEdgeHermitePlane,
    encodeFaceHermitePlane,
} from "./dual-vertex-qef.mjs"
import { qefAccumulatePlane, zeroQefPacked } from "./qef-normal.mjs"

const tol = 1e-6

test("cube QEF: four planes pin a unique interior minimizer", () => {
    const cellMin: [number, number, number] = [0, 0, 0]
    const cellMax: [number, number, number] = [1, 1, 1]
    const cx = 0.25
    const cy = 0.25
    const cz = 0.25
    const w = 0.25

    const packed = zeroQefPacked(4)
    qefAccumulatePlane(encodeCubeHermitePlane(1, 0, 0, cx, cy, cz, w), packed)
    qefAccumulatePlane(encodeCubeHermitePlane(0, 1, 0, cx, cy, cz, w), packed)
    qefAccumulatePlane(encodeCubeHermitePlane(0, 0, 1, cx, cy, cz, w), packed)
    /** Fourth independent linear constraint: `x+y+z+w = 1` at the dual point. */
    qefAccumulatePlane(encodeCubeHermitePlane(1, 1, 1, cx, cy, cz, w), packed)

    const planeNorms4: [number, number, number, number][] = [
        [1, 0, 0, -1],
        [0, 1, 0, -1],
        [0, 0, 1, -1],
        [1, 1, 1, -1],
    ]
    const planePts4: [number, number, number, number][] = [
        [cx, cy, cz, w],
        [cx, cy, cz, w],
        [cx, cy, cz, w],
        [cx, cy, cz, w],
    ]

    const { position, qefError } = computeDualVertexCube({
        cellMin,
        cellMax,
        qefPacked: packed,
        planeNorms4,
        planePts4,
        borderFraction: 0,
    })

    assert.ok(Math.abs(position[0] - cx) < tol)
    assert.ok(Math.abs(position[1] - cy) < tol)
    assert.ok(Math.abs(position[2] - cz) < tol)
    assert.ok(Math.abs(position[3] - w) < tol)
    assert.ok(qefError < 1e-20)
})

test("face QEF: three independent face-local planes pin (xi, yi, scalar)", () => {
    /** Face z = 0 on unit cube: xi=x, yi=y, zi=z */
    const c0: [number, number, number, number] = [0, 0, 0, 0]
    const c2: [number, number, number, number] = [1, 1, 0, 0]
    const packed = zeroQefPacked(3)
    const px = 0.4
    const py = 0.6
    const w = 0.2
    qefAccumulatePlane(encodeFaceHermitePlane(1, 0, px, py, w), packed)
    qefAccumulatePlane(encodeFaceHermitePlane(0, 1, px, py, w), packed)
    /** Independent tilt vs `(1,0)` and `(0,1)` samples at the same corner data. */
    qefAccumulatePlane(encodeFaceHermitePlane(1, 1, px, py, w), packed)

    const planeNorms3: [number, number, number][] = [
        [1, 0, -1],
        [0, 1, -1],
        [1, 1, -1],
    ]
    const planePts3: [number, number, number][] = [
        [px, py, w],
        [px, py, w],
        [px, py, w],
    ]

    const { position, qefError } = computeDualVertexFace({
        c0,
        c2,
        xi: 0,
        yi: 1,
        zi: 2,
        qefPacked: packed,
        planeNorms3,
        planePts3,
        cellSizeForBorder: 1,
        borderFraction: 0,
    })

    assert.ok(Math.abs(position[0] - px) < tol)
    assert.ok(Math.abs(position[1] - py) < tol)
    assert.ok(Math.abs(position[2] - 0) < tol)
    assert.ok(Math.abs(position[3] - w) < tol)
    assert.ok(qefError < 1e-20)
})

test("edge QEF: two planes with distinct slopes pin (xi, scalar)", () => {
    /** Edge parallel to x from (0,0,0) to (1,0,0); solution `(0.35, -0.1)`. */
    const c0: [number, number, number, number] = [0, 0, 0, 0]
    const c1: [number, number, number, number] = [1, 0, 0, 0]
    const packed = zeroQefPacked(2)
    /** Line `xi - w = 0.45` through `(0.35,-0.1)`. */
    qefAccumulatePlane(encodeEdgeHermitePlane(1, 0.2, -0.25), packed)
    /** Line `2*xi - w = 0.8` through `(0.35,-0.1)`. */
    qefAccumulatePlane(encodeEdgeHermitePlane(2, 0.5, 0.2), packed)

    const planeNorms2: [number, number][] = [
        [1, -1],
        [2, -1],
    ]
    const planePts2: [number, number][] = [
        [0.2, -0.25],
        [0.5, 0.2],
    ]

    const px = 0.35
    const w = -0.1

    const { position, qefError } = computeDualVertexEdge({
        xi: 0,
        yi: 1,
        zi: 2,
        c0,
        c1,
        qefPacked: packed,
        planeNorms2,
        planePts2,
        cellSizeForBorder: 1,
        borderFraction: 0,
    })

    assert.ok(Math.abs(position[0] - px) < tol)
    assert.ok(Math.abs(position[1] - 0) < tol)
    assert.ok(Math.abs(position[2] - 0) < tol)
    assert.ok(Math.abs(position[3] - w) < tol)
    assert.ok(qefError < 1e-20)
})

test("cube QEF: unconstrained minimizer outside cell → snaps to face / edge / corner branch", () => {
    /** Parallel planes all with normal +x push unconstrained x negative; with cell [0,1]^3 expect boundary solution. */
    const packed = zeroQefPacked(4)
    for (let i = 0; i < 4; i++) {
        const x = 0.2 + i * 0.2
        qefAccumulatePlane(encodeCubeHermitePlane(1, 0, 0, x, 0.5, 0.5, x), packed)
    }
    const planeNorms4: [number, number, number, number][] = []
    const planePts4: [number, number, number, number][] = []
    for (let i = 0; i < 4; i++) {
        const x = 0.2 + i * 0.2
        planeNorms4.push([1, 0, 0, -1])
        planePts4.push([x, 0.5, 0.5, x])
    }

    const { position } = computeDualVertexCube({
        cellMin: [0, 0, 0],
        cellMax: [1, 1, 1],
        qefPacked: packed,
        planeNorms4,
        planePts4,
        borderFraction: 0,
    })

    assert.ok(position[0] >= 0 - tol && position[0] <= 1 + tol)
    assert.ok(position[1] >= 0 - tol && position[1] <= 1 + tol)
    assert.ok(position[2] >= 0 - tol && position[2] <= 1 + tol)
    assert.ok(Number.isFinite(position[3]))
})
