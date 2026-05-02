import test from "node:test"
import assert from "node:assert/strict"
import {
    chooseIsoVoxelForGpuLimits,
    estimateIsoPass1BrickPeakPass1Bytes,
    computeIsoPass1Bricks,
    countIsoPass1Bricks,
    isoExportBuffersFitDeviceLimits,
    isoExportWillUsePass1BrickStreaming,
    isoPass1GpuSparseBuffersFitDeviceLimits,
} from "./iso.mjs"
import {
    buildChildCubeListFromOctree,
    buildMinimalCubeList,
    CELL_TYPE_SUB_CUBE,
    pickResidualThresholdFromPercentile,
    subAxisMulFromMaxDepth,
    subCubeLinearIdxBig,
    type OctreeBuildResult,
} from "./iso-octree.mjs"
import {
    coarseIsoOccupancyMarginMm,
    filterIsoPass1BricksByCoarseSceneOccupancy,
} from "./iso-vdb-occupancy.mjs"
import { computeMeshExportSanityMetrics } from "./mesh-postprocess.mjs"
import { SIZEOF_VERTEX } from "./mdc.mjs"
import { encodeSparseDualHashKeyBigInt } from "./iso-sparse.mjs"

const generousLimits = {
    maxBufferSize: 256 * 1024 * 1024,
    maxStorageBufferBindingSize: 256 * 1024 * 1024,
}

test("isoPass1GpuSparseBuffersFitDeviceLimits: small grid fits", () => {
    assert.equal(isoPass1GpuSparseBuffersFitDeviceLimits(8, 8, 8, generousLimits), true)
})

test("isoExportWillUsePass1BrickStreaming when full gpuSparse marks exceed limits", () => {
    const nx = 500
    const d = nx + 1
    const fullMarks = Math.max(4, nx * nx * nx * 4)
    const limits = { maxBufferSize: fullMarks - 1, maxStorageBufferBindingSize: fullMarks - 1 }
    assert.equal(isoExportWillUsePass1BrickStreaming(d, d, d, limits), true)
    assert.equal(isoPass1GpuSparseBuffersFitDeviceLimits(d, d, d, generousLimits), true)
})

test("brick peak Pass-1 gpuSparse bytes never exceed full-grid marks buffer", () => {
    const dx = 80
    const dy = 80
    const dz = 80
    const nx = dx - 1
    const ny = dy - 1
    const nz = dz - 1
    const fullMarks = Math.max(4, nx * ny * nz * 4)
    for (let span = 1; span <= 64; span++) {
        const peak = estimateIsoPass1BrickPeakPass1Bytes(dx, dy, dz, span)
        assert.ok(peak.gpuSparseMarks <= fullMarks, `span=${span} marks`)
        assert.ok(peak.gpuSparseDilated <= fullMarks, `span=${span} dilated`)
    }
})

test("estimateIsoPass1BrickPeakPass1Bytes analytic bounds enumerate worst brick (small grids)", () => {
    const cornerDims = (b: {
        hiCellX: number
        loCellX: number
        hiCellY: number
        loCellY: number
        hiCellZ: number
        loCellZ: number
    }) => ({
        dxL: b.hiCellX - b.loCellX + 2,
        dyL: b.hiCellY - b.loCellY + 2,
        dzL: b.hiCellZ - b.loCellZ + 2,
    })
    for (let nx = 2; nx <= 18; nx++) {
        const dx = nx + 1
        for (let span = 1; span <= 10; span++) {
            let maxCells = 0
            let maxCubes = 0
            for (const b of computeIsoPass1Bricks(nx, nx, nx, span)) {
                const { dxL, dyL, dzL } = cornerDims(b)
                const cells = dxL * dyL * dzL
                const nxb = Math.max(0, dxL - 1)
                const nyb = Math.max(0, dyL - 1)
                const nzb = Math.max(0, dzL - 1)
                maxCells = Math.max(maxCells, cells)
                maxCubes = Math.max(maxCubes, nxb * nyb * nzb)
            }
            const peak = estimateIsoPass1BrickPeakPass1Bytes(dx, dx, dx, span)
            const analyticCells = Math.min(dx, span + 3) ** 3
            assert.ok(analyticCells >= maxCells, `nx=${nx} span=${span} cells ${analyticCells} vs ${maxCells}`)
            const analyticCubes = Math.max(0, Math.min(dx, span + 3) - 1) ** 3
            assert.ok(analyticCubes >= maxCubes, `nx=${nx} span=${span} cubes ${analyticCubes} vs ${maxCubes}`)
            const bruteMarks = Math.max(4, maxCubes * 4)
            assert.ok(peak.gpuSparseMarks >= bruteMarks, `nx=${nx} span=${span} marks`)
        }
    }
})

test("countIsoPass1Bricks matches computeIsoPass1Bricks length", () => {
    assert.equal(countIsoPass1Bricks(24, 24, 24, 8), computeIsoPass1Bricks(24, 24, 24, 8).length)
    assert.equal(countIsoPass1Bricks(100, 1, 1, 32), computeIsoPass1Bricks(100, 1, 1, 32).length)
})

test("chooseIsoVoxelForGpuLimits keeps base voxel on small scene with generous limits", () => {
    const base = 0.5
    const chosen = chooseIsoVoxelForGpuLimits(12, 12, 12, base, generousLimits)
    assert.ok(Math.abs(chosen.voxelSizeMm - base) < 1e-6)
    assert.equal(chosen.gridDimX >= 2 && chosen.gridDimY >= 2 && chosen.gridDimZ >= 2, true)
})

test("computeMeshExportSanityMetrics: single closed triangle", () => {
    const verts = new Float32Array([
        0, 0, 0, 0, 0, 0, 0, 0,
        1, 0, 0, 0, 0, 0, 0, 0,
        0, 1, 0, 0, 0, 0, 0, 0,
    ])
    const tris = new Uint32Array([0, 1, 2])
    const m = computeMeshExportSanityMetrics(verts, tris, 1.0, SIZEOF_VERTEX)
    assert.equal(m.triCount, 1)
    assert.equal(m.boundaryEdges, 3)
    assert.equal(m.nonManifoldEdges, 0)
})

test("isoExportBuffersFitDeviceLimits agrees with isoPass1GpuSparse tier on moderate grid", () => {
    const d = 48
    const ok = isoExportBuffersFitDeviceLimits(d, d, d, generousLimits)
    const pass1 = isoPass1GpuSparseBuffersFitDeviceLimits(d, d, d, generousLimits)
    assert.equal(pass1, true)
    assert.equal(ok, true)
})

test("filterIsoPass1BricksByCoarseSceneOccupancy removes bricks entirely outside inflated scene AABB", () => {
    const nx = 24
    const ny = 24
    const nz = 24
    const span = 8
    const bricks = computeIsoPass1Bricks(nx, ny, nz, span)
    assert.ok(bricks.length >= 8)
    const r = filterIsoPass1BricksByCoarseSceneOccupancy(bricks, {
        gridOffsetX: 0,
        gridOffsetY: 0,
        gridOffsetZ: 0,
        voxelSize: 1,
        pass1BrickCoreSpan: span,
        sceneMinMm: [-120, -120, -120],
        sceneMaxMm: [-100, -100, -100],
    })
    assert.equal(r.skipped, bricks.length)
    assert.equal(r.bricks.length, 0)
    assert.ok(r.marginMm > 0 && Number.isFinite(r.marginMm))
})

test("coarseIsoOccupancyMarginMm grows with brick span", () => {
    const m8 = coarseIsoOccupancyMarginMm(0.5, 8)
    const m16 = coarseIsoOccupancyMarginMm(0.5, 16)
    assert.ok(m16 > m8)
})

test("pickResidualThresholdFromPercentile: zero-heavy residuals use positive tail (not T=0)", () => {
    const a = new Float32Array(1000)
    a.fill(0)
    for (let i = 800; i < 1000; i++) a[i] = 1e-6 + (i - 800) * 1e-7
    const t = pickResidualThresholdFromPercentile(a, 0.28)
    assert.ok(t > 0, `expected positive threshold, got ${t}`)
})

test("encodeSparseDualHashKeyBigInt: 60-bit linear splits (key_lo / key_hi)", () => {
    const linear = (1n << 40n) + 12345n
    const { keyLo, keyHi } = encodeSparseDualHashKeyBigInt(7, linear)
    assert.equal(keyLo, Number(linear & 0xffffffffn))
    assert.equal(keyHi, (7 << 28) | Number((linear >> 32n) & 0x0fffffffn))
})

/** Mirrors WGSL / TS sparse dual `vec2u` packing — inverse of `encodeSparseDualHashKeyBigInt`. */
function decodeSparseDualHashKeyBigInt(keyLo: number, keyHi: number): { cellType: number; linear: bigint } {
    const cellType = (keyHi >>> 28) & 0xf
    const linear = BigInt(keyLo >>> 0) | (BigInt(keyHi & 0x0fffffff) << 32n)
    return { cellType, linear }
}

test("sparse dual hash key: linear crosses 32-bit boundary and roundtrips", () => {
    const linear = (1n << 32n) + 0xabcdefn
    const cellType = 9 // CELL_TYPE_SUB_EDGE_X
    const { keyLo, keyHi } = encodeSparseDualHashKeyBigInt(cellType, linear)
    const back = decodeSparseDualHashKeyBigInt(keyLo, keyHi)
    assert.equal(back.linear, linear)
    assert.equal(back.cellType, cellType)
})

test("subCubeLinearIdxBig can exceed 2^32-1 and matches sparse hash decode", () => {
    const nxBase = 2048
    const nyBase = 2048
    const subMul = 32
    const linear = subCubeLinearIdxBig(0, 0, 1, nxBase, nyBase, subMul)
    assert.equal(linear, 1n << 32n)
    const { keyLo, keyHi } = encodeSparseDualHashKeyBigInt(CELL_TYPE_SUB_CUBE, linear)
    const back = decodeSparseDualHashKeyBigInt(keyLo, keyHi)
    assert.equal(back.linear, linear)
    assert.equal(back.cellType, CELL_TYPE_SUB_CUBE)
})

test("adaptive octree child cube list preserves stopped leaf depth", () => {
    const octree: OctreeBuildResult = {
        leaves: [
            { cellPos: [0, 0, 0], depth: 0, coveringResidual: 0 },
            { cellPos: [2, 1, 0], depth: 2, coveringResidual: 0.01 },
        ],
        leavesPerDepth: new Map([[0, 1], [2, 1]]),
        baseCubesRefined: 1,
        totalResidual: 0.01,
        maxResidual: 0.01,
        equivalentUniformLeafCount: 64,
        adaptivityRatio: 2 / 64,
        timingMs: {},
    }
    const { children } = buildChildCubeListFromOctree(octree, 3)
    assert.deepEqual(children, [{ gsx: 4, gsy: 2, gsz: 0, depth: 2 }])
})

test("minimal cube descriptors encode refined leaf depth for Pass 15", () => {
    const maxDepth = 3
    const subMul = subAxisMulFromMaxDepth(maxDepth)
    const refinedLeaf = { gsx: subMul, gsy: 0, gsz: 0, depth: 2 }
    const activeBaseCubes = new Uint32Array([1])
    const minimal = buildMinimalCubeList([refinedLeaf], activeBaseCubes, 4, 4, 4, maxDepth)
    assert.equal(minimal.numDepth1, 1)
    assert.equal(minimal.descriptors[0], refinedLeaf.gsx)
    assert.equal(minimal.descriptors[3]! & 1, 1)
    assert.equal((minimal.descriptors[3]! >> 8) & 0xf, 2)
})

test("filterIsoPass1BricksByCoarseSceneOccupancy keeps all bricks when scene min/max inverted", () => {
    const bricks = computeIsoPass1Bricks(16, 16, 16, 8)
    const r = filterIsoPass1BricksByCoarseSceneOccupancy(bricks, {
        gridOffsetX: 0,
        gridOffsetY: 0,
        gridOffsetZ: 0,
        voxelSize: 1,
        pass1BrickCoreSpan: 8,
        sceneMinMm: [10, 10, 10],
        sceneMaxMm: [5, 5, 5],
    })
    assert.equal(r.skipped, 0)
    assert.equal(r.bricks.length, bricks.length)
})

/** Mirrors WGSL `sdf_sign_bit_positive` / `signed_zero_for_side` (iso.wgsl). */
function isoSdfSignBitPositive(f: number): boolean {
    if (f > 0) return true
    if (f < 0) return false
    const u = new Uint32Array(new Float32Array([f]).buffer)
    return (u[0]! & 0x80000000) === 0
}

function isoSignedZeroForSide(f: number): number {
    return isoSdfSignBitPositive(f) ? 0 : -0
}

test("Pass16 stencil step: subMul >> depth matches finest-grid leaf span", () => {
    for (let maxDepth = 2; maxDepth <= 5; maxDepth++) {
        const subMul = subAxisMulFromMaxDepth(maxDepth)
        for (let depth = 1; depth <= maxDepth; depth++) {
            const span = 1 << (maxDepth - depth)
            assert.equal(subMul >>> depth, span, `maxDepth=${maxDepth} depth=${depth}`)
        }
    }
})

test("Pass16 improvement output fval contract: signed_zero_for_side preserves sign bit", () => {
    assert.ok(isoSdfSignBitPositive(1))
    assert.ok(!isoSdfSignBitPositive(-1))
    assert.ok(isoSdfSignBitPositive(0))
    assert.ok(!isoSdfSignBitPositive(-0))
    assert.ok(Object.is(isoSignedZeroForSide(0.5), 0))
    assert.ok(Object.is(isoSignedZeroForSide(-0.5), -0))
    assert.ok(Object.is(isoSignedZeroForSide(0), 0))
    assert.ok(Object.is(isoSignedZeroForSide(-0), -0))
})
