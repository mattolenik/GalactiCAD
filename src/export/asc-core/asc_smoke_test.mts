import test from "node:test"
import assert from "node:assert/strict"
import { applyAscHermiteQef } from "../asc-hermite-qef.mjs"
import { AscVoxelGrid } from "./data-grid.mjs"
import { runAscLayerSweep } from "./layers.mjs"

/** Synthetic sphere SDF (negative inside); ASC binary matches asc `Data::operator[]` (outside→1). */
function fillSphereGrid(w: number, h: number, d: number, cx: number, cy: number, cz: number, R: number): Float32Array {
    const data = new Float32Array(w * h * d)
    let ix = 0
    for (let z = 0; z < d; z++) {
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const dx = x - cx
                const dy = y - cy
                const dz = z - cz
                data[ix++] = Math.sqrt(dx * dx + dy * dy + dz * dz) - R
            }
        }
    }
    return data
}

function fillBoxGrid(w: number, h: number, d: number, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): Float32Array {
    const data = new Float32Array(w * h * d)
    let ix = 0
    for (let z = 0; z < d; z++) {
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                data[ix++] = Math.max(Math.abs(x - cx) - hx, Math.abs(y - cy) - hy, Math.abs(z - cz) - hz)
            }
        }
    }
    return data
}

test("runAscLayerSweep extracts triangles from a sphere distance field (communicate=false)", () => {
    const w = 33
    const h = 33
    const d = 33
    const data = fillSphereGrid(w, h, d, 16, 16, 16, 8)
    const grid = new AscVoxelGrid(data, w, h, d, 0)
    const out = runAscLayerSweep({
        tierIndex: 2,
        grid,
        handleAmbiguity: true,
        communicate: false,
        widthScale: 1,
        depthScale: 1,
        heightScale: 1,
        handleBeauty: false,
        angleThreshRad: Math.PI / 4,
    })
    assert.ok(out.indices.length > 0, `expected triangles, got indices=${out.indices.length}`)
})

test("runAscLayerSweep extracts triangles with CommunicateSimple sweep", () => {
    const w = 33
    const h = 33
    const d = 33
    const data = fillSphereGrid(w, h, d, 16, 16, 16, 8)
    const grid = new AscVoxelGrid(data, w, h, d, 0)
    const out = runAscLayerSweep({
        tierIndex: 2,
        grid,
        handleAmbiguity: true,
        communicate: true,
        widthScale: 1,
        depthScale: 1,
        heightScale: 1,
        handleBeauty: false,
        angleThreshRad: Math.PI / 4,
    })
    assert.ok(out.indices.length > 0, `expected triangles, got indices=${out.indices.length}`)
})

test("runAscLayerSweep does not emit the sampling-domain boundary for all-outside grids", () => {
    const w = 17
    const h = 17
    const d = 17
    const data = new Float32Array(w * h * d)
    data.fill(1)
    const grid = new AscVoxelGrid(data, w, h, d, 0)
    const out = runAscLayerSweep({
        tierIndex: 2,
        grid,
        handleAmbiguity: true,
        communicate: true,
        widthScale: 1,
        depthScale: 1,
        heightScale: 1,
        handleBeauty: false,
        angleThreshRad: Math.PI / 4,
    })
    assert.equal(out.indices.length, 0)
})

test("applyAscHermiteQef pulls vertices near box edges toward multi-plane feature intersections", () => {
    const w = 17
    const h = 17
    const d = 17
    const grid = new AscVoxelGrid(fillBoxGrid(w, h, d, 8, 8, 8, 4, 4, 4), w, h, d, 0)
    const verts = new Float32Array(8)
    verts[0] = 12
    verts[1] = 11.5
    verts[2] = 8
    const sharpened = applyAscHermiteQef(
        { verts, tris: new Uint32Array(0) },
        grid,
        { originX: 0, originY: 0, originZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
    )
    assert.equal(sharpened.movedVertices, 1)
    assert.ok(Math.abs(sharpened.verts[0]! - 12) < 1e-3)
    assert.ok(Math.abs(sharpened.verts[1]! - 12) < 1e-2, `expected y to snap toward 12, got ${sharpened.verts[1]}`)
})
