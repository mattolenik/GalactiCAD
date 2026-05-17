/**
 * Dual vertex positions from Hermite QEF data — ports `TNode::vertNode`, `vertFace`, `vertEdge`
 * (`iso_method_ours.h`): unconstrained minimizer with border shrink, then face / edge / corner
 * constrained solves via augmented symmetric systems + pseudoinverse (`matInverse`).
 *
 * **Input ordering:** Hermite planes must match reference sampling loops (`x` outer, `y`, `z`
 * inner with `<= oversampleQef`) when packing `qefPacked`; see `IsoSimplicialConstants.oversampleQef`.
 */

import { IsoSimplicialConstants } from "./constants.mjs"
import { symMatPseudoinverse, symMatVec, symMatZeros, type SymMat } from "./qef-matrix.mjs"
import { unpackNormalEquations } from "./qef-normal.mjs"

function solveSymmetricQef(a: SymMat, n: number, b: Float64Array): Float64Array {
    const inv = symMatPseudoinverse(a, n)
    return symMatVec(inv, n, b)
}

export interface DualVertexQefResult {
    /** `[x,y,z,w]` — `w` is the scalar field slot (reference `vect4f`). */
    position: Float64Array
    /** Sum of squared plane residuals at the chosen minimizer (`calcError`). */
    qefError: number
}

export interface ComputeDualVertexCubeInput {
    cellMin: readonly [number, number, number]
    cellMax: readonly [number, number, number]
    /** Packed `QEFNormal<4>` — length 15 */
    qefPacked: Float64Array
    planeNorms4: ReadonlyArray<readonly [number, number, number, number]>
    planePts4: ReadonlyArray<readonly [number, number, number, number]>
    borderFraction?: number
}

export interface ComputeDualVertexFaceInput {
    /** Corners `c0` and `c2` are diagonal on the face (reference `cube_face2vert[][0]` and `[2]`). */
    c0: readonly [number, number, number, number]
    c2: readonly [number, number, number, number]
    xi: 0 | 1 | 2
    yi: 0 | 1 | 2
    zi: 0 | 1 | 2
    /** Packed `QEFNormal<3>` — length 10 */
    qefPacked: Float64Array
    planeNorms3: ReadonlyArray<readonly [number, number, number]>
    planePts3: ReadonlyArray<readonly [number, number, number]>
    /** Reference uses `(verts[7][0]-verts[0][0])`; cubic cells should pass edge length. */
    cellSizeForBorder: number
    borderFraction?: number
}

export interface ComputeDualVertexEdgeInput {
    xi: 0 | 1 | 2
    yi: 0 | 1 | 2
    zi: 0 | 1 | 2
    c0: readonly [number, number, number, number]
    c1: readonly [number, number, number, number]
    /** Packed `QEFNormal<2>` — length 6 */
    qefPacked: Float64Array
    planeNorms2: ReadonlyArray<readonly [number, number]>
    planePts2: ReadonlyArray<readonly [number, number]>
    cellSizeForBorder: number
    borderFraction?: number
}

/** Feature plane `eqn = [nx,ny,nz,0,-(px nx+py ny+pz nz)]` — pure 3D constraint, V_w uncoupled. */
export function encodeFeaturePlane(nx: number, ny: number, nz: number, px: number, py: number, pz: number): Float64Array {
    const eqn = new Float64Array(5)
    eqn[0] = nx
    eqn[1] = ny
    eqn[2] = nz
    eqn[3] = 0
    eqn[4] = -(px * nx + py * ny + pz * nz)
    return eqn
}

/**
 * Face-local feature plane: `(n_xi, n_yi, 0)` + constant — length 4 (`QEFNormal<3>`).
 * Same shape as {@link encodeFaceHermitePlane} but with V_w uncoupled (0 instead of −1)
 * and no scalar offset (feature primitives lie on the modelled surface). Caller is
 * responsible for projecting the 3D feature point into face-local `(pXi, pYi)`.
 */
export function encodeFaceFeaturePlane(nXi: number, nYi: number, pXi: number, pYi: number): Float64Array {
    const eqn = new Float64Array(4)
    eqn[0] = nXi
    eqn[1] = nYi
    eqn[2] = 0
    eqn[3] = -(pXi * nXi + pYi * nYi)
    return eqn
}

/**
 * Edge-local feature plane: `(n_xi, 0)` + constant — length 3 (`QEFNormal<2>`).
 * Same shape as {@link encodeEdgeHermitePlane} but with V_w uncoupled (0 instead of −1)
 * and no scalar offset. Caller projects the 3D feature point onto the edge axis `xi`.
 */
export function encodeEdgeFeaturePlane(nXi: number, pXi: number): Float64Array {
    const eqn = new Float64Array(3)
    eqn[0] = nXi
    eqn[1] = 0
    eqn[2] = -pXi * nXi
    return eqn
}

/** Reference `vertNode` plane encoding: `eqn = [nx,ny,nz,-1, -(px nx+py ny+pz nz)+w]`. */
export function encodeCubeHermitePlane(
    nx: number,
    ny: number,
    nz: number,
    px: number,
    py: number,
    pz: number,
    scalar: number,
): Float64Array {
    const eqn = new Float64Array(5)
    eqn[0] = nx
    eqn[1] = ny
    eqn[2] = nz
    eqn[3] = -1
    eqn[4] = -(px * nx + py * ny + pz * nz) + scalar
    return eqn
}

/** Face-local `(n_xi, n_yi, -1)` plus constant — length 4 (`QEFNormal<3>`). */
export function encodeFaceHermitePlane(nXi: number, nYi: number, pXi: number, pYi: number, scalar: number): Float64Array {
    const eqn = new Float64Array(4)
    eqn[0] = nXi
    eqn[1] = nYi
    eqn[2] = -1
    eqn[3] = -(pXi * nXi + pYi * nYi - scalar)
    return eqn
}

/** Edge-local `(n_xi, -1)` plus constant — length 3 (`QEFNormal<2>`). */
export function encodeEdgeHermitePlane(nXi: number, pXi: number, scalar: number): Float64Array {
    const eqn = new Float64Array(3)
    eqn[0] = nXi
    eqn[1] = -1
    eqn[2] = -(pXi * nXi - scalar)
    return eqn
}

function calcErrorCube(
    p: readonly [number, number, number, number],
    planeNorms4: ComputeDualVertexCubeInput["planeNorms4"],
    planePts4: ComputeDualVertexCubeInput["planePts4"],
): number {
    let err = 0
    const n = planeNorms4.length
    for (let i = 0; i < n; i++) {
        const pn = planeNorms4[i]!
        const pt = planePts4[i]!
        const c =
            pn[0] * p[0] +
            pn[1] * p[1] +
            pn[2] * p[2] +
            pn[3] * p[3] -
            (pn[0] * pt[0] + pn[1] * pt[1] + pn[2] * pt[2] + pn[3] * pt[3])
        err += c * c
    }
    return err
}

function calcErrorFace(
    p: readonly [number, number, number],
    planeNorms3: ComputeDualVertexFaceInput["planeNorms3"],
    planePts3: ComputeDualVertexFaceInput["planePts3"],
): number {
    let err = 0
    const n = planeNorms3.length
    for (let i = 0; i < n; i++) {
        const pn = planeNorms3[i]!
        const pt = planePts3[i]!
        const c = pn[0] * p[0] + pn[1] * p[1] + pn[2] * p[2] - (pn[0] * pt[0] + pn[1] * pt[1] + pn[2] * pt[2])
        err += c * c
    }
    return err
}

function calcErrorEdge(
    p: readonly [number, number],
    planeNorms2: ComputeDualVertexEdgeInput["planeNorms2"],
    planePts2: ComputeDualVertexEdgeInput["planePts2"],
): number {
    let err = 0
    const n = planeNorms2.length
    for (let i = 0; i < n; i++) {
        const pn = planeNorms2[i]!
        const pt = planePts2[i]!
        const c = pn[0] * p[0] + pn[1] * p[1] - (pn[0] * pt[0] + pn[1] * pt[1])
        err += c * c
    }
    return err
}

function augmentedSolveSymmetric(ac: SymMat, n: number, bc: Float64Array): Float64Array {
    return solveSymmetricQef(ac, n, bc)
}

/** `TNode::vertNode` minimizer (no implicit scene `function(p)` — caller re-evaluates `w` if needed). */
export function computeDualVertexCube(input: ComputeDualVertexCubeInput): DualVertexQefResult {
    const borderFrac = input.borderFraction ?? IsoSimplicialConstants.dualVertexBorderFraction
    const cellSize = input.cellMax[0] - input.cellMin[0]
    const border = borderFrac * cellSize

    const mine: [number, number, number] = [
        input.cellMin[0] + border,
        input.cellMin[1] + border,
        input.cellMin[2] + border,
    ]
    const maxe: [number, number, number] = [
        input.cellMax[0] - border,
        input.cellMax[1] - border,
        input.cellMax[2] - border,
    ]

    const { a, b } = unpackNormalEquations(input.qefPacked, 4)
    const n = 4

    let isOut = true
    let err = 1e30
    const p = new Float64Array(4)

    for (let cellDim = 3; cellDim >= 0 && isOut; cellDim--) {
        if (cellDim === 3) {
            const rvalue = solveSymmetricQef(a, n, b)
            p[0] = rvalue[0]!
            p[1] = rvalue[1]!
            p[2] = rvalue[2]!
            p[3] = rvalue[3]!
            if (
                p[0] >= mine[0] &&
                p[0] <= maxe[0] &&
                p[1] >= mine[1] &&
                p[1] <= maxe[1] &&
                p[2] >= mine[2] &&
                p[2] <= maxe[2]
            ) {
                isOut = false
                err = calcErrorCube([p[0]!, p[1]!, p[2]!, p[3]!], input.planeNorms4, input.planePts4)
            }
        } else if (cellDim === 2) {
            for (let face = 0; face < 6; face++) {
                const dir = (face / 2) | 0
                const side = face % 2
                const corners: [[number, number, number], [number, number, number]] = [mine, maxe]
                const acDim = n + 1
                const ac = symMatZeros(acDim)
                const bc = new Float64Array(acDim)
                for (let i = 0; i < n; i++) {
                    for (let j = 0; j < n; j++) ac[i * acDim + j] = a[i * n + j]
                    bc[i] = b[i]!
                }
                ac[n * acDim + dir] = 1
                ac[dir * acDim + n] = 1
                bc[n] = corners[side]![dir]!

                const rvalue = augmentedSolveSymmetric(ac, acDim, bc)
                const pc: [number, number, number, number] = [rvalue[0]!, rvalue[1]!, rvalue[2]!, rvalue[3]!]
                const dp = (dir + 1) % 3
                const dpp = (dir + 2) % 3
                if (pc[dp] >= mine[dp] && pc[dp] <= maxe[dp] && pc[dpp] >= mine[dpp] && pc[dpp] <= maxe[dpp]) {
                    isOut = false
                    const e = calcErrorCube(pc, input.planeNorms4, input.planePts4)
                    if (e < err) {
                        err = e
                        p.set(pc)
                    }
                }
            }
        } else if (cellDim === 1) {
            for (let edge = 0; edge < 12; edge++) {
                const dir = (edge / 4) | 0
                const side = edge % 4
                const corners: [[number, number, number], [number, number, number]] = [mine, maxe]
                const acDim = n + 2
                const ac = symMatZeros(acDim)
                const bc = new Float64Array(acDim)
                for (let i = 0; i < n; i++) {
                    for (let j = 0; j < n; j++) ac[i * acDim + j] = a[i * n + j]
                    bc[i] = b[i]!
                }
                const dp = (dir + 1) % 3
                const dpp = (dir + 2) % 3
                ac[n * acDim + dp] = 1
                ac[dp * acDim + n] = 1
                ac[(n + 1) * acDim + dpp] = 1
                ac[dpp * acDim + (n + 1)] = 1
                bc[n] = corners[side & 1]![dp]!
                bc[n + 1] = corners[side >> 1]![dpp]!

                const rvalue = augmentedSolveSymmetric(ac, acDim, bc)
                const pc: [number, number, number, number] = [rvalue[0]!, rvalue[1]!, rvalue[2]!, rvalue[3]!]
                if (pc[dir] >= mine[dir] && pc[dir] <= maxe[dir]) {
                    isOut = false
                    const e = calcErrorCube(pc, input.planeNorms4, input.planePts4)
                    if (e < err) {
                        err = e
                        p.set(pc)
                    }
                }
            }
        } else {
            for (let vertex = 0; vertex < 8; vertex++) {
                const corners: [[number, number, number], [number, number, number]] = [mine, maxe]
                const acDim = n + 3
                const ac = symMatZeros(acDim)
                const bc = new Float64Array(acDim)
                for (let i = 0; i < n; i++) {
                    for (let j = 0; j < n; j++) ac[i * acDim + j] = a[i * n + j]
                    bc[i] = b[i]!
                }
                for (let i = 0; i < 3; i++) {
                    ac[(n + i) * acDim + i] = 1
                    ac[i * acDim + (n + i)] = 1
                    bc[n + i] = corners[(vertex >> i) & 1]![i]!
                }
                const rvalue = augmentedSolveSymmetric(ac, acDim, bc)
                const pc: [number, number, number, number] = [rvalue[0]!, rvalue[1]!, rvalue[2]!, rvalue[3]!]
                const e = calcErrorCube(pc, input.planeNorms4, input.planePts4)
                if (e < err) {
                    err = e
                    p.set(pc)
                }
            }
        }
    }

    return { position: p, qefError: err }
}

/** `TNode::vertFace` — fills world `position` using face-local `(xi,yi)` plus fixed `zi`. */
export function computeDualVertexFace(input: ComputeDualVertexFaceInput): DualVertexQefResult {
    const borderFrac = input.borderFraction ?? IsoSimplicialConstants.dualVertexBorderFraction
    const border = borderFrac * input.cellSizeForBorder
    const { xi, yi, zi } = input

    const mine: [number, number] = [input.c0[xi] + border, input.c0[yi] + border]
    const maxe: [number, number] = [input.c2[xi] - border, input.c2[yi] - border]

    const { a, b } = unpackNormalEquations(input.qefPacked, 3)
    const n = 3

    let isOut = true
    let err = 1e30
    const p3 = new Float64Array(3)

    for (let cellDim = 2; cellDim >= 0 && isOut; cellDim--) {
        if (cellDim === 2) {
            const rvalue = solveSymmetricQef(a, n, b)
            p3[0] = rvalue[0]!
            p3[1] = rvalue[1]!
            p3[2] = rvalue[2]!
            if (p3[0] >= mine[0] && p3[0] <= maxe[0] && p3[1] >= mine[1] && p3[1] <= maxe[1]) {
                isOut = false
                err = calcErrorFace([p3[0]!, p3[1]!, p3[2]!], input.planeNorms3, input.planePts3)
            }
        } else if (cellDim === 1) {
            for (let edge = 0; edge < 4; edge++) {
                const dir = (edge / 2) | 0
                const side = edge % 2
                const corners: [[number, number], [number, number]] = [mine, maxe]
                const acDim = n + 1
                const ac = symMatZeros(acDim)
                const bc = new Float64Array(acDim)
                for (let i = 0; i < n; i++) {
                    for (let j = 0; j < n; j++) ac[i * acDim + j] = a[i * n + j]
                    bc[i] = b[i]!
                }
                ac[n * acDim + dir] = 1
                ac[dir * acDim + n] = 1
                bc[n] = corners[side]![dir]!

                const rvalue = augmentedSolveSymmetric(ac, acDim, bc)
                const pc: [number, number, number] = [rvalue[0]!, rvalue[1]!, rvalue[2]!]
                const dp = (dir + 1) % 2
                if (pc[dp] >= mine[dp] && pc[dp] <= maxe[dp]) {
                    isOut = false
                    const e = calcErrorFace(pc, input.planeNorms3, input.planePts3)
                    if (e < err) {
                        err = e
                        p3.set(pc)
                    }
                }
            }
        } else {
            for (let vertex = 0; vertex < 4; vertex++) {
                const corners: [[number, number], [number, number]] = [mine, maxe]
                const acDim = n + 2
                const ac = symMatZeros(acDim)
                const bc = new Float64Array(acDim)
                for (let i = 0; i < n; i++) {
                    for (let j = 0; j < n; j++) ac[i * acDim + j] = a[i * n + j]
                    bc[i] = b[i]!
                }
                for (let i = 0; i < 2; i++) {
                    ac[(n + i) * acDim + i] = 1
                    ac[i * acDim + (n + i)] = 1
                    bc[n + i] = corners[(vertex >> i) & 1]![i]!
                }
                const rvalue = augmentedSolveSymmetric(ac, acDim, bc)
                const pc: [number, number, number] = [rvalue[0]!, rvalue[1]!, rvalue[2]!]
                const e = calcErrorFace(pc, input.planeNorms3, input.planePts3)
                if (e < err) {
                    err = e
                    p3.set(pc)
                }
            }
        }
    }

    const pos = new Float64Array(4)
    pos[xi] = p3[0]!
    pos[yi] = p3[1]!
    pos[zi] = input.c0[zi]
    pos[3] = p3[2]!
    return { position: pos, qefError: err }
}

/** `TNode::vertEdge` — fills world `position` using edge-local `(xi, scalar)`. */
export function computeDualVertexEdge(input: ComputeDualVertexEdgeInput): DualVertexQefResult {
    const borderFrac = input.borderFraction ?? IsoSimplicialConstants.dualVertexBorderFraction
    const border = borderFrac * input.cellSizeForBorder
    const { xi, yi, zi } = input

    const vmin = input.c0[xi] + border
    const vmax = input.c1[xi] - border

    const { a, b } = unpackNormalEquations(input.qefPacked, 2)
    const n = 2

    let isOut = true
    let err = 1e30
    const p2 = new Float64Array(2)

    for (let cellDim = 1; cellDim >= 0 && isOut; cellDim--) {
        if (cellDim === 1) {
            const rvalue = solveSymmetricQef(a, n, b)
            p2[0] = rvalue[0]!
            p2[1] = rvalue[1]!
            if (p2[0] >= vmin && p2[0] <= vmax) {
                isOut = false
                err = calcErrorEdge([p2[0]!, p2[1]!], input.planeNorms2, input.planePts2)
            }
        } else {
            for (let vertex = 0; vertex < 2; vertex++) {
                const corners = [vmin, vmax]
                const acDim = n + 1
                const ac = symMatZeros(acDim)
                const bc = new Float64Array(acDim)
                for (let i = 0; i < n; i++) {
                    for (let j = 0; j < n; j++) ac[i * acDim + j] = a[i * n + j]
                    bc[i] = b[i]!
                }
                ac[n * acDim + 0] = 1
                ac[0 * acDim + n] = 1
                bc[n] = corners[vertex >> 0]!

                const rvalue = augmentedSolveSymmetric(ac, acDim, bc)
                const pc: [number, number] = [rvalue[0]!, rvalue[1]!]
                const e = calcErrorEdge(pc, input.planeNorms2, input.planePts2)
                if (e < err) {
                    err = e
                    p2.set(pc)
                }
            }
        }
    }

    const pos = new Float64Array(4)
    pos[xi] = p2[0]!
    pos[yi] = input.c0[yi]
    pos[zi] = input.c0[zi]
    pos[3] = p2[1]!
    return { position: pos, qefError: err }
}
