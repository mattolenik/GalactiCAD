import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

import { transpileCadSource } from "../../cad-transpile.mjs"
import { GridSampler } from "../../export/grid-sample.mjs"
import { GPUHelper } from "../../gpu/helper.mjs"
import { SceneInfo } from "../../scene/scene.mjs"
import { SCENE_PARAMS_BYTE_SIZE } from "../../scene/scene-params.mjs"
import { ShaderCompiler } from "../../shaders/shader.mjs"
import { IsoSampleBatch } from "./iso-sample-batch.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SHADERS_DIR = path.resolve(__dirname, "../../shaders")

const INCLUDE_RE = /^\/\/:\)\s*include\s+"([^"]+)"\s*$/

function expandWgslIncludes(filePath: string, visited = new Set<string>()): string {
    const absPath = path.resolve(filePath)
    if (visited.has(absPath)) return ""
    visited.add(absPath)
    const lines = fs.readFileSync(absPath, "utf8").split(/\r?\n/)
    const out: string[] = []
    const dir = path.dirname(absPath)
    for (const line of lines) {
        const m = line.match(INCLUDE_RE)
        if (m) {
            const nested = path.resolve(dir, m[1])
            out.push(expandWgslIncludes(nested, visited))
        } else {
            out.push(line)
        }
    }
    return out.join("\n")
}

async function installWebGpuIfNeeded(): Promise<void> {
    const { create, globals } = await import("webgpu")
    Object.assign(globalThis, globals)
    Object.defineProperty(globalThis, "navigator", {
        value: { gpu: create([]) },
        configurable: true,
        writable: true,
        enumerable: true,
    })
}

test("IsoSampleBatch vs GridSampler (1×1×1) parity on sphere scene", async (t) => {
    const body = transpileCadSource("return sphere.radius(10)")
    const scene = new SceneInfo(body, { bvhEnabled: true })

    await installWebGpuIfNeeded()
    const helper = await GPUHelper.create()
    if (!helper) {
        t.skip("WebGPU adapter unavailable")
        return
    }
    const sceneAux = scene.compileAux()
    const sceneAuxFast = scene.compileAuxFast()
    const sceneAuxMid = scene.compileAuxMid()
    const sceneSDF = scene.compile()
    const sceneSDF_mid = scene.compileMid()

    const wgslPath = path.join(SHADERS_DIR, "iso_sample_batch.wgsl")
    const isoWgslExpanded = expandWgslIncludes(wgslPath)

    const batchModule = new ShaderCompiler(helper.device)
        .replace("insert", "sceneAuxFast", sceneAuxFast)
        .replace("insert", "sceneAux", sceneAux)
        .replace("insert", "sceneAuxMid", sceneAuxMid)
        .replace("insert", "sceneSDF", sceneSDF)
        .compile(isoWgslExpanded, "IsoSampleBatch test")

    const gridModule = new ShaderCompiler(helper.device)
        .replace("insert", "sceneAuxFast", sceneAuxFast)
        .replace("insert", "sceneAux", sceneAux)
        .replace("insert", "sceneAuxMid", sceneAuxMid)
        .replace("insert", "sceneSDF", sceneSDF)
        .replace("insert", "sceneSDF_mid", sceneSDF_mid)
        .compile(expandWgslIncludes(path.join(SHADERS_DIR, "sample_grid.wgsl")), "GridSampler parity test")

    const polyData = scene.getPolygonVertexData()
    const polyBytes = Math.max(8, polyData.byteLength)
    const polygonVerticesBuffer = helper.device.createBuffer({
        label: "test.poly",
        size: polyBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    if (polyData.byteLength > 0) {
        helper.device.queue.writeBuffer(polygonVerticesBuffer, 0, new Float32Array(polyData))
    } else {
        helper.device.queue.writeBuffer(polygonVerticesBuffer, 0, new Float32Array([0, 0]))
    }

    const faceSelectionBuffer = helper.device.createBuffer({
        label: "test.faceSel",
        size: 20,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    helper.device.queue.writeBuffer(faceSelectionBuffer, 0, new ArrayBuffer(20))

    const packed = scene.packSceneParams()
    const mdcSceneParamsBuffer = helper.device.createBuffer({
        label: "test.mdcSceneParams",
        size: SCENE_PARAMS_BYTE_SIZE,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    helper.device.queue.writeBuffer(mdcSceneParamsBuffer, 0, new Float32Array(packed))

    const batcher = new IsoSampleBatch(helper, polygonVerticesBuffer, faceSelectionBuffer, mdcSceneParamsBuffer)
    const gridSampler = new GridSampler(helper, polygonVerticesBuffer, faceSelectionBuffer, mdcSceneParamsBuffer)

    const points = new Float32Array([
        2, 0, 0,
        12, 0, 0,
        3, 4, 0,
        -1, 9, 2,
    ])

    const batchResult = await batcher.run(batchModule, points)

    const tolD = 5e-4
    const tolN = 5e-4

    for (let i = 0; i < points.length / 3; i++) {
        const px = points[i * 3]!
        const py = points[i * 3 + 1]!
        const pz = points[i * 3 + 2]!
        const grid = await gridSampler.sample(gridModule, {
            gridDimX: 1,
            gridDimY: 1,
            gridDimZ: 1,
            voxelSize: 1,
            gridOffsetX: px,
            gridOffsetY: py,
            gridOffsetZ: pz,
        })
        const bi = i * 4
        const dBatch = batchResult.sdf[bi + 3]!
        const dGrid = grid.scalar[0]!
        assert.ok(Math.abs(dBatch - dGrid) < tolD, `d mismatch i=${i} batch=${dBatch} grid=${dGrid}`)

        for (let c = 0; c < 3; c++) {
            assert.ok(
                Math.abs(batchResult.sdf[bi + c]! - grid.gradient[c]!) < tolN,
                `n[${c}] mismatch i=${i}`,
            )
        }
    }

    polygonVerticesBuffer.destroy()
    faceSelectionBuffer.destroy()
    mdcSceneParamsBuffer.destroy()
})
