import { MeshData } from "./export.mjs"

// Vertex layout is consistent across exporters:
// - position.xyz at floats [0..2]
// - padding at [3]
// - normal.xyz at [4..6]
// - padding at [7]
const VERT_STRIDE_FLOATS = 8

type Vec3 = readonly [number, number, number]
type Vec2 = readonly [number, number]

const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm3 = (a: Vec3) => Math.hypot(a[0], a[1], a[2])
const normalize3 = (a: Vec3): Vec3 => {
    const n = norm3(a)
    if (!isFinite(n) || n === 0) return [0, 0, 0]
    return [a[0] / n, a[1] / n, a[2] / n]
}

const dot2 = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1]
const cross2 = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0]
const sub2 = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]]

const triNormal = (p0: Vec3, p1: Vec3, p2: Vec3): Vec3 => normalize3(cross3(sub3(p1, p0), sub3(p2, p0)))
const isDegenerateNormal = (n: Vec3) => !isFinite(n[0]) || !isFinite(n[1]) || !isFinite(n[2]) || (n[0] === 0 && n[1] === 0 && n[2] === 0)

const edgeKey = (a: number, b: number) => {
    const lo = a < b ? a : b
    const hi = a < b ? b : a
    return (BigInt(lo >>> 0) << 32n) | BigInt(hi >>> 0)
}

function polySignedArea2(points: Vec2[]): number {
    let a = 0
    for (let i = 0; i < points.length; i++) {
        const p = points[i]!
        const q = points[(i + 1) % points.length]!
        a += p[0] * q[1] - q[0] * p[1]
    }
    return 0.5 * a
}

function pointInTri2(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
    // For CCW triangles: p inside iff it’s on same side of all edges.
    const ab = sub2(b, a)
    const bc = sub2(c, b)
    const ca = sub2(a, c)
    const ap = sub2(p, a)
    const bp = sub2(p, b)
    const cp = sub2(p, c)
    const c1 = cross2(ab, ap)
    const c2 = cross2(bc, bp)
    const c3 = cross2(ca, cp)
    const eps = 1e-12
    return c1 >= -eps && c2 >= -eps && c3 >= -eps
}

function removeCollinear(poly: number[], pts2: Vec2[]): number[] {
    // Remove nearly-collinear vertices to help ear clipping.
    const out: number[] = []
    const eps = 1e-12
    for (let i = 0; i < poly.length; i++) {
        const prev = poly[(i - 1 + poly.length) % poly.length]!
        const cur = poly[i]!
        const next = poly[(i + 1) % poly.length]!
        const a = pts2[prev]!
        const b = pts2[cur]!
        const c = pts2[next]!
        const ab = sub2(b, a)
        const bc = sub2(c, b)
        if (Math.abs(cross2(ab, bc)) <= eps) continue
        out.push(cur)
    }
    return out
}

function triangulateSimplePolygon(loopVerts: number[], pts2: Vec2[]): number[] | null {
    // `loopVerts` are vertex indices into pts2 (and original mesh), in boundary order.
    if (loopVerts.length < 3) return null

    // Ensure CCW in 2D
    const loopPts2 = loopVerts.map((vi) => pts2[vi]!)
    if (polySignedArea2(loopPts2) < 0) loopVerts = loopVerts.slice().reverse()

    // Remove collinear points (in terms of indices into pts2)
    loopVerts = removeCollinear(loopVerts, pts2)
    if (loopVerts.length < 3) return null

    // Ear clipping on indices into pts2.
    const poly = loopVerts.slice()
    const outTris: number[] = []

    const maxIters = poly.length * poly.length + 1000
    let iters = 0
    while (poly.length > 3 && iters++ < maxIters) {
        let cut = false
        for (let i = 0; i < poly.length; i++) {
            const iPrev = poly[(i - 1 + poly.length) % poly.length]!
            const iCur = poly[i]!
            const iNext = poly[(i + 1) % poly.length]!

            const a = pts2[iPrev]!
            const b = pts2[iCur]!
            const c = pts2[iNext]!

            // Convexity for CCW polygon.
            const ab = sub2(b, a)
            const bc = sub2(c, b)
            if (cross2(ab, bc) <= 1e-14) continue

            // No other vertex inside the ear.
            let anyInside = false
            for (let j = 0; j < poly.length; j++) {
                const v = poly[j]!
                if (v === iPrev || v === iCur || v === iNext) continue
                if (pointInTri2(pts2[v]!, a, b, c)) {
                    anyInside = true
                    break
                }
            }
            if (anyInside) continue

            outTris.push(iPrev, iCur, iNext)
            poly.splice(i, 1)
            cut = true
            break
        }
        if (!cut) return null
    }

    if (poly.length !== 3) return null
    outTris.push(poly[0]!, poly[1]!, poly[2]!)
    return outTris
}

function buildBoundaryLoopFromComponent(componentTris: number[], tris: Uint32Array<ArrayBuffer>): number[] | null {
    // Build a single boundary loop (simple polygon) from a coplanar triangle component.
    // Returns vertex indices in order, or null if boundary is complex (holes, branches, etc).
    const edgeCounts = new Map<bigint, number>()
    const edgeVerts = new Map<bigint, [number, number]>()

    for (const t of componentTris) {
        const off = t * 3
        const i0 = tris[off + 0]!
        const i1 = tris[off + 1]!
        const i2 = tris[off + 2]!
        const edges: [number, number][] = [
            [i0, i1],
            [i1, i2],
            [i2, i0],
        ]
        for (const [a, b] of edges) {
            if (a === b) continue
            const lo = a < b ? a : b
            const hi = a < b ? b : a
            const k = edgeKey(a, b)
            edgeCounts.set(k, (edgeCounts.get(k) ?? 0) + 1)
            if (!edgeVerts.has(k)) edgeVerts.set(k, [lo, hi])
        }
    }

    // Boundary edges appear exactly once inside the component.
    const boundaryEdges: [number, number][] = []
    for (const [k, c] of edgeCounts) {
        if (c !== 1) continue
        const e = edgeVerts.get(k)
        if (e) boundaryEdges.push(e)
    }
    if (boundaryEdges.length < 3) return null

    // Vertex adjacency on the boundary.
    const adj = new Map<number, number[]>()
    const addAdj = (a: number, b: number) => {
        const arr = adj.get(a)
        if (!arr) adj.set(a, [b])
        else arr.push(b)
    }
    for (const [a, b] of boundaryEdges) {
        addAdj(a, b)
        addAdj(b, a)
    }

    // Simple single-loop boundary requires degree 2 at every boundary vertex.
    for (const [v, ns] of adj) {
        if (ns.length !== 2) return null
        // Rare duplicate neighbor
        if (ns[0] === ns[1]) return null
        // Avoid pathological adjacency lists with repeats
        if (ns[0] === v || ns[1] === v) return null
    }

    // Traverse loop.
    const start = Math.min(...adj.keys())
    const startNs = adj.get(start)
    if (!startNs) return null

    const loop: number[] = []
    let prev = start
    let cur = startNs[0]!
    loop.push(start)

    const maxSteps = boundaryEdges.length + 5
    for (let steps = 0; steps < maxSteps; steps++) {
        loop.push(cur)
        if (cur === start) break
        const ns = adj.get(cur)
        if (!ns) return null
        const next = ns[0] === prev ? ns[1]! : ns[0]!
        prev = cur
        cur = next
        if (cur === start) {
            // close
            loop.push(cur)
            break
        }
    }

    // Remove duplicate end if closed.
    if (loop.length >= 2 && loop[0] === loop[loop.length - 1]) loop.pop()
    if (loop.length < 3) return null

    // Ensure it's a single loop (i.e., uses all boundary edges).
    // Quick check: number of edges in loop should match boundary edges count.
    if (loop.length !== boundaryEdges.length) return null

    return loop
}

/**
 * Merge adjacent coplanar triangle patches by removing internal edges and retriangulating the resulting boundary.
 *
 * Notes / constraints:
 * - Conservative: only merges components that form a single simple boundary loop (no holes/branches/non-manifold).
 * - Uses position only; vertex attributes (normals) are preserved by reusing existing vertex indices.
 */
export function mergeCoplanar(mesh: MeshData): MeshData {
    const { verts, tris } = mesh
    const triCount = Math.floor(tris.length / 3)
    if (triCount <= 1) return { verts, tris }

    const vpos = (vidx: number): Vec3 => {
        const base = vidx * VERT_STRIDE_FLOATS
        return [verts[base]!, verts[base + 1]!, verts[base + 2]!]
    }

    // BBox-based tolerance scaling (on referenced vertices only).
    let minX = Infinity,
        minY = Infinity,
        minZ = Infinity
    let maxX = -Infinity,
        maxY = -Infinity,
        maxZ = -Infinity
    {
        for (let i = 0; i < triCount * 3; i++) {
            const vi = tris[i]!
            const p = vpos(vi)
            minX = Math.min(minX, p[0])
            minY = Math.min(minY, p[1])
            minZ = Math.min(minZ, p[2])
            maxX = Math.max(maxX, p[0])
            maxY = Math.max(maxY, p[1])
            maxZ = Math.max(maxZ, p[2])
        }
    }
    const dx = maxX - minX
    const dy = maxY - minY
    const dz = maxZ - minZ
    const diag = Math.hypot(dx, dy, dz)
    const distEps = Math.max(1e-6, diag * 1e-5)
    const cosTol = 0.9999

    // Precompute triangle planes.
    const nrm: Vec3[] = new Array(triCount)
    const d = new Float64Array(triCount)
    for (let t = 0; t < triCount; t++) {
        const off = t * 3
        const i0 = tris[off + 0]!
        const i1 = tris[off + 1]!
        const i2 = tris[off + 2]!
        const p0 = vpos(i0)
        const p1 = vpos(i1)
        const p2 = vpos(i2)
        const n = triNormal(p0, p1, p2)
        nrm[t] = n
        d[t] = dot3(n, p0)
    }

    const coplanar = (tA: number, tB: number): boolean => {
        const nA = nrm[tA]!
        const nB = nrm[tB]!
        if (isDegenerateNormal(nA) || isDegenerateNormal(nB)) return false
        const nd = Math.abs(dot3(nA, nB))
        if (!isFinite(nd) || nd < cosTol) return false

        // Symmetric plane distance check (independent of normal sign).
        const offA = tA * 3
        const offB = tB * 3
        const pA = vpos(tris[offA]!)
        const pB = vpos(tris[offB]!)
        const distAB = Math.abs(dot3(nA, pB) - d[tA]!)
        const distBA = Math.abs(dot3(nB, pA) - d[tB]!)
        return distAB <= distEps && distBA <= distEps
    }

    // Build edge -> up to 2 triangles map.
    type EdgeEntry = { t0: number; t1: number; count: number }
    const edgeMap = new Map<bigint, EdgeEntry>()
    for (let t = 0; t < triCount; t++) {
        const off = t * 3
        const i0 = tris[off + 0]!
        const i1 = tris[off + 1]!
        const i2 = tris[off + 2]!
        const edges: [number, number][] = [
            [i0, i1],
            [i1, i2],
            [i2, i0],
        ]
        for (const [a, b] of edges) {
            if (a === b) continue
            const k = edgeKey(a, b)
            const e = edgeMap.get(k)
            if (!e) edgeMap.set(k, { t0: t, t1: -1, count: 1 })
            else {
                e.count++
                if (e.t1 === -1) e.t1 = t
            }
        }
    }

    const visited = new Uint8Array(triCount)
    const consumed = new Uint8Array(triCount)
    const outTris: number[] = []

    // Build 2D projection basis on-demand per component (from first triangle normal).
    const project2 = (n: Vec3) => {
        // Find the component with smallest absolute value to avoid parallel reference
        const absN = [Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])]
        let minIdx = 0
        if (absN[1]! < absN[minIdx]!) minIdx = 1
        if (absN[2]! < absN[minIdx]!) minIdx = 2

        const ref: Vec3 = minIdx === 0 ? [1, 0, 0] : minIdx === 1 ? [0, 1, 0] : [0, 0, 1]
        const u = normalize3(cross3(n, ref))
        const v = cross3(n, u)
        return { u, v }
    }

    for (let seed = 0; seed < triCount; seed++) {
        if (visited[seed]) continue
        visited[seed] = 1

        // Gather coplanar connected component using edge adjacency.
        const stack = [seed]
        const comp: number[] = []
        while (stack.length) {
            const t = stack.pop()!
            comp.push(t)

            const off = t * 3
            const i0 = tris[off + 0]!
            const i1 = tris[off + 1]!
            const i2 = tris[off + 2]!
            const edges: [number, number][] = [
                [i0, i1],
                [i1, i2],
                [i2, i0],
            ]

            for (const [a, b] of edges) {
                if (a === b) continue
                const e = edgeMap.get(edgeKey(a, b))
                if (!e || e.count !== 2 || e.t1 === -1) continue
                const nt = e.t0 === t ? e.t1 : e.t0
                if (nt < 0 || visited[nt]) continue
                if (!coplanar(t, nt)) continue
                visited[nt] = 1
                stack.push(nt)
            }
        }

        // Try to merge this component if it is a non-trivial planar patch.
        if (comp.length > 1) {
            const loop = buildBoundaryLoopFromComponent(comp, tris)
            const n = nrm[seed]!
            if (loop && !isDegenerateNormal(n)) {
                const { u, v } = project2(n)

                // pts2 is indexed by original vertex index; sparse fill for loop vertices.
                const pts2: Vec2[] = []
                for (const vi of loop) {
                    const p = vpos(vi)
                    pts2[vi] = [dot3(p, u), dot3(p, v)]
                }

                const merged = triangulateSimplePolygon(loop, pts2)
                if (merged && merged.length >= 3) {
                    for (const t of comp) consumed[t] = 1
                    outTris.push(...merged)
                    continue
                }
            }
        }
    }

    // Append untouched triangles.
    for (let t = 0; t < triCount; t++) {
        if (consumed[t]) continue
        const off = t * 3
        outTris.push(tris[off + 0]!, tris[off + 1]!, tris[off + 2]!)
    }

    return {
        verts,
        tris: new Uint32Array(outTris),
    }
}

