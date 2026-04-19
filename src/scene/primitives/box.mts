import { Node, CompileResult, fluent, decapitalize, DEFAULT_POS } from "../base.mjs"
import { aabb, type AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { vec3Wgsl } from "../scene-params.mjs"
import { Vec3, Vec3f, vec3 } from "../../vecmat/vector.mjs"
import type { ContourBuffer } from "../contour-buffer.mjs"

export class Box extends Node {
    pos = vec3([0, 0, 0])
    size = vec3([0, 0, 0])

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
    }

    #paramSlice(): Float32Array {
        const buf = new Float32Array(6)
        buf.set(this.pos.data, 0)
        buf.set(this.size.data, 3)
        return buf
    }

    override build() {
        super.build()
        this.previewVec3Slot = this.scene.allocPreviewVec3(2)
        this.paramOffset = this.scene.allocSceneParamFloats(6)
        this.paramCount = 6
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
            text: `fBoxEx(p - ${pos}, ${half}, ${this.id}u)`,
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
            text: `fBoxFast(p - ${pos}, ${half})`,
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
            text: `sdfMidSetOwner(fBoxMid(p - ${pos}, ${half}), ${this.id}u)`,
        }
    }

    protected override computeBoundsCore(): AABB {
        return aabb(this.pos.x, this.pos.y, this.pos.z, this.size.x, this.size.y, this.size.z)
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
        builder.beginNode(this.id)
        for (const [i, j] of EDGES) {
            builder.addSegment(corners[i]!, corners[j]!)
        }
        for (const c of corners) {
            builder.addPoint(c)
        }
        builder.endNode()
    }

    @fluent shift(v: Vec3): this {
        this.pos = vec3(v)
        return this
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
