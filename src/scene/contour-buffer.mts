/**
 * Centralised store for **explicit contour metadata** that scene primitives
 * carry alongside their SDF.
 *
 * Why this exists
 * ---------------
 * Every primitive in the scene tree was created from explicit geometric
 * data — a box has 12 edges + 8 corner points, a cylinder has two cap
 * rings, an extrude has its polygon outline, etc. The SDF compilation
 * pipeline collapses this into a single distance function and throws the
 * structural information away. This buffer keeps it alive so SHREC's
 * MergeSharp pass can use those features as **snap targets** during
 * vertex placement, producing clean edges and corners that no amount of
 * gradient-only QEF reconstruction can match.
 *
 * Storage shape
 * -------------
 * Per the design instruction "store contour information in a buffer and
 * pass around an index, not full data", every contour element lives in
 * one of three flat typed arrays — segments, points, rings — packed at a
 * fixed stride per kind. Cross-references and spatial indices use
 * **integer indices** into these arrays, never inline copies of the
 * geometry. This keeps:
 *   - Scene-tree → render-worker postMessage cheap (raw typed array transfer).
 *   - Future GPU uploads trivial (typed arrays map straight to storage buffers).
 *   - WGSL structs (if we ever expose contour info in shaders) thin —
 *     they only need to carry an `ownerId` / `index`, not a copy of the
 *     contour data itself.
 *
 * Per-node range map
 * ------------------
 * `nodeRanges` records, for each scene-node id, the start index and count
 * for that node's segments / points / rings within the flat arrays.
 * Lookups are by id; the data lives once in the buffer.
 *
 * AABBs
 * -----
 * The spatial index in `contour-snap.mts` is built from a per-element
 * AABB. We compute these once at insertion time and cache them in
 * parallel `_segBBox` / `_pointBBox` arrays so the spatial index doesn't
 * need to recompute them.
 */

import type { Vec3f } from "../vecmat/vector.mjs"

/** Segment stride = 6 floats (ax, ay, az, bx, by, bz). */
export const SEGMENT_STRIDE = 6

/** Point stride = 3 floats (x, y, z). */
export const POINT_STRIDE = 3

/** Ring stride = 7 floats (cx, cy, cz, axx, axy, axz, r). Reserved for cylinders/lathes. */
export const RING_STRIDE = 7

/** AABB stride = 6 floats (minX, minY, minZ, maxX, maxY, maxZ). */
export const AABB_STRIDE = 6

/**
 * Encoded contour kinds. Keep in sync with the spatial-index encoding in
 * `contour-snap.mts` (kind packed into the high bits of an int32 ref).
 */
export const enum ContourKind {
    Segment = 0,
    Point = 1,
    Ring = 2,
}

/** Index ranges into the flat arrays, recorded per scene-node id. */
export interface NodeContourRanges {
    segmentStart: number
    segmentCount: number
    pointStart: number
    pointCount: number
    ringStart: number
    ringCount: number
}

/** Optional metadata when opening a contour-recording block for a node. */
export interface BeginNodeOptions {
    /** When true, this node's contours are from a `Box` — used for pre-DC snap scoping. */
    box?: boolean
}

/**
 * Mutable builder: nodes call `addSegment` / `addPoint` / `addRing` between
 * `beginNode(id)` / `endNode()` calls. After all nodes have contributed,
 * `finish()` returns the immutable buffer view used by the rest of the
 * pipeline.
 */
export class ContourBuffer {
    private _segments: number[] = []
    private _segBBox: number[] = []
    private _segOwners: number[] = []

    private _points: number[] = []
    private _pointBBox: number[] = []
    private _pointOwners: number[] = []

    private _rings: number[] = []
    private _ringBBox: number[] = []
    private _ringOwners: number[] = []

    private _nodeRanges = new Map<number, NodeContourRanges>()

    private _currentNodeId: number | null = null
    private _currentRanges: NodeContourRanges | null = null

    /** Node ids whose contours were emitted from a `Box` primitive (see `BeginNodeOptions.box`). */
    private _boxContourOwnerIds = new Set<number>()

    // Builder API ---------------------------------------------------------

    /** Begin recording contours for a node. Must be paired with `endNode()`. */
    beginNode(id: number, opts?: BeginNodeOptions): void {
        if (this._currentNodeId !== null) {
            throw new Error(`ContourBuffer.beginNode(${id}): previous node ${this._currentNodeId} not yet ended`)
        }
        this._currentNodeId = id
        if (opts?.box) {
            this._boxContourOwnerIds.add(id)
        }
        this._currentRanges = {
            segmentStart: this._segOwners.length,
            segmentCount: 0,
            pointStart: this._pointOwners.length,
            pointCount: 0,
            ringStart: this._ringOwners.length,
            ringCount: 0,
        }
    }

    endNode(): void {
        if (this._currentNodeId === null || this._currentRanges === null) {
            throw new Error("ContourBuffer.endNode(): no open node")
        }
        // Only record the range if the node contributed at least one element;
        // empty entries waste a Map slot per node, which adds up across
        // smooth/blend operators that drop all child contours.
        if (
            this._currentRanges.segmentCount > 0 ||
            this._currentRanges.pointCount > 0 ||
            this._currentRanges.ringCount > 0
        ) {
            this._nodeRanges.set(this._currentNodeId, this._currentRanges)
        }
        this._currentNodeId = null
        this._currentRanges = null
    }

    addSegment(a: Vec3f, b: Vec3f): void {
        if (!this._currentRanges) throw new Error("ContourBuffer.addSegment(): no open node")
        this._segments.push(a.x, a.y, a.z, b.x, b.y, b.z)
        const minX = Math.min(a.x, b.x), minY = Math.min(a.y, b.y), minZ = Math.min(a.z, b.z)
        const maxX = Math.max(a.x, b.x), maxY = Math.max(a.y, b.y), maxZ = Math.max(a.z, b.z)
        this._segBBox.push(minX, minY, minZ, maxX, maxY, maxZ)
        this._segOwners.push(this._currentNodeId!)
        this._currentRanges.segmentCount++
    }

    addPoint(p: Vec3f): void {
        if (!this._currentRanges) throw new Error("ContourBuffer.addPoint(): no open node")
        this._points.push(p.x, p.y, p.z)
        // Point AABB collapses to its position; stored explicitly so the
        // spatial-index builder doesn't need a per-kind branch.
        this._pointBBox.push(p.x, p.y, p.z, p.x, p.y, p.z)
        this._pointOwners.push(this._currentNodeId!)
        this._currentRanges.pointCount++
    }

    addRing(center: Vec3f, axis: Vec3f, radius: number): void {
        if (!this._currentRanges) throw new Error("ContourBuffer.addRing(): no open node")
        this._rings.push(center.x, center.y, center.z, axis.x, axis.y, axis.z, radius)
        // Conservative ring AABB: a sphere of `radius` around `center`.
        // Tight axis-aware AABB would be smaller but not worth the math here;
        // the spatial index uses these only as candidate filters.
        const minX = center.x - radius, minY = center.y - radius, minZ = center.z - radius
        const maxX = center.x + radius, maxY = center.y + radius, maxZ = center.z + radius
        this._ringBBox.push(minX, minY, minZ, maxX, maxY, maxZ)
        this._ringOwners.push(this._currentNodeId!)
        this._currentRanges.ringCount++
    }

    /**
     * Collapse the per-kind growable arrays into immutable typed arrays.
     * Returns a view object used by the rest of the SHREC pipeline.
     */
    finish(): ContourBufferView {
        if (this._currentNodeId !== null) {
            throw new Error(`ContourBuffer.finish(): node ${this._currentNodeId} still open`)
        }
        const boxIds = [...this._boxContourOwnerIds].sort((a, b) => a - b)
        return {
            segments: Float32Array.from(this._segments),
            segmentBBox: Float32Array.from(this._segBBox),
            segmentOwners: Uint32Array.from(this._segOwners),
            segmentCount: this._segOwners.length,

            points: Float32Array.from(this._points),
            pointBBox: Float32Array.from(this._pointBBox),
            pointOwners: Uint32Array.from(this._pointOwners),
            pointCount: this._pointOwners.length,

            rings: Float32Array.from(this._rings),
            ringBBox: Float32Array.from(this._ringBBox),
            ringOwners: Uint32Array.from(this._ringOwners),
            ringCount: this._ringOwners.length,

            nodeRanges: this._nodeRanges,

            boxContourOwnerIds: Uint32Array.from(boxIds),
        }
    }
}

/**
 * Immutable read-only view of the contour buffer. This is what flows
 * through the worker boundary to SHREC.
 *
 * All numeric data lives in flat `Float32Array` / `Uint32Array` typed
 * arrays for cheap structured-clone transfer and (eventually) cheap GPU
 * upload. Cross-references — including the per-cell spatial index built
 * later in `contour-snap.mts` — use **integer indices** into these
 * arrays, not copies of the data.
 */
export interface ContourBufferView {
    /** Packed `[ax,ay,az,bx,by,bz]` per segment, stride `SEGMENT_STRIDE = 6`. */
    segments: Float32Array
    /** Packed `[minX,minY,minZ,maxX,maxY,maxZ]` per segment, stride `AABB_STRIDE = 6`. */
    segmentBBox: Float32Array
    /** Owner node id per segment. */
    segmentOwners: Uint32Array
    segmentCount: number

    /** Packed `[x,y,z]` per point, stride `POINT_STRIDE = 3`. */
    points: Float32Array
    pointBBox: Float32Array
    pointOwners: Uint32Array
    pointCount: number

    /** Packed `[cx,cy,cz,axx,axy,axz,r]` per ring, stride `RING_STRIDE = 7`. */
    rings: Float32Array
    ringBBox: Float32Array
    ringOwners: Uint32Array
    ringCount: number

    /** Per-node-id index ranges. Nodes that contributed nothing are absent. */
    nodeRanges: ReadonlyMap<number, NodeContourRanges>

    /**
     * Sorted unique scene-node ids that registered as box contour sources
     * (`beginNode(id, { box: true })`). Empty when no boxes contributed contours.
     */
    boxContourOwnerIds: Uint32Array
}

/** Empty buffer — short-circuit when the scene has no contour-aware primitives. */
export const EMPTY_CONTOUR_BUFFER: ContourBufferView = {
    segments: new Float32Array(0),
    segmentBBox: new Float32Array(0),
    segmentOwners: new Uint32Array(0),
    segmentCount: 0,
    points: new Float32Array(0),
    pointBBox: new Float32Array(0),
    pointOwners: new Uint32Array(0),
    pointCount: 0,
    rings: new Float32Array(0),
    ringBBox: new Float32Array(0),
    ringOwners: new Uint32Array(0),
    ringCount: 0,
    nodeRanges: new Map(),
    boxContourOwnerIds: new Uint32Array(0),
}
