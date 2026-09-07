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

test("SFCC audit: nested soft blend GPU scalar derivative reference", async (t) => {
    // Keep the inner radius explicit: outer fluent modifiers can propagate to
    // descendants. Serialized effective modes are checked below.
    const source = `
        const inner = union(sphere.radius(1.2).shift(-0.8,0,0), sphere.radius(1.2).shift(0.8,0,0)).soft(0.8);
        const outer = union(inner, sphere.radius(1.2).shift(0,1,0)).soft(0.7);
        inner.radius = 0.8;
        return outer;
    `
    const scene = new SceneInfo(transpileCadSource(source))
    const { serializeSceneToBridgeJson } = await import("../sfcc-rs/scene-bridge.mjs")
    t.diagnostic(`effective scene: ${serializeSceneToBridgeJson(scene.root)}`)
    await installWebGpuIfNeeded()
    const helper = await GPUHelper.create()
    if (!helper) {
        t.skip("WebGPU adapter unavailable; GPU reference not checked")
        return
    }
    const buffers: GPUBuffer[] = []
    let batcher: IsoSampleBatch | undefined
    try {
        const module = new ShaderCompiler(helper.device)
            .replace("insert", "sceneAuxFast", scene.compileAuxFast())
            .replace("insert", "sceneAux", scene.compileAux())
            .replace("insert", "sceneSDF", scene.compile())
            .compile(expandWgslIncludes(path.join(SHADERS_DIR, "iso_sample_batch.wgsl")), "SFCC derivative audit")
        const buffer = (size: number, usage: GPUBufferUsageFlags): GPUBuffer => {
            const b = helper.device.createBuffer({ size, usage })
            buffers.push(b)
            return b
        }
        const polygon = buffer(8, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
        const face = buffer(32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)
        const params = buffer(SCENE_PARAMS_BYTE_SIZE, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
        helper.device.queue.writeBuffer(params, 0, new Float32Array(scene.packSceneParams()))
        batcher = new IsoSampleBatch(helper, polygon, face, params)
        const p = [0.1, 0.4, 1.2651338489240112]
        const points = [...p]
        const steps = [0.01, 0.002]
        for (const h of steps) for (let k = 0; k < 3; k++) for (const sign of [-1, 1]) {
            points.push(...p.map((v, axis) => v + (axis === k ? sign * h : 0)))
        }
        const result = await batcher.run(module, new Float32Array(points), 0.001)
        const expected = [0.022617093850773214, -0.05698498450323208, 0.8572443030551287]
        assert.ok(Math.abs(result.sdf[3]!) < 2e-6, "native zero point must lie on the GPU scalar surface")
        for (let j = 0; j < steps.length; j++) {
            const derivative = expected.map((_, k) => {
                const base = 1 + j * 6 + k * 2
                return (result.sdf[(base + 1) * 4 + 3]! - result.sdf[base * 4 + 3]!) / (2 * steps[j]!)
            })
            assert.ok(Math.hypot(...derivative.map((v, k) => v - expected[k]!)) < 1e-4,
                `GPU scalar derivative differs from native reference: ${derivative}`)
        }
        const length = Math.hypot(...expected)
        const dot = expected.reduce((s, v, k) => s + v / length * result.sdf[k]!, 0)
        // Report separately: preview normals currently compose unit directions
        // and g is a stepping estimate, so they are not a derivative oracle.
        t.diagnostic(`GPU analytical-normal discrepancy: ${Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI} degrees`)
    } finally {
        batcher?.destroy()
        for (const b of buffers) b.destroy()
        helper.device.destroy()
    }
})

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
    const sceneSDF = scene.compile()
    const sceneAuxMid = scene.compileAuxMid()
    const sceneSDF_mid = scene.compileMid()

    const wgslPath = path.join(SHADERS_DIR, "iso_sample_batch.wgsl")
    const isoWgslExpanded = expandWgslIncludes(wgslPath)

    const batchModule = new ShaderCompiler(helper.device)
        .replace("insert", "sceneAuxFast", sceneAuxFast)
        .replace("insert", "sceneAux", sceneAux)
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
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    helper.device.queue.writeBuffer(faceSelectionBuffer, 0, new ArrayBuffer(32))

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

    const batchResult = await batcher.run(batchModule, points, 1)

    const points2 = new Float32Array([0, 1, 2, 5, 5, 5])
    const batchResult2 = await batcher.run(batchModule, points2, 1)
    assert.equal(batchResult2.sampleCount, 2)

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

    for (let i = 0; i < points2.length / 3; i++) {
        const px = points2[i * 3]!
        const py = points2[i * 3 + 1]!
        const pz = points2[i * 3 + 2]!
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
        const dBatch = batchResult2.sdf[bi + 3]!
        const dGrid = grid.scalar[0]!
        assert.ok(Math.abs(dBatch - dGrid) < tolD, `second-run d mismatch i=${i}`)
        for (let c = 0; c < 3; c++) {
            assert.ok(
                Math.abs(batchResult2.sdf[bi + c]! - grid.gradient[c]!) < tolN,
                `second-run n[${c}] i=${i}`,
            )
        }
    }

    batcher.destroy()

    polygonVerticesBuffer.destroy()
    faceSelectionBuffer.destroy()
    mdcSceneParamsBuffer.destroy()
})
