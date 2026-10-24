/** Optional binary receipts for full-model repair regressions; no additional exports. */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

export function saveRepairEvidence(label: string, sceneJson: string, result: {
    verts: Float32Array; tris: Uint32Array; feature_edges: Float64Array; stats_json: string
}, parts: Uint8Array[] = [], diagnostics?: unknown) {
    const destination = process.env.SFCC_REPAIR_EVIDENCE_DIR
    if (!destination) return
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..", ".testresults") + sep
    const base = resolve(destination)
    if (!base.startsWith(root)) throw new Error("SFCC_REPAIR_EVIDENCE_DIR must be under .testresults/")
    const directory = resolve(base, label.toLowerCase().replace(/[^a-z0-9]+/g, "-"))
    mkdirSync(directory, { recursive: true })
    for (const [name, data] of [["mesh.verts.bin", result.verts], ["mesh.tris.bin", result.tris],
        ["mesh.feature-edges.bin", result.feature_edges]] as const) {
        writeFileSync(resolve(directory, name), new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    }
    writeFileSync(resolve(directory, "stats.json"), JSON.stringify(JSON.parse(result.stats_json), null, 2) + "\n")
    writeFileSync(resolve(directory, "scene.json"), sceneJson + "\n")
    if (diagnostics !== undefined) writeFileSync(resolve(directory, "diagnostics.json"), JSON.stringify(diagnostics, null, 2) + "\n")
    for (const [index, part] of parts.entries()) writeFileSync(resolve(directory, `worker-${index}.bin`), part)
}
