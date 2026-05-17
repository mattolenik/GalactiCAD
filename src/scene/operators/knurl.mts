import type { Node } from "../base.mjs"
import { repeatPolar } from "./repeat_polar.mjs"
import { Subtract } from "./subtract.mjs"
import { translate } from "./translate.mjs"
import type { Cylinder } from "../primitives/cylinder.mjs"
import type { FeatureGraphBuilder } from "../feature-graph-buffer.mjs"

/**
 * Boolean subtract used by {@link knurl}; same SDF as {@link Subtract} with `radius === 0`,
 * but `getShapeType()` is `knurl` for editor glyph / source matching.
 */
export class KnurlSubtract extends Subtract {
    override getShapeType(): string {
        return "knurl"
    }
    override getIndicatorSymbol(): string {
        return "◈"
    }
    /** Side view: cylinder wall with crossing diagonals (diamond knurl on OD). */
    override getIndicatorSvg(): string {
        return `<path fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" d="M2 2 L2 10 M10 2 L10 10 M2 3.5 L10 5.5 M10 3.5 L2 5.5 M2 6.5 L10 8.5 M10 6.5 L2 8.5"/>`
    }

    /**
     * V1: drop child features. KnurlSubtract pairs with `repeatPolar` of the
     * cutter, which is itself feature-destroying for now (`repeat_polar.mts`).
     * Revisit once both sides of the knurl pair have proven feature semantics.
     */
    override accumulateFeatureGraph(_builder: FeatureGraphBuilder): void {
        // intentionally no-op (do not recurse)
    }

    constructor(lh: Node, rh: Node) {
        super(lh, rh, 0)
    }
}

/**
 * Straight knurl: `subtract(cylinder, repeatPolar(teeth, translate(…, pattern)))`.
 * The pattern node is repeated in azimuth around +Y after translating its origin to
 * `(base.pos.x + base.r + radialOffset, base.pos.y, base.pos.z)` so you can sit cutters on the OD.
 *
 * The base cylinder should be centered on the world Y axis in XZ (`pos.x` ≈ `pos.z` ≈ 0).
 */
export class KnurlBuilder {
    #base: Cylinder
    /** Extra +X translation beyond `base.r` (default 0). */
    #radialOffset = 0

    constructor(base: Cylinder) {
        this.#base = base
    }

    /**
     * Radial placement along +X from the cylinder axis: final origin is
     * `base.pos.x + base.r + offset` (use negative values to pull cutters into the wall).
     */
    offset(radialExtra: number): this {
        this.#radialOffset = radialExtra
        return this
    }

    /**
     * @param pattern Any scene node used as the cutter (translated then polar-repeated).
     * @param teeth Number of polar repeats.
     */
    pattern(pattern: Node, teeth: number): KnurlSubtract {
        const t = Math.round(Number(teeth))
        if (!Number.isFinite(t) || t < 2) {
            throw new Error(`knurl.pattern: teeth must be a number >= 2 (got ${teeth})`)
        }
        const b = this.#base
        const dx = b.pos.x + b.r + this.#radialOffset
        const dy = b.pos.y
        const dz = b.pos.z
        const shifted = translate([dx, dy, dz], pattern)
        const cut = repeatPolar(t, shifted)
        return new KnurlSubtract(b, cut)
    }
}

export function knurl(base: Cylinder): KnurlBuilder {
    return new KnurlBuilder(base)
}