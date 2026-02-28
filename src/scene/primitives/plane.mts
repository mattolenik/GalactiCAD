import { Node, CompileResult, fluent, decapitalize, DEFAULT_POS } from "../base.mjs"
import { Vec3, vec3, type Vec3f } from "../../vecmat/vector.mjs"

export class PlaneNode extends Node {
    pos = vec3([0, 0, 0])
    normal: Vec3f
    dist: number

    constructor(pos: Vec3, { n, dist = 0 }: { n: Vec3; dist?: number }) {
        super()
        this.pos = vec3(pos)
        this.normal = vec3(n).normalize()
        this.dist = dist
    }

    override getShapeType(): string { return "plane" }
    override getIndicatorSymbol(): string { return "▬" }
    override getIndicatorSvg(): string {
        return `<line x1="0" y1="6" x2="12" y2="6" stroke="currentColor" stroke-width="2"/>`
    }
    override updateScene(): void { }
    override compile(indentLevel = 0): CompileResult {
        const funcName = `Plane${this.id}`
        const varName = decapitalize(funcName)
        return { funcName, varName, text: `fPlaneEx(p - ${this.pos.wgsl}, ${this.normal.wgsl}, ${this.dist}, ${this.id}u)` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Plane${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return { funcName, varName, text: `fPlaneFast(p - ${this.pos.wgsl}, ${this.normal.wgsl}, ${this.dist})` }
    }

    @fluent withNormal(n: Vec3): this {
        this.normal = vec3(n).normalize()
        return this
    }
    @fluent withDist(d: number): this {
        this.dist = d
        return this
    }
    @fluent shift(v: Vec3): this {
        this.pos = vec3(v)
        return this
    }
}

function planeNormal(n: Vec3): PlaneNode {
    return new PlaneNode(DEFAULT_POS, { n: vec3(n) })
}

function planeDist(d: number): PlaneNode {
    return new PlaneNode(DEFAULT_POS, { n: vec3([0, 1, 0]), dist: d })
}

export const plane = { normal: planeNormal, dist: planeDist }
