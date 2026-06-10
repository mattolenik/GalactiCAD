/**
 * Standalone closed-2-manifold checker for indexed triangle meshes.
 *
 * A mesh is a closed oriented 2-manifold iff every undirected edge is used by
 * exactly two triangles, once in each direction (and, strictly, every vertex
 * link is a single cycle — the optional vertex-link check catches bowtie
 * vertices the edge test admits). Used by the S4 mesh audit and exported for
 * tests.
 */

export interface ManifoldReport {
    ok: boolean
    /** Undirected edges referenced by exactly one triangle (holes). */
    openEdges: number
    /** Undirected edges referenced by 3+ triangles. */
    nonManifoldEdges: number
    /** Undirected edges referenced exactly twice but in the same direction (orientation flip). */
    misorientedEdges: number
    /** Vertices whose triangle fan is not a single closed cycle (only when checkVertexLinks). */
    nonManifoldVertices: number
    components: number
    /** Euler characteristic per connected component (sphere topology = 2). */
    eulerPerComponent: number[]
    /** Endpoints of open/misoriented edges, xyz pairs (6 floats per edge), for debug overlays. */
    badEdgeVertexIds: number[]
}

const EDGE_BASE = 0x8000000 // 2^27 — supports up to 134M vertex ids in an f64-exact key

function undirectedKey(a: number, b: number): number {
    return a < b ? a * EDGE_BASE + b : b * EDGE_BASE + a
}

export function checkManifold(tris: ArrayLike<number>, opts?: { checkVertexLinks?: boolean }): ManifoldReport {
    const triCount = Math.floor(tris.length / 3)
    // count: total uses; balance: +1 for a<b direction, −1 for b<a.
    const edges = new Map<number, { count: number; balance: number; a: number; b: number }>()
    for (let t = 0; t < triCount; t++) {
        for (let e = 0; e < 3; e++) {
            const a = tris[t * 3 + e]!
            const b = tris[t * 3 + ((e + 1) % 3)]!
            const key = undirectedKey(a, b)
            let rec = edges.get(key)
            if (!rec) {
                rec = { count: 0, balance: 0, a: Math.min(a, b), b: Math.max(a, b) }
                edges.set(key, rec)
            }
            rec.count++
            rec.balance += a < b ? 1 : -1
        }
    }

    let openEdges = 0
    let nonManifoldEdges = 0
    let misorientedEdges = 0
    const badEdgeVertexIds: number[] = []
    for (const rec of edges.values()) {
        if (rec.count === 1) {
            openEdges++
            badEdgeVertexIds.push(rec.a, rec.b)
        } else if (rec.count > 2) {
            nonManifoldEdges++
            badEdgeVertexIds.push(rec.a, rec.b)
        } else if (rec.balance !== 0) {
            misorientedEdges++
            badEdgeVertexIds.push(rec.a, rec.b)
        }
    }

    // Connected components over vertices via union-find on triangle edges.
    const parent = new Map<number, number>()
    const find = (v: number): number => {
        let r = parent.get(v) ?? v
        if (r !== v) {
            r = find(r)
            parent.set(v, r)
        }
        return r
    }
    const union = (a: number, b: number): void => {
        const ra = find(a)
        const rb = find(b)
        if (ra !== rb) parent.set(ra, rb)
    }
    const verts = new Set<number>()
    for (let t = 0; t < triCount; t++) {
        const a = tris[t * 3]!
        const b = tris[t * 3 + 1]!
        const c = tris[t * 3 + 2]!
        verts.add(a).add(b).add(c)
        union(a, b)
        union(b, c)
    }

    const compIndex = new Map<number, number>()
    const vPer: number[] = []
    const ePer: number[] = []
    const fPer: number[] = []
    const compOf = (v: number): number => {
        const root = find(v)
        let ci = compIndex.get(root)
        if (ci === undefined) {
            ci = compIndex.size
            compIndex.set(root, ci)
            vPer.push(0)
            ePer.push(0)
            fPer.push(0)
        }
        return ci
    }
    for (const v of verts) vPer[compOf(v)]!++
    for (const rec of edges.values()) ePer[compOf(rec.a)]!++
    for (let t = 0; t < triCount; t++) fPer[compOf(tris[t * 3]!)]!++

    const eulerPerComponent = vPer.map((v, i) => v - ePer[i]! + fPer[i]!)

    // Optional vertex-link check: at each vertex, opposite edges of incident
    // triangles must chain into a single closed cycle.
    let nonManifoldVertices = 0
    if (opts?.checkVertexLinks) {
        const fans = new Map<number, Array<[number, number]>>()
        for (let t = 0; t < triCount; t++) {
            const a = tris[t * 3]!
            const b = tris[t * 3 + 1]!
            const c = tris[t * 3 + 2]!
            for (const [v, p, q] of [
                [a, b, c],
                [b, c, a],
                [c, a, b],
            ] as const) {
                let fan = fans.get(v)
                if (!fan) {
                    fan = []
                    fans.set(v, fan)
                }
                fan.push([p, q])
            }
        }
        for (const fan of fans.values()) {
            // Walk successor links p→q; a single cycle visits every wedge once.
            const next = new Map<number, number>()
            let dup = false
            for (const [p, q] of fan) {
                if (next.has(p)) dup = true
                next.set(p, q)
            }
            if (dup || next.size !== fan.length) {
                nonManifoldVertices++
                continue
            }
            const start = fan[0]![0]
            let cur = start
            let steps = 0
            do {
                const n = next.get(cur)
                if (n === undefined) break
                cur = n
                steps++
            } while (cur !== start && steps <= fan.length)
            if (cur !== start || steps !== fan.length) nonManifoldVertices++
        }
    }

    return {
        ok: openEdges === 0 && nonManifoldEdges === 0 && misorientedEdges === 0 && nonManifoldVertices === 0,
        openEdges,
        nonManifoldEdges,
        misorientedEdges,
        nonManifoldVertices,
        components: compIndex.size,
        eulerPerComponent,
        badEdgeVertexIds,
    }
}
