import { CompileResult, decapitalize, fluent, Node, UnaryOperator, warpIsoResult } from "../base.mjs"
import { aabbRotate, type AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { mat3x3Wgsl, packMat3ColumnMajorToPreviewOut } from "../scene-params.mjs"
import { Vec3, vec3 } from "../../vecmat/vector.mjs"
import { FeatureGraphBuilder, mat4FromRotationFwd } from "../feature-graph-buffer.mjs"

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

    /**
     * The two 3×3 matrices the WGSL side consumes, as flat row-major arrays.
     * `mat3x3Wgsl` packs consecutive triplets as *columns*, so the WGSL-side
     * matrices are the transposes of these flat arrays read row-major: the SDF
     * evaluates the child at `transpose(inv)·p` (= world-to-local = `fwd` read
     * row-major) and rotates normals by `transpose(fwd)` (= world-from-local).
     * The SFCC CPU evaluator bakes the same convention (transform-bake.mts).
     */
    getWgslMatrices(): { fwd: number[]; inv: number[] } {
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
        const o = this.paramOffset
        const invMat = mat3x3Wgsl(o, this.previewMat3Slot)
        const fwdMat = mat3x3Wgsl(o + 9, this.previewMat3Slot + 1)
        const funcName = `Rotate${this.id}`
        return warpIsoResult(this, funcName, decapitalize(funcName), childResult, `${invMat} * p`, c => `sdfRotateNormal(${c}, ${fwdMat})`, "selectSDF")
    }

    override compileFast(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileFast(indentLevel)
        const invMat = mat3x3Wgsl(this.paramOffset, this.previewMat3Slot)
        const funcName = `Rotate${this.id}`
        // Fast variant has no normal correction — pure domain rotation.
        return warpIsoResult(this, funcName, `${decapitalize(funcName)}_f`, childResult, `${invMat} * p`, c => c, "selectFast")
    }

    override compileMid(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileMid(indentLevel)
        const o = this.paramOffset
        const invMat = mat3x3Wgsl(o, this.previewMat3Slot)
        const fwdMat = mat3x3Wgsl(o + 9, this.previewMat3Slot + 1)
        const funcName = `Rotate${this.id}`
        return warpIsoResult(this, funcName, `${decapitalize(funcName)}_m`, childResult, `${invMat} * p`, c => `sdfRotateNormalMid(${c}, ${fwdMat})`, "selectMid")
    }

    protected override computeBoundsCore(): AABB | null {
        const childBounds = this.arg.computeBounds()
        if (!childBounds) return null
        const { fwd } = this.getWgslMatrices()
        return aabbRotate(childBounds, fwd)
    }

    override accumulateFeatureGraph(builder: FeatureGraphBuilder): void {
        // Same fwd rotation the SDF uses (row-major 3x3); embed as a 4x4
        // column-major affine so the feature-graph transform stack composes
        // with translate/scale uniformly.
        const { fwd } = this.getWgslMatrices()
        builder.pushAffine(mat4FromRotationFwd(fwd))
        try {
            this.arg.accumulateFeatureGraph(builder)
        } finally {
            builder.pop()
        }
    }
}

export const rotate = fluent(function rotate(rot: Vec3, node: Node): Rotate {
    return new Rotate(rot, node)
})

/** Fluent chain: `node.rotate(rot)` — same as `rotate(rot, node)` (including primitives’ `.shift`). */
Node.prototype.rotate = function (this: Node, rot: Vec3): Rotate {
    return new Rotate(rot, this)
}
