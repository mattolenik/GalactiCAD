/** First inventory: one real export per original torture model, retained for every view. */
import { createHash, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, readFile, writeFile, rename, access } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"
import { load } from "js-yaml"
import { parseAgentTestcaseYaml, mergeAgentRenderRequest } from "../src/agent-autotest/agent-testcase.mjs"
import { normalizeSfccTuning } from "../src/export/sfcc/sfcc-tuning.mjs"
import { DEFAULT_SIMPLIFY_TUNING } from "../src/render-worker-protocol.mjs"
import { CASES, viewsFor, witnessesFor } from "../test/acceptance/sdf-meshing/manifest.mjs"
import { classify, renderReport, type CaptureRow } from "../test/acceptance/sdf-meshing/report.mjs"
import { MeshQuery, regionsFor, runCoverage, corruptionChecks, type Point, type Sample } from "../test/acceptance/sdf-meshing/gpu-coverage.mjs"
import { inspectMesh, diagnosticSummary } from "../test/acceptance/sdf-meshing/diagnostics.mjs"

const exec = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex")
const args = process.argv.slice(2)
if (args.includes("--help")) {
    console.log("Usage: node --import tsx scripts/sdf-meshing-acceptance.mts [--out .testresults/sdf-meshing/RUN] [--case bracket|housing|knob|mess1|mess2] [--strict]\nDefault: all five models; starts/refreshes agent server; writes portable report. Exit 0=report complete, 2=harness/infrastructure error; --strict returns 1 for unaccepted meshes.")
    process.exit(0)
}
for (let i = 0; i < args.length; i++) {
    if (["--out", "--case"].includes(args[i])) { if (!args[++i] || args[i].startsWith("--")) throw new Error("Missing option value") }
    else if (args[i] !== "--strict") throw new Error(`Unknown option ${args[i]}`)
}
const option = (key: string) => args.includes(key) ? args[args.indexOf(key) + 1] : undefined
const selection = option("--case")
if (selection && !CASES.some(c => c.id === selection)) throw new Error(`Unknown case ${selection}`)
const runId = new Date().toISOString().replace(/[:.]/g, "-")
const out = path.resolve(root, option("--out") ?? `.testresults/sdf-meshing/${runId}`)
if (!out.startsWith(path.join(root, ".testresults", "sdf-meshing") + path.sep)) throw new Error("--out must be under .testresults/sdf-meshing/")
await mkdir(path.dirname(out), { recursive: true })
await mkdir(out) // An existing run is immutable; never silently overwrite a baseline.
const started = performance.now()
const deadline = started + 30 * 60_000
const rows: CaptureRow[] = CASES.filter(c => !selection || c.id === selection).map(c => ({ id: c.id, name: c.name, status: "NOT_RUN", reasons: [], views: [] }))
async function atomic(file: string, data: string | Uint8Array) {
    await writeFile(file + ".tmp", data)
    await rename(file + ".tmp", file)
}
const json = (file: string, value: unknown) => atomic(file, JSON.stringify(value, null, 2) + "\n")
const run = (file: string, args: string[], timeout = 60_000) => exec(file, args, { cwd: root, timeout, maxBuffer: 32 * 1024 * 1024 })
const cli = (args: string[], timeout = 60_000) => run(path.join(root, "scripts/agentcli"), args, timeout)
const commit = (await run("git", ["rev-parse", "HEAD"])).stdout.trim()
const dirty = (await run("git", ["status", "--porcelain"])).stdout.trim()
const tracked = (await run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "Makefile", "package.json", "pnpm-lock.yaml", "src", "build", "scripts", "test/acceptance/sdf-meshing", "gcad-wasm/kernel", "gcad-wasm/wasm/src", "gcad-wasm/Cargo.toml", "gcad-wasm/Cargo.lock", "gcad-wasm/wasm/Cargo.toml", "docs/manim/scenes"])).stdout.trim().split("\n")
const sourceHashes = []
for (const file of [...new Set(tracked)].sort()) sourceHashes.push({ path: file, sha256: sha(await readFile(path.join(root, file))) })
const manifest: Record<string, any> = { schemaVersion: 1, runId, commit, dirty: Boolean(dirty), dirtyStatus: dirty, sourceHashes,
    sourceDigest: sha(JSON.stringify(sourceHashes)), wasmSha256: sha(await readFile(path.join(root, "gcad-wasm/wasm/pkg/gcad_wasm_bg.wasm"))),
    environment: { platform: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model, node: process.version },
    limits: { exportMs: 180_000, captureMs: 60_000, runMs: 30 * 60_000 }, samplePolicy: "single sample, no warmup; browser production export", startedAt: new Date().toISOString(), cases: rows.map(r => r.id) }
async function save() {
    await json(path.join(out, "manifest.json"), manifest)
    await json(path.join(out, "results.json"), rows)
    await atomic(path.join(out, "report.md"), renderReport(manifest, rows))
}
await save()
// Even a server-start failure must leave a complete, navigable five-row report.
for (const row of rows) {
    const dir = path.join(out, "cases", row.id, "default")
    await mkdir(path.join(dir, "thumbs"), { recursive: true })
    await atomic(path.join(dir, "source.yaml"), await readFile(path.join(root, `docs/manim/scenes/torture_${row.id}.yaml`)))
    await atomic(path.join(dir, "log.txt"), "Not run yet.\n")
    await json(path.join(dir, "result.json"), row)
}
let baseUrl = ""
async function ready(restart = false) {
    await cli(["server", restart ? "restart" : "start"], 120_000)
    const state = JSON.parse(await readFile(path.join(root, ".devserver.agent.run"), "utf8"))
    if (!Number.isInteger(state.port)) throw new Error("Agent server port missing")
    baseUrl = `http://localhost:${state.port}`
    // The run file precedes Chromium/WebGPU readiness on a cold start.
    for (let attempt = 0; ; attempt++) {
        try { await cli(["server", "refresh"], 90_000); break }
        catch (e) { if (attempt === 9) throw e; await new Promise(resolve => setTimeout(resolve, 1000)) }
    }
}
class RpcError extends Error { constructor(message: string, readonly timedOut = false) { super(message) } }
async function rpc(payload: Record<string, unknown>, timeout: number): Promise<Record<string, any>> {
    if (performance.now() >= deadline) throw new RpcError("Run time budget exhausted", true)
    const signal = AbortSignal.timeout(Math.max(1, Math.floor(Math.min(timeout + 5000, deadline - performance.now()))))
    try {
        const response = await fetch(`${baseUrl}/_agent/mesh-acceptance`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "meshAcceptance", ...payload }), signal })
        const result = await response.json() as any
        if (!response.ok || result.error || !result.capture) throw new RpcError(result.error ?? `HTTP ${response.status}`, response.status === 504)
        if (result.capture.captureId !== payload.captureId) throw new RpcError("Stale capture response ID")
        return result.capture
    } catch (e) {
        if (signal.aborted) throw new RpcError(`RPC exceeded ${timeout} ms / remaining run budget`, true)
        throw e
    }
}
let harnessError = false
let stopping = false
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { stopping = true })
try {
    await ready()
    for (const row of rows) {
        const item = CASES.find(c => c.id === row.id)!
        const dir = path.join(out, "cases", row.id, "default")
        await mkdir(path.join(dir, "thumbs"), { recursive: true })
        const source = await readFile(path.join(root, `docs/manim/scenes/torture_${row.id}.yaml`), "utf8")
        await atomic(path.join(dir, "source.yaml"), source)
        const log: string[] = []
        const note = (s: string) => { log.push(`${new Date().toISOString()} ${s}`); console.log(`${row.id}: ${s}`) }
        const caseStart = performance.now()
        const captureId = `${row.id}-${randomUUID()}`
        let timeout = false
        let exportTimeout = false
        try {
            if (stopping || performance.now() >= deadline) { row.reasons.push("Run stopped or time budget exhausted"); continue }
            const raw = load(source) as any
            if (!["sfcc", "sfcc-rs"].includes(raw.meshExport?.exporter)) throw new Error("Unexpected exporter; refusing registry fallback")
            const tc = parseAgentTestcaseYaml(source)
            tc.meshExport.exporter = "sfcc-rs"
            tc.meshExport.exporterTuning = { "sfcc-rs": normalizeSfccTuning(raw.meshExport.exporterTuning?.["sfcc-rs"] ?? raw.meshExport.exporterTuning?.sfcc ?? {}) }
            // The display-only flat-normal pass duplicates vertices but retains old feature IDs.
            // Capture the indexed SFCC artifact itself; geometry/tessellation tuning is unchanged.
            tc.meshExport.simplifyTuning = { ...DEFAULT_SIMPLIFY_TUNING, ...raw.meshExport.simplifyTuning, renormalizeTriangles: false }
            if (tc.meshExport.simplifyOnExport !== false) throw new Error("Original case unexpectedly enables simplification")
            const request = mergeAgentRenderRequest(tc, { mode: "mesh" })
            const sourceSha256 = sha(tc.source.trim())
            manifest[row.id] = { yamlSha256: sha(source), sourceSha256, requestedExporter: raw.meshExport.exporter, resolvedExporter: "sfcc-rs", request }
            const prepared = await rpc({ action: "prepare", captureId, request }, 60_000)
            if (prepared.sourceSha256 !== sourceSha256) throw new Error("Capture source differs from manifest")
            manifest[row.id].browser = prepared.browser; manifest[row.id].gpu = prepared.gpu; manifest[row.id].gpuInfoSource = prepared.gpuInfoSource
            // Capture reference before meshing so an export failure retains useful evidence.
            const viewDefs = viewsFor(tc.camera, item)
            for (const view of viewDefs) row.views.push({ id: view.id, label: view.label, images: {} })
            async function image(viewIndex: number, mode: "sdf" | "mesh" | "wire") {
                const v = viewDefs[viewIndex], target = row.views[viewIndex]
                const r = await rpc({ action: "view", captureId, mode, camera: v.camera, viewCenter: tc.viewCenter }, 60_000)
                if (r.sourceSha256 !== sourceSha256 || (mode !== "sdf" && r.meshDigest !== row.mesh?.meshDigest)) throw new Error("Image source/mesh digest mismatch")
                const file = `${v.id}-${mode}.png`
                const bytes = Buffer.from(r.pngBase64, "base64")
                if (bytes.length < 24 || bytes.readUInt32BE(16) !== r.width || bytes.readUInt32BE(20) !== r.height) throw new Error("Invalid PNG dimensions")
                const metaPath = path.join(dir, `${v.id}-${mode}.json`)
                const { pngBase64, ...metadata } = r
                await json(metaPath, { ...metadata, sha256: sha(bytes), camera: v.camera, viewCenter: tc.viewCenter })
                if (mode !== "sdf") {
                    const sdfMeta = JSON.parse(await readFile(path.join(dir, `${v.id}-sdf.json`), "utf8"))
                    if (sdfMeta.cameraSignature !== r.cameraSignature || sdfMeta.width !== r.width || sdfMeta.height !== r.height) throw new Error("SDF/mesh camera or resolution mismatch")
                }
                await atomic(path.join(dir, file), bytes)
                target.images[mode] = path.relative(out, path.join(dir, file))
                await run("magick", [path.join(dir, file), "-resize", "240x200", path.join(dir, "thumbs", file)])
                target.images[`${mode}Thumb`] = path.relative(out, path.join(dir, "thumbs", file))
            }
            note("capturing hero SDF")
            await image(0, "sdf")
            try {
                note("exporting once")
                const r = await rpc({ action: "export", captureId }, 180_000)
                if (r.sourceSha256 !== sourceSha256) throw new Error("Export source mismatch")
                const artifactInfo: Record<string, any> = {}
                for (const name of ["verts", "tris", "features"]) {
                    const a = r.artifacts[name], bytes = Buffer.from(a.base64, "base64")
                    if (bytes.length !== a.bytes || sha(bytes) !== a.sha256) throw new Error(`Corrupt ${name} artifact`)
                    await atomic(path.join(dir, `mesh.${name}.bin`), bytes)
                    artifactInfo[name] = { bytes: bytes.length, sha256: a.sha256 }
                }
                if (sha(["verts", "tris", "features"].map(k => artifactInfo[k].sha256).join("\n")) !== r.meshDigest || artifactInfo.tris.bytes !== r.triangles * 12 || artifactInfo.verts.bytes !== r.vertices * 32) throw new Error("Mesh digest/count mismatch")
                const { artifacts, ...metadata } = r
                row.mesh = metadata as CaptureRow["mesh"]
                row.status = "INCOMPLETE"
                await json(path.join(dir, "artifacts.json"), artifactInfo)
                await json(path.join(dir, "effective-config.json"), { ...r.execution, simplifyTuning: tc.meshExport.simplifyTuning, captureNormalOverride: "Raw artifact: renormalizeTriangles=false preserves original SFCC vertex/feature identities. Display copy: flatFaceNormals matches production shading; no triangle corner moves." })
                await json(path.join(dir, "stats.json"), r.stats)
                const auditStart = performance.now()
                const buffer = (name: string) => { const b = Buffer.from(r.artifacts[name].base64, "base64"); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }
                const diagnostics = inspectMesh(new Float32Array(buffer("verts")), new Uint32Array(buffer("tris")), new Float64Array(buffer("features")), r.validation.featureChains?.issues ?? [], witnessesFor(row.id, sourceSha256))
                await json(path.join(dir, "diagnostics.json"), diagnostics)
                row.diagnostics = diagnosticSummary(diagnostics)
                row.diagnosticMs = performance.now() - auditStart
                const regions = regionsFor(row.id, sourceSha256)
                if (regions.length) {
                    try {
                    note("sampling independent GPU regional references")
                    let gpuSamples = 0, gpuBatches = 0, gpuBatchMs = 0
                    const sample = async (points: Point[]): Promise<Sample[]> => {
                        const all: Sample[] = []
                        for (let offset = 0; offset < points.length; offset += 20000) {
                            const chunk = points.slice(offset, offset + 20000).map(p => p.map(Math.fround) as Point)
                            const result = await rpc({ action: "sample", captureId, sourceSha256, positions: chunk.flat() }, 60_000)
                            if (result.sourceSha256 !== sourceSha256 || result.meshDigest !== r.meshDigest || result.samples?.length !== chunk.length * 4 || result.samples.some((x: number) => !Number.isFinite(x))) throw new Error("Invalid/stale GPU coverage samples")
                            gpuSamples += chunk.length; gpuBatches++; gpuBatchMs += result.sampleMs
                            for (let i = 0; i < chunk.length; i++) all.push({ point: chunk[i], normal: result.samples.slice(i * 4, i * 4 + 3), field: result.samples[i * 4 + 3] })
                        }
                        return all
                    }
                    const coverageStart = performance.now()
                    const query = new MeshQuery(new Float32Array(buffer("verts")), new Uint32Array(buffer("tris"))), features = new Float64Array(buffer("features"))
                    const coverage = await runCoverage(regions, query, features, sample)
                    coverage.coverageMs = performance.now() - coverageStart
                    // Full refinement histories are large; retain every value without indentation.
                    await atomic(path.join(dir, "gpu-coverage.json"), JSON.stringify({ ...coverage, gpuSamples, gpuBatches, gpuBatchMs, sourceSha256, meshDigest: r.meshDigest }) + "\n")
                    row.gpuCoverage = { status: coverage.status, coverageMs: coverage.coverageMs, regions: coverage.regions.map(x => ({ id: x.region.id, referencePoints: x.reference.roots.length, sameSignEdges: x.reference.sameSignEdges, zeroEndpoints: x.reference.zeroEndpoints, unrefinedBrackets: x.reference.unrefinedBrackets, surfaceToMesh: x.surfaceToMesh, meshSamples: x.meshToField.samples, residualFailures: x.meshToField.residualFailures, worstResidual: x.meshToField.worstResidual, ambiguousProjections: x.meshToField.ambiguousProjections, unresolvedProjectionBudget: x.meshToField.unresolvedProjectionBudget, ambiguousSheetAssociations: x.meshToField.ambiguousSheetAssociations, multipleCrossingLines: x.meshToField.multipleCrossingLines, referenceDiagnostics: x.referenceDiagnostics, crease: x.crease })) }
                    const corruptionStart = performance.now()
                    let corruptions: Awaited<ReturnType<typeof corruptionChecks>>
                    try {
                        corruptions = await corruptionChecks(coverage, query, features, sample)
                        await json(path.join(dir, "gpu-corruptions.json"), { ...corruptions, corruptionMs: performance.now() - corruptionStart, sourceSha256, meshDigest: r.meshDigest })
                        row.gpuCoverage.corruptionChecksPassed = corruptions.passed
                    } catch (e) {
                        harnessError = true
                        await json(path.join(dir, "gpu-corruptions.json"), { passed: false, error: String(e), sourceSha256, meshDigest: r.meshDigest })
                        if (e instanceof RpcError && e.timedOut) { timeout = true; throw e }
                        corruptions = { passed: false, checks: [] }
                        row.gpuCoverage.error = `Corruption stage: ${String(e)}`
                        row.reasons.push(`GPU corruption checks failed to complete: ${String(e)}`)
                    }

                    } catch (e) {
                        harnessError = true
                        row.gpuCoverage ??= { status: "ERROR", coverageMs: 0, regions: [] }
                        row.gpuCoverage.error = String(e)
                        try { await access(path.join(dir, "gpu-coverage.json")) } catch { await json(path.join(dir, "gpu-coverage.json"), { status: "ERROR", error: String(e), sourceSha256, meshDigest: r.meshDigest }) }
                        try { await access(path.join(dir, "gpu-corruptions.json")) } catch { await json(path.join(dir, "gpu-corruptions.json"), { passed: false, error: "GPU reference unavailable" }) }
                        row.reasons.push(`GPU coverage could not run: ${String(e)}`)
                        note(String(e))
                        if (e instanceof RpcError && e.timedOut) { timeout = true; throw e }
                    }
                }
                note(`${r.triangles} triangles; ${r.execution.exportMs.toFixed(1)} ms; ok=${r.execution.ok}`)
                await save()
            } catch (e) {
                timeout = e instanceof RpcError && e.timedOut
                exportTimeout = timeout && !row.mesh
                row.status = timeout ? "TIMEOUT" : /unsupported/i.test(String(e)) ? "UNSUPPORTED" : "ERROR"
                row.reasons.push(String(e)); note(String(e))
                if (timeout) throw e
            }
            for (let i = 0; i < viewDefs.length; i++) {
                try {
                    if (i > 0) await image(i, "sdf")
                    if (!row.mesh) continue
                    note(`rendering ${viewDefs[i].id} from retained mesh`)
                    await image(i, "mesh"); await image(i, "wire")
                    const diff = path.join(dir, `${viewDefs[i].id}-diff.png`)
                    const compareArgs = ["compare", path.join(out, row.views[i].images.sdf), path.join(out, row.views[i].images.mesh), "--json", "--diff-png", diff]
                    let stdout: string
                    try { stdout = (await cli(compareArgs)).stdout } catch (e: any) { if (e.code !== 1) throw e; stdout = e.stdout }
                    const metrics = JSON.parse(stdout)
                    if (![metrics.ssim, metrics.pixelDiff, metrics.errorPct].every(Number.isFinite)) throw new Error("Image comparison did not supply both metrics")
                    row.views[i].metrics = metrics
                    row.views[i].images.diff = path.relative(out, diff)
                    await run("magick", [diff, "-resize", "240x200", path.join(dir, "thumbs", `${viewDefs[i].id}-diff.png`)])
                    row.views[i].images.diffThumb = path.relative(out, path.join(dir, "thumbs", `${viewDefs[i].id}-diff.png`))
                } catch (e) {
                    row.views[i].error = String(e); note(String(e)); harnessError = true
                    if (e instanceof RpcError && e.timedOut) { timeout = true; throw e }
                }
                await save()
            }
        } catch (e) {
            timeout ||= e instanceof RpcError && e.timedOut
            if (!row.mesh) row.status = timeout ? "TIMEOUT" : "ERROR"
            row.reasons.push(String(e)); note(String(e))
            // A bounded mesher timeout is a recorded acceptance outcome, not a broken report.
            harnessError ||= !exportTimeout
        } finally {
            row.totalMs = performance.now() - caseStart
            classify(row)
            await atomic(path.join(dir, "log.txt"), log.join("\n") + "\n")
            await json(path.join(dir, "result.json"), row)
            await save()
            if (timeout) {
                // A page reload kills the blocked render worker; server restart also clears its RPC queue.
                note("restarting isolated agent context after timeout")
                await ready(true)
            } else if (baseUrl) {
                await rpc({ action: "clear", captureId }, 60_000).catch(() => undefined)
            }
        }
    }
} catch (e) {
    manifest.infrastructureError = String(e); harnessError = true
} finally {
    manifest.finishedAt = new Date().toISOString(); manifest.elapsedMs = performance.now() - started
    manifest.harnessStatus = harnessError ? "ERROR" : "COMPLETE"
    manifest.acceptanceStatus = "NOT_PASSED"
    await save()
}
// Validate every generated link, including explicit partial/failure records.
const report = await readFile(path.join(out, "report.md"), "utf8")
for (const match of report.matchAll(/\]\(([^)]+)\)/g)) {
    if (!match[1].startsWith("#")) await access(path.join(out, match[1]))
}
console.log(`Report: ${path.join(out, "report.md")}`)
process.exitCode = harnessError ? 2 : args.includes("--strict") ? 1 : 0
