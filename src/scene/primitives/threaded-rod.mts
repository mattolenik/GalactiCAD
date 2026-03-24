import { Node, CompileResult, fluent, decapitalize, DEFAULT_POS } from "../base.mjs"
import { aabb, type AABB } from "../aabb.mjs"
import { Vec3, vec3 } from "../../vecmat/vector.mjs"

/** Finite Y-axis rod with a helical sinusoidal radius (screw-thread silhouette). */
export class ThreadedRod extends Node {
    pos = vec3([0, 0, 0])
    r = 0
    h = 0
    /** Axial distance for one full 360° turn (same units as scene). */
    turnPitch = 0
    /** Sinusoidal radial amplitude about mean radius `r` (crest minus mean ≈ `turnPitch` term magnitude). */
    threadAmp = 0

    constructor(pos: Vec3, { r, h, pitch, depth }: { r: number; h: number; pitch: number; depth: number }) {
        super()
        this.pos = vec3(pos)
        this.r = r
        this.h = h
        this.turnPitch = pitch
        this.threadAmp = depth
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
    override updateScene(): void {}
    override compile(indentLevel = 0): CompileResult {
        const funcName = `ThreadedRod${this.id}`
        const varName = decapitalize(funcName)
        return {
            funcName,
            varName,
            text: `fThreadedRodEx(p - ${this.pos.wgsl}, ${this.r}, ${this.h}, ${this.turnPitch}, ${this.threadAmp}, ${this.id}u)`,
        }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `ThreadedRod${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return {
            funcName,
            varName,
            text: `fThreadedRodFast(p - ${this.pos.wgsl}, ${this.r}, ${this.h}, ${this.turnPitch}, ${this.threadAmp})`,
        }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const funcName = `ThreadedRod${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        return {
            funcName,
            varName,
            text: `fThreadedRodMid(p - ${this.pos.wgsl}, ${this.r}, ${this.h}, ${this.turnPitch}, ${this.threadAmp})`,
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
        return this
    }
    @fluent depth(d: number): this {
        this.threadAmp = d
        return this
    }
    @fluent shift(v: Vec3): this {
        this.pos = vec3(v)
        return this
    }
}

function threadedRodRadius(r: number): ThreadedRod {
    return new ThreadedRod(DEFAULT_POS, { r, h: 1, pitch: 0.5, depth: 0.06 })
}

export const threadedRod = { radius: threadedRodRadius }
