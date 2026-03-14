import { Node, CompileResult, fluent, decapitalize, DEFAULT_POS } from "../base.mjs"
import { Vec3, vec3 } from "../../vecmat/vector.mjs"

export class Sphere extends Node {
    pos = vec3([0, 0, 0])
    r = 0
    argIndex = {
        pos: 0,
        r: 0,
    }

    constructor(pos: Vec3, { r }: { r: number }) {
        super()
        this.pos = vec3(pos)
        this.r = r
    }

    override getShapeType(): string {
        return "sphere"
    }

    override getIndicatorSymbol(): string {
        return "●"
    }

    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="5" fill="currentColor"/>`
    }

    override updateScene(writeBuffer: (index: number, data: Float32Array) => void): void {
        writeBuffer(this.argIndex.pos, this.pos.data)
        writeBuffer(this.argIndex.r, new Float32Array([this.r]))
    }
    override build() {
        super.build()
        this.argIndex.pos = this.scene.nextArgIndex()
        this.argIndex.r = this.scene.nextArgIndex()
    }
    override compile(indentLevel = 0): CompileResult {
        const funcName = `Sphere${this.id}`
        const varName = decapitalize(funcName)
        return {
            funcName,
            varName,
            text: `fSphereEx(p - ${this.pos.wgsl}, ${this.r}, ${this.id}u)`,
        }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Sphere${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return {
            funcName,
            varName,
            text: `fSphereFast(p - ${this.pos.wgsl}, ${this.r})`,
        }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const funcName = `Sphere${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        return {
            funcName,
            varName,
            text: `fSphereMid(p - ${this.pos.wgsl}, ${this.r})`,
        }
    }

    @fluent shift(v: Vec3): this {
        this.pos = vec3(v)
        return this
    }
}

function sphereRadius(r: number): Sphere {
    return new Sphere(DEFAULT_POS, { r })
}

export const sphere = { radius: sphereRadius }
