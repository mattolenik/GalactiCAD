import { Node, CompileResult, decapitalize, fluent, BVH_MIN_COST, DEFAULT_POS } from "../base.mjs"
import { aabb, type AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { capDragOrF32Wgsl, f32Wgsl, vec3Wgsl } from "../scene-params.mjs"
import { Vec3, vec3 } from "../../vecmat/vector.mjs"
import { VirtualCapNode } from "./virtual-cap.mjs"

/**
 * Default meridional thread angle (degrees): max angle between rod axis and local thread tangent
 * in an axial–radial plane, i.e. ψ with tan(ψ) = A·k for ρ = r + A·sin(k·y − θ), k = 2π/pitch.
 */
const DEFAULT_THREAD_FLANK_ANGLE_DEG = 60

/** Amplitude A for given pitch P and flank angle ψ (degrees): A = tan(ψ) · P / (2π). */
function threadAmpForPitchAndAngle(pitch: number, flankAngleDeg: number): number {
    const p = Math.max(pitch, 1e-12)
    const rad = (flankAngleDeg * Math.PI) / 180
    return (Math.tan(rad) * p) / (2 * Math.PI)
}

export type ThreadedRodProfile = "fdm" | "iso" | "acme"
export type ThreadedRodHandedness = "left" | "right"

/** Finite Y-axis rod with a helical thread on the barrel (FDM = sine, ISO = V-groove triangle, ACME = trapezoid). */
export class ThreadedRod extends Node {
    pos = vec3([0, 0, 0])
    r = 0
    h = 0
    /** Axial distance for one full 360° turn (same units as scene). */
    turnPitch = 0
    /** Meridional flank angle (degrees); with pitch determines threadAmp unless explicitDepth. */
    threadFlankAngleDeg = DEFAULT_THREAD_FLANK_ANGLE_DEG
    /** When true, threadAmp was set by depth() and is not overwritten by pitch/threadAngle. */
    explicitDepth = false
    /** Radial amplitude about mean radius `r` (same meaning for both profiles). */
    threadAmp = 0
    /** `fdm` = sinusoidal barrel; `iso` = triangular; `acme` = trapezoidal (flat crest/root). */
    threadProfile: ThreadedRodProfile = "fdm"
    /** Right-hand thread by default; left-hand flips helix direction. */
    threadHandedness: ThreadedRodHandedness = "right"
    readonly capTop: VirtualCapNode
    readonly capBottom: VirtualCapNode

    constructor(
        pos: Vec3,
        {
            r,
            h,
            pitch,
            depth,
            threadAngle,
            threadProfile,
            threadHandedness,
        }: {
            r: number
            h: number
            pitch: number
            depth?: number
            threadAngle?: number
            threadProfile?: ThreadedRodProfile
            threadHandedness?: ThreadedRodHandedness
        }
    ) {
        super()
        this.capTop = new VirtualCapNode(true)
        this.capBottom = new VirtualCapNode(false)
        this.pos = vec3(pos)
        this.r = r
        this.h = h
        this.turnPitch = pitch
        if (threadProfile !== undefined) {
            this.threadProfile = threadProfile
        }
        if (threadHandedness !== undefined) {
            this.threadHandedness = threadHandedness
        }
        if (threadAngle !== undefined) {
            this.threadFlankAngleDeg = threadAngle
        }
        if (depth !== undefined) {
            this.explicitDepth = true
            this.threadAmp = depth
        } else {
            this.explicitDepth = false
            this.#syncThreadAmpFromAngle()
        }
    }

    #syncThreadAmpFromAngle(): void {
        if (this.explicitDepth) return
        this.threadAmp = threadAmpForPitchAndAngle(this.turnPitch, this.threadFlankAngleDeg)
    }

    override getShapeType(): string {
        return "threaded_rod"
    }
    override getIndicatorSymbol(): string {
        return "⍉"
    }
    override getIndicatorSvg(): string {
        return `<path d="M3 10c2-2 4-2 6 0s4 2 6 0M3 6c2-2 4-2 6 0s4 2 6 0M3 2c2-2 4-2 6 0s4 2 6 0" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>`
    }

    protected override _computeCodegenCost(): number {
        return BVH_MIN_COST
    }

    override writeSceneParams(view: Float32Array): void {
        view.set(this.#paramSlice())
    }

    override writePreviewParams(out: PreviewParamsOut): void {
        const b = this.previewVec3Slot * 4
        out.vec3[b] = this.pos.data[0]!
        out.vec3[b + 1] = this.pos.data[1]!
        out.vec3[b + 2] = this.pos.data[2]!
        out.vec3[b + 3] = 0
        const f = this.previewF32Slot
        out.f32[f + 0] = this.r
        out.f32[f + 1] = this.turnPitch
        out.f32[f + 2] = this.threadAmp
        out.f32[f + 3] = this.h
        out.f32[f + 4] = 0
    }

    #paramSlice(): Float32Array {
        const buf = new Float32Array(8)
        buf.set(this.pos.data, 0)
        buf[3] = this.r
        buf[4] = this.turnPitch
        buf[5] = this.threadAmp
        buf[6] = this.h
        buf[7] = 0
        return buf
    }

    override build() {
        super.build()
        this.previewVec3Slot = this.scene.allocPreviewVec3(1)
        this.previewF32Slot = this.scene.allocPreviewF32(5)
        this.paramOffset = this.scene.allocSceneParamFloats(8)
        this.paramCount = 8
        this.capTop.root = this.root
        this.capTop.build()
        this.capBottom.root = this.root
        this.capBottom.build()
    }

    override appendStructuralFingerprint(parts: string[]): void {
        parts.push(
            `${this.getShapeType()}:${this.structuralBvhSlot()}:profile:${this.threadProfile}:hand:${this.threadHandedness}`,
        )
        this.capTop.appendStructuralFingerprint(parts)
        this.capBottom.appendStructuralFingerprint(parts)
    }

    override getAllDescendantIds(): number[] {
        return [this.id, this.capTop.id, this.capBottom.id]
    }

    get wgslFastFuncName(): string {
        return `fThreadedRod_${this.id}_Fast`
    }
    get wgslExFuncName(): string {
        return `fThreadedRod_${this.id}_Ex`
    }
    get wgslMidFuncName(): string {
        return `fThreadedRod_${this.id}_Mid`
    }

    get #wgslBarrelFn(): string {
        if (this.threadProfile === "iso") return "fThreadedRodBarrelDistIso"
        if (this.threadProfile === "acme") return "fThreadedRodBarrelDistAcme"
        return "fThreadedRodBarrelDist"
    }

    get #wgslHelixSign(): string {
        return this.threadHandedness === "left" ? "-1.0" : "1.0"
    }

    override compileAux(): string {
        const capTopId = this.capTop.id
        const capBottomId = this.capBottom.id
        const ro = this.paramOffset
        const R = f32Wgsl(ro + 3, this.previewF32Slot + 0)
        const P = f32Wgsl(ro + 4, this.previewF32Slot + 1)
        const A = f32Wgsl(ro + 5, this.previewF32Slot + 2)
        const capH = capDragOrF32Wgsl(ro + 6, this.previewF32Slot + 3)
        const capYOff = capDragOrF32Wgsl(ro + 7, this.previewF32Slot + 4)
        const S = this.#wgslHelixSign
        const B = this.#wgslBarrelFn
        return `
fn ${this.wgslExFuncName}(p: vec3f, id: u32) -> SDFResult {
    let dSide = ${B}(p, ${R}, ${P}, ${A}, ${S});
    let capH = ${capH};
    let capY = p.y - ${capYOff};
    let dCap = abs(capY) - capH;
    let d = max(dSide, dCap);
    let onSide = dSide > dCap;
    let eps = 0.001;
    let gx = ${B}(p + vec3f(eps, 0.0, 0.0), ${R}, ${P}, ${A}, ${S}) - ${B}(p - vec3f(eps, 0.0, 0.0), ${R}, ${P}, ${A}, ${S});
    let gy = ${B}(p + vec3f(0.0, eps, 0.0), ${R}, ${P}, ${A}, ${S}) - ${B}(p - vec3f(0.0, eps, 0.0), ${R}, ${P}, ${A}, ${S});
    let gz = ${B}(p + vec3f(0.0, 0.0, eps), ${R}, ${P}, ${A}, ${S}) - ${B}(p - vec3f(0.0, 0.0, eps), ${R}, ${P}, ${A}, ${S});
    let nSide = safeNormalize(vec3f(gx, gy, gz), vec3f(1.0, 0.0, 0.0));
    let nCap = vec3f(0.0, sgn(capY), 0.0);
    let n = select(nCap, nSide, onSide);
    let capId = select(${capBottomId}u, ${capTopId}u, capY > 0.0);
    var resultId = select(capId, id, onSide);
    if (!onSide && faceSelection.nodeId == id && faceSelection.mode >= 2u) {
        let isTopFace = capY > 0.0;
        if (faceSelection.mode == 2u && isTopFace) {
            resultId = FACE_HIGHLIGHT_TOP;
        } else if (faceSelection.mode == 3u && !isTopFace) {
            resultId = FACE_HIGHLIGHT_BOTTOM;
        }
    }
    return sdfTrue(d, resultId, n);
}
`
    }

    override compileAuxFast(): string {
        const ro = this.paramOffset
        const R = f32Wgsl(ro + 3, this.previewF32Slot + 0)
        const P = f32Wgsl(ro + 4, this.previewF32Slot + 1)
        const A = f32Wgsl(ro + 5, this.previewF32Slot + 2)
        const capH = capDragOrF32Wgsl(ro + 6, this.previewF32Slot + 3)
        const capYOff = capDragOrF32Wgsl(ro + 7, this.previewF32Slot + 4)
        const S = this.#wgslHelixSign
        const B = this.#wgslBarrelFn
        const id = this.id
        return `
fn fThreadedRod_${id}_field(p: vec3f) -> f32 {
    let dSide = ${B}(p, ${R}, ${P}, ${A}, ${S});
    let h = ${capH};
    let capY = p.y - ${capYOff};
    let dCap = abs(capY) - h;
    return max(dSide, dCap);
}

fn ${this.wgslFastFuncName}(p: vec3f) -> FastSDFResult {
    return sdfFast(fThreadedRod_${id}_field(p), 1.0, 1.0);
}
`
    }

    override compileAuxMid(): string {
        const ro = this.paramOffset
        const R = f32Wgsl(ro + 3, this.previewF32Slot + 0)
        const P = f32Wgsl(ro + 4, this.previewF32Slot + 1)
        const A = f32Wgsl(ro + 5, this.previewF32Slot + 2)
        const capH = capDragOrF32Wgsl(ro + 6, this.previewF32Slot + 3)
        const capYOff = capDragOrF32Wgsl(ro + 7, this.previewF32Slot + 4)
        const S = this.#wgslHelixSign
        const B = this.#wgslBarrelFn
        const id = this.id
        return `
fn ${this.wgslMidFuncName}(p: vec3f) -> SDFResultMid {
    let dSide = ${B}(p, ${R}, ${P}, ${A}, ${S});
    let capH = ${capH};
    let capY = p.y - ${capYOff};
    let dCap = abs(capY) - capH;
    let d = max(dSide, dCap);
    let onSide = dSide > dCap;
    let eps = 0.001;
    let gx = ${B}(p + vec3f(eps, 0.0, 0.0), ${R}, ${P}, ${A}, ${S}) - ${B}(p - vec3f(eps, 0.0, 0.0), ${R}, ${P}, ${A}, ${S});
    let gy = ${B}(p + vec3f(0.0, eps, 0.0), ${R}, ${P}, ${A}, ${S}) - ${B}(p - vec3f(0.0, eps, 0.0), ${R}, ${P}, ${A}, ${S});
    let gz = ${B}(p + vec3f(0.0, 0.0, eps), ${R}, ${P}, ${A}, ${S}) - ${B}(p - vec3f(0.0, 0.0, eps), ${R}, ${P}, ${A}, ${S});
    let nSide = safeNormalize(vec3f(gx, gy, gz), vec3f(1.0, 0.0, 0.0));
    let nCap = vec3f(0.0, sgn(capY), 0.0);
    let n = select(nCap, nSide, onSide);
    return sdfRMid(d, 1.0, n);
}
`
    }

    override compile(indentLevel = 0): CompileResult {
        const funcName = `ThreadedRod${this.id}`
        const varName = decapitalize(funcName)
        const pos = vec3Wgsl(this.paramOffset, this.previewVec3Slot)
        return {
            funcName,
            varName,
            text: `${this.wgslExFuncName}(p - ${pos}, ${this.id}u)`,
        }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `ThreadedRod${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        const pos = vec3Wgsl(this.paramOffset, this.previewVec3Slot)
        return {
            funcName,
            varName,
            text: `${this.wgslFastFuncName}(p - ${pos})`,
        }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const funcName = `ThreadedRod${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        const pos = vec3Wgsl(this.paramOffset, this.previewVec3Slot)
        return {
            funcName,
            varName,
            text: `${this.wgslMidFuncName}(p - ${pos})`,
        }
    }

    protected override computeBoundsCore(): AABB {
        const outerR = this.r + Math.abs(this.threadAmp)
        return aabb(this.pos.x, this.pos.y, this.pos.z, outerR, this.h, outerR)
    }

    @fluent height(h: number): this {
        this.h = h
        return this
    }
    @fluent pitch(p: number): this {
        this.turnPitch = p
        this.#syncThreadAmpFromAngle()
        return this
    }
    /** Flank angle in degrees (default 60). Updates radial amplitude from pitch unless depth() was used. */
    @fluent threadAngle(deg: number): this {
        this.threadFlankAngleDeg = deg
        this.#syncThreadAmpFromAngle()
        return this
    }
    /** Explicit radial amplitude; disables automatic depth from pitch and threadAngle. */
    @fluent depth(d: number): this {
        this.explicitDepth = true
        this.threadAmp = d
        return this
    }
    @fluent shift(v: Vec3): this {
        this.pos = vec3(v)
        return this
    }
}

function threadedRodRadius(r: number): ThreadedRod {
    return new ThreadedRod(DEFAULT_POS, { r, h: 1, pitch: 0.5, threadProfile: "fdm", threadHandedness: "right" })
}

/** Default meridional `threadAngle` for ACME entry points: 90° − 29° (ACME thread angle uses a different reference than `threadAngle`). */
const DEFAULT_ACME_THREAD_ANGLE_DEG = 61

function threadedRodProfileEntry(
    profile: ThreadedRodProfile,
    hand: ThreadedRodHandedness
): { radius(r: number): ThreadedRod } {
    return {
        radius(r: number): ThreadedRod {
            if (profile === "acme") {
                return new ThreadedRod(DEFAULT_POS, {
                    r,
                    h: 1,
                    pitch: 0.5,
                    threadProfile: "acme",
                    threadHandedness: hand,
                    threadAngle: DEFAULT_ACME_THREAD_ANGLE_DEG,
                })
            }
            return new ThreadedRod(DEFAULT_POS, { r, h: 1, pitch: 0.5, threadProfile: profile, threadHandedness: hand })
        },
    }
}

function threadedRodHandSide(hand: ThreadedRodHandedness): {
    radius(r: number): ThreadedRod
    profile: {
        fdm(): { radius(r: number): ThreadedRod }
        iso(): { radius(r: number): ThreadedRod }
        acme(): { radius(r: number): ThreadedRod }
    }
} {
    return {
        radius(r: number): ThreadedRod {
            return new ThreadedRod(DEFAULT_POS, { r, h: 1, pitch: 0.5, threadProfile: "fdm", threadHandedness: hand })
        },
        profile: {
            fdm(): { radius(r: number): ThreadedRod } {
                return threadedRodProfileEntry("fdm", hand)
            },
            iso(): { radius(r: number): ThreadedRod } {
                return threadedRodProfileEntry("iso", hand)
            },
            acme(): { radius(r: number): ThreadedRod } {
                return threadedRodProfileEntry("acme", hand)
            },
        },
    }
}

export const threaded_rod = {
    radius: threadedRodRadius,
    left: threadedRodHandSide("left"),
    right: threadedRodHandSide("right"),
    profile: {
        fdm(): { radius(r: number): ThreadedRod } {
            return threadedRodProfileEntry("fdm", "right")
        },
        iso(): { radius(r: number): ThreadedRod } {
            return threadedRodProfileEntry("iso", "right")
        },
        acme(): { radius(r: number): ThreadedRod } {
            return threadedRodProfileEntry("acme", "right")
        },
    },
}
