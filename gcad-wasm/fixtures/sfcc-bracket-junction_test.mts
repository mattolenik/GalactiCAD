/** Regression for the face-interior junction in the complete transformed Manim bracket. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { test, type TestContext } from "node:test"
import { Worker } from "node:worker_threads"
import { load } from "js-yaml"
import { SceneInfo } from "../../src/scene/scene.mjs"
import { serializeSceneToBridgeJson } from "../../src/export/sfcc-rs/scene-bridge.mjs"
import { inspectMesh } from "../../test/acceptance/sdf-meshing/diagnostics.mjs"
import { saveRepairEvidence } from "./sfcc-repair-evidence.mjs"
import { witnessesFor } from "../../test/acceptance/sdf-meshing/manifest.mjs"
import { initSync, export_sfcc, audit_field_samples, sfcc_worker_prepare, sfcc_worker_merge } from "../wasm/pkg/gcad_wasm.js"

initSync({ module: readFileSync(new URL("../wasm/pkg/gcad_wasm_bg.wasm", import.meta.url)) })

function fixture() {
    const { source } = load(readFileSync(new URL("../../docs/manim/scenes/torture_bracket.yaml", import.meta.url), "utf8")) as { source: string }
    const witnesses = witnessesFor("bracket", createHash("sha256").update(source).digest("hex"))
    const scene = new SceneInfo(source)
    const sourceJson = serializeSceneToBridgeJson(scene.root)
    return { sourceJson, witnesses }
}
const cube = [-25.2, -19.2, -25.2, 50.4] as const
function checkProductionFeatureObligations(result: ReturnType<typeof export_sfcc>) {
    const chains = JSON.parse(result.stats_json).validation.featureChains
    for (const [name,limit] of Object.entries({intervalGaps:46,disconnectedCurves:4,missingEdges:7,missingCurves:0,offCurveEdges:0,invalidMemberships:0})) {
        assert.ok(chains[name] <= limit, `production bracket ${name} regressed: ${chains[name]} > ${limit}`)
    }
    assert.deepEqual(chains.issues.filter((i: {curveId:number}) => i.curveId === 63 || i.curveId === 64), [],
        "concave planar trim triangulation must preserve both complete notch curves")
}
function checkJunction(result: ReturnType<typeof export_sfcc>, sourceJson: string, witnesses: ReturnType<typeof witnessesFor>, t: TestContext, parts: Uint8Array[] = []) {
    const stats = JSON.parse(result.stats_json)
    assert.equal(stats.components, 1, "the junction must attach to the bracket, not form a separately capped bubble")
    const audit = inspectMesh(result.verts, result.tris, result.feature_edges, [], witnesses)
    saveRepairEvidence(t.name, sourceJson, result, parts, audit)
    assert.equal(audit.defects.length, 0, "the complete bracket must contain no exact invalid float32 triangles")
    for (const witness of audit.pointWitnesses) assert.ok(witness.passed, `${witness.id} misses mesh by ${witness.distance} mm`)
    for (const check of ["edgeIncidence", "vertexLinks", "faceSegments"]) assert.equal(stats.validation[check], "passed", check)
    const verts = result.verts, tris = result.tris, edges = result.feature_edges
    const p = witnesses[0]!.position
    let junction = -1, distance = Infinity
    for (let i = 0; i < verts.length; i += 8) {
        const d = Math.hypot(...p.map((x,k) => x - verts[i+k]!))
        if (d < distance) { distance = d; junction = i / 8 }
    }
    assert.ok(distance < 1e-5, `the actual junction vertex must be present: ${distance}`)
    const incident = new Set<number>()
    for (let i = 0; i < edges.length; i += 5) {
        if (edges[i] === junction || edges[i+1] === junction) incident.add(edges[i+2]!)
    }
    assert.equal(incident.size, 3, "all three compiled incident curves must reach the same junction vertex")
    const samples: number[] = []
    let localTriangles = 0
    for (let i = 0; i < tris.length; i += 3) {
        const ids = [tris[i]!, tris[i+1]!, tris[i+2]!]
        if (!ids.includes(junction)) continue
        localTriangles++
        for (const weights of [[1/3,1/3,1/3], [0.5,0.5,0], [0,0.5,0.5], [0.5,0,0.5]]) {
            samples.push(...[0,1,2].map(k => ids.reduce((s,id,j) => s + weights[j]! * verts[id*8+k]!,0)))
        }
    }
    assert.ok(localTriangles >= 3)
    const fields = audit_field_samples(sourceJson, new Float64Array(samples))
    let maxResidual = 0
    for (let i = 0; i < fields.length; i += 15) maxResidual = Math.max(maxResidual, Math.abs(fields[i]!))
    assert.ok(maxResidual < 0.01, `junction triangle interiors have exporter-field residual ${maxResidual}`)
    assert.equal(audit.defects.filter(d => d.vertices.includes(junction)).length, 0)
    t.diagnostic(JSON.stringify({ components: stats.components, euler: stats.euler, invalidTriangles: audit.defects.length, triangleCount: tris.length / 3, cornerDistance: audit.pointWitnesses[0]!.distance,
        junctionVertexDistance: distance, incidentCurveCount: incident.size, localTriangles, maxExporterFieldResidual: maxResidual,
        validation: stats.validation }))
}

test("full bracket retains the dent/rib junction on the production acceptance lattice", t => {
    const { sourceJson, witnesses } = fixture()
    const result = export_sfcc(sourceJson, "{}", ...cube)
    try { checkJunction(result, sourceJson, witnesses, t); checkProductionFeatureObligations(result) } finally { result.free() }
})

test("the full bracket junction survives a rigid axis rotation", t => {
    const input = fixture()
    const sourceJson = JSON.stringify({ kind: "rotate", node_id: -100,
        fwd: [0,1,0,-1,0,0,0,0,1], arg: JSON.parse(input.sourceJson) })
    const witnesses = input.witnesses.map(w => ({ ...w, position: [-w.position[1]!, w.position[0]!, w.position[2]!] }))
    const result = export_sfcc(sourceJson, "{}", -31.2, -25.2, -25.2, 50.4)
    try { checkJunction(result, sourceJson, witnesses, t) } finally { result.free() }
})


test("worker partitions retain the same connected bracket junction when merged in reverse order", async t => {
    const { sourceJson, witnesses } = fixture()
    const leaves = sfcc_worker_prepare(sourceJson, "{}", ...cube)
    const parts: Uint8Array[] = []
    // Sequential workers avoid turning a correctness check into a timing campaign.
    for (let index = 0; index < 2; index++) {
        parts.push(await new Promise<Uint8Array>((resolve, reject) => {
            const w = new Worker(new URL("./sfcc-discovery-worker.mjs", import.meta.url), {
                workerData: { task: "mesh", scene: sourceJson, tuning: "{}", cube, leaves, index, count: 2 },
            })
            let output: Uint8Array | undefined
            w.once("message", value => { output = value })
            w.once("error", reject)
            w.once("exit", code => code === 0 && output ? resolve(output) : reject(new Error(`worker exit ${code}`)))
        }))
    }
    checkRawPartitionNeighborhood(parts, witnesses[0]!.position)
    const result = sfcc_worker_merge(sourceJson, "{}", ...cube, [...parts].reverse())
    try {
        checkJunction(result, sourceJson, witnesses, t, parts)
        checkProductionFeatureObligations(result)
        t.diagnostic(`serialRecovery=${JSON.parse(result.stats_json).serialRecovery}; final recovery is reported, not mistaken for raw partition certification`)
    } finally { result.free() }
})

function checkRawPartitionNeighborhood(parts: Uint8Array[], witness: number[]) {
    const edges = new Map<string, { count: number; orientation: number; local: boolean }>()
    let cornerTriangles = 0
    for (const [partIndex, part] of parts.entries()) {
        const view = new DataView(part.buffer, part.byteOffset, part.byteLength)
        assert.equal(view.getUint32(0, true), 0x53465035, "update diagnostic parser if worker format changes")
        let offset = 48
        const u64 = () => { const n = Number(view.getBigUint64(offset, true)); offset += 8; return n }
        const signature = u64(); offset += signature * 8
        const count = u64()
        const positions = Array.from({ length: count }, () => {
            const p = [0,1,2].map(k => view.getFloat64(offset + k * 8, true)); offset += 64; return p
        })
        const keys = Array.from({ length: count }, (_, i) => {
            const tag = view.getUint8(offset++)
            if (tag === 0) { const key = `n:${view.getBigInt64(offset, true)}`; offset += 8; return key }
            if (tag === 1) { const n = u64(); const key = `s:${new TextDecoder().decode(part.subarray(offset, offset + n))}`; offset += n; return key }
            assert.equal(tag, 2)
            return `local:${partIndex}:${i}`
        })
        const distance = positions.map(p => Math.hypot(...p.map((x,k) => x - witness[k]!)))
        const indices = u64()
        for (let i = 0; i < indices; i += 3) {
            const tri = [0,1,2].map(k => view.getUint32(offset + k * 4, true)); offset += 12
            if (tri.some(v => distance[v]! < 1e-7)) cornerTriangles++
            for (let k = 0; k < 3; k++) {
                const a = tri[k]!, b = tri[(k + 1) % 3]!, ka = keys[a]!, kb = keys[b]!
                const key = JSON.stringify(ka < kb ? [ka,kb] : [kb,ka])
                const entry = edges.get(key) ?? { count: 0, orientation: 0, local: false }
                entry.count++; entry.orientation += ka < kb ? 1 : -1
                entry.local ||= Math.max(distance[a]!,distance[b]!) < 0.25 && Math.min(distance[a]!,distance[b]!) < 0.08
                edges.set(key, entry)
            }
        }
    }
    assert.ok(cornerTriangles >= 3, "raw workers must construct the junction before any serial recovery")
    const local = [...edges.values()].filter(e => e.local)
    assert.ok(local.length >= 6)
    for (const edge of local) {
        assert.equal(edge.count, 2, "raw shared-face/coarse-fine edge incidence near the junction")
        assert.equal(edge.orientation, 0, "raw shared face must be consumed in opposite directions")
    }
}
