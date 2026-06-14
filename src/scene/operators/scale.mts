import { CompileResult, decapitalize, fluent, Node, UnaryOperator, warpIsoResult } from "../base.mjs"
import { aabbScale, type AABB } from "../aabb.mjs"
import { Vec3, vec3 } from "../../vecmat/vector.mjs"
import { FeatureGraphBuilder, mat4FromScale } from "../feature-graph-buffer.mjs"

const MIN_ABS_SCALE = 1e-9

function clampAxis(v: number): number {
    const s = Math.sign(v === 0 ? 1 : v)
    return s * Math.max(Math.abs(v), MIN_ABS_SCALE)
}

export class Scale extends UnaryOperator {
    sx: number
    sy: number
    sz: number

    constructor(factors: Vec3, arg: Node) {
        super(arg)
        const f = vec3(factors)
        this.sx = clampAxis(f.x)
        this.sy = clampAxis(f.y)
        this.sz = clampAxis(f.z)
    }

    override getShapeType(): string { return "scale" }
    override getIndicatorSvg(): string {
        return `<path d="M1,11 L5,7 M11,1 L7,5 M7,11 L11,7 M1,5 L5,1" fill="none" stroke="currentColor" stroke-width="1.2"/>`
    }

    override getAllDescendantIds(): number[] {
        return [this.id, ...this.arg.getAllDescendantIds()]
    }

    private sVecWgsl(): string {
        const fmt = (v: number) => v.toFixed(10)
        return `vec3f(${fmt(this.sx)}, ${fmt(this.sy)}, ${fmt(this.sz)})`
    }

    override compile(indentLevel = 0): CompileResult {
        const svec = this.sVecWgsl()
        const childResult = this.arg.compile(indentLevel)
        const funcName = `Scale${this.id}`
        return warpIsoResult(this, funcName, decapitalize(funcName), childResult, `p / ${svec}`, c => `sdfScaleNormal(${c}, ${svec})`, "selectSDF")
    }

    override compileFast(indentLevel = 0): CompileResult {
        const svec = this.sVecWgsl()
        const childResult = this.arg.compileFast(indentLevel)
        const funcName = `Scale${this.id}`
        return warpIsoResult(this, funcName, `${decapitalize(funcName)}_f`, childResult, `p / ${svec}`, c => `sdfScaleFast(${c}, ${svec})`, "selectFast")
    }

    override compileMid(indentLevel = 0): CompileResult {
        const svec = this.sVecWgsl()
        const childResult = this.arg.compileMid(indentLevel)
        const funcName = `Scale${this.id}`
        return warpIsoResult(this, funcName, `${decapitalize(funcName)}_m`, childResult, `p / ${svec}`, c => `sdfScaleNormalMid(${c}, ${svec})`, "selectMid")
    }

    override computeBounds(): AABB | null {
        const childBounds = this.arg.computeBounds()
        if (!childBounds) return null
        return aabbScale(childBounds, this.sx, this.sy, this.sz)
    }

    override accumulateFeatureGraph(builder: FeatureGraphBuilder): void {
        builder.pushAffine(mat4FromScale(this.sx, this.sy, this.sz))
        try {
            this.arg.accumulateFeatureGraph(builder)
        } finally {
            builder.pop()
        }
    }
}

export const scale = fluent(function scale(factors: Vec3, node: Node): Scale {
    return new Scale(factors, node)
})
