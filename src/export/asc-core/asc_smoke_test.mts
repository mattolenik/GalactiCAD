import test from "node:test"
import assert from "node:assert/strict"
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
