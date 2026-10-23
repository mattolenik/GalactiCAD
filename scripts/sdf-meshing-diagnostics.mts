/** Rebuild a report and inspect its saved geometry without exporting or rendering again. */
import { readFile, writeFile, cp, mkdir, access } from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { inspectMesh, diagnosticSummary } from "../test/acceptance/sdf-meshing/diagnostics.mjs"
import { classify, renderReport, type CaptureRow } from "../test/acceptance/sdf-meshing/report.mjs"
import { witnessesFor } from "../test/acceptance/sdf-meshing/manifest.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
if (args.length !== 2) throw new Error("Usage: node --import tsx scripts/sdf-meshing-diagnostics.mts INPUT_RUN NEW_OUTPUT_RUN")
const [input, output] = args.map(p => path.resolve(root, p))
const allowed = path.join(root, ".testresults", "sdf-meshing") + path.sep
if (!input.startsWith(allowed) || !output.startsWith(allowed) || output === input || output.startsWith(input + path.sep)) throw new Error("Use distinct run directories under .testresults/sdf-meshing")
const manifest = JSON.parse(await readFile(path.join(input, "manifest.json"), "utf8"))
const rows = JSON.parse(await readFile(path.join(input, "results.json"), "utf8")) as CaptureRow[]
await cp(input, output, { recursive: true, force: false, errorOnExist: true })
await mkdir(path.join(output, "provenance"), { recursive: true })
await cp(path.join(input, "report.md"), path.join(output, "provenance", "report-before-diagnostics.md"))
manifest.diagnosticRevision = { basedOn: path.basename(input), startedAt: new Date().toISOString(), sceneEvaluation: false, remeshed: false, sources: [] }
for (const p of ["scripts/sdf-meshing-diagnostics.mts", "test/acceptance/sdf-meshing/diagnostics.mts", "test/acceptance/sdf-meshing/report.mts", "test/acceptance/sdf-meshing/manifest.mts"]) {
    manifest.diagnosticRevision.sources.push({ path: p, sha256: createHash("sha256").update(await readFile(path.join(root, p))).digest("hex") })
}
for (const row of rows) {
    if (!row.mesh) continue
    const dir = path.join(output, "cases", row.id, "default")
    const bytes = async (name: string) => { const b = await readFile(path.join(dir, `mesh.${name}.bin`)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }
    const start = performance.now()
    const a = inspectMesh(new Float32Array(await bytes("verts")), new Uint32Array(await bytes("tris")), new Float64Array(await bytes("features")), row.mesh.validation.featureChains?.issues ?? [], witnessesFor(row.id, manifest[row.id].sourceSha256))
    await writeFile(path.join(dir, "diagnostics.json"), JSON.stringify(a, null, 2) + "\n")
    row.diagnostics = diagnosticSummary(a)
    row.diagnosticMs = performance.now() - start
    classify(row)
    await writeFile(path.join(dir, "result.json"), JSON.stringify(row, null, 2) + "\n")
    console.log(`${row.id}: ${a.invalidTriangles} exact invalid triangles; exporter reported ${row.mesh.validation.invalidTriangles}`)
}
manifest.diagnosticRevision.finishedAt = new Date().toISOString()
await writeFile(path.join(output, "results.json"), JSON.stringify(rows, null, 2) + "\n")
await writeFile(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
const report = renderReport(manifest, rows)
await writeFile(path.join(output, "report.md"), report)
for (const match of report.matchAll(/\]\(([^)]+)\)/g)) if (!match[1].startsWith("#")) await access(path.join(output, match[1]))
console.log(path.join(output, "report.md"))
