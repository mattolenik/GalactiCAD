import { Node, CompileResult, decapitalize, fluent, BVH_MIN_COST, DEFAULT_POS } from "../base.mjs"
import { aabb, type AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { capDragOrF32Wgsl, f32Wgsl, vec3Wgsl } from "../scene-params.mjs"
import { Vec3, vec3 } from "../../vecmat/vector.mjs"
import { BOTTOM, LEFT, RIGHT, TOP, type DirectionIndicator } from "../direction-indicator.mjs"
import { VirtualCapNode } from "./virtual-cap.mjs"

export type { DirectionIndicator } from "../direction-indicator.mjs"

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
    /** Right-hand thread by default; use {@link LEFT} for left-hand. */
    handedness: DirectionIndicator = RIGHT
    /** Fillet radius where barrel meets +y cap (CSG round intersection). */
    filletTop = 0
    filletBottom = 0
    chamferTop = 0
    chamferBottom = 0
    /**
     * Female / fit adjustment: barrel is evaluated in xz scaled by `1/(1 + femalePlay)`.
     * 0 = nominal; e.g. 0.01 uses scale 1.01 (default for female() with no args).
     */
    femalePlay = 0
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
            handedness,
        }: {
            r: number
            h: number
            pitch: number
            depth?: number
            threadAngle?: number
            threadProfile?: ThreadedRodProfile
            handedness?: DirectionIndicator
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
        if (handedness !== undefined) {
            this.handedness = handedness === LEFT ? LEFT : RIGHT
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
        out.f32[f + 5] = this.filletTop
        out.f32[f + 6] = this.filletBottom
        out.f32[f + 7] = this.chamferTop
        out.f32[f + 8] = this.chamferBottom
        out.f32[f + 9] = this.femalePlay
    }

    #paramSlice(): Float32Array {
        const buf = new Float32Array(13)
        buf.set(this.pos.data, 0)
        buf[3] = this.r
        buf[4] = this.turnPitch
        buf[5] = this.threadAmp
        buf[6] = this.h
        buf[7] = 0
        buf[8] = this.filletTop
        buf[9] = this.filletBottom
        buf[10] = this.chamferTop
        buf[11] = this.chamferBottom
        buf[12] = this.femalePlay
        return buf
    }

    override build() {
        super.build()
        this.previewVec3Slot = this.scene.allocPreviewVec3(1)
        this.previewF32Slot = this.scene.allocPreviewF32(10)
        this.paramOffset = this.scene.allocSceneParamFloats(13)
        this.paramCount = 13
        this.capTop.root = this.root
        this.capTop.build()
        this.capBottom.root = this.root
        this.capBottom.build()
    }

    override appendStructuralFingerprint(parts: string[]): void {
        parts.push(
            `${this.getShapeType()}:${this.structuralBvhSlot()}:profile:${this.threadProfile}:hand:${this.handedness}:female:${this.femalePlay}`,
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
        return this.handedness === LEFT ? "1.0" : "-1.0"
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
        const ft = f32Wgsl(ro + 8, this.previewF32Slot + 5)
        const fb = f32Wgsl(ro + 9, this.previewF32Slot + 6)
        const ct = f32Wgsl(ro + 10, this.previewF32Slot + 7)
        const cb = f32Wgsl(ro + 11, this.previewF32Slot + 8)
        const fp = f32Wgsl(ro + 12, this.previewF32Slot + 9)
        const S = this.#wgslHelixSign
        const B = this.#wgslBarrelFn
        return `
fn ${this.wgslExFuncName}(p: vec3f, id: u32) -> SDFResult {
    let femalePlayV = ${fp};
    let xzScale = max(1.0 + femalePlayV, 1e-5);
    let dSide = xzScale * ${B}(vec3f(p.x / xzScale, p.y, p.z / xzScale), ${R}, ${P}, ${A}, ${S});
    let capH = ${capH};
    let capY = p.y - ${capYOff};
    let dCapSharp = abs(capY) - capH;
    let eps = 0.001;
    let gx = xzScale * (${B}(vec3f((p.x + eps) / xzScale, p.y, p.z / xzScale), ${R}, ${P}, ${A}, ${S}) - ${B}(vec3f((p.x - eps) / xzScale, p.y, p.z / xzScale), ${R}, ${P}, ${A}, ${S}));
    let gy = xzScale * (${B}(vec3f(p.x / xzScale, p.y + eps, p.z / xzScale), ${R}, ${P}, ${A}, ${S}) - ${B}(vec3f(p.x / xzScale, p.y - eps, p.z / xzScale), ${R}, ${P}, ${A}, ${S}));
    let gz = xzScale * (${B}(vec3f(p.x / xzScale, p.y, (p.z + eps) / xzScale), ${R}, ${P}, ${A}, ${S}) - ${B}(vec3f(p.x / xzScale, p.y, (p.z - eps) / xzScale), ${R}, ${P}, ${A}, ${S}));
    let nSide = safeNormalize(vec3f(gx, gy, gz), vec3f(1.0, 0.0, 0.0));
    let filletTopR = ${ft};
    let filletBotR = ${fb};
    let chamferTopAmt = ${ct};
    let chamferBotAmt = ${cb};
    var cur = sdfTrue(dSide, id, nSide);
    let topHS = sdfTrue(capY - capH, ${capTopId}u, vec3f(0.0, 1.0, 0.0));
    let botHS = sdfTrue(-capY - capH, ${capBottomId}u, vec3f(0.0, -1.0, 0.0));
    if (filletTopR > 0.0) {
        cur = fOpIntersectionRoundEx(cur, topHS, filletTopR);
    } else if (chamferTopAmt > 0.0) {
        cur = fOpIntersectionChamferEx(cur, topHS, chamferTopAmt);
    } else {
        cur = opIntersectionEx(cur, topHS);
    }
    if (filletBotR > 0.0) {
        cur = fOpIntersectionRoundEx(cur, botHS, filletBotR);
    } else if (chamferBotAmt > 0.0) {
        cur = fOpIntersectionChamferEx(cur, botHS, chamferBotAmt);
    } else {
        cur = opIntersectionEx(cur, botHS);
    }
    let d = cur.d;
    let onSideSharp = dSide > dCapSharp;
    let n = select(cur.n, nSide, onSideSharp);
    let capId = select(${capBottomId}u, ${capTopId}u, capY > 0.0);
    var resultId = select(capId, id, onSideSharp);
    if (!onSideSharp && faceSelection.nodeId == id && faceSelection.mode >= 2u) {
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
        const ft = f32Wgsl(ro + 8, this.previewF32Slot + 5)
        const fb = f32Wgsl(ro + 9, this.previewF32Slot + 6)
        const ct = f32Wgsl(ro + 10, this.previewF32Slot + 7)
        const cb = f32Wgsl(ro + 11, this.previewF32Slot + 8)
        const fp = f32Wgsl(ro + 12, this.previewF32Slot + 9)
        const S = this.#wgslHelixSign
        const B = this.#wgslBarrelFn
        const id = this.id
        return `
fn ${this.wgslFastFuncName}(p: vec3f) -> FastSDFResult {
    let femalePlayV = ${fp};
    let xzScale = max(1.0 + femalePlayV, 1e-5);
    let dSide = xzScale * ${B}(vec3f(p.x / xzScale, p.y, p.z / xzScale), ${R}, ${P}, ${A}, ${S});
    let h = ${capH};
    let capY = p.y - ${capYOff};
    let filletTopR = ${ft};
    let filletBotR = ${fb};
    let chamferTopAmt = ${ct};
    let chamferBotAmt = ${cb};
    var fa = sdfFast(dSide, 1.0, 1.0);
    let fTop = sdfFast(capY - h, 1.0, 1.0);
    let fBot = sdfFast(-capY - h, 1.0, 1.0);
    if (filletTopR > 0.0) {
        fa = fOpIntersectionRoundFast(fa, fTop, filletTopR);
    } else if (chamferTopAmt > 0.0) {
        fa = fOpIntersectionChamferFast(fa, fTop, chamferTopAmt);
    } else {
        fa = opIntersectionFast(fa, fTop);
    }
    if (filletBotR > 0.0) {
        fa = fOpIntersectionRoundFast(fa, fBot, filletBotR);
    } else if (chamferBotAmt > 0.0) {
        fa = fOpIntersectionChamferFast(fa, fBot, chamferBotAmt);
    } else {
        fa = opIntersectionFast(fa, fBot);
    }
    return fa;
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
        const ft = f32Wgsl(ro + 8, this.previewF32Slot + 5)
        const fb = f32Wgsl(ro + 9, this.previewF32Slot + 6)
        const ct = f32Wgsl(ro + 10, this.previewF32Slot + 7)
        const cb = f32Wgsl(ro + 11, this.previewF32Slot + 8)
        const fp = f32Wgsl(ro + 12, this.previewF32Slot + 9)
        const S = this.#wgslHelixSign
        const B = this.#wgslBarrelFn
        const id = this.id
        return `
fn ${this.wgslMidFuncName}(p: vec3f) -> SDFResultMid {
    let femalePlayV = ${fp};
    let xzScale = max(1.0 + femalePlayV, 1e-5);
    let dSide = xzScale * ${B}(vec3f(p.x / xzScale, p.y, p.z / xzScale), ${R}, ${P}, ${A}, ${S});
    let capHv = ${capH};
    let capY = p.y - ${capYOff};
    let eps = 0.001;
    let gx = xzScale * (${B}(vec3f((p.x + eps) / xzScale, p.y, p.z / xzScale), ${R}, ${P}, ${A}, ${S}) - ${B}(vec3f((p.x - eps) / xzScale, p.y, p.z / xzScale), ${R}, ${P}, ${A}, ${S}));
    let gy = xzScale * (${B}(vec3f(p.x / xzScale, p.y + eps, p.z / xzScale), ${R}, ${P}, ${A}, ${S}) - ${B}(vec3f(p.x / xzScale, p.y - eps, p.z / xzScale), ${R}, ${P}, ${A}, ${S}));
    let gz = xzScale * (${B}(vec3f(p.x / xzScale, p.y, (p.z + eps) / xzScale), ${R}, ${P}, ${A}, ${S}) - ${B}(vec3f(p.x / xzScale, p.y, (p.z - eps) / xzScale), ${R}, ${P}, ${A}, ${S}));
    let nSide = safeNormalize(vec3f(gx, gy, gz), vec3f(1.0, 0.0, 0.0));
    let filletTopR = ${ft};
    let filletBotR = ${fb};
    let chamferTopAmt = ${ct};
    let chamferBotAmt = ${cb};
    var cur = sdfRMidOwned(dSide, 1.0, nSide, ${id}u, ${id}u);
    let topM = sdfRMidOwned(capY - capHv, 1.0, vec3f(0.0, 1.0, 0.0), ${this.capTop.id}u, ${this.capTop.id}u);
    let botM = sdfRMidOwned(-capY - capHv, 1.0, vec3f(0.0, -1.0, 0.0), ${this.capBottom.id}u, ${this.capBottom.id}u);
    if (filletTopR > 0.0) {
        cur = fOpIntersectionRoundMid(cur, topM, filletTopR);
    } else if (chamferTopAmt > 0.0) {
        cur = fOpIntersectionChamferMid(cur, topM, chamferTopAmt);
    } else {
        cur = opIntersectionMid(cur, topM);
    }
    if (filletBotR > 0.0) {
        cur = fOpIntersectionRoundMid(cur, botM, filletBotR);
    } else if (chamferBotAmt > 0.0) {
        cur = fOpIntersectionChamferMid(cur, botM, chamferBotAmt);
    } else {
        cur = opIntersectionMid(cur, botM);
    }
    return cur;
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
            text: `sdfMidSetOwner(${this.wgslMidFuncName}(p - ${pos}), ${this.id}u)`,
        }
    }

    protected override computeBoundsCore(): AABB {
        const outerR = this.r + Math.abs(this.threadAmp)
        return aabb(this.pos.x, this.pos.y, this.pos.z, outerR, this.h, outerR)
    }

    @fluent height(h: number): this {
        this.h = h
        this.#reclampRimEdges()
        return this
    }
    @fluent pitch(p: number): this {
        this.turnPitch = p
        this.#syncThreadAmpFromAngle()
        this.#reclampRimEdges()
        return this
    }
    /** Thread helix handedness: {@link RIGHT} (default) or {@link LEFT}. */
    @fluent hand(side: typeof LEFT | typeof RIGHT): this {
        this.handedness = side
        return this
    }
    /** Flank angle in degrees (default 60). Updates radial amplitude from pitch unless depth() was used. */
    @fluent threadAngle(deg: number): this {
        this.threadFlankAngleDeg = deg
        this.#syncThreadAmpFromAngle()
        this.#reclampRimEdges()
        return this
    }
    /** Explicit radial amplitude; disables automatic depth from pitch and threadAngle. */
    @fluent depth(d: number): this {
        this.explicitDepth = true
        this.threadAmp = d
        this.#reclampRimEdges()
        return this
    }

    /** Chamfer where the threaded barrel meets a flat end cap (CSG chamfer intersection). */
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

    /** Fillet where the threaded barrel meets a flat end cap (CSG round intersection). Default both caps: TOP | BOTTOM. */
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

    /**
     * Female / fit: evaluate the barrel in xz scaled by `1/(1+play)` (default play 0.01 → factor 1.01).
     * Pass `0` to clear.
     */
    @fluent female(play?: number): this {
        const p = play === undefined ? 0.01 : play
        this.femalePlay = ThreadedRod.#clampFemalePlay(p)
        return this
    }

    static #clampFemalePlay(v: number): number {
        if (!Number.isFinite(v)) return 0
        return Math.max(-0.99, Math.min(v, 3))
    }

    #clampEdgeAmount(v: number): number {
        if (!(v > 0) || !Number.isFinite(v)) return 0
        const cap = this.#rimClampCap()
        return Math.min(v, Math.max(0, cap))
    }

    /** Max fillet/chamfer so it stays on the outer envelope vs cap half-height. */
    #rimClampCap(): number {
        const envR = this.r + Math.abs(this.threadAmp)
        return Math.min(envR * 0.49, this.h * 0.49)
    }

    #reclampRimEdges(): void {
        const cap = this.#rimClampCap()
        const c = (x: number) => Math.min(Math.max(0, x), cap)
        this.filletTop = c(this.filletTop)
        this.filletBottom = c(this.filletBottom)
        this.chamferTop = c(this.chamferTop)
        this.chamferBottom = c(this.chamferBottom)
    }

    @fluent shift(v: Vec3): this {
        this.pos = vec3(v)
        return this
    }
}

function threadedRodRadius(r: number): ThreadedRod {
    return new ThreadedRod(DEFAULT_POS, { r, h: 1, pitch: 0.5, threadProfile: "fdm" })
}

/** Default meridional `threadAngle` for ACME entry points: 90° − 29° (ACME thread angle uses a different reference than `threadAngle`). */
const DEFAULT_ACME_THREAD_ANGLE_DEG = 61

function threadedRodProfileEntry(
    profile: ThreadedRodProfile,
    handedness: DirectionIndicator
): { radius(r: number): ThreadedRod } {
    return {
        radius(r: number): ThreadedRod {
            if (profile === "acme") {
                return new ThreadedRod(DEFAULT_POS, {
                    r,
                    h: 1,
                    pitch: 0.5,
                    threadProfile: "acme",
                    handedness,
                    threadAngle: DEFAULT_ACME_THREAD_ANGLE_DEG,
                })
            }
            return new ThreadedRod(DEFAULT_POS, { r, h: 1, pitch: 0.5, threadProfile: profile, handedness })
        },
    }
}

function threadedRodHandSide(handedness: DirectionIndicator): {
    radius(r: number): ThreadedRod
    profile: {
        fdm(): { radius(r: number): ThreadedRod }
        iso(): { radius(r: number): ThreadedRod }
        acme(): { radius(r: number): ThreadedRod }
    }
} {
    return {
        radius(r: number): ThreadedRod {
            return new ThreadedRod(DEFAULT_POS, { r, h: 1, pitch: 0.5, threadProfile: "fdm", handedness })
        },
        profile: {
            fdm(): { radius(r: number): ThreadedRod } {
                return threadedRodProfileEntry("fdm", handedness)
            },
            iso(): { radius(r: number): ThreadedRod } {
                return threadedRodProfileEntry("iso", handedness)
            },
            acme(): { radius(r: number): ThreadedRod } {
                return threadedRodProfileEntry("acme", handedness)
            },
        },
    }
}

export const threaded_rod = {
    radius: threadedRodRadius,
    left: threadedRodHandSide(LEFT),
    right: threadedRodHandSide(RIGHT),
    profile: {
        fdm(): { radius(r: number): ThreadedRod } {
            return threadedRodProfileEntry("fdm", RIGHT)
        },
        iso(): { radius(r: number): ThreadedRod } {
            return threadedRodProfileEntry("iso", RIGHT)
        },
        acme(): { radius(r: number): ThreadedRod } {
            return threadedRodProfileEntry("acme", RIGHT)
        },
    },
}
