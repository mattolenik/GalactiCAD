/**
 * CPU screen-space hit-testing of FeatureGraph features for interactive
 * selection. Mirrors the overlay shader's projection exactly
 * (`feature_graph_overlay.wgsl` `project()` / `clipToPixels()`), so a click on
 * a rendered edge/corner resolves to the same feature the user sees.
 *
 * Coordinate convention (the load-bearing detail):
 *  - The overlay projects a world point to **centered framebuffer pixels**:
 *    `clip = project(world).clip`, `pixCentered = clip * (res * 0.5)`, range
 *    `[-res/2, +res/2]` with +y up.
 *  - The incoming pick is `clickUV ∈ [0,1]` with v flipped (v=1 at top), per
 *    `SDFRenderer.#screenToClickUV`. We map it to the same centered space via
 *    `((u-0.5)*resX, (v-0.5)*resY)`. Distances in this space equal framebuffer
 *    pixel distances (it's a pure translation/flip of top-left pixels), so a
 *    pixel threshold applies directly.
 *
 * Picking ignores depth/occlusion — it matches the overlay's default
 * draw-on-top behavior, so features are selectable through the model.
 */

import {
    enumerateAliveCorners,
    enumerateAliveEdges,
    type FeatureGraphCpu,
} from "../scene/feature-graph-buffer.mjs"
import type { FeatureGraphWorldPositions } from "./feature-graph-stages.mjs"
import type { FgChainGrouping } from "./feature-graph-chains.mjs"

export interface FgCameraParams {
    /**
     * Inverse of the frame's `viewTransform`, column-major — the *same*
     * Float32Array the overlay receives as `camera.transform`
     * (`new Mat4x4f(viewTransform).inverse().data`).
     */
    viewTransformInv: Float32Array
    /** `cameraPosition + (0, 0, PREVIEW_RAY_ORIGIN_DEPTH)`. */
    origin: readonly [number, number, number]
    resX: number
    resY: number
    /** Orthographic half-extent along Y (`orthoHalfFromDolly`). */
    zoom: number
    /** UV-space center of the visible scene area (0..1); usually `[0.5, 0.5]`. */
    viewCenter: readonly [number, number]
}

export interface FgEdgeHit {
    chainId: number
    distPx: number
}
export interface FgCornerHit {
    cornerVertexIndex: number
    distPx: number
}
export type FgAnyHit =
    | { kind: "edge"; id: number; distPx: number }
    | { kind: "corner"; id: number; distPx: number }

/** Project a world point to centered framebuffer pixels (overlay convention). */
function projectCentered(cam: FgCameraParams, x: number, y: number, z: number, out: [number, number]): void {
    const m = cam.viewTransformInv
    const cx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!
    const cy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!
    const px = cx - cam.origin[0]
    const py = cy - cam.origin[1]
    const aspect = cam.resX / cam.resY
    const ndcX = px / (cam.zoom * aspect)
    const ndcY = py / cam.zoom
    const clipX = ndcX + 2 * (cam.viewCenter[0] - 0.5)
    const clipY = ndcY - 2 * (cam.viewCenter[1] - 0.5)
    out[0] = clipX * cam.resX * 0.5
    out[1] = clipY * cam.resY * 0.5
}

/** clickUV (flipped-v, [0,1]) → centered framebuffer pixels. */
function clickToCentered(cam: FgCameraParams, clickUV: readonly [number, number]): [number, number] {
    return [(clickUV[0] - 0.5) * cam.resX, (clickUV[1] - 0.5) * cam.resY]
}

// Surface-occlusion bias in view-space (world) units — must match OCCLUSION_BIAS
// in feature_graph_overlay.wgsl so the CPU hit-test hides exactly the features
// the overlay hides in "hide behind" mode (features coincident with the surface
// stay pickable; only those clearly behind it drop out).
const OCCLUSION_BIAS = 0.5

// View-space depth of a world point (== `viewZ` in the overlay shader). Larger
// is nearer the camera, so a feature is occluded when its viewZ is below the
// surface's viewZ at that pixel. `cam.viewTransformInv` is the world→camera
// transform; this is the z row of (viewTransformInv · point) minus origin.z.
export function viewZOf(cam: FgCameraParams, x: number, y: number, z: number): number {
    const m = cam.viewTransformInv
    return m[2]! * x + m[6]! * y + m[10]! * z + m[14]! - cam.origin[2]
}

/** Nearest point on segment a–b to q: squared distance + the clamped param t. */
function segNearest(qx: number, qy: number, ax: number, ay: number, bx: number, by: number): { d2: number; t: number } {
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    let t = len2 > 0 ? ((qx - ax) * dx + (qy - ay) * dy) / len2 : 0
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const ex = qx - (ax + t * dx)
    const ey = qy - (ay + t * dy)
    return { d2: ex * ex + ey * ey, t }
}

export class FeatureGraphHitTester {
    readonly #cpu: FeatureGraphCpu
    readonly #world: FeatureGraphWorldPositions
    readonly #chains: FgChainGrouping
    readonly #aliveEdges: Uint32Array
    readonly #aliveCorners: Uint32Array
    /** FG vertex index → corner instance index (position in alive-corner stream); -1 if not a corner. */
    readonly #cornerInstanceByVertex: Map<number, number>

    constructor(cpu: FeatureGraphCpu, world: FeatureGraphWorldPositions, chains: FgChainGrouping) {
        this.#cpu = cpu
        this.#world = world
        this.#chains = chains
        this.#aliveEdges = enumerateAliveEdges(cpu)
        this.#aliveCorners = enumerateAliveCorners(cpu)
        this.#cornerInstanceByVertex = new Map()
        for (let i = 0; i < this.#aliveCorners.length; i++) {
            this.#cornerInstanceByVertex.set(this.#aliveCorners[i]!, i)
        }
    }

    get edgeInstanceCount(): number {
        return this.#aliveEdges.length
    }
    get cornerInstanceCount(): number {
        return this.#aliveCorners.length
    }
    get chains(): FgChainGrouping {
        return this.#chains
    }
    /** Corner instance index for an FG vertex, or -1 if it isn't an alive corner. */
    cornerInstanceIndex(vertexIndex: number): number {
        return this.#cornerInstanceByVertex.get(vertexIndex) ?? -1
    }

    /** Project every world vertex once: centered pixels + view-space depth
     *  (stride 3: x, y, viewZ). viewZ feeds the surface-occlusion test. */
    #projectAll(cam: FgCameraParams): Float32Array {
        const w = this.#world.positions
        const n = this.#world.count
        const out = new Float32Array(n * 3)
        const tmp: [number, number] = [0, 0]
        for (let i = 0; i < n; i++) {
            const x = w[i * 3]!
            const y = w[i * 3 + 1]!
            const z = w[i * 3 + 2]!
            projectCentered(cam, x, y, z, tmp)
            out[i * 3] = tmp[0]
            out[i * 3 + 1] = tmp[1]
            out[i * 3 + 2] = viewZOf(cam, x, y, z)
        }
        return out
    }

    pickCorner(
        clickUV: readonly [number, number],
        cam: FgCameraParams,
        thresholdPx: number,
        occluderViewZ?: number,
    ): FgCornerHit | null {
        const [qx, qy] = clickToCentered(cam, clickUV)
        const proj = this.#projectAll(cam)
        const occ = occluderViewZ !== undefined ? occluderViewZ - OCCLUSION_BIAS : null
        let best = -1
        let bestD2 = thresholdPx * thresholdPx
        for (const v of this.#aliveCorners) {
            if (occ !== null && proj[v * 3 + 2]! < occ) continue // behind the surface
            const dx = proj[v * 3]! - qx
            const dy = proj[v * 3 + 1]! - qy
            const d2 = dx * dx + dy * dy
            if (d2 < bestD2) {
                bestD2 = d2
                best = v
            }
        }
        return best < 0 ? null : { cornerVertexIndex: best, distPx: Math.sqrt(bestD2) }
    }

    pickEdgeChain(
        clickUV: readonly [number, number],
        cam: FgCameraParams,
        thresholdPx: number,
        occluderViewZ?: number,
    ): FgEdgeHit | null {
        const [qx, qy] = clickToCentered(cam, clickUV)
        const proj = this.#projectAll(cam)
        const cpu = this.#cpu
        const occ = occluderViewZ !== undefined ? occluderViewZ - OCCLUSION_BIAS : null
        let bestS = -1
        let bestD2 = thresholdPx * thresholdPx
        for (let s = 0; s < this.#aliveEdges.length; s++) {
            const e = this.#aliveEdges[s]!
            const a = cpu.edgeEndpoints[e * 2]!
            const b = cpu.edgeEndpoints[e * 2 + 1]!
            const nd = segNearest(qx, qy, proj[a * 3]!, proj[a * 3 + 1]!, proj[b * 3]!, proj[b * 3 + 1]!)
            if (nd.d2 >= bestD2) continue
            // Surface occlusion: the edge's depth at the point nearest the cursor,
            // behind the surface ⇒ skip (matches the overlay's hide-behind).
            if (occ !== null) {
                const vz = proj[a * 3 + 2]! + (proj[b * 3 + 2]! - proj[a * 3 + 2]!) * nd.t
                if (vz < occ) continue
            }
            bestD2 = nd.d2
            bestS = s
        }
        if (bestS < 0) return null
        return { chainId: this.#chains.edgeInstanceToChain[bestS]!, distPx: Math.sqrt(bestD2) }
    }

    /**
     * Nearest feature of any type, with CORNERS taking precedence: if a corner
     * is within its threshold it always wins over an edge, even one that's
     * closer — otherwise picking near a vertex flickers between the corner and
     * the edges meeting at it. To select such an edge, hover its mid-span away
     * from the vertex. Corners and edge-chains take separate thresholds — points
     * warrant a more generous grab radius than lines, where a loose threshold
     * reads as "triggering far from the line". `edgeThresholdPx` defaults to the
     * corner threshold.
     */
    pickAny(
        clickUV: readonly [number, number],
        cam: FgCameraParams,
        cornerThresholdPx: number,
        edgeThresholdPx: number = cornerThresholdPx,
        occluderViewZ?: number,
    ): FgAnyHit | null {
        const c = this.pickCorner(clickUV, cam, cornerThresholdPx, occluderViewZ)
        if (c) return { kind: "corner", id: c.cornerVertexIndex, distPx: c.distPx }
        const e = this.pickEdgeChain(clickUV, cam, edgeThresholdPx, occluderViewZ)
        if (e) return { kind: "edge", id: e.chainId, distPx: e.distPx }
        return null
    }
}
