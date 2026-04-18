import { CompileResult, decapitalize, fluent, Node, UnaryOperator } from "../base.mjs"
import { aabbRotate, type AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { mat3x3Wgsl, packMat3ColumnMajorToPreviewOut } from "../scene-params.mjs"
import { Vec3, vec3 } from "../../vecmat/vector.mjs"

export class Rotate extends UnaryOperator {
    rx: number
    ry: number
    rz: number

    constructor(rotation: Vec3, arg: Node) {
        super(arg)
        const r = vec3(rotation)
        this.rx = r.x
        this.ry = r.y
        this.rz = r.z
    }

    override getShapeType(): string { return "rotate" }
    override getIndicatorSvg(): string {
        return `<path d="M6,1 A5,5 0 1,1 1,6" fill="none" stroke="currentColor" stroke-width="1.5"/><polygon points="1,3 1,7 3,5" fill="currentColor"/>`
    }

    override getAllDescendantIds(): number[] {
        return [this.id, ...this.arg.getAllDescendantIds()]
    }

    protected override reserveUnarySceneParams(): void {
        this.paramOffset = this.scene.allocSceneParamFloats(18)
        this.paramCount = 18
        this.previewMat3Slot = this.scene.allocPreviewMat3(2)
    }

    override writeSceneParams(view: Float32Array): void {
        view.set(this.#paramSlice())
    }

    override writePreviewParams(out: PreviewParamsOut): void {
        const slice = this.#paramSlice()
        packMat3ColumnMajorToPreviewOut(out.mat3, this.previewMat3Slot, slice.subarray(0, 9))
        packMat3ColumnMajorToPreviewOut(out.mat3, this.previewMat3Slot + 1, slice.subarray(9, 18))
    }

    #paramSlice(): Float32Array {
        const { fwd, inv } = this.getWgslMatrices()
        const buf = new Float32Array(18)
        buf.set(inv, 0)
        buf.set(fwd, 9)
        return buf
    }

    private getWgslMatrices(): { fwd: number[]; inv: number[] } {
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

    override compile(indentLevel = 0): CompileResult {
        const childResult = this.arg.compile(indentLevel)
        const childText = childResult.text!
        const o = this.paramOffset
        const invMat = mat3x3Wgsl(o, this.previewMat3Slot)
        const fwdMat = mat3x3Wgsl(o + 9, this.previewMat3Slot + 1)

        const funcName = `Rotate${this.id}`
        const varName = decapitalize(funcName)

        if (childResult.prelude) {
            const rotatedPrelude = childResult.prelude.replace(/\bp\b/g, `(${invMat} * p)`)
            const accVar = childResult.varName!
            const prelude = rotatedPrelude + `${accVar} = sdfRotateNormal(${accVar}, ${fwdMat});\n`
            return { funcName, varName: accVar, text: accVar, prelude }
        }

        const rotatedChildText = childText.replace(/\bp\b/g, `(${invMat} * p)`)
        return {
            funcName,
            varName,
            text: `sdfRotateNormal(${rotatedChildText}, ${fwdMat})`,
        }
    }

    override compileFast(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileFast(indentLevel)
        const childText = childResult.text!
        const invMat = mat3x3Wgsl(this.paramOffset, this.previewMat3Slot)

        const funcName = `Rotate${this.id}`
        const varName = `${decapitalize(funcName)}_f`

        if (childResult.prelude) {
            const rotatedPrelude = childResult.prelude.replace(/\bp\b/g, `(${invMat} * p)`)
            return { funcName, varName: childResult.varName!, text: childResult.varName!, prelude: rotatedPrelude }
        }

        const rotatedChildText = childText.replace(/\bp\b/g, `(${invMat} * p)`)
        return {
            funcName,
            varName,
            text: rotatedChildText,
        }
    }

    override compileMid(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileMid(indentLevel)
        const childText = childResult.text!
        const o = this.paramOffset
        const invMat = mat3x3Wgsl(o, this.previewMat3Slot)
        const fwdMat = mat3x3Wgsl(o + 9, this.previewMat3Slot + 1)
        const rotatedChildText = childText.replace(/\bp\b/g, `(${invMat} * p)`)

        const funcName = `Rotate${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        if (childResult.prelude) {
            const rotatedPrelude = childResult.prelude.replace(/\bp\b/g, `(${invMat} * p)`)
            const accVar = childResult.varName!
            const prelude = rotatedPrelude + `${accVar} = sdfRotateNormalMid(${accVar}, ${fwdMat});\n`
            return { funcName, varName: accVar, text: accVar, prelude }
        }
        return {
            funcName,
            varName,
            text: `sdfRotateNormalMid(${rotatedChildText}, ${fwdMat})`,
        }
    }

    protected override computeBoundsCore(): AABB | null {
        const childBounds = this.arg.computeBounds()
        if (!childBounds) return null
        const { fwd } = this.getWgslMatrices()
        return aabbRotate(childBounds, fwd)
    }
}

export const rotate = fluent(function rotate(rot: Vec3, node: Node): Rotate {
    return new Rotate(rot, node)
})
