import { Node, CompileResult, fluent, decapitalize, DEFAULT_POS } from "../base.mjs"
import { Vec3, vec3 } from "../../vecmat/vector.mjs"

export class Box extends Node {
    pos = vec3([0, 0, 0])
    size = vec3([0, 0, 0])
    argIndex = {
        pos: 0,
        size: 0,
    }

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

    override updateScene(writeBuffer: (index: number, data: Float32Array) => void): void {
        writeBuffer(this.argIndex.pos, this.pos.data)
        writeBuffer(this.argIndex.size, this.size.data)
    }
    override build() {
        super.build()
        this.argIndex.pos = this.scene.nextArgIndex()
        this.argIndex.size = this.scene.nextArgIndex()
    }
    override compile(indentLevel = 0): CompileResult {
        const funcName = `Box${this.id}`
        const varName = decapitalize(funcName)
        return {
            funcName,
            varName,
            text: `fBoxEx(p - ${this.pos.wgsl}, ${this.size.wgsl}, ${this.id}u)`,
        }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Box${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return {
            funcName,
            varName,
            text: `fBoxFast(p - ${this.pos.wgsl}, ${this.size.wgsl})`,
        }
    }

    @fluent override shift(v: Vec3): this {
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
