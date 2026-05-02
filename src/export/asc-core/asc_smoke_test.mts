import test from "node:test"
import assert from "node:assert/strict"
import type { MeshData } from "../export.mjs"
import { applyAscHermiteQef, applyAscHermiteQefSync } from "../asc-hermite-qef.mjs"
import {
    ASC_HERMITE_VERTEX_STRIDE_F32,
    applyAscHermiteQefVertexRange,
    type AscHermiteQefOptions,
} from "../asc-hermite-qef-range.mjs"
import { mergeAscLayerSweepChunks } from "../asc-layer-merge.mjs"
import { AscVoxelGrid } from "./data-grid.mjs"
import { runAscLayerSweep, type AscLayerSweepResult } from "./layers.mjs"

const VERTEX_STRIDE_F32 = 8

function ascLayerResultToMeshData(asc: AscLayerSweepResult, originX: number, originY: number, originZ: number): MeshData {
    const n = (asc.positions.length / 3) | 0
    if (n === 0) {
        return { verts: new Float32Array(0), tris: new Uint32Array(0) }
    }
    const verts = new Float32Array(n * VERTEX_STRIDE_F32)
    for (let i = 0; i < n; i++) {
        const b = i * VERTEX_STRIDE_F32
        verts[b] = asc.positions[i * 3]! + originX
        verts[b + 1] = asc.positions[i * 3 + 1]! + originY
        verts[b + 2] = asc.positions[i * 3 + 2]! + originZ
        verts[b + 3] = 0
        verts[b + 4] = asc.normals[i * 3]!
        verts[b + 5] = asc.normals[i * 3 + 1]!
        verts[b + 6] = asc.normals[i * 3 + 2]!
        verts[b + 7] = 0
    }
    const tris = new Uint32Array(asc.indices.length)
    for (let i = 0; i < asc.indices.length; i++) tris[i] = asc.indices[i]!
    return { verts, tris }
}

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

test("runAscLayerSweep extracts triangles from a sphere distance field (communicate=false)", async () => {
    const w = 33
    const h = 33
    const d = 33
    const data = fillSphereGrid(w, h, d, 16, 16, 16, 8)
    const grid = new AscVoxelGrid(data, w, h, d, 0)
    const out = await runAscLayerSweep({
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

test("runAscLayerSweep extracts triangles with CommunicateSimple sweep", async () => {
    const w = 33
    const h = 33
    const d = 33
    const data = fillSphereGrid(w, h, d, 16, 16, 16, 8)
    const grid = new AscVoxelGrid(data, w, h, d, 0)
    const out = await runAscLayerSweep({
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

test("runAscLayerSweep does not emit the sampling-domain boundary for all-outside grids", async () => {
    const w = 17
    const h = 17
    const d = 17
    const data = new Float32Array(w * h * d)
    data.fill(1)
    const grid = new AscVoxelGrid(data, w, h, d, 0)
    const out = await runAscLayerSweep({
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

test("mergeAscLayerSweepChunks preserves order and offsets triangle indices", () => {
    const a = {
        positions: [0, 0, 0, 1, 0, 0],
        normals: [1, 0, 0, 0, 1, 0],
        indices: [0, 1, 0],
    }
    const b = {
        positions: [2, 2, 2],
        normals: [0, 0, 1],
        indices: [0, 0, 0],
    }
    const m = mergeAscLayerSweepChunks([a, b])
    assert.deepEqual(m.indices, [0, 1, 0, 2, 2, 2])
    assert.equal(m.positions.length, 9)
})

test("applyAscHermiteQef pulls vertices near box edges toward multi-plane feature intersections", async () => {
    const w = 17
    const h = 17
    const d = 17
    const grid = new AscVoxelGrid(fillBoxGrid(w, h, d, 8, 8, 8, 4, 4, 4), w, h, d, 0)
    const verts = new Float32Array(8)
    verts[0] = 12
    verts[1] = 11.5
    verts[2] = 8
    const sharpened = await applyAscHermiteQef(
        { verts, tris: new Uint32Array(0) },
        grid,
        { originX: 0, originY: 0, originZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
    )
    assert.equal(sharpened.movedVertices, 1)
    assert.ok(Math.abs(sharpened.verts[0]! - 12) < 1e-3)
    assert.ok(Math.abs(sharpened.verts[1]! - 12) < 1e-2, `expected y to snap toward 12, got ${sharpened.verts[1]}`)
})

test("applyAscHermiteQefVertexRange disjoint chunks match full sequential pass", async () => {
    const w = 33
    const h = 33
    const d = 33
    const grid = new AscVoxelGrid(fillSphereGrid(w, h, d, 16, 16, 16, 8), w, h, d, 0)
    const asc = await runAscLayerSweep({
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
    const mesh = ascLayerResultToMeshData(asc, 0, 0, 0)
    const opts: AscHermiteQefOptions = { originX: 0, originY: 0, originZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1 }
    const ref = applyAscHermiteQefSync(mesh, grid, opts)

    const featureDot = opts.featureNormalDot ?? Math.cos((35 * Math.PI) / 180)
    const maxMove = (opts.maxMoveVoxels ?? 1.25) * Math.max(Math.abs(opts.scaleX), Math.abs(opts.scaleY), Math.abs(opts.scaleZ))
    const vertCount = (mesh.verts.length / ASC_HERMITE_VERTEX_STRIDE_F32) | 0
    assert.ok(vertCount > 4, `expected mesh verts for Hermite parity, got ${vertCount}`)

    const mid = (vertCount / 2) | 0
    const orderA = new Float32Array(mesh.verts)
    applyAscHermiteQefVertexRange(orderA, grid, opts, featureDot, maxMove, 0, mid)
    applyAscHermiteQefVertexRange(orderA, grid, opts, featureDot, maxMove, mid, vertCount)

    const orderB = new Float32Array(mesh.verts)
    applyAscHermiteQefVertexRange(orderB, grid, opts, featureDot, maxMove, mid, vertCount)
    applyAscHermiteQefVertexRange(orderB, grid, opts, featureDot, maxMove, 0, mid)

    assert.deepEqual(Array.from(ref.verts), Array.from(orderA))
    assert.deepEqual(Array.from(ref.verts), Array.from(orderB))

    const seq = await applyAscHermiteQef(mesh, grid, opts)
    assert.deepEqual(Array.from(ref.verts), Array.from(seq.verts))
    assert.equal(ref.movedVertices, seq.movedVertices)
})
