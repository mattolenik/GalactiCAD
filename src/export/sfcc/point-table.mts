/**
 * Global point table for SFCC meshing.
 *
 * Every mesh vertex (edge iso-crossing, cell interior vertex, and later
 * feature face-pins / corners / polyline points) is created exactly once,
 * keyed by integer provenance, and shared by id across all consuming faces
 * and cells — float positions are payload, never keys. This is what makes
 * the CMS face-sharing invariant and the S4 audits exact.
 *
 * Numeric provenance keys (f64-exact integers):
 *   latticeKey·8 + axis(0|1|2)  — iso-crossing on the minimal edge whose min
 *                                  corner is `latticeKey`, running along `axis`
 *   latticeKey·8 + 3            — interior vertex of the leaf cell whose min
 *                                  corner is `latticeKey` (unique among leaves)
 * Rare composite provenances (feature points) use the string map.
 */

export const POINT_KEY_INTERIOR = 3

export function crossingKey(latticeKey: number, axis: 0 | 1 | 2): number {
    return latticeKey * 8 + axis
}

export function interiorKey(latticeKey: number): number {
    return latticeKey * 8 + POINT_KEY_INTERIOR
}

export class PointTable {
    #pos: number[] = []
    #normal: number[] = []
    #byNumKey = new Map<number, number>()
    #byStrKey = new Map<string, number>()

    get count(): number {
        return this.#pos.length / 3
    }

    /** Create an unkeyed point (cell-owned, e.g. feature polyline samples). */
    add(x: number, y: number, z: number, nx: number, ny: number, nz: number): number {
        const id = this.#pos.length / 3
        this.#pos.push(x, y, z)
        this.#normal.push(nx, ny, nz)
        return id
    }

    /** Get the id for a numeric provenance key, creating the point on first use. */
    getOrCreate(key: number, create: (out: Float64Array) => void): number {
        const hit = this.#byNumKey.get(key)
        if (hit !== undefined) return hit
        const buf = new Float64Array(6)
        create(buf)
        const id = this.add(buf[0]!, buf[1]!, buf[2]!, buf[3]!, buf[4]!, buf[5]!)
        this.#byNumKey.set(key, id)
        return id
    }

    /** Lookup without creating. */
    lookup(key: number): number | undefined {
        return this.#byNumKey.get(key)
    }

    getOrCreateStr(key: string, create: (out: Float64Array) => void): number {
        const hit = this.#byStrKey.get(key)
        if (hit !== undefined) return hit
        const buf = new Float64Array(6)
        create(buf)
        const id = this.add(buf[0]!, buf[1]!, buf[2]!, buf[3]!, buf[4]!, buf[5]!)
        this.#byStrKey.set(key, id)
        return id
    }

    lookupStr(key: string): number | undefined {
        return this.#byStrKey.get(key)
    }

    x(id: number): number {
        return this.#pos[id * 3]!
    }

    y(id: number): number {
        return this.#pos[id * 3 + 1]!
    }

    z(id: number): number {
        return this.#pos[id * 3 + 2]!
    }

    /** Overwrite a point's normal (used when a better analytic normal becomes known). */
    setNormal(id: number, nx: number, ny: number, nz: number): void {
        this.#normal[id * 3] = nx
        this.#normal[id * 3 + 1] = ny
        this.#normal[id * 3 + 2] = nz
    }

    /**
     * Compact to the points referenced by `tris` and emit the MeshData vertex
     * layout (8 floats: pos + pad + normal + pad). Returns the remapped
     * triangle index buffer alongside.
     */
    buildMesh(tris: readonly number[]): { verts: Float32Array<ArrayBuffer>; tris: Uint32Array<ArrayBuffer> } {
        const remap = new Map<number, number>()
        for (const id of tris) {
            if (!remap.has(id)) remap.set(id, remap.size)
        }
        const verts = new Float32Array(remap.size * 8)
        for (const [id, slot] of remap) {
            const o = slot * 8
            verts[o] = this.#pos[id * 3]!
            verts[o + 1] = this.#pos[id * 3 + 1]!
            verts[o + 2] = this.#pos[id * 3 + 2]!
            verts[o + 4] = this.#normal[id * 3]!
            verts[o + 5] = this.#normal[id * 3 + 1]!
            verts[o + 6] = this.#normal[id * 3 + 2]!
        }
        const outTris = new Uint32Array(tris.length)
        for (let i = 0; i < tris.length; i++) outTris[i] = remap.get(tris[i]!)!
        return { verts, tris: outTris }
    }
}
