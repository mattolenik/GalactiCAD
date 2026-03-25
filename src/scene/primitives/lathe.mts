import { Node, CompileResult, decapitalize, fluent, BVH_MIN_COST, DEFAULT_POS } from "../base.mjs"
import { aabb, type AABB } from "../aabb.mjs"
import { spVec3Wgsl } from "../scene-params.mjs"
import { Vec3, vec3, Vec3f } from "../../vecmat/vector.mjs"
import { Polygon2D } from "./polygon2d.mjs"

/**
 * Revolves a 2D SDF profile around the Y axis to create a solid of revolution.
 */
export class Lathe extends Node {
    pos = new Vec3f()
    child: Polygon2D

    constructor(child: Polygon2D)
    constructor(pos: Vec3, child: Polygon2D)
    constructor(...args: any[]) {
        super()
        if (args[0] instanceof Polygon2D) {
            this.pos = new Vec3f()
            this.child = args[0]
        } else {
            this.pos = vec3(args[0])
            this.child = args[1]
        }
    }

    override getShapeType(): string { return "lathe" }
    override getIndicatorSymbol(): string { return "◐" }

    protected override _computeCodegenCost(): number {
        return this.child.codegenCost() + BVH_MIN_COST
    }
    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="6" y1="1" x2="6" y2="11" stroke="currentColor" stroke-width="1" stroke-dasharray="2,1"/>`
    }
    override writeSceneParams(view: Float32Array): void {
        view.set(this.pos.data)
    }

    override build() {
        super.build()
        this.paramOffset = this.scene.allocSceneParamFloats(3)
        this.paramCount = 3
        this.child.root = this.root
        this.child.build()
    }

    override appendStructuralFingerprint(parts: string[]): void {
        parts.push(`${this.getShapeType()}:${this.structuralBvhSlot()}`)
        this.child.appendStructuralFingerprint(parts)
    }

    override getAllDescendantIds(): number[] {
        return [this.id, ...this.child.getAllDescendantIds()]
    }

    get wgslExFuncName(): string { return `fLathe_${this.id}_Ex` }
    get wgslFastFuncName(): string { return `fLathe_${this.id}_Fast` }
    get wgslMidFuncName(): string { return `fLathe_${this.id}_Mid` }

    override compileAux(): string {
        const combinedFunc = this.child.wgslCombinedFuncName

        return `
fn ${this.wgslExFuncName}(p: vec3f, id: u32) -> SDFResult {
    let r = length(p.xz);
    let q = vec2f(r, p.y);
    let combined = ${combinedFunc}(q);
    let d = combined.x;
    let g2d = combined.zw;
    var radDir = vec2f(1.0, 0.0);
    if (r > 1e-8) {
        radDir = p.xz / r;
    }
    let n = safeNormalize(vec3f(g2d.x * radDir.x, g2d.y, g2d.x * radDir.y), vec3f(0.0, 1.0, 0.0));
    return sdfTrue(d, id, n);
}
`
    }

    override compileAuxMid(): string {
        const combinedFunc = this.child.wgslCombinedFuncName
        return `
fn ${this.wgslMidFuncName}(p: vec3f) -> SDFResultMid {
    let r = length(p.xz);
    let q = vec2f(r, p.y);
    let combined = ${combinedFunc}(q);
    let d = combined.x;
    let g2d = combined.zw;
    var radDir = vec2f(1.0, 0.0);
    if (r > 1e-8) {
        radDir = p.xz / r;
    }
    let n = safeNormalize(vec3f(g2d.x * radDir.x, g2d.y, g2d.x * radDir.y), vec3f(0.0, 1.0, 0.0));
    return sdfRMid(d, 1.0, n);
}
`
    }

    override compileAuxFast(): string {
        const childFunc = this.child.wgslFuncName
        return `
fn ${this.wgslFastFuncName}(p: vec3f) -> FastSDFResult {
    let q = vec2f(length(p.xz), p.y);
    return sdfFast(${childFunc}(q), 1.0, 1.0);
}
`
    }

    override compile(indentLevel = 0): CompileResult {
        const funcName = `Lathe${this.id}`
        const varName = decapitalize(funcName)
        const pos = spVec3Wgsl(this.paramOffset)
        return {
            funcName,
            varName,
            text: `${this.wgslExFuncName}(p - ${pos}, ${this.id}u)`,
        }
    }

    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Lathe${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        const pos = spVec3Wgsl(this.paramOffset)
        return {
            funcName,
            varName,
            text: `${this.wgslFastFuncName}(p - ${pos})`,
        }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const funcName = `Lathe${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        const pos = spVec3Wgsl(this.paramOffset)
        return {
            funcName,
            varName,
            text: `${this.wgslMidFuncName}(p - ${pos})`,
        }
    }

    override computeBounds(): AABB {
        // Profile vertices are (r, y) in lathe space; revolve around Y
        let maxR = 0, minY = 0, maxY = 0
        for (const [r, y] of this.child.vertices) {
            maxR = Math.max(maxR, Math.abs(r))
            minY = Math.min(minY, y)
            maxY = Math.max(maxY, y)
        }
        const cy = (minY + maxY) * 0.5
        const hy = (maxY - minY) * 0.5
        return aabb(this.pos.x, this.pos.y + cy, this.pos.z, maxR, hy, maxR)
    }

    @fluent shift(v: Vec3): this {
        this.pos = vec3(v)
        return this
    }
}

function latheProfile(profile: Polygon2D): Lathe {
    return new Lathe(DEFAULT_POS, profile)
}

export const lathe = { profile: latheProfile }
