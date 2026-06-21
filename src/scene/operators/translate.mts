import { CompileResult, decapitalize, fluent, Node, UnaryOperator, BVH_MIN_COST, warpIsoResult } from "../base.mjs"
import { type AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { vec3Wgsl } from "../scene-params.mjs"
import { Vec3, vec3 } from "../../vecmat/vector.mjs"
import { FeatureGraphBuilder, mat4FromTranslation } from "../feature-graph-buffer.mjs"

/** Rigid translation: evaluate child at `p - delta` (same as primitives with `.shift`). */
export class Translate extends UnaryOperator {
    dx: number
    dy: number
    dz: number

    constructor(offset: Vec3, arg: Node) {
        super(arg)
        const v = vec3(offset)
        this.dx = v.x
        this.dy = v.y
        this.dz = v.z
    }

    override getShapeType(): string {
        return "translate"
    }
    override getIndicatorSvg(): string {
        return `<path d="M2 6 L6 2 M6 2 L6 4 M6 2 L4 2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="9" cy="7" r="2.2" fill="none" stroke="currentColor" stroke-width="1"/>`
    }
    override getAllDescendantIds(): number[] {
        return [this.id, ...this.arg.getAllDescendantIds()]
    }

    protected override _computeCodegenCost(): number {
        return this.arg.codegenCost() + BVH_MIN_COST
    }

    protected override reserveUnarySceneParams(): void {
        this.paramOffset = this.scene.allocSceneParamFloats(3)
        this.paramCount = 3
        this.previewVec3Slot = this.scene.allocPreviewVec3(1)
    }

    override writeSceneParams(view: Float32Array): void {
        view[0] = this.dx
        view[1] = this.dy
        view[2] = this.dz
    }

    override writePreviewParams(out: PreviewParamsOut): void {
        const b = this.previewVec3Slot * 4
        out.vec3[b] = this.dx
        out.vec3[b + 1] = this.dy
        out.vec3[b + 2] = this.dz
        out.vec3[b + 3] = 0
    }

    private deltaWgsl(): string {
        return vec3Wgsl(this.paramOffset, this.previewVec3Slot)
    }

    override compile(indentLevel = 0): CompileResult {
        const childResult = this.arg.compile(indentLevel)
        const d = this.deltaWgsl()
        const funcName = `Translate${this.id}`
        return warpIsoResult(this, funcName, decapitalize(funcName), childResult, `p - ${d}`, c => c, "selectSDF")
    }

    override compileFast(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileFast(indentLevel)
        const d = this.deltaWgsl()
        const funcName = `Translate${this.id}`
        return warpIsoResult(this, funcName, `${decapitalize(funcName)}_f`, childResult, `p - ${d}`, c => c, "selectFast")
    }

    override compileMid(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileMid(indentLevel)
        const d = this.deltaWgsl()
        const funcName = `Translate${this.id}`
        return warpIsoResult(this, funcName, `${decapitalize(funcName)}_m`, childResult, `p - ${d}`, c => `sdfTranslateFeatureMid(${c}, p, ${d})`, "selectMid")
    }

    protected override computeBoundsCore(): AABB | null {
        const b = this.arg.computeBounds()
        if (!b) return null
        return {
            cx: b.cx + this.dx,
            cy: b.cy + this.dy,
            cz: b.cz + this.dz,
            hx: b.hx,
            hy: b.hy,
            hz: b.hz,
        }
    }

    override accumulateFeatureGraph(builder: FeatureGraphBuilder): void {
        builder.pushAffine(mat4FromTranslation(this.dx, this.dy, this.dz))
        try {
            this.arg.accumulateFeatureGraph(builder)
        } finally {
            builder.pop()
        }
    }
}

export const translate = fluent(function translate(a: Vec3 | number, b: Node | number, c?: number, d?: Node): Translate {
    return typeof a === "number" ? new Translate([a, b as number, c as number], d as Node) : new Translate(a, b as Node)
})

/**
 * Default `Node.prototype.shift` — `node.shift(v)` (or `node.shift(x, y, z)`) is `translate(v, node)` (rigid move).
 * Primitives (sphere, box, …) install their own `shift` on the subclass to update `pos` in place.
 */
;(Node.prototype as { shift?: (this: Node, v: Vec3 | number, y?: number, z?: number) => Translate }).shift = function (
    this: Node,
    v: Vec3 | number,
    y?: number,
    z?: number,
): Translate {
    return typeof v === "number" ? translate(v, y!, z!, this) : translate(v, this)
}
