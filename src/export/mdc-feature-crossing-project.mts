/**
 * CPU mirror of `mdc_feature_crossing_project.wgsl` (`mdcFeatureProjectCrossingPosition`).
 * Keep formulas and constants aligned with the WGSL include.
 *
 * For rings, pass `ringQefCircleProjection`: true iff the **maximum** 3D distance from every
 * Hermite crossing in that cell-component to the ring circle is ≤ `voxelSize * MDC_RING_QEF_PROJECT_SCALE`
 * (same rule as `edgeDetection_Pass3` in `mdc.wgsl`). Per-edge mixed projection breaks QEF consistency.
 */

import type { ComponentFeatureCpu } from "./mdc-mid-grid.mjs"
import {
    MID_FEATURE_BOOLEAN_SEAM,
    MID_FEATURE_CORNER,
    MID_FEATURE_LINE,
    MID_FEATURE_RING,
} from "./mdc-mid-grid.mjs"

/** Matches WGSL `MDC_RING_QEF_PROJECT_SCALE` in `mdc_feature_crossing_project.wgsl`. */
export const MDC_RING_QEF_PROJECT_SCALE = 1.85

function lengthSqr3(x: number, y: number, z: number): number {
    return x * x + y * y + z * z
}

function safeUnit3(x: number, y: number, z: number): [number, number, number] {
    const len = Math.hypot(x, y, z)
    if (len < 1e-12) return [0, 1, 0]
    const inv = 1 / len
    return [x * inv, y * inv, z * inv]
}

function cross3(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
): [number, number, number] {
    return [
        ay * bz - az * by,
        az * bx - ax * bz,
        ax * by - ay * bx,
    ]
}

function dot3(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
    return ax * bx + ay * by + az * bz
}

export function mdcClosestPointOnRingFeatureCpu(f: ComponentFeatureCpu, px: number, py: number, pz: number): [number, number, number] {
    const rx = f.point[0] - f.axisCenter[0]
    const ry = f.point[1] - f.axisCenter[1]
    const rz = f.point[2] - f.axisCenter[2]
    const ringR = Math.hypot(rx, ry, rz)
    if (ringR < 1e-8) return [f.point[0], f.point[1], f.point[2]]

    const tang = safeUnit3(f.tangent[0], f.tangent[1], f.tangent[2])
    const axisRaw = cross3(tang[0], tang[1], tang[2], rx, ry, rz)
    if (lengthSqr3(axisRaw[0], axisRaw[1], axisRaw[2]) < 1e-12) {
        return [f.point[0], f.point[1], f.point[2]]
    }
    const ringAxis = safeUnit3(axisRaw[0], axisRaw[1], axisRaw[2])
    const vx = px - f.axisCenter[0]
    const vy = py - f.axisCenter[1]
    const vz = pz - f.axisCenter[2]
    const projLen = vx * ringAxis[0] + vy * ringAxis[1] + vz * ringAxis[2]
    const inx = vx - ringAxis[0] * projLen
    const iny = vy - ringAxis[1] * projLen
    const inz = vz - ringAxis[2] * projLen
    const rho = Math.hypot(inx, iny, inz)
    if (rho > 1e-8) {
        const s = ringR / rho
        return [
            f.axisCenter[0] + inx * s,
            f.axisCenter[1] + iny * s,
            f.axisCenter[2] + inz * s,
        ]
    }
    return [f.point[0], f.point[1], f.point[2]]
}

export function featureLineTangentCpu(f: ComponentFeatureCpu): [number, number, number] {
    if (lengthSqr3(f.tangent[0], f.tangent[1], f.tangent[2]) > 1e-8) {
        return safeUnit3(f.tangent[0], f.tangent[1], f.tangent[2])
    }
    if (f.normalCount >= 2) {
        const t = cross3(f.n0[0], f.n0[1], f.n0[2], f.n1[0], f.n1[1], f.n1[2])
        if (lengthSqr3(t[0], t[1], t[2]) > 1e-8) return safeUnit3(t[0], t[1], t[2])
    }
    return [0, 0, 0]
}

export function mdcFeatureProjectCrossingPositionCpu(
    intersectionPos: readonly [number, number, number],
    feature: ComponentFeatureCpu,
    explicitRingFeat: ComponentFeatureCpu,
    featureConstraintsEnabled: boolean,
    explicitLineDist: number,
    explicitRingDist: number,
    explicitCornerDist: number,
    explicitSeamDist: number,
    ringQefCircleProjection: boolean,
): [number, number, number] {
    let projPos: [number, number, number] = [intersectionPos[0], intersectionPos[1], intersectionPos[2]]
    if (!featureConstraintsEnabled) return projPos

    const px = intersectionPos[0]
    const py = intersectionPos[1]
    const pz = intersectionPos[2]

    if (feature.kind === MID_FEATURE_LINE && explicitLineDist < 1e8) {
        const tangent = featureLineTangentCpu(feature)
        if (lengthSqr3(tangent[0], tangent[1], tangent[2]) > 1e-8) {
            const tdot = dot3(px - feature.point[0], py - feature.point[1], pz - feature.point[2], tangent[0], tangent[1], tangent[2])
            projPos = [
                feature.point[0] + tangent[0] * tdot,
                feature.point[1] + tangent[1] * tdot,
                feature.point[2] + tangent[2] * tdot,
            ]
        }
    } else if (feature.kind === MID_FEATURE_RING && explicitRingDist < 1e8) {
        if (ringQefCircleProjection) {
            projPos = mdcClosestPointOnRingFeatureCpu(explicitRingFeat, px, py, pz)
        } else {
            projPos = [px, py, pz]
        }
    } else if (feature.kind === MID_FEATURE_CORNER && explicitCornerDist < 1e8) {
        projPos = [feature.point[0], feature.point[1], feature.point[2]]
    } else if (feature.kind === MID_FEATURE_BOOLEAN_SEAM && explicitSeamDist < 1e8) {
        const tangent = featureLineTangentCpu(feature)
        if (lengthSqr3(tangent[0], tangent[1], tangent[2]) > 1e-8) {
            const tdot = dot3(px - feature.point[0], py - feature.point[1], pz - feature.point[2], tangent[0], tangent[1], tangent[2])
            projPos = [
                feature.point[0] + tangent[0] * tdot,
                feature.point[1] + tangent[1] * tdot,
                feature.point[2] + tangent[2] * tdot,
            ]
        }
    }
    return projPos
}
