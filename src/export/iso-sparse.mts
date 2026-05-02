/**
 * Sparse active-cell representation for ISO export Phase 5B.
 *
 * The dense ISO grid allocates one DualVertex slot per (corner | edge | face | cube)
 * in the bounding box, which scales like O(grid³). For surface-only meshes that's
 * 50–500× more memory than necessary — the iso surface only intersects a thin shell
 * of cells. This module:
 *
 * 1. (`ISOExport`) GPU dilation + stream-compact base cubes from `activeCellFlags`, then a
 *    small CPU readback of the dilated cube list only — no dense CPU walk of the bitmap.
 *    (`computeSparseDualSetsFromDilatedCubeLinears`; legacy `computeSparseDualSets` still
 *    implements CPU dilation from flags for tooling/tests.) Dilation uses Chebyshev
 *    distance ≤ 1 so every edge Pass 6 emits around has the four incident cube duals.
 * 2. Enumerates the union of (corners, X/Y/Z edges, XY/YZ/XZ faces, cubes) belonging
 *    to dilated cubes — the "sparse set".
 * 3. Builds compact lists (slot → linear cell index) used to drive Pass 2/3/4/5
 *    dispatches, and a single open-addressed hash table (key → absolute slot in
 *    `allDuals`) used by Pass 6 to look up duals by grid index.
 *
 * Hash key layout: `key = (cellType << 28) | (linearIdx & 0x0fffffff)`.
 *   cellType 0 = corner, 1 = X-edge, 2 = Y-edge, 3 = Z-edge,
 *            4 = XY-face, 5 = YZ-face, 6 = XZ-face, 7 = cube.
 *   linearIdx supports up to ~268 M cells per category (grid ≤ ~640³).
 *
 * Hash table: power-of-two size, ≥ 4× total slot count (≤ 25% load factor → very low
 * probe counts). Slot encoding: `vec2u(key, absoluteSlot)`, with `key = 0xffffffffu`
 * marking empty.
 */

export const SPARSE_HASH_KEY_EMPTY = 0xffffffff
export const SPARSE_HASH_KNUTH = 0x9e3779b1 // = 2654435761; matches WGSL helper

/** Cell type tag stored in the upper 4 bits of the hash key. */
export const CELL_TYPE_CORNER = 0
export const CELL_TYPE_EDGE_X = 1
export const CELL_TYPE_EDGE_Y = 2
export const CELL_TYPE_EDGE_Z = 3
export const CELL_TYPE_FACE_XY = 4
export const CELL_TYPE_FACE_YZ = 5
export const CELL_TYPE_FACE_XZ = 6
export const CELL_TYPE_CUBE = 7

export function makeSparseKey(cellType: number, linearIdx: number): number {
    return ((cellType & 0xf) << 28) | (linearIdx & 0x0fffffff)
}

export interface SparseDualSets {
    /** Slot → linear corner index (gridIdx in [0, dx*dy*dz)). */
    cornerCompactList: Uint32Array
    /** Slot → linear X-edge index (in [0, (dx-1)*dy*dz)). */
    edgeXCompactList: Uint32Array
    edgeYCompactList: Uint32Array
    edgeZCompactList: Uint32Array
    /** Slot → linear XY-face index (in [0, (dx-1)*(dy-1)*dz)). */
    faceXYCompactList: Uint32Array
    faceYZCompactList: Uint32Array
    faceXZCompactList: Uint32Array
    /** Slot → linear cube index (in [0, (dx-1)*(dy-1)*(dz-1))). */
    cubeCompactList: Uint32Array

    /** Absolute base slot for each category in the unified `allDuals` buffer. */
    cornerBase: number
    edgeXBase: number
    edgeYBase: number
    edgeZBase: number
    faceXYBase: number
    faceYZBase: number
    faceXZBase: number
    cubeBase: number

    /** Total `allDuals` slots = sum of all compact list lengths. */
    totalDualSlots: number

    /** Open-addressed hash table: interleaved (key, absoluteSlot) pairs; power-of-two entries. */
    hashTable: Uint32Array
    /** Number of (key, value) entries (= hashTable.length / 2). Power of two. */
    hashEntries: number
    /** `hashEntries - 1`, used as the slot mask in WGSL. */
    hashMask: number

    /** Per-step CPU timing in ms (alloc/dilate/enumerate/compact/hash). Set when DEBUG. */
    timingMs?: Record<string, number>
}

/**
 * Build sparse dual sets from **already dilated** base-cube linear indices
 * (`cx + cy*nx + cz*nx*ny`, `nx = dx-1`), as produced by GPU compaction (`isoGpuSparse*` passes).
 */
export function computeSparseDualSetsFromDilatedCubeLinears(
    dilatedCubeLinears: Uint32Array,
    dx: number,
    dy: number,
    dz: number,
): SparseDualSets {
    const nx = Math.max(0, dx - 1)
    const ny = Math.max(0, dy - 1)
    const nz = Math.max(0, dz - 1)
    const dxm1 = Math.max(1, dx - 1)
    const dym1 = Math.max(1, dy - 1)

    const _isoSparseT = (typeof performance !== "undefined" && performance.now)
        ? () => performance.now()
        : () => Date.now()
    const _t0 = _isoSparseT()
    const _times: Record<string, number> = {}
    const _mark = (label: string, prevTime: number): number => {
        const now = _isoSparseT()
        _times[label] = Math.round((now - prevTime) * 100) / 100
        return now
    }
    let _t = _t0

    const dilatedCubeCount = dilatedCubeLinears.length
    _t = _mark("fromGpuList", _t)

    const cornerFlags = new Uint8Array(dx * dy * dz)
    const edgeXFlags = new Uint8Array(dxm1 * dy * dz)
    const edgeYFlags = new Uint8Array(dx * dym1 * dz)
    const edgeZFlags = new Uint8Array(dx * dy * Math.max(1, dz - 1))
    const faceXYFlags = new Uint8Array(nx * ny * dz)
    const faceYZFlags = new Uint8Array(dx * ny * Math.max(1, dz - 1))
    const faceXZFlags = new Uint8Array(nx * dy * Math.max(1, dz - 1))
    const cornerRaw = new Uint32Array(Math.max(8, dilatedCubeCount * 8))
    const edgeXRaw = new Uint32Array(Math.max(4, dilatedCubeCount * 4))
    const edgeYRaw = new Uint32Array(Math.max(4, dilatedCubeCount * 4))
    const edgeZRaw = new Uint32Array(Math.max(4, dilatedCubeCount * 4))
    const faceXYRaw = new Uint32Array(Math.max(2, dilatedCubeCount * 2))
    const faceYZRaw = new Uint32Array(Math.max(2, dilatedCubeCount * 2))
    const faceXZRaw = new Uint32Array(Math.max(2, dilatedCubeCount * 2))
    let cornerN = 0, eXN = 0, eYN = 0, eZN = 0, fXYN = 0, fYZN = 0, fXZN = 0
    _t = _mark("flags-alloc", _t)

    for (let i = 0; i < dilatedCubeCount; i++) {
        const cubeIdx = dilatedCubeLinears[i]!
        const cx = cubeIdx % nx
        const cy = ((cubeIdx / nx) | 0) % ny
        const cz = (cubeIdx / (nx * ny)) | 0

        for (let dz1 = 0; dz1 <= 1; dz1++) {
            for (let dy1 = 0; dy1 <= 1; dy1++) {
                for (let dx1 = 0; dx1 <= 1; dx1++) {
                    const idx = (cx + dx1) + (cy + dy1) * dx + (cz + dz1) * dx * dy
                    if (cornerFlags[idx] === 0) {
                        cornerFlags[idx] = 1
                        cornerRaw[cornerN++] = idx
                    }
                }
            }
        }
        for (let dz1 = 0; dz1 <= 1; dz1++) {
            for (let dy1 = 0; dy1 <= 1; dy1++) {
                const idx = cx + (cy + dy1) * dxm1 + (cz + dz1) * dxm1 * dy
                if (edgeXFlags[idx] === 0) {
                    edgeXFlags[idx] = 1
                    edgeXRaw[eXN++] = idx
                }
            }
        }
        for (let dz1 = 0; dz1 <= 1; dz1++) {
            for (let dx1 = 0; dx1 <= 1; dx1++) {
                const idx = (cx + dx1) + cy * dx + (cz + dz1) * dx * dym1
                if (edgeYFlags[idx] === 0) {
                    edgeYFlags[idx] = 1
                    edgeYRaw[eYN++] = idx
                }
            }
        }
        for (let dy1 = 0; dy1 <= 1; dy1++) {
            for (let dx1 = 0; dx1 <= 1; dx1++) {
                const idx = (cx + dx1) + (cy + dy1) * dx + cz * dx * dy
                if (edgeZFlags[idx] === 0) {
                    edgeZFlags[idx] = 1
                    edgeZRaw[eZN++] = idx
                }
            }
        }
        for (let dz1 = 0; dz1 <= 1; dz1++) {
            const idx = cx + cy * nx + (cz + dz1) * nx * ny
            if (faceXYFlags[idx] === 0) {
                faceXYFlags[idx] = 1
                faceXYRaw[fXYN++] = idx
            }
        }
        for (let dx1 = 0; dx1 <= 1; dx1++) {
            const idx = (cx + dx1) + cy * dx + cz * dx * ny
            if (faceYZFlags[idx] === 0) {
                faceYZFlags[idx] = 1
                faceYZRaw[fYZN++] = idx
            }
        }
        for (let dy1 = 0; dy1 <= 1; dy1++) {
            const idx = cx + (cy + dy1) * nx + cz * nx * dy
            if (faceXZFlags[idx] === 0) {
                faceXZFlags[idx] = 1
                faceXZRaw[fXZN++] = idx
            }
        }
    }
    _t = _mark("enumerate", _t)

    const trim = (raw: Uint32Array, n: number): Uint32Array => {
        const out = new Uint32Array(n)
        out.set(raw.subarray(0, n))
        return out
    }
    const cornerCompactList = trim(cornerRaw, cornerN)
    const edgeXCompactList = trim(edgeXRaw, eXN)
    const edgeYCompactList = trim(edgeYRaw, eYN)
    const edgeZCompactList = trim(edgeZRaw, eZN)
    const faceXYCompactList = trim(faceXYRaw, fXYN)
    const faceYZCompactList = trim(faceYZRaw, fYZN)
    const faceXZCompactList = trim(faceXZRaw, fXZN)
    _t = _mark("compact", _t)
    const cubeCompactList = new Uint32Array(dilatedCubeLinears)

    let base = 0
    const cornerBase = base; base += cornerCompactList.length
    const edgeXBase = base; base += edgeXCompactList.length
    const edgeYBase = base; base += edgeYCompactList.length
    const edgeZBase = base; base += edgeZCompactList.length
    const faceXYBase = base; base += faceXYCompactList.length
    const faceYZBase = base; base += faceYZCompactList.length
    const faceXZBase = base; base += faceXZCompactList.length
    const cubeBase = base; base += cubeCompactList.length
    const totalDualSlots = base

    let hashEntries = 1
    // Keep average linear-probe chains well under the WGSL 256-iter lookup cap on large CAD meshes.
    const target = Math.max(64, totalDualSlots * 4)
    while (hashEntries < target) hashEntries <<= 1
    const hashMask = hashEntries - 1
    const hashTable = new Uint32Array(hashEntries * 2)
    hashTable.fill(0xffffffff)

    const insertHash = (key: number, slot: number) => {
        let probe = (Math.imul(key >>> 0, SPARSE_HASH_KNUTH) >>> 0) & hashMask
        for (let i = 0; i < 256; i++) {
            const base2 = probe * 2
            if (hashTable[base2] === 0xffffffff) {
                hashTable[base2] = key >>> 0
                hashTable[base2 + 1] = slot >>> 0
                return
            }
            probe = (probe + 1) & hashMask
        }
        throw new Error(
            `Sparse hash insert overflowed 256 probes at key=${key}, slot=${slot}; `
            + `entries=${hashEntries}, totalDualSlots=${totalDualSlots}`,
        )
    }

    const insertList = (list: Uint32Array, cellType: number, baseSlot: number) => {
        for (let i = 0; i < list.length; i++) {
            insertHash(makeSparseKey(cellType, list[i]!), baseSlot + i)
        }
    }
    insertList(cornerCompactList, CELL_TYPE_CORNER, cornerBase)
    insertList(edgeXCompactList, CELL_TYPE_EDGE_X, edgeXBase)
    insertList(edgeYCompactList, CELL_TYPE_EDGE_Y, edgeYBase)
    insertList(edgeZCompactList, CELL_TYPE_EDGE_Z, edgeZBase)
    insertList(faceXYCompactList, CELL_TYPE_FACE_XY, faceXYBase)
    insertList(faceYZCompactList, CELL_TYPE_FACE_YZ, faceYZBase)
    insertList(faceXZCompactList, CELL_TYPE_FACE_XZ, faceXZBase)
    insertList(cubeCompactList, CELL_TYPE_CUBE, cubeBase)
    _t = _mark("hash", _t)

    return {
        cornerCompactList,
        edgeXCompactList,
        edgeYCompactList,
        edgeZCompactList,
        faceXYCompactList,
        faceYZCompactList,
        faceXZCompactList,
        cubeCompactList,
        cornerBase,
        edgeXBase,
        edgeYBase,
        edgeZBase,
        faceXYBase,
        faceYZBase,
        faceXZBase,
        cubeBase,
        totalDualSlots,
        hashTable,
        hashEntries,
        hashMask,
        timingMs: _times,
    }
}

/**
 * Build the sparse dual sets from the bit-packed active-cell flags. Active cubes are
 * dilated by 1 (each cube + 26 neighbors) before enumerating their corners/edges/faces.
 *
 * Indexing conventions (must match `iso.wgsl`):
 *   corner @ (x, y, z)         = x + y*dx + z*dx*dy            ; 0 ≤ x < dx, 0 ≤ y < dy, 0 ≤ z < dz
 *   X-edge @ (x, y, z)→(x+1)   = x + y*(dx-1) + z*(dx-1)*dy    ; 0 ≤ x < dx-1
 *   Y-edge @ (x, y, z)→(y+1)   = x + y*dx + z*dx*(dy-1)        ; 0 ≤ y < dy-1
 *   Z-edge @ (x, y, z)→(z+1)   = x + y*dx + z*dx*dy            ; 0 ≤ z < dz-1
 *   XY-face @ (x, y, z)        = x + y*(dx-1) + z*(dx-1)*(dy-1); cubes (cx, cy, cz-1) & (cx, cy, cz) sharing
 *   YZ-face @ (x, y, z)        = x + y*dx + z*dx*(dy-1)
 *   XZ-face @ (x, y, z)        = x + y*(dx-1) + z*(dx-1)*dy
 *   cube @ (x, y, z)           = x + y*(dx-1) + z*(dx-1)*(dy-1); 0 ≤ x < dx-1, etc.
 */
export function computeSparseDualSets(
    activeCellFlags: Uint32Array,
    dx: number,
    dy: number,
    dz: number,
): SparseDualSets {
    const nx = Math.max(0, dx - 1)
    const ny = Math.max(0, dy - 1)
    const nz = Math.max(0, dz - 1)
    const dxm1 = Math.max(1, dx - 1)
    const dym1 = Math.max(1, dy - 1)

    // Diagnostic: per-step timing logged via console.timeStamp / console.log if available.
    // Total time is also logged from the caller; this gives us per-section breakdowns when
    // the IsoExport debug log is enabled.
    const _isoSparseT = (typeof performance !== "undefined" && performance.now)
        ? () => performance.now()
        : () => Date.now()
    const _t0 = _isoSparseT()
    const _times: Record<string, number> = {}
    const _mark = (label: string, prevTime: number): number => {
        const now = _isoSparseT()
        _times[label] = Math.round((now - prevTime) * 100) / 100
        return now
    }
    let _t = _t0

    // Approach: dilate the active cube set into a sparse Uint32Array (with a small bit-flag
    // array for in-loop dedup), then iterate that LIST to enumerate downstream categories
    // into Uint32Arrays (with overcount). Finally sort + unique each list. Avoids any
    // O(grid³) iteration; total cost is ~O(activeCubes) plus sort time.

    // Bit flags only used for dedup during dilation — the list version is what we walk later.
    const cubeFlags = new Uint8Array(nx * ny * nz)

    // Upper bound for dilated cube list: each active cube contributes ≤ 27 entries (itself
    // + 26 neighbors). We'll trim after building.
    const activePopcount = (() => {
        let c = 0
        for (let i = 0; i < activeCellFlags.length; i++) {
            let v = activeCellFlags[i]! >>> 0
            v = v - ((v >>> 1) & 0x55555555)
            v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
            c += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
        }
        return c
    })()
    const dilatedCubeListMax = activePopcount * 27
    const dilatedCubeList = new Uint32Array(dilatedCubeListMax)
    let dilatedCubeCount = 0
    _t = _mark("popcount+alloc", _t)

    // Step 1: dilate the active cube set (each active cube + 26 neighbors). Each set bit
    // in `activeCellFlags` is a corner-linear index that Pass 1 marked as a valid cube
    // min-corner — see Pass 1 in iso.wgsl.
    for (let block = 0; block < activeCellFlags.length; block++) {
        let v = activeCellFlags[block]! >>> 0
        while (v !== 0) {
            const lsb = (v & -v) >>> 0
            const bit = 31 - Math.clz32(lsb)
            const cellFlatIndex = block * 32 + bit
            v = (v ^ lsb) >>> 0
            const cx = cellFlatIndex % dx
            const cy = ((cellFlatIndex / dx) | 0) % dy
            const cz = (cellFlatIndex / (dx * dy)) | 0
            for (let dz1 = -1; dz1 <= 1; dz1++) {
                const z = cz + dz1
                if (z < 0 || z >= nz) continue
                for (let dy1 = -1; dy1 <= 1; dy1++) {
                    const y = cy + dy1
                    if (y < 0 || y >= ny) continue
                    const yzBase = y * nx + z * nx * ny
                    for (let dx1 = -1; dx1 <= 1; dx1++) {
                        const x = cx + dx1
                        if (x < 0 || x >= nx) continue
                        const idx = x + yzBase
                        if (cubeFlags[idx] === 0) {
                            cubeFlags[idx] = 1
                            dilatedCubeList[dilatedCubeCount++] = idx
                        }
                    }
                }
            }
        }
    }

    _t = _mark("dilate", _t)

    const dilatedSlice = dilatedCubeList.subarray(0, dilatedCubeCount)
    const inner = computeSparseDualSetsFromDilatedCubeLinears(
        new Uint32Array(dilatedSlice.buffer, dilatedSlice.byteOffset, dilatedSlice.length),
        dx,
        dy,
        dz,
    )
    return {
        ...inner,
        timingMs: { ..._times, ...inner.timingMs },
    }
}
