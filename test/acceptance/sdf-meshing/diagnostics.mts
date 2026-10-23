/** Geometry-only inspection of saved output. No scene/SDF evaluator is involved. */
export interface TriangleDefect {
    triangle: number
    vertices: number[]
    positions: number[][]
    kind: "invalidIndex" | "nonfinite" | "coincidentCorners" | "collinear"
    longestEdge: number | null
    centroid: number[] | null
    featureCurves: number[]
}
export interface MeshDiagnostics {
    scope: string
    triangleCount: number
    invalidTriangles: number
    invalidPercent: number
    defectKinds: Record<string, number>
    defects: TriangleDefect[]
    defectBounds: number[] | null
    longestDefectEdge: number | null
    exactPositionWeld: { verticesBefore: number; verticesAfter: number; removedInvalidFaces: number; openEdges: number; nonManifoldEdges: number; misorientedEdges: number }
    curveConnectivity: Array<{ curveId: number; edges: number; indexedComponents: number; geometricComponents: number; indexedEndpoints: number; geometricEndpoints: number; collapsedEdges: number }>
    parameterGaps: Array<{ curveId: number; range: number[]; endpointChord: number | null; endpoints: number[][] | null; straightSegmentCoverage: { fullyCovered: boolean; uncovered: number[][]; coveringCurveIds: number[] } | null }>
    pointWitnesses: Array<{ id: string; position: number[]; tolerance: number; distance: number | null; closestPoint: number[] | null; triangle: number | null; passed: boolean }>
}

function closestPoint(p: number[], a: number[], b: number[], c: number[]): number[] {
    const sub = (a: number[], b: number[]) => a.map((x, i) => x - b[i])
    const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0)
    const add = (a: number[], b: number[], t: number) => a.map((x, i) => x + t * b[i])
    const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a), d1 = dot(ab, ap), d2 = dot(ac, ap)
    if (d1 <= 0 && d2 <= 0) return a
    const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp)
    if (d3 >= 0 && d4 <= d3) return b
    const vc = d1 * d4 - d3 * d2
    if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, ab, d1 / (d1 - d3))
    const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp)
    if (d6 >= 0 && d5 <= d6) return c
    const vb = d5 * d2 - d1 * d6
    if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, ac, d2 / (d2 - d6))
    const va = d3 * d6 - d5 * d4
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return add(b, sub(c, b), (d4 - d3) / (d4 - d3 + d5 - d6))
    const denominator = va + vb + vc
    if (denominator === 0) {
        const segments = [[a, b], [b, c], [c, a]].map(([x, y]) => { const d = sub(y, x), n = dot(d, d); return add(x, d, n ? Math.max(0, Math.min(1, dot(sub(p, x), d) / n)) : 0) })
        return segments.reduce((best, q) => Math.hypot(...sub(p, q)) < Math.hypot(...sub(p, best)) ? q : best)
    }
    return add(add(a, ab, vb / denominator), ac, vc / denominator)
}

// Every finite f32 is an integer multiple of 2^-149. Use that common unit so
// zero-area classification has no tolerance and cannot reject a small valid face.
function exactF32(bits: number): bigint | null {
    const exponent = (bits >>> 23) & 255, fraction = bits & 0x7fffff
    if (exponent === 255) return null
    const magnitude = BigInt(fraction | (exponent ? 0x800000 : 0)) << BigInt(exponent ? exponent - 1 : 0)
    return bits >>> 31 ? -magnitude : magnitude
}
function connectivity(edges: number[][]) {
    const graph = new Map<number, Set<number>>()
    for (const [a, b] of edges) {
        if (a === b) continue
        if (!graph.has(a)) graph.set(a, new Set())
        if (!graph.has(b)) graph.set(b, new Set())
        graph.get(a)!.add(b); graph.get(b)!.add(a)
    }
    const seen = new Set<number>(); let components = 0
    for (const first of graph.keys()) {
        if (seen.has(first)) continue
        components++
        const pending = [first]
        while (pending.length) {
            const v = pending.pop()!
            if (seen.has(v)) continue
            seen.add(v)
            for (const n of graph.get(v)!) if (!seen.has(n)) pending.push(n)
        }
    }
    return { components, endpoints: [...graph.values()].filter(s => s.size === 1).length }
}

export function inspectMesh(verts: Float32Array, tris: Uint32Array, features: Float64Array, issues: Array<{ curveId: number; kind: string; range: number[] }> = [], witnesses: Array<{ id: string; position: number[]; tolerance: number }> = []): MeshDiagnostics {
    if (verts.length % 8 || tris.length % 3 || features.length % 5) throw new Error("Invalid saved buffer layout")
    const n = verts.length / 8, bits = new Uint32Array(verts.buffer, verts.byteOffset, verts.length)
    const points = Array.from({ length: n }, (_, i) => [verts[8 * i], verts[8 * i + 1], verts[8 * i + 2]])
    const exact = Array.from({ length: n }, (_, i) => [0, 1, 2].map(k => exactF32(bits[8 * i + k])))
    const canonical = new Uint32Array(n), positions = new Map<string, number>()
    for (let i = 0; i < n; i++) {
        const key = [0, 1, 2].map(k => verts[i * 8 + k] === 0 ? 0 : bits[i * 8 + k]).join(",")
        if (!positions.has(key)) positions.set(key, positions.size)
        canonical[i] = positions.get(key)!
    }
    const curves = new Map<number, Array<{ a: number; b: number; start: number; end: number }>>()
    const memberships = new Map<number, Set<number>>()
    const edgeMemberships = new Map<string, Set<number>>()
    for (let i = 0; i < features.length; i += 5) {
        const [a, b, curveId, start, end] = Array.from(features.subarray(i, i + 5))
        if (![a, b, curveId].every(Number.isSafeInteger) || a < 0 || b < 0 || a >= n || b >= n || !Number.isFinite(start) || !Number.isFinite(end)) throw new Error("Invalid saved feature membership")
        if (!curves.has(curveId)) curves.set(curveId, [])
        curves.get(curveId)!.push({ a, b, start, end })
        const edgeKey = `${Math.min(a, b)}:${Math.max(a, b)}`
        if (!edgeMemberships.has(edgeKey)) edgeMemberships.set(edgeKey, new Set())
        edgeMemberships.get(edgeKey)!.add(curveId)
        for (const v of [a, b]) { if (!memberships.has(v)) memberships.set(v, new Set()); memberships.get(v)!.add(curveId) }
    }
    const defects: TriangleDefect[] = [], defectKinds: Record<string, number> = {}
    const pointWitnesses: MeshDiagnostics["pointWitnesses"] = witnesses.map(w => ({ ...w, distance: null, closestPoint: null, triangle: null, passed: false }))
    type EdgeUse = { count: number; balance: number; curves?: Set<number> }
    const edgeUses = new Map<string, EdgeUse>()
    const lines = new Map<string, Array<{ lo: number; hi: number; entry: EdgeUse }>>()
    const lineKey = (axis: number, p: number[]) => `${axis}:${p[(axis + 1) % 3]}:${p[(axis + 2) % 3]}`
    for (let t = 0; t < tris.length; t += 3) {
        const ids = Array.from(tris.subarray(t, t + 3))
        let kind: TriangleDefect["kind"] | undefined
        if (ids.some(i => i >= n)) kind = "invalidIndex"
        else if (ids.some(i => exact[i].some(x => x === null))) kind = "nonfinite"
        else {
            const [a, b, c] = ids.map(i => exact[i] as bigint[])
            const u = b.map((v, k) => v - a[k]), v = c.map((v, k) => v - a[k])
            if (u[1] * v[2] === u[2] * v[1] && u[2] * v[0] === u[0] * v[2] && u[0] * v[1] === u[1] * v[0]) {
                kind = new Set(ids.map(i => canonical[i])).size < 3 ? "coincidentCorners" : "collinear"
            }
        }
        if (kind) {
            const p = ids.map(i => points[i] ?? [NaN, NaN, NaN])
            const finite = p.flat().every(Number.isFinite)
            defects.push({ triangle: t / 3, vertices: ids, positions: p, kind,
                longestEdge: finite ? Math.max(...p.map((a, k) => Math.hypot(...a.map((v, j) => v - p[(k + 1) % 3][j])))) : null,
                centroid: finite ? [0, 1, 2].map(k => (p[0][k] + p[1][k] + p[2][k]) / 3) : null,
                featureCurves: [...new Set(ids.flatMap(i => [...(memberships.get(i) ?? [])]))].sort((a, b) => a - b) })
            defectKinds[kind] = (defectKinds[kind] ?? 0) + 1
            continue
        }
        for (const w of pointWitnesses) {
            const q = closestPoint(w.position, points[ids[0]], points[ids[1]], points[ids[2]])
            const distance = Math.hypot(...q.map((x, k) => x - w.position[k]))
            if (Number.isFinite(distance) && (w.distance === null || distance < w.distance)) {
                w.distance = distance; w.closestPoint = q; w.triangle = t / 3; w.passed = distance <= w.tolerance
            }
        }
        for (let k = 0; k < 3; k++) {
            const a = canonical[ids[k]], b = canonical[ids[(k + 1) % 3]], key = `${Math.min(a, b)}:${Math.max(a, b)}`
            const entry: EdgeUse = edgeUses.get(key) ?? { count: 0, balance: 0 }
            const pa = points[ids[k]], pb = points[ids[(k + 1) % 3]]
            if (entry.count === 0) {
                const axes = [0, 1, 2].filter(j => pa[j] !== pb[j])
                if (axes.length === 1) {
                    const axis = axes[0], lk = lineKey(axis, pa)
                    if (!lines.has(lk)) lines.set(lk, [])
                    lines.get(lk)!.push({ lo: Math.min(pa[axis], pb[axis]), hi: Math.max(pa[axis], pb[axis]), entry })
                }
            }
            for (const id of edgeMemberships.get(`${Math.min(ids[k], ids[(k + 1) % 3])}:${Math.max(ids[k], ids[(k + 1) % 3])}`) ?? []) {
                entry.curves ??= new Set(); entry.curves.add(id)
            }
            entry.count++; entry.balance += a < b ? 1 : -1; edgeUses.set(key, entry)
        }
    }
    const curveConnectivity = [...curves].sort(([a], [b]) => a - b).map(([curveId, edges]) => {
        const indexed = connectivity(edges.map(e => [e.a, e.b])), geometric = connectivity(edges.map(e => [canonical[e.a], canonical[e.b]]))
        return { curveId, edges: edges.length, indexedComponents: indexed.components, geometricComponents: geometric.components,
            indexedEndpoints: indexed.endpoints, geometricEndpoints: geometric.endpoints, collapsedEdges: edges.filter(e => canonical[e.a] === canonical[e.b]).length }
    })
    const parameterGaps = issues.filter(i => i.kind === "parameterGap").map(issue => {
        const es = curves.get(issue.curveId) ?? [], epsilon = Math.max(1, ...issue.range.map(Math.abs)) * 1e-9
        const endpoint = (t: number) => {
            for (const e of es) { if (Math.abs(e.start - t) <= epsilon) return points[e.a]; if (Math.abs(e.end - t) <= epsilon) return points[e.b] }
            return null
        }
        const a = endpoint(issue.range[0]), b = endpoint(issue.range[1])
        let straightSegmentCoverage: MeshDiagnostics["parameterGaps"][number]["straightSegmentCoverage"] = null
        if (a && b) {
            const axes = [0, 1, 2].filter(k => a[k] !== b[k])
            if (axes.length === 1) {
                const axis = axes[0], lo = Math.min(a[axis], b[axis]), hi = Math.max(a[axis], b[axis])
                const intervals = (lines.get(lineKey(axis, a)) ?? []).filter(e => e.hi > lo && e.lo < hi).sort((a, b) => a.lo - b.lo)
                let end = lo; const uncovered: number[][] = [], ids = new Set<number>()
                for (const e of intervals) {
                    const start = Math.max(lo, e.lo), stop = Math.min(hi, e.hi)
                    if (start > end) uncovered.push([end, start])
                    end = Math.max(end, stop)
                    for (const c of e.entry.curves ?? []) ids.add(c)
                }
                if (end < hi) uncovered.push([end, hi])
                straightSegmentCoverage = { fullyCovered: uncovered.length === 0, uncovered, coveringCurveIds: [...ids].sort((a, b) => a - b) }
            }
        }
        return { ...issue, endpoints: a && b ? [a, b] : null, endpointChord: a && b ? Math.hypot(...a.map((v, k) => v - b[k])) : null, straightSegmentCoverage }
    })
    const finiteDefects = defects.filter(d => d.centroid)
    const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
    for (const d of finiteDefects) for (const p of d.positions) for (let k = 0; k < 3; k++) { bounds[k] = Math.min(bounds[k], p[k]); bounds[k + 3] = Math.max(bounds[k + 3], p[k]) }
    return { scope: "Exact zero-area audit of stored f32 coordinates; diagnostic exact-position weld/drop only, no output repair or SDF evaluation",
        triangleCount: tris.length / 3, invalidTriangles: defects.length, invalidPercent: tris.length ? defects.length * 300 / tris.length : 0,
        defectKinds, defects, defectBounds: finiteDefects.length ? bounds : null,
        longestDefectEdge: finiteDefects.length ? finiteDefects.reduce((v, d) => Math.max(v, d.longestEdge!), 0) : null,
        exactPositionWeld: { verticesBefore: n, verticesAfter: positions.size, removedInvalidFaces: defects.length,
            openEdges: [...edgeUses.values()].filter(e => e.count === 1).length,
            nonManifoldEdges: [...edgeUses.values()].filter(e => e.count > 2).length,
            misorientedEdges: [...edgeUses.values()].filter(e => e.count === 2 && e.balance !== 0).length },
        curveConnectivity, parameterGaps, pointWitnesses }
}

export function diagnosticSummary(audit: MeshDiagnostics) {
    return { ...audit, defects: [...audit.defects].sort((a, b) => (b.longestEdge ?? 0) - (a.longestEdge ?? 0)).slice(0, 20), displayedDefects: Math.min(20, audit.defects.length) }
}
