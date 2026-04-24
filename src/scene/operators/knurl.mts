import type { Node } from "../base.mjs"
import { Groove } from "./groove.mjs"
import { repeatPolar } from "./repeat_polar.mjs"
import { box } from "../primitives/box.mjs"
import type { Cylinder } from "../primitives/cylinder.mjs"

/**
 * Heuristic groove `ra` (channel width along the intersection) from the stock cylinder.
 * Tuned to match the straight_knurl sample (~0.38 at r=2.2).
 */
export function defaultKnurlGrooveRa(base: Cylinder): number {
    const r = Math.max(base.r, 1e-6)
    return Math.min(Math.max(0.17 * r, 0.06), 1.5)
}

/**
 * Heuristic groove `rb` (depth into the pattern) from stock radius and pattern radial bite.
 */
export function defaultKnurlGrooveRb(base: Cylinder, patternCylinder: Cylinder): number {
    const biteX = Math.max(1e-6, patternCylinder.r)
    const br = Math.max(base.r, 1e-6)
    return Math.min(Math.max(0.6 * biteX + 0.028 * br, 0.04), 0.55)
}

function knurlToothPattern(base: Cylinder, patternCylinder: Cylinder, teeth: number): Node {
    const baseR = Math.max(base.r, 1e-6)
    const baseH = Math.max(base.h, 1e-6)
    const biteX = Math.max(1e-4, patternCylinder.r)
    const biteY = Math.max(1e-4, Math.min(baseH, patternCylinder.h) * 0.92)
    const halfPitch = Math.PI / teeth
    const biteZ = Math.max(1e-4, baseR * Math.sin(halfPitch) * 0.52)
    const clearance = Math.max(0.02 * baseR, 0.25 * biteX)
    const radialShift = baseR + biteX - clearance
    const tooth = box([biteX, biteY, biteZ]).shift([base.pos.x + radialShift, base.pos.y, base.pos.z])
    return repeatPolar(teeth, tooth)
}

/**
 * Straight knurl helper: builds `groove(base, repeatPolar(teeth, toothBox))` with tooth
 * sizing from a pattern cylinder and optional groove radii (defaults scale with `base` / bite).
 *
 * The base cylinder should be centered on the world Y axis in XZ (`pos.x` ≈ `pos.z` ≈ 0);
 * polar repeat is evaluated around global +Y through the origin.
 */
export class KnurlBuilder {
    #base: Cylinder
    #ra?: number
    #rb?: number

    constructor(base: Cylinder) {
        this.#base = base
    }

    /** Override automatic groove radii from {@link defaultKnurlGrooveRa} / {@link defaultKnurlGrooveRb}. */
    radii(ra: number, rb: number): this {
        this.#ra = ra
        this.#rb = rb
        return this
    }

    /**
     * @param patternCylinder Radial bite uses `.r`; axial band uses `min(base.h, pattern.h) * 0.92`
     *        (same idea as straight_knurl). Height on the pattern cylinder is the **half-height**
     *        stored on `Cylinder` (same as `cylinder.radius(r).height(h)`).
     * @param teeth Number of polar repeats (knurl count).
     */
    pattern(patternCylinder: Cylinder, teeth: number): Groove {
        const t = Math.round(Number(teeth))
        if (!Number.isFinite(t) || t < 2) {
            throw new Error(`knurl.pattern: teeth must be a number >= 2 (got ${teeth})`)
        }
        const ra = this.#ra ?? defaultKnurlGrooveRa(this.#base)
        const rb = this.#rb ?? defaultKnurlGrooveRb(this.#base, patternCylinder)
        const pat = knurlToothPattern(this.#base, patternCylinder, t)
        return new Groove(this.#base, pat, ra, rb)
    }
}

export function knurl(base: Cylinder): KnurlBuilder {
    return new KnurlBuilder(base)
}
