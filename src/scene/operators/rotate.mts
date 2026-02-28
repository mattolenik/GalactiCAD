import { UnaryOperator, CompileResult, decapitalize } from "../base.mjs"
import { Vec3, vec3 } from "../../vecmat/vector.mjs"

export class Rotate extends UnaryOperator {
    rx: number
    ry: number
    rz: number

    constructor(rotation: Vec3, arg: import("../base.mjs").Node) {
        super(arg)
        const r = vec3(rotation)
        this.rx = r.x
        this.ry = r.y
        this.rz = r.z
    }

    override getShapeType(): string { return "rotate" }
    override getIndicatorSymbol(): string { return "↻" }
    override getIndicatorSvg(): string {
        return `<path d="M6,1 A5,5 0 1,1 1,6" fill="none" stroke="currentColor" stroke-width="1.5"/><polygon points="1,3 1,7 3,5" fill="currentColor"/>`
    }

    override getAllDescendantIds(): number[] {
        return [this.id, ...this.arg.getAllDescendantIds()]
    }

    getWgslMatrices(): { fwd: number[], inv: number[] } {
        const toRad = Math.PI / 180
        const cx = Math.cos(this.rx * toRad), sx = Math.sin(this.rx * toRad)
        const cy = Math.cos(this.ry * toRad), sy = Math.sin(this.ry * toRad)
        const cz = Math.cos(this.rz * toRad), sz = Math.sin(this.rz * toRad)

        const fwd = [
            cy * cz, cy * sz, -sy,
            sx * sy * cz - cx * sz, sx * sy * sz + cx * cz, sx * cy,
            cx * sy * cz + sx * sz, cx * sy * sz - sx * cz, cx * cy,
        ]
        const inv = [
            cy * cz, sx * sy * cz - cx * sz, cx * sy * cz + sx * sz,
            cy * sz, sx * sy * sz + cx * cz, cx * sy * sz - sx * cz,
            -sy, sx * cy, cx * cy,
        ]
        return { fwd, inv }
    }

    applyInvRotation(px: number, py: number, pz: number): [number, number, number] {
        const toRad = Math.PI / 180
        const cx = Math.cos(this.rx * toRad), sx = Math.sin(this.rx * toRad)
        const cy = Math.cos(this.ry * toRad), sy = Math.sin(this.ry * toRad)
        const cz = Math.cos(this.rz * toRad), sz = Math.sin(this.rz * toRad)
        return [
            (cy * cz) * px + (cy * sz) * py + (-sy) * pz,
            (sx * sy * cz - cx * sz) * px + (sx * sy * sz + cx * cz) * py + (sx * cy) * pz,
            (cx * sy * cz + sx * sz) * px + (cx * sy * sz - sx * cz) * py + (cx * cy) * pz,
        ]
    }

    private matToWgsl(m: number[]): string {
        const f = (v: number) => v.toFixed(10)
        return `mat3x3f(vec3f(${f(m[0])}, ${f(m[1])}, ${f(m[2])}), vec3f(${f(m[3])}, ${f(m[4])}, ${f(m[5])}), vec3f(${f(m[6])}, ${f(m[7])}, ${f(m[8])}))`
    }

    override compile(indentLevel = 0): CompileResult {
        const { fwd, inv } = this.getWgslMatrices()
        const childResult = this.arg.compile(indentLevel)
        const childText = childResult.text!

        const invMat = this.matToWgsl(inv)
        const fwdMat = this.matToWgsl(fwd)
        const rotatedChildText = childText.replace(/\bp\b/g, `(${invMat} * p)`)

        const funcName = `Rotate${this.id}`
        const varName = decapitalize(funcName)
        return {
            funcName,
            varName,
            text: `sdfRotateNormal(${rotatedChildText}, ${fwdMat})`,
        }
    }

    override compileFast(indentLevel = 0): CompileResult {
        const { inv } = this.getWgslMatrices()
        const childResult = this.arg.compileFast(indentLevel)
        const childText = childResult.text!

        const invMat = this.matToWgsl(inv)
        const rotatedChildText = childText.replace(/\bp\b/g, `(${invMat} * p)`)

        const funcName = `Rotate${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return {
            funcName,
            varName,
            text: rotatedChildText,
        }
    }
}
