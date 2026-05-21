/**
 * Adapter: FeatureGraph → ContourBufferView (Stage 6, SHREC integration).
 *
 * SHREC's MergeSharp pass consumes a {@link ContourBufferView} of segments
 * + points + rings, builds its own spatial index, and snaps mesh vertices
 * to these features during DC vertex placement. This adapter feeds it
 * CSG-survival-aware data from the FeatureGraph instead of the raw
 * `accumulateContours` walk — features that got cut by a CSG operation or
 * faded into a smooth blend are absent from the snap set, so SHREC stops
 * snapping to features that no longer exist on the iso-surface.
 *
 * Mapping
 * -------
 *  - **Alive FG corner vertices** (FG_FLAG_CORNER set) → ContourBuffer
 *    points. These are 3-way meetings and the strongest snap targets.
 *  - **Non-corner alive FG vertices** (mid-segment subdivision samples,
 *    bisection boundary vertices) → NOT emitted as points. They're already
 *    implicit in the segment endpoints; adding them as points would just
 *    add weak candidates that fight the segment-based snap for ambiguous
 *    cells.
 *  - **Alive FG edges** → ContourBuffer segments, with world-space
 *    endpoints from {@link FeatureGraphWorldPositions}.
 *  - **FG loops** → not converted (no equivalent in v1 ContourBuffer).
 *  - **Rings** → empty; the FG doesn't model parametric circles yet.
 *
 * Fields not preserved (acceptable losses)
 * -----------------------------------------
 *  - `nodeRanges` is only used by SHREC for logging (`.size` count), so we
 *    emit an empty Map.
 *  - `boxContourOwnerIds` enables a SHREC pre-snap optimisation scoped to
 *    box-origin features. The FG doesn't track primitive types (only node
 *    ids), so we emit empty; SHREC falls back to its main snap path which
 *    is still correct, just slightly less aggressive.
 */

import {
    type ContourBufferView,
    EMPTY_CONTOUR_BUFFER,
} from "../scene/contour-buffer.mjs"
import type { FeatureGraphCpu } from "../scene/feature-graph-buffer.mjs"
import {
    FG_FLAG_ALIVE,
    FG_FLAG_CORNER,
} from "../scene/feature-graph-buffer.mjs"
import type { FeatureGraphWorldPositions } from "./feature-graph-stages.mjs"

export function featureGraphToContours(
    cpu: FeatureGraphCpu,
    world: FeatureGraphWorldPositions,
): ContourBufferView {
    let pointCount = 0
    for (let i = 0; i < cpu.vertexCount; i++) {
        const f = cpu.vertexFlags[i]!
        if ((f & FG_FLAG_ALIVE) !== 0 && (f & FG_FLAG_CORNER) !== 0) pointCount++
    }
    let segmentCount = 0
    for (let e = 0; e < cpu.edgeCount; e++) {
        if ((cpu.edgeFlags[e]! & FG_FLAG_ALIVE) !== 0) segmentCount++
    }

    if (pointCount === 0 && segmentCount === 0) {
        return EMPTY_CONTOUR_BUFFER
    }

    const points = new Float32Array(pointCount * 3)
    const pointBBox = new Float32Array(pointCount * 6)
    const pointOwners = new Uint32Array(pointCount)
    const segments = new Float32Array(segmentCount * 6)
    const segmentBBox = new Float32Array(segmentCount * 6)
    const segmentOwners = new Uint32Array(segmentCount)

    let pIdx = 0
    for (let i = 0; i < cpu.vertexCount; i++) {
        const f = cpu.vertexFlags[i]!
        if ((f & FG_FLAG_ALIVE) === 0 || (f & FG_FLAG_CORNER) === 0) continue
        const x = world.positions[i * 3]!,    y = world.positions[i * 3 + 1]!, z = world.positions[i * 3 + 2]!
        points[pIdx * 3 + 0] = x
        points[pIdx * 3 + 1] = y
        points[pIdx * 3 + 2] = z
        // Point AABB collapses to its position (matches contour-buffer
        // convention so the spatial-index builder can stay branch-free).
        pointBBox[pIdx * 6 + 0] = x
        pointBBox[pIdx * 6 + 1] = y
        pointBBox[pIdx * 6 + 2] = z
        pointBBox[pIdx * 6 + 3] = x
        pointBBox[pIdx * 6 + 4] = y
        pointBBox[pIdx * 6 + 5] = z
        pointOwners[pIdx] = cpu.vertexOwnerNodeId[i]!
        pIdx++
    }

    let sIdx = 0
    for (let e = 0; e < cpu.edgeCount; e++) {
        if ((cpu.edgeFlags[e]! & FG_FLAG_ALIVE) === 0) continue
        const va = cpu.edgeEndpoints[e * 2]!
        const vb = cpu.edgeEndpoints[e * 2 + 1]!
        const ax = world.positions[va * 3]!,    ay = world.positions[va * 3 + 1]!, az = world.positions[va * 3 + 2]!
        const bx = world.positions[vb * 3]!,    by = world.positions[vb * 3 + 1]!, bz = world.positions[vb * 3 + 2]!
        segments[sIdx * 6 + 0] = ax
        segments[sIdx * 6 + 1] = ay
        segments[sIdx * 6 + 2] = az
        segments[sIdx * 6 + 3] = bx
        segments[sIdx * 6 + 4] = by
        segments[sIdx * 6 + 5] = bz
        segmentBBox[sIdx * 6 + 0] = Math.min(ax, bx)
        segmentBBox[sIdx * 6 + 1] = Math.min(ay, by)
        segmentBBox[sIdx * 6 + 2] = Math.min(az, bz)
        segmentBBox[sIdx * 6 + 3] = Math.max(ax, bx)
        segmentBBox[sIdx * 6 + 4] = Math.max(ay, by)
        segmentBBox[sIdx * 6 + 5] = Math.max(az, bz)
        segmentOwners[sIdx] = cpu.edgeOwnerNodeId[e]!
        sIdx++
    }

    return {
        segments,
        segmentBBox,
        segmentOwners,
        segmentCount,
        points,
        pointBBox,
        pointOwners,
        pointCount,
        rings: new Float32Array(0),
        ringBBox: new Float32Array(0),
        ringOwners: new Uint32Array(0),
        ringCount: 0,
        nodeRanges: new Map(),
        boxContourOwnerIds: new Uint32Array(0),
    }
}
