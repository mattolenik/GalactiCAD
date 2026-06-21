import { Node, CompileResult, fluent, decapitalize, DEFAULT_POS } from "../base.mjs"
import { aabb, type AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { f32Wgsl, vec3Wgsl } from "../scene-params.mjs"
import { BOTTOM, TOP, type DirectionIndicator } from "../direction-indicator.mjs"
import { Vec3, vec3, Vec3f } from "../../vecmat/vector.mjs"
import {
    FG_FLAG_CREASE_ORIGINAL,
    type FeatureGraphBuilder,
} from "../feature-graph-buffer.mjs"

export type { DirectionIndicator } from "../direction-indicator.mjs"

export class Cylinder extends Node {
    pos = vec3([0, 0, 0])
    r = 0
    h: number
    /** Fillet radius at outer rim (+y cap); 0 = none. */
    filletTop = 0
    /** Fillet radius at outer rim (-y cap). */
    filletBottom = 0
    /** Chamfer size (same units as radius) at (+y) rim; 0 = none. */
    chamferTop = 0
    /** Chamfer size at (-y) rim. */
    chamferBottom = 0

    constructor(pos: Vec3, { r, h }: { r: number; h: number }) {
        super()
        this.pos = vec3(pos)
        this.r = r
        this.h = h
    }

    override getShapeType(): string { return "cylinder" }
    override getIndicatorSymbol(): string { return "⬭" }
    override getIndicatorSvg(): string {
        return `<rect x="1" y="2" width="10" height="8" rx="3" fill="currentColor"/>`
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
        const s = this.previewF32Slot
        out.f32[s + 0] = this.r
        out.f32[s + 1] = this.h
        out.f32[s + 2] = this.filletTop
        out.f32[s + 3] = this.filletBottom
        out.f32[s + 4] = this.chamferTop
        out.f32[s + 5] = this.chamferBottom
    }

    #paramSlice(): Float32Array {
        const buf = new Float32Array(9)
        buf.set(this.pos.data, 0)
        buf[3] = this.r
        buf[4] = this.h
        buf[5] = this.filletTop
        buf[6] = this.filletBottom
        buf[7] = this.chamferTop
        buf[8] = this.chamferBottom
        return buf
    }

    override build() {
        super.build()
        this.previewVec3Slot = this.scene.allocPreviewVec3(1)
        this.previewF32Slot = this.scene.allocPreviewF32(6)
        this.paramOffset = this.scene.allocSceneParamFloats(9)
        this.paramCount = 9
    }
    override compile(indentLevel = 0): CompileResult {
        const funcName = `Cylinder${this.id}`
        const varName = decapitalize(funcName)
        const o = this.paramOffset
        const s = this.previewF32Slot
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        const r = f32Wgsl(o + 3, s + 0)
        const h = f32Wgsl(o + 4, s + 1)
        const ft = f32Wgsl(o + 5, s + 2)
        const fb = f32Wgsl(o + 6, s + 3)
        const ct = f32Wgsl(o + 7, s + 4)
        const cb = f32Wgsl(o + 8, s + 5)
        return { funcName, varName, text: `fCylinderEx(p - ${pos}, ${r}, ${h}, ${ft}, ${fb}, ${ct}, ${cb}, ${this.id}u)` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Cylinder${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        const o = this.paramOffset
        const s = this.previewF32Slot
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        const r = f32Wgsl(o + 3, s + 0)
        const h = f32Wgsl(o + 4, s + 1)
        const ft = f32Wgsl(o + 5, s + 2)
        const fb = f32Wgsl(o + 6, s + 3)
        const ct = f32Wgsl(o + 7, s + 4)
        const cb = f32Wgsl(o + 8, s + 5)
        return { funcName, varName, text: `fCylinderFast(p - ${pos}, ${r}, ${h}, ${ft}, ${fb}, ${ct}, ${cb})` }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const funcName = `Cylinder${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        const o = this.paramOffset
        const s = this.previewF32Slot
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        const r = f32Wgsl(o + 3, s + 0)
        const h = f32Wgsl(o + 4, s + 1)
        const ft = f32Wgsl(o + 5, s + 2)
        const fb = f32Wgsl(o + 6, s + 3)
        const ct = f32Wgsl(o + 7, s + 4)
        const cb = f32Wgsl(o + 8, s + 5)
        return { funcName, varName, text: `sdfMidSetOwner(fCylinderMid(p - ${pos}, ${r}, ${h}, ${ft}, ${fb}, ${ct}, ${cb}), ${this.id}u)` }
    }

    protected override computeBoundsCore(): AABB {
        return aabb(this.pos.x, this.pos.y, this.pos.z, this.r, this.h, this.r)
    }

    @fluent height(h: number): this {
        this.h = h
        this.#reclampStoredEdges()
        return this
    }

    /** Chamfer the outer rim where the side meets a cap (45° cut). Clears fillet on the same side(s). */
    @fluent chamfer(side: DirectionIndicator, amount: number): this {
        const a = this.#clampEdgeAmount(amount)
        if (side & TOP) {
            this.chamferTop = a
            this.filletTop = 0
        }
        if (side & BOTTOM) {
            this.chamferBottom = a
            this.filletBottom = 0
        }
        return this
    }

    /** Fillet (round) the outer rim where the side meets a cap. Clears chamfer on the same side(s). Default both caps: TOP | BOTTOM. */
    @fluent fillet(radius: number, side: DirectionIndicator = TOP | BOTTOM): this {
        const rad = this.#clampEdgeAmount(radius)
        if (side & TOP) {
            this.filletTop = rad
            this.chamferTop = 0
        }
        if (side & BOTTOM) {
            this.filletBottom = rad
            this.chamferBottom = 0
        }
        return this
    }

    #clampEdgeAmount(v: number): number {
        if (!(v > 0) || !Number.isFinite(v)) return 0
        const cap = Math.min(this.r * 0.49, this.h * 0.49)
        return Math.min(v, Math.max(0, cap))
    }

    #reclampStoredEdges(): void {
        const cap = Math.min(this.r * 0.49, this.h * 0.49)
        const c = (x: number) => Math.min(Math.max(0, x), cap)
        this.filletTop = c(this.filletTop)
        this.filletBottom = c(this.filletBottom)
        this.chamferTop = c(this.chamferTop)
        this.chamferBottom = c(this.chamferBottom)
    }

    @fluent shift(v: Vec3 | number, y?: number, z?: number): this {
        this.pos = typeof v === "number" ? vec3(v, y!, z!) : vec3(v)
        return this
    }

    /**
     * Emit the two cap rings (cap-meets-side dihedral circles) as
     * discretised polylines. Each ring is broken into {@link RING_SEGMENTS}
     * short segments around the circle — enough resolution to look smooth
     * on screen and to flow through stage 3 subdivision without further
     * splitting in typical cell sizes.
     *
     * Each ring sample is a 2-way crease (cap face + cylindrical side
     * surface). Ring samples are NOT corners — a circular ring has no 0D
     * features. The cap face loop is emitted with the discretised ring
     * vertices so downstream meshers see a planar cap.
     *
     * Skipped when:
     *  - Under a non-affine ancestor (warp gate).
     *  - That cap has a fillet or chamfer set — those round/bevel the ring
     *    away, so no sharp dihedral is present. (Each cap checked
     *    independently so a cylinder with only a top fillet still emits the
     *    bottom ring.)
     */
    override accumulateFeatureGraph(builder: FeatureGraphBuilder): void {
        if (builder.hasNonAffineAncestor()) return
        if (!(this.r > 0) || !(this.h > 0)) return

        const cx = this.pos.x, cy = this.pos.y, cz = this.pos.z
        const r = this.r, h = this.h
        const topNormal = new Vec3f([0, 1, 0])
        const botNormal = new Vec3f([0, -1, 0])

        const emitTop = this.filletTop === 0 && this.chamferTop === 0
        const emitBot = this.filletBottom === 0 && this.chamferBottom === 0
        if (!emitTop && !emitBot) return

        builder.beginNode(this.id)

        const emitRing = (capY: number, capNormal: Vec3f, reverseLoop: boolean): void => {
            const idx: number[] = new Array(RING_SEGMENTS)
            for (let i = 0; i < RING_SEGMENTS; i++) {
                const theta = (i / RING_SEGMENTS) * 2 * Math.PI
                const ca = Math.cos(theta)
                const sa = Math.sin(theta)
                const sideNormal = new Vec3f([ca, 0, sa])
                idx[i] = builder.emitVertex(
                    new Vec3f([cx + r * ca, capY, cz + r * sa]),
                    FG_FLAG_CREASE_ORIGINAL,
                    [capNormal, sideNormal],
                )
            }
            for (let i = 0; i < RING_SEGMENTS; i++) {
                const next = (i + 1) % RING_SEGMENTS
                builder.emitEdge(idx[i]!, idx[next]!, FG_FLAG_CREASE_ORIGINAL)
            }
            // Bottom loop reversed so winding agrees with the -Y outward normal.
            const loopIdx = reverseLoop ? idx.slice().reverse() : idx
            builder.emitLoop(loopIdx, capNormal, FG_FLAG_CREASE_ORIGINAL)
        }

        if (emitTop) emitRing(cy + h, topNormal, false)
        if (emitBot) emitRing(cy - h, botNormal, true)

        builder.endNode()
    }
}

/**
 * Ring discretisation resolution. 64 segments around a circle keeps revolved
 * feature rings visually smooth (notably in the FeatureGraph debug overlay)
 * and well above the stage-3 subdivision target for default cell sizes — so
 * the ring won't be further subdivided into even smaller chords. Exported so
 * tests assert against the single source of truth; shared in spirit with
 * `LATHE_FG_RING_SEGMENTS`. Raise further if even smoother rings are needed.
 */
export const RING_SEGMENTS = 64

function cylinderRadius(r: number): Cylinder {
    return new Cylinder(DEFAULT_POS, { r, h: 1 })
}

export const cylinder = { radius: cylinderRadius }
