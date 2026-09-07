import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { load as loadYaml } from "js-yaml"

import { transpileCadSource } from "../../cad-transpile.mjs"
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
    const inputPath = path.basename(absPath) === "hg_sdf.wgsl" && process.env.GPU_NORMAL_BASELINE ? process.env.GPU_NORMAL_BASELINE : absPath
    const lines = fs.readFileSync(inputPath, "utf8").split(/\r?\n/)
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

// Real generated scene evaluations; the CPU only compares returned GPU values.
const cases = [
    ["soft nesting", `const i=union(sphere.radius(1.2).shift(-.8,0,0),sphere.radius(1.2).shift(.8,0,0)).soft(.8); const o=union(i,sphere.radius(1.2).shift(0,1,0)).soft(.7); i.radius=.8; return o;`],
    ...["soft", "round", "chamfer"].flatMap(inner => ["soft", "round", "chamfer"].map(outer => [
        `${inner} in ${outer}`,
        `const i=union(sphere.radius(1.2).shift(-.7,0,0),sphere.radius(1.2).shift(.7,0,0)).${inner}(.8); const o=union(i,sphere.radius(1.2).shift(0,.7,0)).${outer}(.6); i.radius=.8; return o;`,
    ])),
    ["three operands", `return union(sphere.radius(1.2).shift(-.8,0,0),sphere.radius(1.2).shift(.8,0,0),sphere.radius(1.2).shift(0,.8,0)).soft(.8);`],
    ["scaled child", `return union(scale(-2,1,.7,sphere.radius(1.2)),sphere.radius(1.2).shift(.8,0,0)).round(.8);`],
    ["twist inside", `return union(twist(.3,box(2,3,1)),sphere.radius(1.2).shift(.8,0,0)).soft(.8);`],
    ["bend inside", `return union(bend(.25,box(2,3,1)),sphere.radius(1.2).shift(.8,0,0)).soft(.8);`],
    ["taper inside", `return union(taper(.5,2,sphere.radius(1.2)),sphere.radius(1.2).shift(.8,0,0)).soft(.8);`],
    ["elongate", `return union(elongate(.4,.3,.2,sphere.radius(1.2)),sphere.radius(1.2).shift(.8,0,0)).soft(.8);`],
    ["extrude", `return union(extrude.profile(polygon2d([-1,-1],[1,-1],[1,1],[-1,1])).height(2).twist(45),sphere.radius(1.2).shift(.8,0,0)).soft(.8);`],
    ["loft", `return union(loft.sections(polygon2d([-1,-1],[1,-1],[1,1],[-1,1]),polygon2d([-.6,-.7],[.6,-.7],[.6,.7],[-.6,.7])).height(2),sphere.radius(1.2).shift(.8,0,0)).soft(.8);`],
    ["lathe", `return union(lathe.profile(polygon2d([.4,-1],[1,-1],[1.4,1],[.4,1])),sphere.radius(1.2).shift(.8,0,0)).soft(.8);`],
    ["cylinder", `return union(cylinder.radius(1).height(2),sphere.radius(1.2).shift(.8,0,0)).soft(.8);`],
    ["thread", `return union(threaded_rod.radius(1).height(2),sphere.radius(1.2).shift(.8,0,0)).soft(.8);`],
    ["depth three", `const i=union(sphere.radius(1.2).shift(-.7,0,0),sphere.radius(1.2).shift(.7,0,0)).soft(.8); const m=union(i,sphere.radius(1.2).shift(0,.7,0)).round(.6); const o=union(m,sphere.radius(.9).shift(0,0,.7)).chamfer(.4); i.radius=.8; m.radius=.6; return o;`],
    ["twist outside", `return twist(.3,union(sphere.radius(1.2).shift(-.7,0,0),sphere.radius(1.2).shift(.7,0,0)).soft(.8));`],
    ["bend outside", `return bend(.25,union(sphere.radius(1.2).shift(-.7,0,0),sphere.radius(1.2).shift(.7,0,0)).round(.8));`],
    ["taper outside", `return taper(.5,2,union(sphere.radius(1.2).shift(-.7,0,0),sphere.radius(1.2).shift(.7,0,0)).chamfer(.8));`],
    ...["cone.radius(1).height(2)", "torus.largeRadius(1).smallRadius(.3)", "capsule.radius(.7).cylinderLength(2)", "disc.radius(1)", "hexprism.radius(1).height(2)"].map(primitive => [primitive, `return union(${primitive},sphere.radius(1.2).shift(.8,0,0)).soft(.8);`]),
    ["triangle extrude bound", `return union(extrude.profile(polygon2d([-1,-1],[1,-1],[0,1])).height(2),sphere.radius(1.2).shift(.8,0,0)).soft(.8);`],
] as const

async function sampleScene(helper: GPUHelper, scene: SceneInfo, points: Float32Array<ArrayBuffer>, mode: "full" | "mid" | "normal" | "fast" | "midNormal", overrides: { full?: string, mid?: string, timings?: number[], compileMs?: number[] } = {}): Promise<Float32Array> {
    const source = expandWgslIncludes(path.join(SHADERS_DIR, "iso_sample_batch.wgsl"))
        .replace("let r = sceneSDF(p);", (mode === "mid" || mode === "midNormal") ? "let r = sceneSDF_mid(p);" : mode === "fast" ? "let r = derivativeTestFast(p);" : "let r = sceneSDF(p);")
        .replace("sdfOut[i] = vec4f(r.n, r.d);", (mode === "normal" || mode === "midNormal") ? ((process.env.GPU_NORMAL_BASELINE || overrides.timings) ? "sdfOut[i] = vec4f(r.n, r.d);" : "sdfOut[i] = vec4f(r.n, f32(r.derivativeStatus));") : mode === "fast" ? "sdfOut[i] = vec4f(r.g, r.safeStepMul, 0.0, r.d);" : "sdfOut[i] = vec4f(r.gradient, r.d);")
        + `\nfn derivativeTestFast(p: vec3f) -> FastSDFResult { _ = polygonVertices[0]; _ = faceSelection.nodeId; ${scene.compileFast()} }`
    const compileStart = performance.now()
    const module = new ShaderCompiler(helper.device)
        .replace("insert", "sceneAuxFast", scene.compileAuxFast())
        .replace("insert", "sceneAux", scene.compileAux())
        .replace("insert", "sceneAuxMid", scene.compileAuxMid())
        .replace("insert", "sceneSDF", overrides.full ?? scene.compile())
        .replace("insert", "sceneSDF_mid", overrides.mid ?? scene.compileMid())
        .compile(source, `derivative ${mode}`)
    const errors = (await module.getCompilationInfo()).messages.filter(m => m.type === "error")
    assert.deepEqual(errors.map(m => m.message), [], `invalid ${mode} shader`)
    overrides.compileMs?.push(performance.now() - compileStart)
    const buffers: GPUBuffer[] = []
    const buffer = (size: number, usage: GPUBufferUsageFlags) => {
        const result = helper.device.createBuffer({ size, usage })
        buffers.push(result)
        return result
    }
    const polygonData = scene.getPolygonVertexData()
    const polygon = buffer(Math.max(8, polygonData.byteLength), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
    if (polygonData.byteLength) helper.device.queue.writeBuffer(polygon, 0, new Float32Array(polygonData))
    const face = buffer(32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)
    const params = buffer(SCENE_PARAMS_BYTE_SIZE, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
    helper.device.queue.writeBuffer(params, 0, new Float32Array(scene.packSceneParams()))
    const batch = new IsoSampleBatch(helper, polygon, face, params)
    helper.device.pushErrorScope("validation")
    try {
        const result = (await batch.run(module, points, .001)).sdf
        if (overrides.timings) for (let i = 0; i < 5; i++) {
            const start = performance.now()
            await batch.run(module, points, .001)
            overrides.timings.push(performance.now() - start)
        }
        assert.equal(await helper.device.popErrorScope(), null, "GPU validation")
        return result
    }
    finally { batch.destroy(); for (const b of buffers) b.destroy() }
}

test("GPU derivative composition: generated full/Mid/Fast matrix", async t => {
    await installWebGpuIfNeeded()
    const helper = await GPUHelper.create()
    if (!helper) {
        assert.notEqual(process.env.REQUIRE_WEBGPU, "1", "mandatory GPU acceptance needs an adapter")
        t.skip("WebGPU adapter unavailable")
        return
    }
    const info = helper.device.adapterInfo
    t.diagnostic(`adapter: ${JSON.stringify({ vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description })}`)
    const centers = [[.13, .37, 1.17], [-.31, .51, .91], [.29, -.41, 1.03], [.21, 2.31, .93], [1.7, .37, .6]]
    const steps = [.004, .002]
    const points = new Float32Array(centers.flatMap(p => [p, ...steps.flatMap(h => [0, 1, 2].flatMap(axis => [-1, 1].map(sign => p.map((v, k) => v + (k === axis ? sign * h : 0)))))]).flat())
    try {
        for (const [name, body] of cases) await t.test(name, async () => {
            for (const bvhEnabled of [false, true]) {
                const scene = new SceneInfo(transpileCadSource(body), { bvhEnabled })
                const full = await sampleScene(helper, scene, points, "full")
                const mid = await sampleScene(helper, scene, points, "mid")
                const normal = await sampleScene(helper, scene, points, "normal")
                const fast = await sampleScene(helper, scene, points, "fast")
                for (let j = 0; j < centers.length; j++) {
                    const base = j * 13
                    const gradient = Array.from(full.slice(base * 4, base * 4 + 3))
                    for (let step = 0; step < steps.length; step++) {
                        const fd = [0, 1, 2].map(k => (full[(base + 2 + step * 6 + k * 2) * 4 + 3]! - full[(base + 1 + step * 6 + k * 2) * 4 + 3]!) / (2 * steps[step]!))
                        assert.ok(Math.hypot(...fd.map((v, k) => v - gradient[k]!)) < .002, `${name} at ${centers[j]}: raw ${gradient}, FD ${fd}`)
                    }
                    for (let k = 0; k < 4; k++) assert.ok(Math.abs(full[base * 4 + k]! - mid[base * 4 + k]!) < .002, `${name}: full/Mid ${k}: ${full[base * 4 + k]} vs ${mid[base * 4 + k]}`)
                    assert.ok(Math.abs(full[base * 4 + 3]! - fast[base * 4 + 3]!) < 2e-5, `${name}: full/Fast scalar mismatch`)
                    const magnitude = Math.hypot(...gradient)
                    if (magnitude > 1e-5) for (let k = 0; k < 3; k++) assert.ok(Math.abs(normal[base * 4 + k]! - gradient[k]! / magnitude) < 2e-5, `${name}: public normal`)
                    assert.equal(normal[base * 4 + 3]! & 8, 0, `${name}: unavailable derivative`)
                }
            }
        })
    } finally { helper.device.destroy() }
})

// Affine operands have independent, closed-form scalar derivatives and allow
// testing cancellation and operator branches without a CPU scene evaluator.
test("GPU derivative composition: operator partials and exceptional points", async t => {
    await installWebGpuIfNeeded()
    const helper = await GPUHelper.create()
    if (!helper) {
        assert.notEqual(process.env.REQUIRE_WEBGPU, "1", "mandatory GPU acceptance needs an adapter")
        t.skip("WebGPU adapter unavailable")
        return
    }
    const scene = new SceneInfo(transpileCadSource("return sphere.radius(1)"))
    const prefixes = {
        full: "let a=sdfExact(2.0*p.x,1.0,9u,vec3f(2.0,0.0,0.0)); let b=sdfExact(0.3*p.y,1.0,2u,vec3f(0.0,0.3,0.0));",
        mid: "let a=sdfWithGradientMid(sdfRMid(2.0*p.x,1.0,vec3f(1.0,0.0,0.0)),vec3f(2.0,0.0,0.0),0u); let b=sdfWithGradientMid(sdfRMid(0.3*p.y,1.0,vec3f(0.0,1.0,0.0)),vec3f(0.0,0.3,0.0),0u);",
    }
    const operators = [
        ["opUnion", ""], ["opIntersection", ""], ["opDifference", ""],
        ...["UnionSoft", "UnionRound", "IntersectionRound", "DifferenceRound", "UnionChamfer", "IntersectionChamfer", "DifferenceChamfer", "Pipe", "Engrave"].map(n => [`fOp${n}`, ", 0.8"]),
        ...["UnionColumns", "DifferenceColumns", "IntersectionColumns", "UnionStairs", "IntersectionStairs", "DifferenceStairs"].map(n => [`fOp${n}`, ", 0.8, 4.0"]),
        ["fOpGroove", ", 0.8, 0.4"], ["fOpTongue", ", 0.8, 0.4"], ["sdfMorph", ", 0.37"], ["sdfSeam", ", 0.8"],
    ]
    const h = .0001
    const centers = [[.13, .37, .1], [-.11, .51, .1], [.72, -.41, .1], [-.3, -.71, .1]]
    const points = new Float32Array(centers.flatMap(p => [p, ...[0, 1, 2].flatMap(k => [-1, 1].map(sign => p.map((v, i) => v + (k === i ? sign * h : 0))))]).flat())
    try {
        for (const [op, args] of operators) await t.test(op!, async () => {
            const overrides = { full: `${prefixes.full} return ${op}Ex(a,b${args});`, mid: `${prefixes.mid} return ${op}Mid(a,b${args});` }
            const full = await sampleScene(helper, scene, points, "full", overrides)
            const mid = await sampleScene(helper, scene, points, "mid", overrides)
            for (let j = 0; j < centers.length; j++) {
                const base = j * 7
                for (let k = 0; k < 3; k++) {
                    const fd = (full[(base + 2 + k * 2) * 4 + 3]! - full[(base + 1 + k * 2) * 4 + 3]!) / (2 * h)
                    assert.ok(Math.abs(fd - full[base * 4 + k]!) < .002, `${op} raw partial ${k} at ${centers[j]}: ${full[base * 4 + k]} vs ${fd}`)
                }
                for (let k = 0; k < 4; k++) assert.ok(Math.abs(full[base * 4 + k]! - mid[base * 4 + k]!) < 1e-5, `${op} full/Mid`)
            }
        })
        const zero = { full: "let a=sdfExact(p.x,1.0,1u,vec3f(1.0,0.0,0.0)); let b=sdfExact(-p.x,1.0,2u,vec3f(-1.0,0.0,0.0)); return fOpUnionSoftEx(a,b,1.0);" }
        const point = new Float32Array([0, 0, 0])
        const stationary = await sampleScene(helper, scene, point, "full", zero)
        assert.deepEqual(Array.from(stationary.slice(0, 3)), [0, 0, 0], "opposing gradients must cancel exactly")
        const normal = await sampleScene(helper, scene, point, "normal", zero)
        assert.ok(Array.from(normal).every(Number.isFinite), "stationary shading fallback is finite")
        assert.equal(normal[3], 0, "stationary exact derivative is not missing or singular")
        // IDs previously chose the wrong scalar throughout SURF_DIST's near-tie band.
        for (const ids of [[1, 9], [9, 1]]) {
            const hard = { full: `let a=sdfExact(p.x,1.0,${ids[0]}u,vec3f(1.0,0.0,0.0)); let b=sdfExact(p.y+0.0005,1.0,${ids[1]}u,vec3f(0.0,1.0,0.0)); return opUnionEx(a,b);` }
            const r = await sampleScene(helper, scene, point, "full", hard)
            assert.deepEqual(Array.from(r), [1, 0, 0, 0], "distance/derivative winner independent of ownership")
        }
        const tie = { full: `${prefixes.full} return opUnionEx(a,b);` }
        const tieNormal = await sampleScene(helper, scene, point, "normal", tie)
        assert.equal(tieNormal[3], 1, "hard tie has an explicit one-sided derivative")
        const tiny = { full: "return sdfExact(1e-7*p.x,1.0,1u,vec3f(1e-7,0.0,0.0));" }
        const tinyNormal = await sampleScene(helper, scene, point, "normal", tiny)
        assert.deepEqual(Array.from(tinyNormal), [1, 0, 0, 0], "small regular derivatives must not use the stationary fallback")
        const nestedScene = new SceneInfo(transpileCadSource(cases[0][1]))
        const nestedRaw = await sampleScene(helper, nestedScene, new Float32Array([.1, .4, 1.2651338489240112]), "full")
        const reference = [.022617093850773214, -.05698498450323208, .8572443030551287]
        assert.ok(Math.hypot(...reference.map((v, k) => v - nestedRaw[k]!)) < 2e-4, "independent nested-soft raw derivative")
        const boxOverride = { full: "return fBoxEx(p,vec3f(1.0),1u);", mid: "return fBoxMid(p,vec3f(1.0));" }
        const boxPoint = new Float32Array([1.001, 1.002, .2])
        const boxFull = await sampleScene(helper, scene, boxPoint, "full", boxOverride)
        const boxMid = await sampleScene(helper, scene, boxPoint, "mid", boxOverride)
        for (let k = 0; k < 4; k++) assert.ok(Math.abs(boxFull[k]! - boxMid[k]!) < 1e-6, "feature face normals cannot replace scalar derivatives")
        const inactive = { full: "let a=sdfExact(-2.0,1.0,1u,vec3f(1.0,0.0,0.0)); let b=sdfApproximate(2.0,1.0,2u,vec3f(0.0,1.0,0.0)); return fOpUnionSoftEx(a,b,0.0);" }
        assert.equal((await sampleScene(helper, scene, point, "normal", inactive))[3], 0, "inactive approximate operand does not contaminate winner")
    } finally { helper.device.destroy() }
})

test("GPU derivative composition: sampling performance", { skip: process.env.GPU_NORMAL_BENCH !== "1" }, async t => {
    await installWebGpuIfNeeded()
    const helper = await GPUHelper.create()
    assert.ok(helper, "benchmark requires a GPU")
    try {
        const scene = new SceneInfo(transpileCadSource(cases[0][1]))
        const points = new Float32Array(1048576 * 3)
        for (let i = 0; i < 1048576; i++) points.set([(i % 64) / 32 - 1, (Math.floor(i / 64) % 32) / 16 - 1, Math.floor(i / 2048) / 16], i * 3)
        for (const mode of ["normal", "midNormal", "fast"] as const) {
            const timings: number[] = []
            const compileMs: number[] = []
            await sampleScene(helper, scene, points, mode, { timings, compileMs })
            t.diagnostic(JSON.stringify({ mode, samples: 1048576, compileMs, timings, medianMs: [...timings].sort((a, b) => a - b)[2] }))
        }
    } finally { helper.device.destroy() }
})

async function previewSampler(helper: GPUHelper, scene: SceneInfo, points: Float32Array<ArrayBuffer>) {
    const banks = fs.readFileSync(path.join(SHADERS_DIR, "preview.wgsl"), "utf8").split("\n")
        .filter(line => /^@group\(0\).*var<uniform> preview/.test(line))
        .map(line => line.replace("@group(0)", "@group(1)")).join("\n")
    const forceBanks = "_ = previewParamsF32[0]; _ = previewParamsVec2[0]; _ = previewParamsVec3[0]; _ = previewParamsMat3[0]; _ = previewCapParamDrag[0];"
    const source = expandWgslIncludes(path.join(SHADERS_DIR, "iso_sample_batch.wgsl"))
        .replace("sdfOut[i] = vec4f(r.n, r.d);", "sdfOut[i] = vec4f(r.gradient, r.d);") + "\n" + banks
    const module = new ShaderCompiler(helper.device)
        .replace("insert", "sceneAuxFast", scene.compileAuxFastPreview())
        .replace("insert", "sceneAux", scene.compileAuxPreview())
        .replace("insert", "sceneAuxMid", scene.compileAuxMidPreview())
        .replace("insert", "sceneSDF", forceBanks + scene.compileForPreview())
        .replace("insert", "sceneSDF_mid", forceBanks + scene.compileMidForPreview())
        .compile(source, "preview derivative uniforms")
    assert.deepEqual((await module.getCompilationInfo()).messages.filter(m => m.type === "error").map(m => m.message), [])
    const buffers: GPUBuffer[] = []
    const allocate = (size: number, usage: GPUBufferUsageFlags, data?: ArrayBuffer | Float32Array<ArrayBuffer> | Uint32Array<ArrayBuffer>) => {
        const b = helper.device.createBuffer({ size, usage })
        buffers.push(b)
        if (data && data.byteLength) helper.device.queue.writeBuffer(b, 0, data)
        return b
    }
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    const uniform = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    const output = allocate(points.length / 3 * 16, storage | GPUBufferUsage.COPY_SRC)
    const readback = allocate(output.size, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST)
    const polygon = scene.getPolygonVertexData()
    const resources = new Map<number, GPUBuffer>([
        [0, allocate(16, uniform, new Uint32Array([points.length / 3, 0, Math.ceil(points.length / 3 / 256) * 256, 0]))],
        [1, allocate(points.byteLength, storage, points)], [2, output], [25, allocate(4, storage)],
        [27, allocate(Math.max(8, polygon.byteLength), storage, new Float32Array(polygon))],
        [28, allocate(32, uniform)], [30, allocate(SCENE_PARAMS_BYTE_SIZE, storage)],
    ])
    helper.device.queue.writeBuffer(resources.get(0)!, 4, new Float32Array([.001]))
    const bankBuffers = new Map<number, GPUBuffer>([
        [19, allocate(65536, uniform)], [20, allocate(65536, uniform)], [21, allocate(65536, uniform)],
        [23, allocate(49152, uniform)], [24, allocate(65536, uniform)],
    ])
    const pipeline = helper.createComputePipeline(module, "isoSampleBatch")
    const bind = (group: number, resources: Map<number, GPUBuffer>) => helper.device.createBindGroup({ layout: pipeline.getBindGroupLayout(group), entries: [...resources].map(([binding, buffer]) => ({ binding, resource: { buffer } })) })
    const group0 = bind(0, resources), group1 = bind(1, bankBuffers)
    const capShadow = new Float32Array(16384)
    const upload = (updated: SceneInfo) => {
        const packed = updated.packPreviewParams()
        capShadow.set(packed.f32)
        for (const [binding, data] of [[19, packed.f32], [20, packed.vec2], [21, packed.vec3], [23, packed.mat3], [24, packed.f32]] as const) {
            if (data.byteLength) helper.device.queue.writeBuffer(bankBuffers.get(binding)!, 0, new Float32Array(data))
        }
        const poly = updated.getPolygonVertexData()
        assert.ok(poly.byteLength <= resources.get(27)!.size, "param-only polygon allocation")
        if (poly.byteLength) helper.device.queue.writeBuffer(resources.get(27)!, 0, new Float32Array(poly))
    }
    upload(scene)
    return {
        upload,
        patchCap: (byteOffset: number, data: Float32Array<ArrayBuffer>) => {
            capShadow.set(data, byteOffset / 4)
            helper.device.queue.writeBuffer(bankBuffers.get(24)!, 0, capShadow)
        },
        run: async () => {
            helper.device.pushErrorScope("validation")
            const encoder = helper.device.createCommandEncoder()
            const pass = encoder.beginComputePass()
            pass.setPipeline(pipeline); pass.setBindGroup(0, group0); pass.setBindGroup(1, group1)
            pass.dispatchWorkgroups(Math.ceil(points.length / 3 / 256)); pass.end()
            encoder.copyBufferToBuffer(output, 0, readback, 0, output.size)
            helper.device.queue.submit([encoder.finish()])
            await readback.mapAsync(GPUMapMode.READ)
            const result = new Float32Array(readback.getMappedRange().slice(0)); readback.unmap()
            assert.equal(await helper.device.popErrorScope(), null)
            return result
        },
        destroy: () => { for (const b of buffers) b.destroy() },
    }
}

test("GPU derivative composition: preview uniforms and param-only updates", async t => {
    await installWebGpuIfNeeded()
    const helper = await GPUHelper.create()
    if (!helper) { assert.notEqual(process.env.REQUIRE_WEBGPU, "1"); t.skip("WebGPU adapter unavailable"); return }
    const points = new Float32Array([.13, .37, 1.17, -.31, .51, .91, .29, -.41, 1.03])
    try {
        for (const index of [0, 12, 16, 17, 18]) {
            const scene = new SceneInfo(transpileCadSource(cases[index]![1]))
            const sampler = await previewSampler(helper, scene, points)
            try {
                const expected = await sampleScene(helper, scene, points, "full")
                const actual = await sampler.run()
                for (let k = 0; k < expected.length; k++) assert.ok(Math.abs(actual[k]! - expected[k]!) < .002, `${cases[index]![0]} preview/storage ${k}`)
                if (index === 16) {
                    const extrude = scene.getAllNodes().find(node => node.getShapeType() === "extrude")!
                    const resized = new SceneInfo(transpileCadSource(cases[index]![1].replace("height(2)", "height(2.4)")))
                    const resizedExtrude = resized.getAllNodes().find(node => node.getShapeType() === "extrude")!
                    const packed = resized.packPreviewParams().f32
                    sampler.patchCap(extrude.previewF32Slot * 4, new Float32Array(packed.slice(resizedExtrude.previewF32Slot, resizedExtrude.previewF32Slot + 2)))
                    const capExpected = await sampleScene(helper, resized, points, "full")
                    const capActual = await sampler.run()
                    for (let k = 0; k < expected.length; k++) assert.ok(Math.abs(capActual[k]! - capExpected[k]!) < .002, `live cap derivative ${k}`)
                }
                const updated = new SceneInfo(transpileCadSource(cases[index]![1].replaceAll("1.2", "1.4")))
                sampler.upload(updated)
                const updatedExpected = await sampleScene(helper, updated, points, "full")
                const updatedActual = await sampler.run()
                for (let k = 0; k < expected.length; k++) assert.ok(Math.abs(updatedActual[k]! - updatedExpected[k]!) < .002, `${cases[index]![0]} reused shader ${k}`)
            } finally { sampler.destroy() }
        }
    } finally { helper.device.destroy() }
})

test("GPU derivative composition: housing and bracket regular samples", async t => {
    await installWebGpuIfNeeded()
    const helper = await GPUHelper.create()
    if (!helper) { assert.notEqual(process.env.REQUIRE_WEBGPU, "1"); t.skip("WebGPU adapter unavailable"); return }
    try {
        for (const [name, centers] of [
            ["housing", [[6.8, 5.3, 4.1], [8.3, 3.1, 2.7], [3.7, 9.1, 3.3]]],
            ["bracket", [[7.1, 4.2, 2.3], [15.7, 8.2, 3.1], [1.3, 6.1, 4.7]]],
        ] as const) {
            const yaml = loadYaml(fs.readFileSync(path.resolve(__dirname, `../../../docs/manim/scenes/torture_${name}.yaml`), "utf8")) as { source: string }
            const scene = new SceneInfo(transpileCadSource(yaml.source))
            const steps = [.01, .005]
            const points = new Float32Array(centers.flatMap(p => [p, ...steps.flatMap(h => [0, 1, 2].flatMap(k => [-1, 1].map(sign => p.map((v, i) => v + (i === k ? sign * h : 0)))))]).flat())
            const full = await sampleScene(helper, scene, points, "full")
            const mid = await sampleScene(helper, scene, points, "mid")
            const fast = await sampleScene(helper, scene, points, "fast")
            for (let j = 0; j < centers.length; j++) {
                const base = j * 13
                for (let step = 0; step < 2; step++) for (let k = 0; k < 3; k++) {
                    const fd = (full[(base + 2 + step * 6 + k * 2) * 4 + 3]! - full[(base + 1 + step * 6 + k * 2) * 4 + 3]!) / (2 * steps[step]!)
                    assert.ok(Math.abs(fd - full[base * 4 + k]!) < .008, `${name} at ${centers[j]}: raw ${full[base * 4 + k]} FD ${fd}`)
                }
                for (let k = 0; k < 4; k++) assert.ok(Math.abs(full[base * 4 + k]! - mid[base * 4 + k]!) < .008, `${name} full/Mid ${k}`)
                assert.ok(Math.abs(full[base * 4 + 3]! - fast[base * 4 + 3]!) < .0001, `${name} full/Fast`)
            }
        }
    } finally { helper.device.destroy() }
})
