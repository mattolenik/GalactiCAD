import assert from "node:assert/strict"
import test from "node:test"
import { extrude, path2d } from "../scene.mjs"
import { FG_FLAG_CORNER, FeatureGraphBuilder } from "../feature-graph-buffer.mjs"

// A quad whose right side ([10,0] → [10,10]) is a bowed cubic. Four authored
// anchors: [0,0], [10,0], [10,10], [0,10]. The curve tessellates into several
// interior samples that must NOT become selectable creases/corners.
const PROFILE = () =>
    path2d(
        [0, 0],
        [10, 0],
        [[10, 0], [15, 3], [15, 7], [10, 10]],
        [0, 10],
    )

/** Edges whose endpoints share X,Z but differ in Y are the vertical side creases. */
function countVerticalSideEdges(cpu: ReturnType<FeatureGraphBuilder["finish"]>): number {
    let n = 0
    for (let e = 0; e < cpu.edgeCount; e++) {
        const a = cpu.edgeEndpoints[e * 2]!
        const b = cpu.edgeEndpoints[e * 2 + 1]!
        const ax = cpu.vertexPositions[a * 3]!, ay = cpu.vertexPositions[a * 3 + 1]!, az = cpu.vertexPositions[a * 3 + 2]!
        const bx = cpu.vertexPositions[b * 3]!, by = cpu.vertexPositions[b * 3 + 1]!, bz = cpu.vertexPositions[b * 3 + 2]!
        if (Math.abs(ax - bx) < 1e-9 && Math.abs(az - bz) < 1e-9 && Math.abs(ay - by) > 1e-6) n++
    }
    return n
}

test("Extrude of path2d: vertical creases only at authored anchors, not curve samples", () => {
    const root = extrude.profile(PROFILE()).height(5)
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()

    // Exactly 4 authored anchors → 4 vertical side creases, regardless of how
    // finely the bowed side tessellated.
    assert.equal(countVerticalSideEdges(cpu), 4, "one vertical crease per authored anchor")

    // The profile has more than 4 polygon vertices (the curve added interior
    // samples), so this is genuinely fewer creases than vertices.
    assert.ok(cpu.vertexCount > 8, "curve contributed interior tessellation samples (>4 polygon verts)")
})

test("Extrude of path2d: interior curve samples carry no FG_FLAG_CORNER", () => {
    const profile = PROFILE()
    const mask = profile.vertexIsAnchor!
    const root = extrude.profile(profile).height(5)
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()

    // Vertices are emitted top/bottom per polygon vertex k → indices 2k, 2k+1.
    for (let k = 0; k < mask.length; k++) {
        const expectCorner = mask[k]!
        const topFlag = cpu.vertexFlags[2 * k]! & FG_FLAG_CORNER
        const botFlag = cpu.vertexFlags[2 * k + 1]! & FG_FLAG_CORNER
        if (expectCorner) {
            assert.ok(topFlag !== 0 && botFlag !== 0, `anchor ${k} top/bottom flagged corner`)
        } else {
            assert.equal(topFlag, 0, `interior sample ${k} top not a corner`)
            assert.equal(botFlag, 0, `interior sample ${k} bottom not a corner`)
        }
    }

    const cornerVerts = Array.from(cpu.vertexFlags.slice(0, cpu.vertexCount)).filter(f => (f & FG_FLAG_CORNER) !== 0).length
    assert.equal(cornerVerts, 8, "exactly 4 anchors × (top+bottom) = 8 corner vertices")
})
