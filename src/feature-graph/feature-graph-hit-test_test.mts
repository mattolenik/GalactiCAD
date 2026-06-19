import assert from "node:assert/strict"
import test from "node:test"
import {
    FeatureGraphBuilder,
    FG_FLAG_CORNER,
    FG_FLAG_CREASE_ORIGINAL,
} from "../scene/feature-graph-buffer.mjs"
import { Vec3f } from "../vecmat/vector.mjs"
import { groupChains } from "./feature-graph-chains.mjs"
import { FeatureGraphHitTester, type FgCameraParams } from "./feature-graph-hit-test.mjs"
import type { FeatureGraphWorldPositions } from "./feature-graph-stages.mjs"

const v3 = (x: number, y: number, z: number) => new Vec3f([x, y, z])

function identityMat4(): Float32Array {
    const m = new Float32Array(16)
    m[0] = 1
    m[5] = 1
    m[10] = 1
    m[15] = 1
    return m
}

// Identity camera, non-square res so the aspect path is exercised. With
// viewTransformInv = I, origin = 0, zoom = 1, viewCenter = (0.5,0.5):
//   centeredX = (x / aspect) * resX/2,  centeredY = y * resY/2
//   clickUV   = (centeredX/resX + 0.5, centeredY/resY + 0.5)
const CAM: FgCameraParams = {
    viewTransformInv: identityMat4(),
    origin: [0, 0, 0],
    resX: 200,
    resY: 100,
    zoom: 1,
    viewCenter: [0.5, 0.5],
}

// Hand-computed clickUV for a world point under CAM (inverse of the projection).
function uvForWorld(x: number, y: number): [number, number] {
    const aspect = CAM.resX / CAM.resY
    const centeredX = (x / (CAM.zoom * aspect)) * CAM.resX * 0.5
    const centeredY = (y / CAM.zoom) * CAM.resY * 0.5
    return [centeredX / CAM.resX + 0.5, centeredY / CAM.resY + 0.5]
}

function build() {
    const b = new FeatureGraphBuilder()
    b.beginNode(1)
    const a = b.emitVertex(v3(-0.5, 0, 0), FG_FLAG_CORNER, [])
    const c = b.emitVertex(v3(0.5, 0, 0), FG_FLAG_CORNER, [])
    b.emitEdge(a, c, FG_FLAG_CREASE_ORIGINAL)
    b.endNode()
    const cpu = b.finish()
    const world: FeatureGraphWorldPositions = { positions: cpu.vertexPositions.slice(), count: cpu.vertexCount }
    const chains = groupChains(cpu)
    return { ht: new FeatureGraphHitTester(cpu, world, chains), a, c, chains }
}

test("hit-test: clicking a corner's projected pixel returns that corner", () => {
    const { ht, a } = build()
    const hit = ht.pickCorner(uvForWorld(-0.5, 0), CAM, 8)
    assert.ok(hit)
    assert.equal(hit!.cornerVertexIndex, a)
    assert.ok(hit!.distPx < 1e-3)
})

test("hit-test: clicking the edge midpoint returns its chain", () => {
    const { ht } = build()
    const hit = ht.pickEdgeChain(uvForWorld(0, 0), CAM, 8)
    assert.ok(hit)
    assert.equal(hit!.chainId, 0)
    assert.ok(hit!.distPx < 1e-3)
})

test("hit-test: a far click rejects (threshold)", () => {
    const { ht } = build()
    // Top-right corner of the viewport, nowhere near the segment.
    assert.equal(ht.pickCorner([0.95, 0.95], CAM, 8), null)
    assert.equal(ht.pickEdgeChain([0.95, 0.95], CAM, 8), null)
})

test("hit-test: pickAny prefers the edge mid-span, corner at the tie", () => {
    const { ht, a } = build()
    const mid = ht.pickAny(uvForWorld(0, 0), CAM, 8)
    assert.equal(mid?.kind, "edge")
    // At a corner that is also a segment endpoint, both dist ≈ 0 → corner wins.
    const atCorner = ht.pickAny(uvForWorld(-0.5, 0), CAM, 8)
    assert.equal(atCorner?.kind, "corner")
    assert.equal(atCorner?.id, a)
})

test("hit-test: corner instance index maps back from vertex id", () => {
    const { ht, a, c } = build()
    assert.equal(ht.cornerInstanceCount, 2)
    assert.equal(ht.cornerInstanceIndex(a), 0)
    assert.equal(ht.cornerInstanceIndex(c), 1)
    assert.equal(ht.cornerInstanceIndex(999), -1)
})
