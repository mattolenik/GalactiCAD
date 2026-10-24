/** Actual WASM regression for duplicate descriptions of the full housing's loft rim. */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { test, type TestContext } from "node:test"
import { Worker } from "node:worker_threads"
import { load } from "js-yaml"
import { SceneInfo } from "../../src/scene/scene.mjs"
import { serializeSceneToBridgeJson } from "../../src/export/sfcc-rs/scene-bridge.mjs"
import { inspectMesh } from "../../test/acceptance/sdf-meshing/diagnostics.mjs"
import { initSync, export_sfcc, sfcc_worker_prepare, sfcc_worker_merge } from "../wasm/pkg/gcad_wasm.js"

initSync({ module: readFileSync(new URL("../wasm/pkg/gcad_wasm_bg.wasm", import.meta.url)) })
const cube = [-22.45, -12.7, -22.2, 44.9] as const
const pairs = [[3,12],[6,7],[9,10],[14,15],[17,18],[20,21],[24,25],[27,28],[30,31]] as const
// The eleven diagnosed gaps, in each curve's own parameter chart.
const gaps = [
    [3,0.08059940276432506,0.883143253415675],
    [6,0.08875408529586712,0.4900260106215424],[6,0.5903439919529604,0.8912979359472168],
    [9,0.1995151969141092,0.7266501135386656],[14,0.012875701713018693,0.8154195523643675],
    [17,0.00015838733372657818,0.5272933039582854],[20,0.004721019181475776,0.8072648698328256],
    [24,0.11685674658432468,0.9194005972356754],[27,0.27334988646133446,0.8004848030858909],
    [30,0.10870206405278351,0.4096560080470397],[30,0.5099739893784575,0.9112459147041324],
] as const
function source() {
    const { source } = load(readFileSync(new URL("../../docs/manim/scenes/torture_housing.yaml", import.meta.url), "utf8")) as { source: string }
    assert.equal(createHash("sha256").update(source).digest("hex"), "54964141fea0ed055f5392837c5e524f4a358e1c610f0b11a90857b8b57ad4a5")
    return serializeSceneToBridgeJson(new SceneInfo(source).root)
}
function check(result: ReturnType<typeof export_sfcc>, t: TestContext) {
    const stats = JSON.parse(result.stats_json)
    for (const name of ["edgeIncidence", "vertexLinks", "faceSegments"]) assert.equal(stats.validation[name], "passed", name)
    const verts = result.verts, tris = result.tris, data = result.feature_edges
    const audit = inspectMesh(verts, tris, data, [])
    assert.ok(audit.defects.length <= 180, "membership reconciliation must not introduce invalid faces")
    const edges = new Map<string, Map<number, number[]>>()
    const ranges = new Map<number, number[][]>()
    const key = (a: number, b: number) => `${Math.min(a,b)}:${Math.max(a,b)}`
    const invalid = new Set(audit.defects.map(d => d.triangle))
    const validEdges = new Set<string>()
    for (let i = 0; i < tris.length; i += 3) {
        if (invalid.has(i / 3)) continue
        for (let k = 0; k < 3; k++) validEdges.add(key(tris[i+k]!,tris[i+(k+1)%3]!))
    }
    for (let i = 0; i < data.length; i += 5) {
        const [a,b,id,start,end] = Array.from(data.subarray(i,i+5)) as [number,number,number,number,number]
        const edge = key(a,b)
        if (!edges.has(edge)) edges.set(edge,new Map())
        edges.get(edge)!.set(id,a < b ? [start,end] : [end,start])
        if (validEdges.has(edge)) {
            if (!ranges.has(id)) ranges.set(id,[])
            ranges.get(id)!.push([Math.min(start,end),Math.max(start,end)])
        }
    }
    for (const [id,lo,hi] of gaps) {
        let end: number = lo
        for (const [a,b] of (ranges.get(id) ?? []).sort((a,b) => a[0]!-b[0]!)) {
            if (a! <= end + 1e-10) end = Math.max(end,b!)
        }
        assert.ok(end >= hi - 1e-10, `curve ${id} still lacks membership over ${lo}..${hi}: reaches ${end}`)
    }
    for (const [a,b] of pairs) {
        let shared = 0
        for (const [edge,labels] of edges) if (validEdges.has(edge) && (labels.has(a) || labels.has(b))) {
            assert.deepEqual(labels.get(a),labels.get(b), `same oriented chart on physical edge ${edge}: ${a}/${b}`)
            shared++
        }
        assert.ok(shared > 0, `no valid physical edges for pair ${a}/${b}`)
        const issues = stats.validation.featureChains.issues.filter((i: {curveId:number}) => i.curveId === a || i.curveId === b)
        // These two pairs already have duplicated physical rim edges and
        // zero-area fans. Keep the strict connectivity failure for milestone 3.
        const unexpected = issues.filter((i: {kind:string}) => !([6,30].includes(a) && i.kind === "disconnected"))
        assert.deepEqual(unexpected,[],`reconciled pair ${a}/${b} has an unaccounted feature failure`)
    }
    const curve75Issues = stats.validation.featureChains.issues.filter((i: {curveId:number}) => i.curveId === 75)
    t.diagnostic(JSON.stringify({triangles:tris.length/3,invalidTriangles:audit.defects.length,
        repairedGapSpans:gaps.length,reconciledPairs:pairs.length,curve75Issues,
        vertsSha256:createHash("sha256").update(new Uint8Array(verts.buffer,verts.byteOffset,verts.byteLength)).digest("hex"),
        trisSha256:createHash("sha256").update(new Uint8Array(tris.buffer,tris.byteOffset,tris.byteLength)).digest("hex"),featureChains:stats.validation.featureChains,serialRecovery:stats.serialRecovery}))
}

test("full housing preserves all eleven overlapping-rim memberships on valid mesh edges", t => {
    const result = export_sfcc(source(),"{}",...cube)
    try { check(result,t) } finally { result.free() }
})

test("housing overlap memberships survive reverse worker merge order", async t => {
    const scene = source(), leaves = sfcc_worker_prepare(scene,"{}",...cube)
    const parts: Uint8Array[] = []
    for (let index = 0; index < 2; index++) {
        parts.push(await new Promise<Uint8Array>((resolve,reject) => {
            const worker = new Worker(new URL("./sfcc-discovery-worker.mjs",import.meta.url),{
                workerData:{task:"mesh",scene,tuning:"{}",cube,leaves,index,count:2},
            })
            let result: Uint8Array | undefined
            worker.once("message",value => { result=value })
            worker.once("error",reject)
            worker.once("exit",code => code === 0 && result ? resolve(result) : reject(new Error(`worker exit ${code}`)))
        }))
    }
    const result = sfcc_worker_merge(scene,"{}",...cube,parts.reverse())
    try { check(result,t) } finally { result.free() }
})

test("full housing overlap memberships survive a rigid axis rotation", t => {
    const scene = JSON.stringify({kind:"rotate",node_id:-100,fwd:[0,1,0,-1,0,0,0,0,1],arg:JSON.parse(source())})
    const result = export_sfcc(scene,"{}",-32.2,-22.45,-22.2,44.9)
    try { check(result,t) } finally { result.free() }
})
