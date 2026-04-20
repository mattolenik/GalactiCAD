import { log as dbgLog, type LogModule } from "../logging/debug-log.mjs"

/** Optional meshoptimizer simplify knobs (subset of `MDCParams`). */
export interface MeshSimplifyParams {
    simplifyTargetRatio?: number
    simplifyTargetError?: number
    simplifyLockBorder?: boolean
    simplifySparse?: boolean
    simplifyErrorAbsolute?: boolean
    simplifyPrune?: boolean
    simplifyRegularize?: boolean
    simplifyNormalWeight?: number
}

/**
 * Re-orient triangles to consistent winding: adjacent triangles oppose on shared edges,
 * then flip whole components for positive signed volume (outward convention).
 * Mutates `tris` in place; reads vertex positions from `verts`.
 */
export function reorientMeshTriangleWinding(
    verts: Float32Array<ArrayBuffer>,
    tris: Uint32Array<ArrayBuffer>,
    vertexStrideBytes: number,
): void {
    const stride = vertexStrideBytes / 4 // floats per vertex
    const triCount = Math.floor(tris.length / 3)
    if (triCount <= 0) return

    type EdgeEntry = { t0: number; d0: number; t1: number; d1: number; count: number }
    const edgeMap = new Map<bigint, EdgeEntry>()

    const edgeKey = (a: number, b: number) => {
        const lo = a < b ? a : b
        const hi = a < b ? b : a
        return (BigInt(lo) << 32n) | BigInt(hi >>> 0)
    }
    const edgeDir = (a: number, b: number) => {
        return a < b ? 0 : 1
    }

    for (let t = 0; t < triCount; t++) {
        const i0 = tris[t * 3]!
        const i1 = tris[t * 3 + 1]!
        const i2 = tris[t * 3 + 2]!
        const edges: [number, number][] = [
            [i0, i1],
            [i1, i2],
            [i2, i0],
        ]
        for (const [a, b] of edges) {
            if (a === b) continue
            const k = edgeKey(a, b)
            const d = edgeDir(a, b)
            const e = edgeMap.get(k)
            if (!e) {
                edgeMap.set(k, { t0: t, d0: d, t1: -1, d1: 0, count: 1 })
            } else {
                e.count++
                if (e.t1 === -1) {
                    e.t1 = t
                    e.d1 = d
                }
            }
        }
    }

    const visited = new Uint8Array(triCount)
    const flip = new Uint8Array(triCount)
    const comps: number[][] = []

    for (let seed = 0; seed < triCount; seed++) {
        if (visited[seed]) continue
        visited[seed] = 1
        flip[seed] = 0
        const stack = [seed]
        const comp: number[] = []

        while (stack.length) {
            const t = stack.pop()!
            comp.push(t)

            const i0 = tris[t * 3]!
            const i1 = tris[t * 3 + 1]!
            const i2 = tris[t * 3 + 2]!
            const edges: [number, number][] = [
                [i0, i1],
                [i1, i2],
                [i2, i0],
            ]

            for (const [a, b] of edges) {
                if (a === b) continue
                const k = edgeKey(a, b)
                const e = edgeMap.get(k)
                if (!e || e.count !== 2 || e.t1 === -1) continue
                const curIs0 = e.t0 === t
                const nt = curIs0 ? e.t1 : e.t0
                if (nt < 0) continue

                const dCur = curIs0 ? e.d0 : e.d1
                const dNei = curIs0 ? e.d1 : e.d0

                const desiredFlipNei = (dNei ^ dCur ^ flip[t] ^ 1) & 1

                if (!visited[nt]) {
                    visited[nt] = 1
                    flip[nt] = desiredFlipNei
                    stack.push(nt)
                }
            }
        }
        comps.push(comp)
    }

    for (let t = 0; t < triCount; t++) {
        if (!flip[t]) continue
        const off = t * 3
        const tmp = tris[off + 1]!
        tris[off + 1] = tris[off + 2]!
        tris[off + 2] = tmp
    }

    const vpos = (vidx: number) => {
        const base = vidx * stride
        return [verts[base]!, verts[base + 1]!, verts[base + 2]!] as const
    }
    const cross = (a: readonly [number, number, number], b: readonly [number, number, number]) =>
        [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] as const
    const dot = (a: readonly [number, number, number], b: readonly [number, number, number]) =>
        a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    const sub = (a: readonly [number, number, number], b: readonly [number, number, number]) =>
        [a[0] - b[0], a[1] - b[1], a[2] - b[2]] as const

    for (const comp of comps) {
        let vol6 = 0
        for (const t of comp) {
            const off = t * 3
            const i0 = tris[off + 0]!
            const i1 = tris[off + 1]!
            const i2 = tris[off + 2]!
            const p0 = vpos(i0)
            const p1 = vpos(i1)
            const p2 = vpos(i2)
            vol6 += dot(p0, cross(p1, p2))
        }
        if (vol6 < 0) {
            for (const t of comp) {
                const off = t * 3
                const tmp = tris[off + 1]!
                tris[off + 1] = tris[off + 2]!
                tris[off + 2] = tmp
            }
        }
    }
}

/**
 * Two triangles share an edge through `sharedVert` iff they share a second
 * vertex (in addition to `sharedVert` itself).
 */
function triSharesEdge(tris: Uint32Array, t0: number, t1: number, sharedVert: number): boolean {
    const base0 = t0 * 3, base1 = t1 * 3
    for (let c0 = 0; c0 < 3; c0++) {
        const v0 = tris[base0 + c0]!
        if (v0 === sharedVert) continue
        for (let c1 = 0; c1 < 3; c1++) {
            const v1 = tris[base1 + c1]!
            if (v1 === sharedVert) continue
            if (v0 === v1) return true
        }
    }
    return false
}

/**
 * Split mesh vertices at crease edges and assign averaged face normals per smooth group.
 * `vertexStrideBytes` must match GPU vertex layout (e.g. `SIZEOF_VERTEX` from `mdc.mts`).
 */
export function splitCreaseVertices(
    verts: Float32Array<ArrayBuffer>,
    tris: Uint32Array<ArrayBuffer>,
    creaseAngleDeg: number,
    vertexStrideBytes: number,
): { verts: Float32Array<ArrayBuffer>; tris: Uint32Array<ArrayBuffer> } {
    const S = vertexStrideBytes / Float32Array.BYTES_PER_ELEMENT
    const cosThresh = Math.cos(creaseAngleDeg * Math.PI / 180)
    const triCount = (tris.length / 3) | 0
    const vertCount = (verts.length / S) | 0
    if (triCount === 0 || vertCount === 0) return { verts, tris }

    // Per-triangle store the UNIT face normal (used by the cosThresh crease test, which
    // measures angle between adjacent faces and must be scale-invariant) AND the RAW cross
    // product (length = 2 × triangle area). The raw vector is used for area-weighted
    // smooth-group normal averaging — sliver triangles in dense MT contours have noisy
    // direction but tiny area, so weighting by area suppresses their contribution to the
    // final per-vertex normal. Without weighting, slivers add the same noise as large
    // triangles and produce visible per-vertex normal jitter on smooth surfaces.
    const fnx = new Float32Array(triCount)
    const fny = new Float32Array(triCount)
    const fnz = new Float32Array(triCount)
    const wnx = new Float32Array(triCount)
    const wny = new Float32Array(triCount)
    const wnz = new Float32Array(triCount)
    for (let t = 0; t < triCount; t++) {
        const b0 = tris[t * 3]! * S, b1 = tris[t * 3 + 1]! * S, b2 = tris[t * 3 + 2]! * S
        const ax = verts[b1]! - verts[b0]!, ay = verts[b1 + 1]! - verts[b0 + 1]!, az = verts[b1 + 2]! - verts[b0 + 2]!
        const bx = verts[b2]! - verts[b0]!, by = verts[b2 + 1]! - verts[b0 + 1]!, bz = verts[b2 + 2]! - verts[b0 + 2]!
        const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx
        wnx[t] = cx; wny[t] = cy; wnz[t] = cz
        const l = Math.hypot(cx, cy, cz)
        if (l > 1e-20) {
            const inv = 1 / l
            fnx[t] = cx * inv; fny[t] = cy * inv; fnz[t] = cz * inv
        }
    }

    const deg = new Uint32Array(vertCount)
    for (let k = 0; k < tris.length; k++) {
        const vi = tris[k]!
        if (vi < vertCount) deg[vi]++
    }
    const adjOff = new Uint32Array(vertCount + 1)
    for (let i = 0; i < vertCount; i++) adjOff[i + 1] = adjOff[i]! + deg[i]!
    const totalAdj = adjOff[vertCount]!
    const adjT = new Uint32Array(totalAdj)
    const adjC = new Uint8Array(totalAdj)
    const cursor = new Uint32Array(vertCount)
    for (let t = 0; t < triCount; t++)
        for (let c = 0; c < 3; c++) {
            const vi = tris[t * 3 + c]!
            if (vi < vertCount) {
                const off = adjOff[vi]! + cursor[vi]!
                adjT[off] = t
                adjC[off] = c
                cursor[vi]++
            }
        }

    const outTris = new Uint32Array(tris)
    let cap = Math.max(vertCount * 2, 1024)
    let outV = new Float32Array(cap * S)
    let nOut = 0

    const ensureCap = () => {
        if (nOut < cap) return
        cap *= 2
        const nv = new Float32Array(cap * S)
        nv.set(outV.subarray(0, nOut * S))
        outV = nv
    }

    let visBuf = new Uint8Array(64)

    for (let vi = 0; vi < vertCount; vi++) {
        const s0 = adjOff[vi]!, s1 = adjOff[vi + 1]!
        const n = s1 - s0
        if (n === 0) continue

        if (visBuf.length < n) visBuf = new Uint8Array(Math.max(n, visBuf.length * 2))
        const vis = visBuf
        vis.fill(0, 0, n)

        for (let seed = 0; seed < n; seed++) {
            if (vis[seed]) continue
            vis[seed] = 1

            const grp: number[] = [seed]
            const stk: number[] = [seed]
            while (stk.length > 0) {
                const ci = stk.pop()!
                const ct = adjT[s0 + ci]!
                for (let j = 0; j < n; j++) {
                    if (vis[j]) continue
                    const jt = adjT[s0 + j]!
                    const dot = fnx[ct]! * fnx[jt]! + fny[ct]! * fny[jt]! + fnz[ct]! * fnz[jt]!
                    if (dot < cosThresh) continue
                    if (!triSharesEdge(tris, ct, jt, vi)) continue
                    vis[j] = 1
                    grp.push(j)
                    stk.push(j)
                }
            }

            // Area-weighted sum of face normals (raw cross products) within the smooth
            // group. Sliver triangles contribute proportionally to their (tiny) area, so
            // their noisy direction barely perturbs the result.
            let nx = 0, ny = 0, nz = 0
            for (const idx of grp) {
                const t = adjT[s0 + idx]!
                nx += wnx[t]!; ny += wny[t]!; nz += wnz[t]!
            }
            const l = Math.hypot(nx, ny, nz)
            if (l > 1e-12) { nx /= l; ny /= l; nz /= l }

            ensureCap()
            const sb = vi * S, db = nOut * S
            outV[db] = verts[sb]!
            outV[db + 1] = verts[sb + 1]!
            outV[db + 2] = verts[sb + 2]!
            outV[db + 3] = 0
            outV[db + 4] = nx
            outV[db + 5] = ny
            outV[db + 6] = nz
            outV[db + 7] = 0

            for (const idx of grp) {
                outTris[adjT[s0 + idx]! * 3 + adjC[s0 + idx]!] = nOut
            }
            nOut++
        }
    }

    const resultVerts = new Float32Array(nOut * S)
    resultVerts.set(outV.subarray(0, nOut * S))
    const resultTris = new Uint32Array(outTris.length)
    resultTris.set(outTris)
    return { verts: resultVerts, tris: resultTris }
}

/**
 * Like `splitCreaseVertices` but uses the **analytic per-vertex normals already in
 * `verts` (from ISO Pass 7)** to detect smooth groups, instead of the geometric face
 * normal of each triangle. Within each smooth group, the original analytic per-vertex
 * normal is preserved (not overwritten with face-averaged) so smooth regions get exact
 * SDF gradients and sharp features stay sharp at their actual gradient discontinuity.
 *
 * Why this beats face-normal-based crease detection for ISO:
 *   - MT slivers have wildly noisy geometric face normals (cross product of nearly-collinear
 *     edges). With a 30° crease threshold the noise alone splits ~70% of vertices in smooth
 *     regions, fragmenting the mesh and producing the "all edges jagged" appearance even
 *     though the underlying mesh is manifold.
 *   - Analytic ∇F sampled at iso-crossing positions is genuinely smooth across smooth surface
 *     regions and jumps only at REAL sharp features (CSG max/min, polygon corners, box edges).
 *
 * Triangles whose 3 analytic normals point in different directions (e.g. a triangle
 * straddling a sharp feature) are treated as having the *averaged* analytic normal for
 * smooth-group classification — same as the original `splitCreaseVertices` approach.
 */
export function splitCreaseVerticesByAnalyticNormal(
    verts: Float32Array<ArrayBuffer>,
    tris: Uint32Array<ArrayBuffer>,
    creaseAngleDeg: number,
    vertexStrideBytes: number,
): { verts: Float32Array<ArrayBuffer>; tris: Uint32Array<ArrayBuffer> } {
    const S = vertexStrideBytes / Float32Array.BYTES_PER_ELEMENT
    const cosThresh = Math.cos(creaseAngleDeg * Math.PI / 180)
    const triCount = (tris.length / 3) | 0
    const vertCount = (verts.length / S) | 0
    if (triCount === 0 || vertCount === 0) return { verts, tris }

    // 1. Per-triangle "analytic normal" = unit-normalized average of the 3 vertex
    //    analytic normals. This is smooth across smooth regions, jumps only at real
    //    SDF gradient discontinuities.
    const tnx = new Float32Array(triCount)
    const tny = new Float32Array(triCount)
    const tnz = new Float32Array(triCount)
    for (let t = 0; t < triCount; t++) {
        const b0 = tris[t * 3]! * S + 4
        const b1 = tris[t * 3 + 1]! * S + 4
        const b2 = tris[t * 3 + 2]! * S + 4
        let nx = (verts[b0]! + verts[b1]! + verts[b2]!) / 3
        let ny = (verts[b0 + 1]! + verts[b1 + 1]! + verts[b2 + 1]!) / 3
        let nz = (verts[b0 + 2]! + verts[b1 + 2]! + verts[b2 + 2]!) / 3
        const l = Math.hypot(nx, ny, nz)
        if (l > 1e-20) { nx /= l; ny /= l; nz /= l }
        tnx[t] = nx; tny[t] = ny; tnz[t] = nz
    }

    // 2. CSR vertex → (triangle, corner) adjacency (same as splitCreaseVertices).
    const deg = new Uint32Array(vertCount)
    for (let k = 0; k < tris.length; k++) {
        const vi = tris[k]!
        if (vi < vertCount) deg[vi]++
    }
    const adjOff = new Uint32Array(vertCount + 1)
    for (let i = 0; i < vertCount; i++) adjOff[i + 1] = adjOff[i]! + deg[i]!
    const totalAdj = adjOff[vertCount]!
    const adjT = new Uint32Array(totalAdj)
    const adjC = new Uint8Array(totalAdj)
    const cursor = new Uint32Array(vertCount)
    for (let t = 0; t < triCount; t++) {
        for (let c = 0; c < 3; c++) {
            const vi = tris[t * 3 + c]!
            if (vi < vertCount) {
                const off = adjOff[vi]! + cursor[vi]!
                adjT[off] = t
                adjC[off] = c
                cursor[vi]++
            }
        }
    }

    // 3. For each vertex, flood-fill smooth groups of adjacent triangles where the
    //    analytic-normal cosine ≥ cosThresh. Emit one output vertex per group, KEEPING
    //    the original analytic per-vertex normal (Pass 7 already gave us the best one).
    const outTris = new Uint32Array(tris)
    let cap = Math.max(vertCount * 2, 1024)
    let outV = new Float32Array(cap * S)
    let nOut = 0
    const ensureCap = () => {
        if (nOut < cap) return
        cap *= 2
        const nv = new Float32Array(cap * S)
        nv.set(outV.subarray(0, nOut * S))
        outV = nv
    }
    let visBuf = new Uint8Array(64)

    for (let vi = 0; vi < vertCount; vi++) {
        const s0 = adjOff[vi]!, s1 = adjOff[vi + 1]!
        const n = s1 - s0
        if (n === 0) continue
        if (visBuf.length < n) visBuf = new Uint8Array(Math.max(n, visBuf.length * 2))
        const vis = visBuf
        vis.fill(0, 0, n)

        for (let seed = 0; seed < n; seed++) {
            if (vis[seed]) continue
            vis[seed] = 1
            const grp: number[] = [seed]
            const stk: number[] = [seed]
            while (stk.length > 0) {
                const ci = stk.pop()!
                const ct = adjT[s0 + ci]!
                for (let j = 0; j < n; j++) {
                    if (vis[j]) continue
                    const jt = adjT[s0 + j]!
                    const dot = tnx[ct]! * tnx[jt]! + tny[ct]! * tny[jt]! + tnz[ct]! * tnz[jt]!
                    if (dot < cosThresh) continue
                    if (!triSharesEdge(tris, ct, jt, vi)) continue
                    vis[j] = 1
                    grp.push(j)
                    stk.push(j)
                }
            }

            // For each smooth group: average the analytic normals of the participating
            // triangles to get the smoothed normal at this split copy. (Within a smooth
            // group all per-triangle analytic normals are similar by definition, so the
            // average ≈ any of them, but averaging hides any residual MT sliver noise.)
            let nx = 0, ny = 0, nz = 0
            for (const idx of grp) {
                const t = adjT[s0 + idx]!
                nx += tnx[t]!; ny += tny[t]!; nz += tnz[t]!
            }
            const l = Math.hypot(nx, ny, nz)
            if (l > 1e-12) { nx /= l; ny /= l; nz /= l }

            ensureCap()
            const sb = vi * S, db = nOut * S
            outV[db] = verts[sb]!
            outV[db + 1] = verts[sb + 1]!
            outV[db + 2] = verts[sb + 2]!
            outV[db + 3] = 0
            outV[db + 4] = nx
            outV[db + 5] = ny
            outV[db + 6] = nz
            outV[db + 7] = 0

            for (const idx of grp) {
                outTris[adjT[s0 + idx]! * 3 + adjC[s0 + idx]!] = nOut
            }
            nOut++
        }
    }

    const resultVerts = new Float32Array(nOut * S)
    resultVerts.set(outV.subarray(0, nOut * S))
    const resultTris = new Uint32Array(outTris.length)
    resultTris.set(outTris)
    return { verts: resultVerts, tris: resultTris }
}

/**
 * Overwrite per-vertex normals with the area-weighted average of incident triangle
 * face normals (standard Phong smooth shading). Mutates `verts` in place.
 *
 * Preconditions:
 *   - Triangle winding is globally consistent (e.g. after `orientTrianglesToMatchAnalyticNormals`),
 *     so face normals all point outward and averaging cannot cancel out.
 *
 * Why this is needed for ISO: the analytic SDF gradient (`sceneSDF_mid(p).n`) is piecewise
 * smooth — it has C1 discontinuities at polygon-profile segment boundaries (lathe/extrude),
 * at CSG seams, and at smooth-blend transitions. Sampling those at every MT vertex produces
 * a faceted look on visually-smooth surfaces. Averaging face normals across each vertex's
 * triangle ring smooths these out at the cost of softening real sharp features (acceptable
 * for Phase 1; sharp-feature recovery is Phase 4).
 */
export function smoothNormalsByAreaWeightedFaceAverage(
    verts: Float32Array<ArrayBuffer>,
    tris: Uint32Array<ArrayBuffer>,
    vertexStrideBytes: number,
): void {
    const stride = vertexStrideBytes / Float32Array.BYTES_PER_ELEMENT
    const triCount = (tris.length / 3) | 0
    const vertCount = (verts.length / stride) | 0
    if (triCount === 0 || vertCount === 0) return

    const sumX = new Float32Array(vertCount)
    const sumY = new Float32Array(vertCount)
    const sumZ = new Float32Array(vertCount)

    for (let t = 0; t < triCount; t++) {
        const i0 = tris[t * 3]!, i1 = tris[t * 3 + 1]!, i2 = tris[t * 3 + 2]!
        if (i0 >= vertCount || i1 >= vertCount || i2 >= vertCount) continue
        const b0 = i0 * stride, b1 = i1 * stride, b2 = i2 * stride
        const ax = verts[b1]! - verts[b0]!
        const ay = verts[b1 + 1]! - verts[b0 + 1]!
        const az = verts[b1 + 2]! - verts[b0 + 2]!
        const bx = verts[b2]! - verts[b0]!
        const by = verts[b2 + 1]! - verts[b0 + 1]!
        const bz = verts[b2 + 2]! - verts[b0 + 2]!
        // Cross-product magnitude = 2 × triangle area; using the un-normalized cross weights
        // each contribution by area, which is the standard Phong smoothing formulation.
        const nx = ay * bz - az * by
        const ny = az * bx - ax * bz
        const nz = ax * by - ay * bx
        sumX[i0]! += nx; sumY[i0]! += ny; sumZ[i0]! += nz
        sumX[i1]! += nx; sumY[i1]! += ny; sumZ[i1]! += nz
        sumX[i2]! += nx; sumY[i2]! += ny; sumZ[i2]! += nz
    }

    for (let v = 0; v < vertCount; v++) {
        const off = v * stride + 4
        const nx = sumX[v]!
        const ny = sumY[v]!
        const nz = sumZ[v]!
        const len = Math.hypot(nx, ny, nz)
        if (len > 1e-12) {
            const inv = 1 / len
            verts[off + 0] = nx * inv
            verts[off + 1] = ny * inv
            verts[off + 2] = nz * inv
        }
        // Leave existing normal in place for unreferenced vertices (sum is zero).
    }
}

/**
 * Orient each triangle's winding so its geometric face normal agrees with the
 * average analytic vertex normal across its 3 corners. Mutates `tris` in place.
 *
 * Designed for ISO export, where Pass 7 writes per-vertex analytic SDF gradients
 * (`safeUnit3(sceneSDF_mid(p).n)`) — by SDF convention these point canonically
 * outward (toward +F = outside the solid). Per-triangle alignment is robust to
 * non-manifold edges (unlike BFS-based reorientation, which fragments at any
 * count != 2 edge) and to disconnected components from welding artifacts.
 *
 * Returns the number of triangles whose winding was flipped (for logging).
 */
export function orientTrianglesToMatchAnalyticNormals(
    verts: Float32Array<ArrayBuffer>,
    tris: Uint32Array<ArrayBuffer>,
    vertexStrideBytes: number,
): number {
    const stride = vertexStrideBytes / Float32Array.BYTES_PER_ELEMENT
    const triCount = (tris.length / 3) | 0
    const vertCount = (verts.length / stride) | 0
    if (triCount === 0 || vertCount === 0) return 0

    let flipped = 0
    for (let t = 0; t < triCount; t++) {
        const off = t * 3
        const i0 = tris[off]!, i1 = tris[off + 1]!, i2 = tris[off + 2]!
        if (i0 >= vertCount || i1 >= vertCount || i2 >= vertCount) continue
        const b0 = i0 * stride, b1 = i1 * stride, b2 = i2 * stride

        const ax = (verts[b0 + 4]! + verts[b1 + 4]! + verts[b2 + 4]!) / 3
        const ay = (verts[b0 + 5]! + verts[b1 + 5]! + verts[b2 + 5]!) / 3
        const az = (verts[b0 + 6]! + verts[b1 + 6]! + verts[b2 + 6]!) / 3

        const e0x = verts[b1]! - verts[b0]!
        const e0y = verts[b1 + 1]! - verts[b0 + 1]!
        const e0z = verts[b1 + 2]! - verts[b0 + 2]!
        const e1x = verts[b2]! - verts[b0]!
        const e1y = verts[b2 + 1]! - verts[b0 + 1]!
        const e1z = verts[b2 + 2]! - verts[b0 + 2]!
        const fx = e0y * e1z - e0z * e1y
        const fy = e0z * e1x - e0x * e1z
        const fz = e0x * e1y - e0y * e1x

        // Skip degenerate triangles (zero face area) and skip when analytic
        // normal is degenerate too — both leave winding unchanged.
        const fl2 = fx * fx + fy * fy + fz * fz
        const al2 = ax * ax + ay * ay + az * az
        if (fl2 <= 0 || al2 <= 0) continue

        // Only flip on strong disagreement (cos < -0.3 ≈ angle > 107°). Sliver triangles
        // and triangles spanning a sharp feature have noisy or weak dot products near 0;
        // flipping them based on noise creates inconsistent winding across the smooth
        // surface and fragments downstream crease detection. The strong-disagreement
        // threshold catches genuinely-inverted triangles (cos ≈ -1) without false positives.
        const cos = (ax * fx + ay * fy + az * fz) / Math.sqrt(fl2 * al2)
        if (cos < -0.3) {
            tris[off + 1] = i2
            tris[off + 2] = i1
            flipped++
        }
    }
    return flipped
}

/**
 * Per-vertex: flip the stored normal if it points opposite the area-weighted
 * sum of incident triangle face normals. Designed for ISO export's Pass 7
 * analytic normals from `sceneSDF_mid`, which can come out backwards when:
 *   - Newton lands a welded vertex on the "wrong" side of a thin feature, or
 *   - a CSG-difference seam returns an inward-pointing normal at the seam point.
 *
 * Must run AFTER `reorientMeshTriangleWinding` so the area-weighted sum is the
 * outward direction by convention. Mutates `verts` in place. Vertex layout
 * matches `MeshData`: floats `[px, py, pz, _, nx, ny, nz, _]` per record (the
 * normal slot starts at float index 4).
 *
 * Returns the number of vertices that were flipped (for diagnostic logging).
 */
export function flipMisorientedVertexNormalsToMatchGeometry(
    verts: Float32Array<ArrayBuffer>,
    tris: Uint32Array<ArrayBuffer>,
    vertexStrideBytes: number,
): number {
    const stride = vertexStrideBytes / Float32Array.BYTES_PER_ELEMENT
    const triCount = (tris.length / 3) | 0
    const vertCount = (verts.length / stride) | 0
    if (triCount === 0 || vertCount === 0) return 0

    // Area-weighted (un-normalized) face normals summed per vertex give the
    // outward direction by the same convention `reorientMeshTriangleWinding`
    // enforces (positive signed volume → outward).
    const gnx = new Float32Array(vertCount)
    const gny = new Float32Array(vertCount)
    const gnz = new Float32Array(vertCount)

    for (let t = 0; t < triCount; t++) {
        const i0 = tris[t * 3]!
        const i1 = tris[t * 3 + 1]!
        const i2 = tris[t * 3 + 2]!
        if (i0 >= vertCount || i1 >= vertCount || i2 >= vertCount) continue
        const b0 = i0 * stride, b1 = i1 * stride, b2 = i2 * stride
        const ax = verts[b1]! - verts[b0]!
        const ay = verts[b1 + 1]! - verts[b0 + 1]!
        const az = verts[b1 + 2]! - verts[b0 + 2]!
        const bx = verts[b2]! - verts[b0]!
        const by = verts[b2 + 1]! - verts[b0 + 1]!
        const bz = verts[b2 + 2]! - verts[b0 + 2]!
        const nx = ay * bz - az * by
        const ny = az * bx - ax * bz
        const nz = ax * by - ay * bx
        gnx[i0]! += nx; gny[i0]! += ny; gnz[i0]! += nz
        gnx[i1]! += nx; gny[i1]! += ny; gnz[i1]! += nz
        gnx[i2]! += nx; gny[i2]! += ny; gnz[i2]! += nz
    }

    let flipped = 0
    for (let v = 0; v < vertCount; v++) {
        const noff = v * stride + 4
        const nx = verts[noff]!
        const ny = verts[noff + 1]!
        const nz = verts[noff + 2]!
        const dot = nx * gnx[v]! + ny * gny[v]! + nz * gnz[v]!
        // Strict-negative: a tied vertex (dot==0, e.g. unreferenced) keeps
        // whatever it had. NaN propagates as not-< 0 so we leave them alone.
        if (dot < 0) {
            verts[noff] = -nx
            verts[noff + 1] = -ny
            verts[noff + 2] = -nz
            flipped++
        }
    }
    return flipped
}

export async function optionalSimplifyExportedMesh(
    verts: Float32Array<ArrayBuffer>,
    tris: Uint32Array<ArrayBuffer>,
    params: MeshSimplifyParams,
): Promise<{ verts: Float32Array<ArrayBuffer>; tris: Uint32Array<ArrayBuffer> }> {
    if (params.simplifyTargetRatio === undefined || params.simplifyTargetRatio >= 1) {
        return { verts, tris }
    }
    const { simplifyMesh } = await import("./simplify.mjs")
    const simplified = await simplifyMesh(
        { verts, tris },
        params.simplifyTargetRatio,
        params.simplifyTargetError,
        {
            lockBorder: params.simplifyLockBorder,
            sparse: params.simplifySparse,
            errorAbsolute: params.simplifyErrorAbsolute,
            prune: params.simplifyPrune,
            regularize: params.simplifyRegularize,
            normalWeight: params.simplifyNormalWeight,
        },
    )
    return { verts: simplified.verts, tris: simplified.tris }
}

/**
 * Boundary / non-manifold edge counts and degenerate triangle tally (same logic as legacy MDC export).
 */
export function logExportMeshSanityStats(
    verts: Float32Array<ArrayBuffer>,
    tris: Uint32Array<ArrayBuffer>,
    voxelSize: number,
    vertexStrideBytes: number,
    logModule: LogModule,
    statsLabel: string,
): void {
    const stride = vertexStrideBytes / 4
    const triCount = Math.floor(tris.length / 3)
    const areaEpsSq = Math.pow(voxelSize * voxelSize * 1e-6, 2)
    let degenerate = 0

    const edgeCounts = new Map<bigint, number>()
    const addEdge = (a: number, b: number) => {
        if (a === b) return
        const lo = a < b ? a : b
        const hi = a < b ? b : a
        const key = (BigInt(lo) << 32n) | BigInt(hi >>> 0)
        edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1)
    }

    const vpos = (vidx: number) => {
        const base = vidx * stride
        return [verts[base]!, verts[base + 1]!, verts[base + 2]!] as const
    }
    const sub = (a: readonly [number, number, number], b: readonly [number, number, number]) =>
        [a[0] - b[0], a[1] - b[1], a[2] - b[2]] as const
    const cross = (a: readonly [number, number, number], b: readonly [number, number, number]) =>
        [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] as const

    for (let t = 0; t < triCount; t++) {
        const i0 = tris[t * 3]!
        const i1 = tris[t * 3 + 1]!
        const i2 = tris[t * 3 + 2]!

        addEdge(i0, i1)
        addEdge(i1, i2)
        addEdge(i2, i0)

        const p0 = vpos(i0)
        const p1 = vpos(i1)
        const p2 = vpos(i2)
        const e0 = sub(p1, p0)
        const e1 = sub(p2, p0)
        const n = cross(e0, e1)
        const a2 = n[0] * n[0] + n[1] * n[1] + n[2] * n[2]
        if (!isFinite(a2) || a2 <= areaEpsSq) degenerate++
    }

    let boundaryEdges = 0
    let nonManifoldEdges = 0
    for (const c of edgeCounts.values()) {
        if (c === 1) boundaryEdges++
        else if (c !== 2) nonManifoldEdges++
    }
    dbgLog(logModule).debug(
        `${statsLabel} mesh stats: tris=${triCount} degenerateTris=${degenerate} boundaryEdges=${boundaryEdges} nonManifoldEdges=${nonManifoldEdges}`,
    )
}
