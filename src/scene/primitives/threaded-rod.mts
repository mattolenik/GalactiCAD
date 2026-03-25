import { Node, CompileResult, decapitalize, fluent, BVH_MIN_COST, DEFAULT_POS } from "../base.mjs"
import { aabb, type AABB } from "../aabb.mjs"
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

/** Finite Y-axis rod with a helical sinusoidal radius (screw-thread silhouette). */
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
    /** Sinusoidal radial amplitude about mean radius `r`. */
    threadAmp = 0
    readonly capTop: VirtualCapNode
    readonly capBottom: VirtualCapNode

    constructor(
        pos: Vec3,
        { r, h, pitch, depth, threadAngle }: { r: number; h: number; pitch: number; depth?: number; threadAngle?: number }
    ) {
        super()
        this.capTop = new VirtualCapNode(true)
        this.capBottom = new VirtualCapNode(false)
        this.pos = vec3(pos)
        this.r = r
        this.h = h
        this.turnPitch = pitch
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
        return "threadedRod"
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

    override updateScene(): void {}

    override build() {
        super.build()
        this.capTop.root = this.root
        this.capTop.build()
        this.capBottom.root = this.root
        this.capBottom.build()
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

    override compileAux(): string {
        const capTopId = this.capTop.id
        const capBottomId = this.capBottom.id
        const R = formatWgslFloat(this.r)
        const P = formatWgslFloat(this.turnPitch)
        const A = formatWgslFloat(this.threadAmp)
        return `
fn ${this.wgslExFuncName}(p: vec3f, id: u32) -> SDFResult {
    let dSide = fThreadedRodBarrelDist(p, ${R}, ${P}, ${A});
    let capH = nodeParams[id].x;
    let capY = p.y - nodeParams[id].y;
    let dCap = abs(capY) - capH;
    let d = max(dSide, dCap);
    let onSide = dSide > dCap;
    let eps = 0.001;
    let gx = fThreadedRodBarrelDist(p + vec3f(eps, 0.0, 0.0), ${R}, ${P}, ${A}) - fThreadedRodBarrelDist(p - vec3f(eps, 0.0, 0.0), ${R}, ${P}, ${A});
    let gy = fThreadedRodBarrelDist(p + vec3f(0.0, eps, 0.0), ${R}, ${P}, ${A}) - fThreadedRodBarrelDist(p - vec3f(0.0, eps, 0.0), ${R}, ${P}, ${A});
    let gz = fThreadedRodBarrelDist(p + vec3f(0.0, 0.0, eps), ${R}, ${P}, ${A}) - fThreadedRodBarrelDist(p - vec3f(0.0, 0.0, eps), ${R}, ${P}, ${A});
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
        const R = formatWgslFloat(this.r)
        const P = formatWgslFloat(this.turnPitch)
        const A = formatWgslFloat(this.threadAmp)
        const id = this.id
        return `
fn fThreadedRod_${id}_field(p: vec3f) -> f32 {
    let dSide = fThreadedRodBarrelDist(p, ${R}, ${P}, ${A});
    let h = nodeParams[${id}].x;
    let capY = p.y - nodeParams[${id}].y;
    let dCap = abs(capY) - h;
    return max(dSide, dCap);
}

fn ${this.wgslFastFuncName}(p: vec3f) -> vec2f {
    return vec2f(fThreadedRod_${id}_field(p), 1.0);
}
`
    }

    override compileAuxMid(): string {
        const R = formatWgslFloat(this.r)
        const P = formatWgslFloat(this.turnPitch)
        const A = formatWgslFloat(this.threadAmp)
        const id = this.id
        return `
fn ${this.wgslMidFuncName}(p: vec3f) -> SDFResultMid {
    let dSide = fThreadedRodBarrelDist(p, ${R}, ${P}, ${A});
    let capH = nodeParams[${id}].x;
    let capY = p.y - nodeParams[${id}].y;
    let dCap = abs(capY) - capH;
    let d = max(dSide, dCap);
    let onSide = dSide > dCap;
    let eps = 0.001;
    let gx = fThreadedRodBarrelDist(p + vec3f(eps, 0.0, 0.0), ${R}, ${P}, ${A}) - fThreadedRodBarrelDist(p - vec3f(eps, 0.0, 0.0), ${R}, ${P}, ${A});
    let gy = fThreadedRodBarrelDist(p + vec3f(0.0, eps, 0.0), ${R}, ${P}, ${A}) - fThreadedRodBarrelDist(p - vec3f(0.0, eps, 0.0), ${R}, ${P}, ${A});
    let gz = fThreadedRodBarrelDist(p + vec3f(0.0, 0.0, eps), ${R}, ${P}, ${A}) - fThreadedRodBarrelDist(p - vec3f(0.0, 0.0, eps), ${R}, ${P}, ${A});
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
        return {
            funcName,
            varName,
            text: `${this.wgslExFuncName}(p - ${this.pos.wgsl}, ${this.id}u)`,
        }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `ThreadedRod${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return {
            funcName,
            varName,
            text: `${this.wgslFastFuncName}(p - ${this.pos.wgsl})`,
        }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const funcName = `ThreadedRod${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        return {
            funcName,
            varName,
            text: `${this.wgslMidFuncName}(p - ${this.pos.wgsl})`,
        }
    }

    override computeBounds(): AABB {
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

function formatWgslFloat(n: number): string {
    if (!Number.isFinite(n)) return "0.0"
    const t = n.toFixed(8)
    const trimmed = t.includes(".") ? t.replace(/\.?0+$/, "") : t
    return trimmed === "" || trimmed === "-" ? "0.0" : trimmed
}

function threadedRodRadius(r: number): ThreadedRod {
    return new ThreadedRod(DEFAULT_POS, { r, h: 1, pitch: 0.5 })
}

export const threadedRod = { radius: threadedRodRadius }
