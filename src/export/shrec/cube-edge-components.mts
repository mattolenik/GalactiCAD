/**
 * Cube-edge topology for dual contouring: 12 edges + marching-squares glue,
 * matching `edgeDetection_Pass3` in `mdc.wgsl` (same corner / edge indices).
 */

/** Corner indices: 0:(0,0,0) 1:(1,0,0) 2:(0,1,0) 3:(1,1,0) 4:(0,0,1) 5:(1,0,1) 6:(0,1,1) 7:(1,1,1) */
const FACE_CORNERS: ReadonlyArray<readonly [number, number, number, number]> = [
    [0, 1, 3, 2],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 3, 7, 6],
    [0, 2, 6, 4],
    [1, 3, 7, 5],
]

/** Face edges in cyclic order (matches `FACE_CORNERS`). */
const FACE_EDGES: ReadonlyArray<readonly [number, number, number, number]> = [
    [0, 5, 1, 4],
    [2, 7, 3, 6],
    [0, 9, 2, 8],
    [1, 11, 3, 10],
    [4, 10, 6, 8],
    [5, 11, 7, 9],
]

/** MDC `edges_info`: endpoints (c1,c2, axis, parity). Edge index 0..11. */
const EDGES_INFO: ReadonlyArray<readonly [number, number]> = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
]

function ufFind(parent: Uint32Array, x: number): number {
    let r = x
    while (parent[r] !== r) r = parent[r]!
    let y = x
    while (parent[y] !== y) {
        const p = parent[y]!
        parent[y] = r
        y = p
    }
    return r
}

function ufUnion(parent: Uint32Array, a: number, b: number): void {
    const ra = ufFind(parent, a)
    const rb = ufFind(parent, b)
    if (ra !== rb) parent[rb] = ra
}

function edgeCrosses(isoValue: number, v0: number, v1: number): boolean {
    const inside0 = v0 <= isoValue
    const inside1 = v1 <= isoValue
    return inside0 !== inside1
}

export interface CubeEdgeComponentResult {
    edgeCrossMask: Uint8Array
    edgeComp: Int32Array
    compCount: number
}

/**
 * Classify connected iso-crossing components on the 12 cube edges.
 * `cornerScalar[8]` order matches MDC corner indices for one cell.
 */
export function classifyCubeEdgeComponents(cornerScalar: readonly number[], isoValue = 0): CubeEdgeComponentResult {
    const edgeCrossMask = new Uint8Array(12)
    const parent = new Uint32Array(12)
    for (let e = 0; e < 12; e++) {
        parent[e] = e
        const [c1, c2] = EDGES_INFO[e]!
        const val0 = cornerScalar[c1]!
        const val1 = cornerScalar[c2]!
        edgeCrossMask[e] = edgeCrosses(isoValue, val0, val1) ? 1 : 0
    }

    for (let f = 0; f < 6; f++) {
        const fc = FACE_CORNERS[f]!
        const fe = FACE_EDGES[f]!
        const e0 = fe[0]!, e1 = fe[1]!, e2 = fe[2]!, e3 = fe[3]!
        const m0 = edgeCrossMask[e0]
        const m1 = edgeCrossMask[e1]
        const m2 = edgeCrossMask[e2]
        const m3 = edgeCrossMask[e3]
        const cnt = m0 + m1 + m2 + m3

        if (cnt === 2) {
            let a = -1, b = -1
            if (m0) { if (a < 0) a = e0; else b = e0 }
            if (m1) { if (a < 0) a = e1; else b = e1 }
            if (m2) { if (a < 0) a = e2; else b = e2 }
            if (m3) { if (a < 0) a = e3; else b = e3 }
            if (a >= 0 && b >= 0) ufUnion(parent, a, b)
        } else if (cnt === 4) {
            const s0 = cornerScalar[fc[0]!]! <= isoValue ? 1 : 0
            const s1 = cornerScalar[fc[1]!]! <= isoValue ? 1 : 0
            const s2 = cornerScalar[fc[2]!]! <= isoValue ? 1 : 0
            const s3 = cornerScalar[fc[3]!]! <= isoValue ? 1 : 0
            const faceCase = s0 | (s1 << 1) | (s2 << 2) | (s3 << 3)
            const c0 = (cornerScalar[fc[0]!]! + cornerScalar[fc[1]!]! + cornerScalar[fc[2]!]! + cornerScalar[fc[3]!]!) * 0.25
            const centerInside = c0 < isoValue
            if (faceCase === 5) {
                if (centerInside) {
                    ufUnion(parent, e0, e1)
                    ufUnion(parent, e2, e3)
                } else {
                    ufUnion(parent, e0, e3)
                    ufUnion(parent, e1, e2)
                }
            } else if (faceCase === 10) {
                if (centerInside) {
                    ufUnion(parent, e0, e3)
                    ufUnion(parent, e1, e2)
                } else {
                    ufUnion(parent, e0, e1)
                    ufUnion(parent, e2, e3)
                }
            } else {
                ufUnion(parent, e0, e1)
                ufUnion(parent, e2, e3)
            }
        }
    }

    const compRoots = new Uint32Array(12)
    let compCount = 0
    const edgeComp = new Int32Array(12)
    edgeComp.fill(-1)

    for (let e = 0; e < 12; e++) {
        if (!edgeCrossMask[e]) continue
        const root = ufFind(parent, e)
        let idx = -1
        for (let j = 0; j < compCount; j++) {
            if (compRoots[j] === root) {
                idx = j
                break
            }
        }
        if (idx < 0) {
            if (compCount < 4) {
                compRoots[compCount] = root
                idx = compCount
                compCount++
            } else {
                idx = 3
            }
        }
        edgeComp[e] = idx
    }

    return { edgeCrossMask, edgeComp, compCount }
}
