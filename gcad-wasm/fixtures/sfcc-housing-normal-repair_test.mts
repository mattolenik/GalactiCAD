/** Actual full-source WASM regression against retained independent GPU sections.
 * Live acceptance separately supplies normals at the resulting face centroids. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { load } from "js-yaml"
import { SceneInfo } from "../../src/scene/scene.mjs"
import { serializeSceneToBridgeJson } from "../../src/export/sfcc-rs/scene-bridge.mjs"
import { MeshQuery, measureCrease, regionsFor, verifyShrinkingSamples, type CreaseReference } from "../../test/acceptance/sdf-meshing/gpu-coverage.mjs"
import { saveRepairEvidence } from "./sfcc-repair-evidence.mjs"
import { initSync, export_sfcc } from "../wasm/pkg/gcad_wasm.js"

initSync({ module: readFileSync(new URL("../wasm/pkg/gcad_wasm_bg.wasm", import.meta.url)) })

test("full housing preserves sharp GPU sections and source paths after paired normal repair", t => {
    const { source } = load(readFileSync(new URL("../../docs/manim/scenes/torture_housing.yaml", import.meta.url), "utf8")) as { source: string }
    const fixture = JSON.parse(readFileSync(new URL("../../test/acceptance/sdf-meshing/housing-crease-surface-window.json", import.meta.url), "utf8"))
    const hash = createHash("sha256").update(source.trim()).digest("hex")
    assert.equal(hash, fixture.sourceSha256, "retained GPU observations must match the original complete model")
    const regions = regionsFor("housing", hash)
    const scene = serializeSceneToBridgeJson(new SceneInfo(source).root)
    const result = export_sfcc(scene, "{}", -22.45, -12.7, -22.2, 44.9)
    try {
        const stats = JSON.parse(result.stats_json)
        const mesh = new MeshQuery(result.verts, result.tris)
        const measured: Array<{ id: string; crease: ReturnType<typeof measureCrease> }> = fixture.regions.map((saved: any) => {
            const region = regions.find(r => r.id === saved.id)
            assert.ok(region)
            const references: CreaseReference[] = saved.references.map((s: any) => {
                const ref = structuredClone(s.reference) as CreaseReference
                verifyShrinkingSamples(ref, s.searches, s.center)
                assert.equal(ref.status, "RESOLVED")
                return ref
            })
            return { id: saved.id, crease: measureCrease(references, mesh, result.feature_edges, undefined, region) }
        })
        saveRepairEvidence(t.name, scene, result, [], { scope: "Retained GPU section normals; centroid correspondence remains a live-GPU acceptance obligation", measured })
        assert.equal(stats.validation.normalRepair.scope, "sampledNormalTransactions")
        assert.notEqual(stats.validation.normalRepair.status, "notChecked")
        for (const { id, crease } of measured) {
            assert.equal(crease.status, "SAMPLED_PASS", `${id}: physical sharpness, memberships, ordered parameters and endpoints`)
            assert.ok(crease.identifiedGeometry!.every(s => s.status === "SAMPLED_PASS"), `${id}: unrelated nearby edges cannot substitute for the required feature`)
        }
    } finally {
        result.free()
    }
})
