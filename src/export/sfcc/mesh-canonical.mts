/**
 * Order-insensitive mesh comparison for SFCC tests.
 *
 * The SFCC output arrays (`verts`, `tris`) are deterministic in GEOMETRY and
 * TOPOLOGY, but a parallel (rayon) meshing pass is free to emit vertices and
 * triangles in any array order. These helpers canonicalize a mesh so that two
 * meshings of the same scene compare equal iff they describe the same surface
 * with the same winding — independent of vertex/triangle array order and of the
 * cyclic rotation of each triangle.
 *
 * Two intended uses:
 *  - Determinism guard (same implementation): compare two runs with `posEps = 0`
 *    (exact). A correct deterministic pipeline is bit-identical run-to-run, so
 *    any difference is a real nondeterminism bug, not FP noise.
 *  - Cross-implementation / refactor compare (e.g. TS vs Rust port): pass a
 *    small `posEps` to absorb ULP-level f64 differences while still catching any
 *    change in topology, winding, or a vertex moving by more than eps.
 *
 * Canonical form: the identity tuple (quantized position [+ normal]) of every
 * triangle-referenced vertex, deduped and sorted; triangles remapped onto that
 * order, each rotated so its smallest index is first (preserving winding), then
 * the triangle list sorted. Two meshes are equivalent iff their canonical forms
 * are identical.
 */

export interface MeshLike {
    readonly verts: ArrayLike<number>
    readonly tris: ArrayLike<number>
}

export interface CanonicalizeOptions {
    /** Floats per vertex. The SFCC/MeshData layout is 8 (pos, pad, normal, pad). */
    stride?: number
    /** Index of position.x within a vertex. Default 0. */
    posOffset?: number
    /** Index of normal.x within a vertex. Default 4. */
    normalOffset?: number
    /** Fold the normal into vertex identity (so a normal flip is a difference). Default false. */
    compareNormals?: boolean
    /** Position quantization grid. 0 (default) = exact bit-compare — the determinism guard. */
    posEps?: number
    /** Normal quantization grid. Defaults to 1e-4. */
    normalEps?: number
}

export interface CanonicalMesh {
    /** Sorted, unique vertex identity tuples (quantized pos [+ normal]). */
    readonly verts: readonly string[]
    /** Sorted, winding-preserving, min-rotated triangle index triples. */
    readonly tris: ReadonlyArray<readonly [number, number, number]>
}

export interface MeshDiff {
    equal: boolean
    reason?: string
}

function quant(v: number, eps: number): string {
    // String(-0) === "0", so signed zero collapses correctly with eps = 0 too.
    return eps <= 0 ? String(v) : String(Math.round(v / eps))
}

export function canonicalizeMesh(mesh: MeshLike, opts: CanonicalizeOptions = {}): CanonicalMesh {
    const stride = opts.stride ?? 8
    const posOff = opts.posOffset ?? 0
    const nrmOff = opts.normalOffset ?? 4
    const compareNormals = opts.compareNormals ?? false
    const posEps = opts.posEps ?? 0
    const nrmEps = opts.normalEps ?? 1e-4
    const { verts, tris } = mesh

    const identity = (vi: number): string => {
        const o = vi * stride
        let s =
            quant(verts[o + posOff]!, posEps) +
            "|" +
            quant(verts[o + posOff + 1]!, posEps) +
            "|" +
            quant(verts[o + posOff + 2]!, posEps)
        if (compareNormals) {
            s +=
                "|n|" +
                quant(verts[o + nrmOff]!, nrmEps) +
                "|" +
                quant(verts[o + nrmOff + 1]!, nrmEps) +
                "|" +
                quant(verts[o + nrmOff + 2]!, nrmEps)
        }
        return s
    }

    // Identity of every triangle-referenced vertex (ignores any unreferenced verts).
    const refIdentity = new Map<number, string>()
    for (let i = 0; i < tris.length; i++) {
        const vi = tris[i]!
        if (!refIdentity.has(vi)) refIdentity.set(vi, identity(vi))
    }

    // Canonical vertex order: unique identities, sorted.
    const sortedIds = [...new Set(refIdentity.values())].sort()
    const idToCanon = new Map<string, number>()
    sortedIds.forEach((id, idx) => idToCanon.set(id, idx))

    // Remap + canonicalize each triangle, then sort the triangle list.
    const outTris: Array<readonly [number, number, number]> = []
    for (let t = 0; t + 2 < tris.length; t += 3) {
        const a = idToCanon.get(refIdentity.get(tris[t]!)!)!
        const b = idToCanon.get(refIdentity.get(tris[t + 1]!)!)!
        const c = idToCanon.get(refIdentity.get(tris[t + 2]!)!)!
        outTris.push(rotateMin(a, b, c))
    }
    outTris.sort(cmpTri)

    return { verts: sortedIds, tris: outTris }
}

/** Rotate a triangle so its smallest index is first, preserving cyclic winding. */
function rotateMin(a: number, b: number, c: number): readonly [number, number, number] {
    if (a <= b && a <= c) return [a, b, c]
    if (b <= a && b <= c) return [b, c, a]
    return [c, a, b]
}

function cmpTri(x: readonly [number, number, number], y: readonly [number, number, number]): number {
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}

/** Compare two meshes for order-insensitive geometric + topological equivalence. */
export function meshesEquivalent(a: MeshLike, b: MeshLike, opts: CanonicalizeOptions = {}): MeshDiff {
    const ca = canonicalizeMesh(a, opts)
    const cb = canonicalizeMesh(b, opts)
    if (ca.verts.length !== cb.verts.length) {
        return { equal: false, reason: `vertex count: ${ca.verts.length} vs ${cb.verts.length}` }
    }
    if (ca.tris.length !== cb.tris.length) {
        return { equal: false, reason: `triangle count: ${ca.tris.length} vs ${cb.tris.length}` }
    }
    for (let i = 0; i < ca.verts.length; i++) {
        if (ca.verts[i] !== cb.verts[i]) {
            return { equal: false, reason: `vertex[${i}] differs: ${ca.verts[i]} vs ${cb.verts[i]}` }
        }
    }
    for (let i = 0; i < ca.tris.length; i++) {
        const x = ca.tris[i]!
        const y = cb.tris[i]!
        if (x[0] !== y[0] || x[1] !== y[1] || x[2] !== y[2]) {
            return { equal: false, reason: `triangle[${i}] differs: [${x}] vs [${y}]` }
        }
    }
    return { equal: true }
}
