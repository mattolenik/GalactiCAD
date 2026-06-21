import { Node, CompileResult, fluent, decapitalize, DEFAULT_POS } from "../base.mjs"
import { aabb, aabbRotate, type AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { vec3Wgsl } from "../scene-params.mjs"
import { Vec3, Vec3f, vec3 } from "../../vecmat/vector.mjs"
import { composeEuler, eulerMatrices } from "../transform-math.mjs"
import { rotate as rotateOp, type Rotate } from "../operators/rotate.mjs"
import type { ContourBuffer } from "../contour-buffer.mjs"
import {
    FG_FLAG_CORNER,
    FG_FLAG_CREASE_ORIGINAL,
    type FeatureGraphBuilder,
} from "../feature-graph-buffer.mjs"

export class Box extends Node {
    pos = vec3([0, 0, 0])
    size = vec3([0, 0, 0])
    /** Whether `.shift` has been applied — gates `.rotate` (pre-shift → local `rot`; post-shift → pivot operator). */
    #shifted = false

    constructor(pos: Vec3, size: Vec3) {
        super()
        this.pos = vec3(pos)
        this.size = vec3(size)
    }

    override getShapeType(): string {
        return "box"
    }

    override getIndicatorSymbol(): string {
        return "■"
    }

    override getIndicatorSvg(): string {
        return `<rect x="1" y="1" width="10" height="10" rx="1" fill="currentColor"/>`
    }

    override writeSceneParams(view: Float32Array): void {
        view.set(this.#paramSlice())
    }

    override writePreviewParams(out: PreviewParamsOut): void {
        let b = this.previewVec3Slot * 4
        out.vec3[b] = this.pos.data[0]!
        out.vec3[b + 1] = this.pos.data[1]!
        out.vec3[b + 2] = this.pos.data[2]!
        out.vec3[b + 3] = 0
        b = (this.previewVec3Slot + 1) * 4
        out.vec3[b] = this.size.data[0]!
        out.vec3[b + 1] = this.size.data[1]!
        out.vec3[b + 2] = this.size.data[2]!
        out.vec3[b + 3] = 0
        this.writeRotPreview(out)
    }

    #paramSlice(): Float32Array {
        // pos (3) + size (3) + rot inverse (9, contiguous via reservePrimitiveRot).
        const buf = new Float32Array(15)
        buf.set(this.pos.data, 0)
        buf.set(this.size.data, 3)
        this.writeRotScene(buf, 6)
        return buf
    }

    override build() {
        super.build()
        this.previewVec3Slot = this.scene.allocPreviewVec3(2)
        this.paramOffset = this.scene.allocSceneParamFloats(6)
        this.paramCount = 6
        this.reservePrimitiveRot() // +9 storage floats (contiguous) + 1 preview mat3
    }
    override compile(indentLevel = 0): CompileResult {
        const funcName = `Box${this.id}`
        const varName = decapitalize(funcName)
        const o = this.paramOffset
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        const half = vec3Wgsl(o + 3, this.previewVec3Slot + 1)
        return {
            funcName,
            varName,
            text: this.warpRot(`fBoxEx(p - ${pos}, ${half}, ${this.id}u)`, pos),
        }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Box${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        const o = this.paramOffset
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        const half = vec3Wgsl(o + 3, this.previewVec3Slot + 1)
        return {
            funcName,
            varName,
            text: this.warpRot(`fBoxFast(p - ${pos}, ${half})`, pos),
        }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const funcName = `Box${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        const o = this.paramOffset
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        const half = vec3Wgsl(o + 3, this.previewVec3Slot + 1)
        return {
            funcName,
            varName,
            text: this.warpRot(`sdfMidSetOwner(fBoxMid(p - ${pos}, ${half}), ${this.id}u)`, pos),
        }
    }

    protected override computeBoundsCore(): AABB {
        // Box rotated about its own center (pos) by `rot`: expand the AABB.
        const { fwd } = eulerMatrices(this.rot.x, this.rot.y, this.rot.z)
        const r = aabbRotate(aabb(0, 0, 0, this.size.x, this.size.y, this.size.z), fwd)
        return aabb(this.pos.x, this.pos.y, this.pos.z, r.hx, r.hy, r.hz)
    }

    /**
     * Emit the box's 12 edges and 8 corner points as snap targets for the
     * SHREC/MergeSharp pass. `pos` is the box center; `size` is the
     * **half-extents** (matches `fBoxEx(p - pos, size, …)` in the shader).
     *
     * No transforms are composed yet — for the first slice we assume the
     * box sits in world space (i.e. no enclosing `rotate` / `translate`
     * operator). Operator-side transform composition follows once the
     * box-only pipeline is verified visually.
     */
    override accumulateContours(builder: ContourBuffer): void {
        const cx = this.pos.x, cy = this.pos.y, cz = this.pos.z
        const hx = this.size.x, hy = this.size.y, hz = this.size.z
        // 8 world-space corners, indexed by the bit pattern of (z,y,x):
        //   000 = (-x,-y,-z)  001 = (+x,-y,-z)  ...  111 = (+x,+y,+z)
        const corners: Vec3f[] = [
            vec3([cx - hx, cy - hy, cz - hz]), // 0
            vec3([cx + hx, cy - hy, cz - hz]), // 1
            vec3([cx - hx, cy + hy, cz - hz]), // 2
            vec3([cx + hx, cy + hy, cz - hz]), // 3
            vec3([cx - hx, cy - hy, cz + hz]), // 4
            vec3([cx + hx, cy - hy, cz + hz]), // 5
            vec3([cx - hx, cy + hy, cz + hz]), // 6
            vec3([cx + hx, cy + hy, cz + hz]), // 7
        ]
        // 12 edges as corner-index pairs. Three groups of four parallel edges
        // (one group per axis), so MergeSharp's seam-tangent agreement check
        // automatically gets a strong signal along each box face.
        const EDGES: ReadonlyArray<readonly [number, number]> = [
            // 4 x-edges (along +x):
            [0, 1], [2, 3], [4, 5], [6, 7],
            // 4 y-edges (along +y):
            [0, 2], [1, 3], [4, 6], [5, 7],
            // 4 z-edges (along +z):
            [0, 4], [1, 5], [2, 6], [3, 7],
        ]
        builder.beginNode(this.id, { box: true })
        for (const [i, j] of EDGES) {
            builder.addSegment(corners[i]!, corners[j]!)
        }
        for (const c of corners) {
            builder.addPoint(c)
        }
        builder.endNode()
    }

    @fluent shift(v: Vec3 | number, y?: number, z?: number): this {
        this.pos = typeof v === "number" ? vec3(v, y!, z!) : vec3(v)
        this.#shifted = true
        return this
    }

    /**
     * `.rotate` BEFORE any `.shift` composes onto the local `rot` field (rotates
     * the box about its own center, param-only/live). AFTER a `.shift` it falls
     * back to a `Rotate` operator (the shift becomes the pivot), preserving the
     * historical chain-order semantics.
     */
    @fluent override rotate(v: Vec3 | number, ry?: number, rz?: number): Rotate {
        const r = typeof v === "number" ? vec3(v, ry!, rz!) : vec3(v)
        if (this.#shifted) return rotateOp(r, this)
        const c = composeEuler([this.rot.x, this.rot.y, this.rot.z], [r.x, r.y, r.z])
        this.rot = vec3(c[0], c[1], c[2])
        // Returns the mutated box itself (no node added); typed as the chain's
        // declared `Rotate` so `Box` stays a valid `Node` for the type system.
        return this as unknown as Rotate
    }

    /**
     * Emit the box's 8 corners, 12 edges, and 6 face loops with source-face
     * normals. Corners are 3-way meetings (`FG_FLAG_CORNER`), edges are
     * 2-way creases.
     *
     * Local-space convention: positions bake `this.pos` into the emitted
     * coords (same as `Extrude.accumulateFeatureGraph`); the transform stack
     * carries any enclosing `Translate`/`Rotate`/`Scale`. Non-affine
     * ancestors short-circuit emission for v1 (matches the Extrude policy).
     *
     * Face loops use a winding consistent with their outward normal — the
     * cross product of the first two consecutive edges agrees with the
     * stored normal so downstream meshers that care about orientation get a
     * coherent face.
     */
    override accumulateFeatureGraph(builder: FeatureGraphBuilder): void {
        if (builder.hasNonAffineAncestor()) return

        const cx = this.pos.x, cy = this.pos.y, cz = this.pos.z
        const hx = this.size.x, hy = this.size.y, hz = this.size.z

        // Six face outward normals, indexed by face axis (0=X, 1=Y, 2=Z) and
        // sign bit (0=negative, 1=positive). Reused for corners (3 per
        // vertex) and edges (2 per crease).
        const faceNormal = (axis: 0 | 1 | 2, signBit: 0 | 1): Vec3f => {
            const s = signBit ? 1 : -1
            if (axis === 0) return new Vec3f([s, 0, 0])
            if (axis === 1) return new Vec3f([0, s, 0])
            return new Vec3f([0, 0, s])
        }

        builder.beginNode(this.id)

        // 8 corners. Index packs (z, y, x) bits — same convention as
        // `accumulateContours`, kept identical so debug glyphs match across
        // both paths.
        const cornerIdx: number[] = new Array(8)
        for (let i = 0; i < 8; i++) {
            const xb = (i & 1) as 0 | 1
            const yb = ((i >> 1) & 1) as 0 | 1
            const zb = ((i >> 2) & 1) as 0 | 1
            const px = cx + (xb ? hx : -hx)
            const py = cy + (yb ? hy : -hy)
            const pz = cz + (zb ? hz : -hz)
            cornerIdx[i] = builder.emitVertex(
                new Vec3f([px, py, pz]),
                FG_FLAG_CREASE_ORIGINAL | FG_FLAG_CORNER,
                [faceNormal(0, xb), faceNormal(1, yb), faceNormal(2, zb)],
            )
        }

        // 12 edges. Each tuple is `[i, j, axis, signBitA, signBitB]` where
        // `axis` is the edge's varying axis and `signBitA/B` are the sign
        // bits of the two *perpendicular* axes (which determine the two
        // adjacent face normals).
        type EdgeSpec = readonly [number, number, 0 | 1 | 2, 0 | 1, 0 | 1]
        const EDGES: ReadonlyArray<EdgeSpec> = [
            // 4 x-edges (varies in X, perp = Y, Z)
            [0, 1, 0, 0, 0], [2, 3, 0, 1, 0], [4, 5, 0, 0, 1], [6, 7, 0, 1, 1],
            // 4 y-edges (varies in Y, perp = X, Z)
            [0, 2, 1, 0, 0], [1, 3, 1, 1, 0], [4, 6, 1, 0, 1], [5, 7, 1, 1, 1],
            // 4 z-edges (varies in Z, perp = X, Y)
            [0, 4, 2, 0, 0], [1, 5, 2, 1, 0], [2, 6, 2, 0, 1], [3, 7, 2, 1, 1],
        ]
        for (const [i, j, axis] of EDGES) {
            // For each edge, the two perp faces are the ones the edge sits
            // on. We don't store edge-normals on the FGEdge struct itself —
            // downstream classifiers read them from the endpoint vertices,
            // which already carry the 3 incident face normals (with the
            // edge's two perp faces being two of those three).
            void axis
            builder.emitEdge(cornerIdx[i]!, cornerIdx[j]!, FG_FLAG_CREASE_ORIGINAL)
        }

        // 6 face loops. Order chosen so `cross(edge0, edge1)` of the first
        // two consecutive edges agrees with the stored outward normal.
        const FACES: ReadonlyArray<readonly [readonly number[], Vec3f]> = [
            [[1, 3, 7, 5], new Vec3f([+1, 0, 0])],  // +X
            [[0, 4, 6, 2], new Vec3f([-1, 0, 0])],  // -X
            [[2, 6, 7, 3], new Vec3f([0, +1, 0])],  // +Y
            [[0, 1, 5, 4], new Vec3f([0, -1, 0])],  // -Y
            [[4, 5, 7, 6], new Vec3f([0, 0, +1])],  // +Z
            [[0, 2, 3, 1], new Vec3f([0, 0, -1])],  // -Z
        ]
        for (const [loop, normal] of FACES) {
            const indices = loop.map(corner => cornerIdx[corner]!)
            builder.emitLoop(indices, normal, FG_FLAG_CREASE_ORIGINAL)
        }

        builder.endNode()
    }
}

export function box(size: Vec3): Box
export function box(l: number, w: number, h: number): Box
export function box(sizeOrL: Vec3 | number, w?: number, h?: number): Box {
    if (typeof sizeOrL === "number" && typeof w === "number" && typeof h === "number") {
        return new Box(DEFAULT_POS, [sizeOrL, w, h])
    }
    return new Box(DEFAULT_POS, sizeOrL as Vec3)
}
