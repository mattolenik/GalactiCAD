/**
 * Feature-aware meshing scaffold: per-primitive **explicit** corner/crease/cap
 * data, in **local space**, accompanied by the affine transform chain from each
 * primitive up to the scene root. This is the v1 input to the FeatureGraph
 * pipeline (extract → transform → subdivide → survival test → bin) that feeds
 * sharp-feature recovery in downstream meshers (MDC, iso-simplicial, SHREC).
 *
 * Why this exists alongside {@link ContourBuffer}
 * -----------------------------------------------
 * `ContourBuffer` bakes positions into **world space** at emission time and
 * carries no surface-normal or face-loop information — enough for SHREC's snap
 * pass, not enough for downstream meshers that need to (a) re-transform under a
 * known affine chain, (b) classify the dihedral at a crease, or (c) reconstruct
 * a planar cap. The builder here is the parallel pattern.
 *
 * Phase A scope (this file)
 * -------------------------
 * Builder + data layouts + transform-stack discipline only — no primitive yet
 * emits into it. Phase B adds the first primitive extractor (`Extrude`); Phase
 * C+ promotes the CPU snapshot to GPU storage buffers and runs the subdivide /
 * survival / bin stages.
 *
 * Non-affine warp policy (v1)
 * ---------------------------
 * Any `Twist` / `Bend` / `Taper` ancestor sets a non-affine flag on the active
 * transform-stack frame. Per-primitive emitters check
 * {@link FeatureGraphBuilder.hasNonAffineAncestor} and **skip emission**
 * entirely when true — local→world via affine matrix would produce incorrect
 * world positions under non-affine warps. Revisit when per-warp `warpPoint`
 * application lands.
 */

import type { Vec3f } from "../vecmat/vector.mjs"

// -----------------------------------------------------------------------------
// Bit layout for FGVertex.flags / FGEdge.flags / FGLoop.flags.
//
// `alive` is set on creation and cleared by the survival test (stage 4).
// `corner` distinguishes 0D features (vertex where 3+ surfaces meet) from
// 1D crease samples; corners receive a hard QEF constraint downstream while
// crease samples become soft directional hints. `crease_original` /
// `crease_subdivided` lets stage 3 / stage 4 distinguish primitive-supplied
// vertices from subdivision-inserted samples; downstream code may weight
// originals differently. `non_affine_ancestor` propagates from the transform
// stack into each emitted element so the subdivision pass (stage 3) can
// subdivide more aggressively in that subtree once per-warp `warpPoint` lands.
// -----------------------------------------------------------------------------

export const FG_FLAG_ALIVE = 1 << 0
export const FG_FLAG_CORNER = 1 << 1
export const FG_FLAG_CREASE_ORIGINAL = 1 << 2
export const FG_FLAG_CREASE_SUBDIVIDED = 1 << 3
export const FG_FLAG_NON_AFFINE_ANCESTOR = 1 << 4

/** A primitive may emit up to three source-face normals per vertex (a corner where three faces meet). */
export const FG_MAX_NORMALS_PER_VERTEX = 3

// -----------------------------------------------------------------------------
// CPU snapshot — packed typed arrays, ready for cheap GPU upload in phase C.
// -----------------------------------------------------------------------------

export interface FeatureGraphCpu {
    /**
     * Local-space vertex positions, stride 3 floats (x, y, z). World-space
     * positions are produced in stage 2 by applying
     * {@link transforms}`[transformIdx[i]]` to each `(x, y, z)`.
     */
    vertexPositions: Float32Array
    /** Bit-flags per vertex; see `FG_FLAG_*`. */
    vertexFlags: Uint32Array
    /** Number of source-face normals stored for this vertex (0..{@link FG_MAX_NORMALS_PER_VERTEX}). */
    vertexNormalCount: Uint32Array
    /**
     * Packed source-face normals, stride `3 * FG_MAX_NORMALS_PER_VERTEX` floats;
     * unused slots are zero. Local-space as emitted by the builder; rotated to
     * world space in place by stage 2 (`applyTransformsCpu`).
     */
    vertexNormals: Float32Array
    /** Index into {@link transforms} for this vertex. */
    vertexTransformIdx: Uint32Array
    /** Scene-node id that produced this vertex. */
    vertexOwnerNodeId: Uint32Array
    vertexCount: number

    /** Packed edge endpoints, stride 2 indices (va, vb) into the vertex arrays. */
    edgeEndpoints: Uint32Array
    /** Bit-flags per edge; see `FG_FLAG_*`. */
    edgeFlags: Uint32Array
    /** Index into {@link transforms} for this edge (typically matches both endpoints'). */
    edgeTransformIdx: Uint32Array
    /** Scene-node id that produced this edge. */
    edgeOwnerNodeId: Uint32Array
    edgeCount: number

    /**
     * Vertex-index loop bodies; each loop occupies a contiguous range of
     * indices. `loopIndexStart[l]` + `loopIndexCount[l]` slices this array.
     */
    loopVertexIndices: Uint32Array
    loopIndexStart: Uint32Array
    loopIndexCount: Uint32Array
    /** Local-space cap normal per loop, stride 3 floats. */
    loopNormals: Float32Array
    /** Index into {@link transforms} for this loop. */
    loopTransformIdx: Uint32Array
    /** Scene-node id that produced this loop. */
    loopOwnerNodeId: Uint32Array
    /** Bit-flags per loop; see `FG_FLAG_*`. */
    loopFlags: Uint32Array
    loopCount: number

    /**
     * 4x4 column-major affine matrices accumulated leaf→root, stride 16 floats.
     * One entry per distinct transform-stack snapshot taken at emission time.
     * Slot 0 is always the identity (the implicit root frame).
     */
    transforms: Float32Array
    /** Per-transform bit-flags; currently only `FG_FLAG_NON_AFFINE_ANCESTOR`. */
    transformFlags: Uint32Array
    transformCount: number
}

/** Convenient empty snapshot — used as the default return when no primitive emitted. */
export function emptyFeatureGraphCpu(): FeatureGraphCpu {
    return {
        vertexPositions: new Float32Array(0),
        vertexFlags: new Uint32Array(0),
        vertexNormalCount: new Uint32Array(0),
        vertexNormals: new Float32Array(0),
        vertexTransformIdx: new Uint32Array(0),
        vertexOwnerNodeId: new Uint32Array(0),
        vertexCount: 0,
        edgeEndpoints: new Uint32Array(0),
        edgeFlags: new Uint32Array(0),
        edgeTransformIdx: new Uint32Array(0),
        edgeOwnerNodeId: new Uint32Array(0),
        edgeCount: 0,
        loopVertexIndices: new Uint32Array(0),
        loopIndexStart: new Uint32Array(0),
        loopIndexCount: new Uint32Array(0),
        loopNormals: new Float32Array(0),
        loopTransformIdx: new Uint32Array(0),
        loopOwnerNodeId: new Uint32Array(0),
        loopFlags: new Uint32Array(0),
        loopCount: 0,
        // The implicit-root identity is always present so the slot-0 invariant
        // holds even on an empty snapshot.
        transforms: identityMat4(),
        transformFlags: new Uint32Array([0]),
        transformCount: 1,
    }
}

// -----------------------------------------------------------------------------
// Alive-feature enumeration — the canonical iteration order shared by the
// overlay's instance upload, the chain grouping, and the CPU hit-tester. The
// s-th alive edge returned here IS overlay instance index `s`; keeping this in
// one place guarantees the instance buffer, the chain `edgeInstanceToChain`
// map, and the hit-tester all agree on indexing.
// -----------------------------------------------------------------------------

/** Indices `e` of edges with `FG_FLAG_ALIVE`, ascending — overlay instance order. */
export function enumerateAliveEdges(cpu: FeatureGraphCpu): Uint32Array {
    const out: number[] = []
    for (let e = 0; e < cpu.edgeCount; e++) {
        if ((cpu.edgeFlags[e]! & FG_FLAG_ALIVE) !== 0) out.push(e)
    }
    return Uint32Array.from(out)
}

/** Vertex indices `v` that are alive *corners* (0D features), ascending — overlay corner-instance order. */
export function enumerateAliveCorners(cpu: FeatureGraphCpu): Uint32Array {
    const mask = FG_FLAG_ALIVE | FG_FLAG_CORNER
    const out: number[] = []
    for (let i = 0; i < cpu.vertexCount; i++) {
        if ((cpu.vertexFlags[i]! & mask) === mask) out.push(i)
    }
    return Uint32Array.from(out)
}

// -----------------------------------------------------------------------------
// Mat4 helpers — column-major Float32Array(16), matching WGSL `mat4x4f` layout.
// Kept local rather than reaching for `Mat4x4f` so the builder has no external
// runtime deps; the math is small and only runs at scene-build time.
// -----------------------------------------------------------------------------

function identityMat4(): Float32Array {
    const m = new Float32Array(16)
    m[0] = 1
    m[5] = 1
    m[10] = 1
    m[15] = 1
    return m
}

/** Multiply `a * b` (both column-major 4x4) into a new Float32Array. */
function mulMat4(a: Float32Array, b: Float32Array): Float32Array {
    const r = new Float32Array(16)
    for (let c = 0; c < 4; c++) {
        for (let row = 0; row < 4; row++) {
            let s = 0
            for (let k = 0; k < 4; k++) s += a[row + k * 4]! * b[k + c * 4]!
            r[row + c * 4] = s
        }
    }
    return r
}

export function mat4FromTranslation(dx: number, dy: number, dz: number): Float32Array {
    const m = identityMat4()
    m[12] = dx
    m[13] = dy
    m[14] = dz
    return m
}

export function mat4FromScale(sx: number, sy: number, sz: number): Float32Array {
    const m = new Float32Array(16)
    m[0] = sx
    m[5] = sy
    m[10] = sz
    m[15] = 1
    return m
}

/**
 * Build a 4x4 world-from-local rotation from `Rotate.getWgslMatrices().fwd`.
 *
 * The WGSL side packs flat 9-float arrays as *columns* (`mat3x3Wgsl`), so the
 * world-from-local rotation the GPU applies to normals is the flat `fwd`
 * array's triplets read as columns. This function writes those triplets
 * straight into the column-major 4x4 — NO transpose. (The previous version
 * transposed here, which made FeatureGraph features rotate inversely to the
 * GPU surface and get culled by the stage-4 survival test on rotated scenes;
 * see the SFCC transform-bake regression test that pins the two paths
 * together.)
 */
export function mat4FromRotationFwd(fwd: ArrayLike<number>): Float32Array {
    const m = new Float32Array(16)
    m[0] = fwd[0]!; m[1] = fwd[1]!; m[2] = fwd[2]!
    m[4] = fwd[3]!; m[5] = fwd[4]!; m[6] = fwd[5]!
    m[8] = fwd[6]!; m[9] = fwd[7]!; m[10] = fwd[8]!
    m[15] = 1
    return m
}

// -----------------------------------------------------------------------------
// Transform stack frame: the accumulated leaf→root matrix at this depth, plus a
// sticky non-affine flag inherited from any ancestor warp.
// -----------------------------------------------------------------------------

interface TransformFrame {
    accumulated: Float32Array
    nonAffineAncestor: boolean
}

// -----------------------------------------------------------------------------
// FeatureGraphBuilder
// -----------------------------------------------------------------------------

export class FeatureGraphBuilder {
    // Growable JS arrays during build; collapsed into typed arrays by finish().
    private _vertexPositions: number[] = []
    private _vertexFlags: number[] = []
    private _vertexNormalCount: number[] = []
    private _vertexNormals: number[] = []
    private _vertexTransformIdx: number[] = []
    private _vertexOwnerNodeId: number[] = []

    private _edgeEndpoints: number[] = []
    private _edgeFlags: number[] = []
    private _edgeTransformIdx: number[] = []
    private _edgeOwnerNodeId: number[] = []

    private _loopVertexIndices: number[] = []
    private _loopIndexStart: number[] = []
    private _loopIndexCount: number[] = []
    private _loopNormals: number[] = []
    private _loopTransformIdx: number[] = []
    private _loopOwnerNodeId: number[] = []
    private _loopFlags: number[] = []

    // Slot 0 reserved for the implicit-root identity. Subsequent slots are
    // interned per accumulated-matrix snapshot taken at emission time.
    private _transformMatrices: Float32Array[] = [identityMat4()]
    private _transformFlags: number[] = [0]

    private _stack: TransformFrame[] = [{ accumulated: identityMat4(), nonAffineAncestor: false }]

    /** Currently-open node id (set by `beginNode`); used to stamp owner ids. */
    private _currentNodeId: number | null = null

    // ---- Transform stack -----------------------------------------------------

    pushAffine(local: Float32Array): void {
        const top = this._stack[this._stack.length - 1]!
        this._stack.push({
            accumulated: mulMat4(top.accumulated, local),
            nonAffineAncestor: top.nonAffineAncestor,
        })
    }

    /**
     * Mark the rest of this subtree as living under a non-affine warp. The
     * accumulated matrix is unchanged (warps are not affine) — emitters check
     * {@link hasNonAffineAncestor} and skip emission for v1.
     */
    pushNonAffine(): void {
        const top = this._stack[this._stack.length - 1]!
        this._stack.push({
            accumulated: top.accumulated,
            nonAffineAncestor: true,
        })
    }

    pop(): void {
        if (this._stack.length <= 1) {
            throw new Error("FeatureGraphBuilder.pop(): underflow (root frame must remain on the stack)")
        }
        this._stack.pop()
    }

    hasNonAffineAncestor(): boolean {
        return this._stack[this._stack.length - 1]!.nonAffineAncestor
    }

    // ---- Per-node emission ---------------------------------------------------

    beginNode(id: number): void {
        if (this._currentNodeId !== null) {
            throw new Error(
                `FeatureGraphBuilder.beginNode(${id}): previous node ${this._currentNodeId} not yet ended`,
            )
        }
        this._currentNodeId = id
    }

    endNode(): void {
        if (this._currentNodeId === null) {
            throw new Error("FeatureGraphBuilder.endNode(): no open node")
        }
        this._currentNodeId = null
    }

    /**
     * Intern the current accumulated-transform frame into the transform table,
     * returning its index. Same content always returns the same slot so
     * primitives sharing a transform chain (e.g. a polygon's many corners under
     * one Translate) share a transform slot.
     */
    private _internCurrentTransform(): number {
        const top = this._stack[this._stack.length - 1]!
        const flags = top.nonAffineAncestor ? FG_FLAG_NON_AFFINE_ANCESTOR : 0
        // Linear scan is fine — transform tables stay small (one per
        // emission-bearing affine chain). Avoid a Map keyed on a 16-float
        // string which is both slower and allocates.
        for (let i = 0; i < this._transformMatrices.length; i++) {
            if (this._transformFlags[i] !== flags) continue
            if (matricesEqual(this._transformMatrices[i]!, top.accumulated)) return i
        }
        const idx = this._transformMatrices.length
        this._transformMatrices.push(new Float32Array(top.accumulated))
        this._transformFlags.push(flags)
        return idx
    }

    /**
     * Emit a vertex at local-space `posLocal` with the given flags and up to
     * {@link FG_MAX_NORMALS_PER_VERTEX} source-face normals (local-space).
     * Returns the vertex index for later edge/loop references.
     */
    emitVertex(
        posLocal: Vec3f,
        flags: number,
        normals: ReadonlyArray<Vec3f>,
    ): number {
        if (this._currentNodeId === null) {
            throw new Error("FeatureGraphBuilder.emitVertex(): no open node")
        }
        if (normals.length > FG_MAX_NORMALS_PER_VERTEX) {
            throw new Error(
                `FeatureGraphBuilder.emitVertex(): up to ${FG_MAX_NORMALS_PER_VERTEX} normals per vertex; got ${normals.length}`,
            )
        }
        const idx = this._vertexFlags.length
        this._vertexPositions.push(posLocal.x, posLocal.y, posLocal.z)
        this._vertexFlags.push(flags | FG_FLAG_ALIVE | this._stackNonAffineBit())
        this._vertexNormalCount.push(normals.length)
        for (let i = 0; i < FG_MAX_NORMALS_PER_VERTEX; i++) {
            const n = normals[i]
            if (n !== undefined) this._vertexNormals.push(n.x, n.y, n.z)
            else this._vertexNormals.push(0, 0, 0)
        }
        this._vertexTransformIdx.push(this._internCurrentTransform())
        this._vertexOwnerNodeId.push(this._currentNodeId)
        return idx
    }

    /** Emit an edge between two previously-emitted vertex indices. */
    emitEdge(va: number, vb: number, flags: number): number {
        if (this._currentNodeId === null) {
            throw new Error("FeatureGraphBuilder.emitEdge(): no open node")
        }
        const idx = this._edgeFlags.length
        this._edgeEndpoints.push(va, vb)
        this._edgeFlags.push(flags | FG_FLAG_ALIVE | this._stackNonAffineBit())
        this._edgeTransformIdx.push(this._internCurrentTransform())
        this._edgeOwnerNodeId.push(this._currentNodeId)
        return idx
    }

    /**
     * Emit a face loop: an ordered closed sequence of vertex indices bounding a
     * planar cap, with the cap's local-space outward normal.
     */
    emitLoop(vertexIndices: ReadonlyArray<number>, normalLocal: Vec3f, flags: number): number {
        if (this._currentNodeId === null) {
            throw new Error("FeatureGraphBuilder.emitLoop(): no open node")
        }
        const idx = this._loopFlags.length
        const start = this._loopVertexIndices.length
        for (const v of vertexIndices) this._loopVertexIndices.push(v)
        this._loopIndexStart.push(start)
        this._loopIndexCount.push(vertexIndices.length)
        this._loopNormals.push(normalLocal.x, normalLocal.y, normalLocal.z)
        this._loopTransformIdx.push(this._internCurrentTransform())
        this._loopOwnerNodeId.push(this._currentNodeId)
        this._loopFlags.push(flags | FG_FLAG_ALIVE | this._stackNonAffineBit())
        return idx
    }

    private _stackNonAffineBit(): number {
        return this._stack[this._stack.length - 1]!.nonAffineAncestor ? FG_FLAG_NON_AFFINE_ANCESTOR : 0
    }

    // ---- Finalisation --------------------------------------------------------

    finish(): FeatureGraphCpu {
        if (this._currentNodeId !== null) {
            throw new Error(`FeatureGraphBuilder.finish(): node ${this._currentNodeId} still open`)
        }
        if (this._stack.length !== 1) {
            throw new Error(
                `FeatureGraphBuilder.finish(): transform stack depth ${this._stack.length - 1} (expected 0 — unbalanced push/pop)`,
            )
        }
        const tMatrices = new Float32Array(this._transformMatrices.length * 16)
        for (let i = 0; i < this._transformMatrices.length; i++) {
            tMatrices.set(this._transformMatrices[i]!, i * 16)
        }
        return {
            vertexPositions: Float32Array.from(this._vertexPositions),
            vertexFlags: Uint32Array.from(this._vertexFlags),
            vertexNormalCount: Uint32Array.from(this._vertexNormalCount),
            vertexNormals: Float32Array.from(this._vertexNormals),
            vertexTransformIdx: Uint32Array.from(this._vertexTransformIdx),
            vertexOwnerNodeId: Uint32Array.from(this._vertexOwnerNodeId),
            vertexCount: this._vertexFlags.length,

            edgeEndpoints: Uint32Array.from(this._edgeEndpoints),
            edgeFlags: Uint32Array.from(this._edgeFlags),
            edgeTransformIdx: Uint32Array.from(this._edgeTransformIdx),
            edgeOwnerNodeId: Uint32Array.from(this._edgeOwnerNodeId),
            edgeCount: this._edgeFlags.length,

            loopVertexIndices: Uint32Array.from(this._loopVertexIndices),
            loopIndexStart: Uint32Array.from(this._loopIndexStart),
            loopIndexCount: Uint32Array.from(this._loopIndexCount),
            loopNormals: Float32Array.from(this._loopNormals),
            loopTransformIdx: Uint32Array.from(this._loopTransformIdx),
            loopOwnerNodeId: Uint32Array.from(this._loopOwnerNodeId),
            loopFlags: Uint32Array.from(this._loopFlags),
            loopCount: this._loopFlags.length,

            transforms: tMatrices,
            transformFlags: Uint32Array.from(this._transformFlags),
            transformCount: this._transformMatrices.length,
        }
    }
}

function matricesEqual(a: Float32Array, b: Float32Array): boolean {
    for (let i = 0; i < 16; i++) {
        if (a[i] !== b[i]) return false
    }
    return true
}
