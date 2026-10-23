import type { diagnosticSummary } from "./diagnostics.mjs"

export interface CaptureRow {
    id: string
    name: string
    status: "NOT_RUN" | "ERROR" | "TIMEOUT" | "UNSUPPORTED" | "FAIL" | "INCOMPLETE"
    reasons: string[]
    mesh?: { triangles: number; vertices: number; meshDigest: string; pipelineMs: number; execution: Record<string, any>; stats: Record<string, any>; validation: Record<string, any> }
    views: Array<{ id: string; label: string; images: Record<string, string>; metrics?: Record<string, any>; error?: string }>
    totalMs?: number
    diagnostics?: ReturnType<typeof diagnosticSummary>
    diagnosticMs?: number
    visualReview?: string
    investigation?: {
        summary: string[]
        nativeReplay?: { triangles: number; savedGeometryMatches: boolean; droppedRecords: number; unresolvedFirstReasons: Record<string, number> }
        files: Record<string, string>
    }
}

export const escapeMd = (v: unknown) => String(v).replaceAll("|", "\\|").replace(/[\r\n]/g, " ").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "N/A"
const seconds = (v: unknown) => typeof v === "number" ? `${(v / 1000).toFixed(3)} s` : "N/A"
const measurement = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v === 0 ? "0" : v.toPrecision(7) : "N/A"
const coordinates = (p: number[] | null | undefined) => p ? p.map(x => Number.isFinite(x) ? x.toPrecision(9) : String(x)).join(", ") : "N/A"
function topologyStatus(v: Record<string, any> | undefined): string {
    if (!v) return "N/A"
    const states = [v.edgeIncidence, v.vertexLinks, v.faceSegments]
    return states.includes("failed") ? "FAIL" : states.every(s => s === "passed") ? "PASS" : "NOT_CHECKED"
}

function detailedDiagnostics(row: CaptureRow, dir: string): string[] {
    if (!row.mesh) return []
    const { stats: s, validation: v, execution: e } = row.mesh, f = v.featureChains, a = row.diagnostics
    const o = ["", "### What passed, what failed, and what remains unresolved", "",
        "Visual similarity, indexed topology, geometric validity, feature preservation and refinement are separate results. A `FAIL` is not an overall appearance score. Feature audits concern the compiled curve graph; they are not independent proof of a missing physical feature.", "",
        "| Obligation | Result | Evidence / scope |", "| --- | --- | --- |",
        `| Indexed edge incidence | ${v.edgeIncidence ?? "N/A"} | Open ${number(s.openEdges)}; nonmanifold ${number(s.nonManifoldEdges)}; misoriented ${number(s.misorientedEdges)} |`,
        `| Vertex links | ${v.vertexLinks ?? "N/A"} | Nonmanifold vertices ${number(s.nonManifoldVertices)} |`,
        `| Shared-face segments | ${v.faceSegments ?? "N/A"} | Face-audit failures ${number(s.faceAuditFailures)}; boundary violations ${number(s.boundaryViolations)} |`,
        `| Vertex field residuals | ${v.vertexResiduals ?? "N/A"} | Off-surface vertices ${number(v.offSurfaceVertices)}; max residual ${measurement(v.maxVertexResidual)}; configured threshold ${measurement(e.tuning?.surfaceTolMm)}. Field residual is not generally Euclidean distance |`,
        `| Final triangle nondegeneracy | ${v.triangleNondegeneracy ?? "N/A"} | ${number(v.invalidTriangles)} / ${number(row.mesh.triangles)} invalid (${measurement(row.mesh.triangles ? 100 * v.invalidTriangles / row.mesh.triangles : 0)}%); no minimum-area epsilon |`,
        `| Compiled feature chains | ${f?.status ?? "N/A"} | Missing curves ${number(f?.missingCurves)}, missing labeled edges ${number(f?.missingEdges)}, connectivity/degree failures ${number(f?.disconnectedCurves)}, parameter gaps ${number(f?.intervalGaps)} |`,
        `| Feature memberships | ${f?.status ?? "N/A"} | Off-curve ${number(f?.offCurveEdges)}; invalid memberships ${number(f?.invalidMemberships)}; unidentified edges ${number(f?.unidentifiedEdges)} |`,
        `| Unmet refinement / construction criteria | ${v.unresolvedCells > 0 ? "INCOMPLETE" : "See raw status"} | ${number(v.unresolvedCells)} unresolved cells, not that many demonstrated visible defects |`,
        `| Analytic local coverage | ${v.localCoverage?.scope ?? "N/A"} | Certified ${number(v.localCoverage?.certifiedCells)}; transported ${number(v.localCoverage?.transportedCells)}; excluded ${number(v.localCoverage?.excludedCells)}; outside ${number(v.localCoverage?.outsideCells)}. Outside scope alone does not fail this suite |`,
        `| Independent triangle-interior / full-surface coverage | NOT_ESTABLISHED | Vertex checks and image samples do not establish these obligations |`,
        `| Optional quality audit | ${v.quality === null || v.quality === undefined ? "NOT_CHECKED" : "See complete JSON below"} | Audit contacts are not automatically confirmed penetrations |`,
        "", "### Construction, numerical events and cost", "", "| Metric | Value |", "| --- | ---: |"]
    for (const [label, value] of [
        ["Raw exporter ok", e.ok], ["Raw validation status", v.status], ["Components", s.components], ["Euler characteristic per component", s.euler],
        ["Leaves", s.leaves], ["Prepared/final degenerate-cell count", s.degenerateCells], ["Failed cells", s.failedCells],
        ["Feature-cell fallbacks", v.featureFallbackCells], ["Re-refinement rounds", s.reRefineRounds], ["Actual partitions", e.partitions], ["Serial recovery", s.serialRecovery],
        ["Compiled curves", s.featureCurves], ["Edge / corner cells", [s.edgeCells, s.cornerCells]],
        ["Curve projection failures (events)", v.curveProjectionFailures], ["Face projection failures (events)", v.faceProjectionFailures], ["Chord-budget failures", v.chordBudgetFailures],
        ["Unresolved branch paths", v.unresolvedBranchPaths], ["Feature trace counters", v.featureTrace],
        ["Raw mesh vertex/index bytes", row.mesh.vertices * 32 + row.mesh.triangles * 12], ["Peak memory", "Not measured"],
        ["Independent saved-buffer audit ms", row.diagnosticMs],
    ] as Array<[string, unknown]>) o.push(`| ${label} | ${escapeMd(value === undefined ? "N/A" : typeof value === "object" ? JSON.stringify(value) : typeof value === "number" ? number(value) : value)} |`)
    o.push("", "Projection/tracing counters count events and can include rejected supporting candidates; they are not counts of distinct defective output faces.", "", "| Export phase | Kernel-reported ms |", "| --- | ---: |")
    for (const key of ["phaseFeatureMs", "phaseOctreeMs", "phaseContourMs", "phaseCellmeshMs", "phaseAssembleMs", "phaseOctreeDecideMs", "phaseOctreeApplyMs"]) o.push(`| ${key} | ${number(s[key])} |`)
    o.push("", "Subphase timings overlap their parent phase and must not be summed as independent costs.")
    if (a) {
        o.push("", "### Independent audit of the saved float32 artifact", "",
            `[All defect coordinates, connectivity and gap records](${dir}/diagnostics.json). Exact classification agrees with exporter count: **${a.invalidTriangles === v.invalidTriangles ? "yes" : "NO — investigate the discrepancy"}**.`, "",
            `Defect kinds: ${escapeMd(JSON.stringify(a.defectKinds))}. Invalid-face bounds [min, max]: [${coordinates(a.defectBounds)}]. Longest defective face edge: ${measurement(a.longestDefectEdge)} mm. These zero-area faces can be invisible even when their longest edge spans a measurable distance.`, "",
            `A diagnostic exact-position weld followed by removal of invalid faces gives ${number(a.exactPositionWeld.openEdges)} open edges, ${number(a.exactPositionWeld.nonManifoldEdges)} nonmanifold edges, and ${number(a.exactPositionWeld.misorientedEdges)} misoriented edges. Vertices: ${number(a.exactPositionWeld.verticesBefore)} → ${number(a.exactPositionWeld.verticesAfter)}. **This is a what-if geometric audit, not a repair applied to the exported mesh.**`, "",
            `Largest-span defect examples (${a.displayedDefects} of ${a.invalidTriangles}; triangle and vertex IDs are zero-based):`, "",
            "| Triangle | Type | Vertex IDs | Centroid (mm) | Longest edge (mm) | Incident feature IDs |", "| ---: | --- | --- | --- | ---: | --- |")
        for (const d of a.defects) o.push(`| ${d.triangle} | ${d.kind} | ${d.vertices.join(", ")} | ${coordinates(d.centroid)} | ${measurement(d.longestEdge)} | ${d.featureCurves.join(", ") || "None recorded"} |`)
        if (a.pointWitnesses.length) {
            o.push("", "### Required geometric witnesses", "", "These source-pinned points come from the full torture model. Distance is measured against every valid stored triangle, independently of curve labels. The bracket junction was checked against the existing exporter field; this is a local regression witness, not an independent GPU/global-coverage oracle.", "",
                "| Witness | Position (mm) | Nearest surface distance (mm) | Tolerance (mm) | Nearest triangle | Result |", "| --- | --- | ---: | ---: | ---: | --- |")
            for (const w of a.pointWitnesses) o.push(`| ${w.id} | ${coordinates(w.position)} | ${measurement(w.distance)} | ${measurement(w.tolerance)} | ${number(w.triangle)} | ${w.passed ? "PASS" : "FAIL"} |`)
        }
    }
    const issues = f?.issues ?? []
    o.push("", "<details>", `<summary>Complete compiled-feature issue table (${issues.length} records)</summary>`, "",
        "Parameter ranges are curve coordinates, not millimetres. A chord is reported only when both gap endpoints are present in the stored feature edges; it is not the arc length or proof of a hole. Connectivity includes endpoint-degree/branch checks.", "",
        "| Curve | Issue | Parameter range | Gap endpoint chord (mm) | Indexed / exact-position components | Endpoint chord edge coverage |", "| ---: | --- | --- | ---: | --- | --- |")
    for (const i of issues) {
        const c = a?.curveConnectivity.find(c => c.curveId === i.curveId)
        const g = i.kind === "parameterGap" ? a?.parameterGaps.find(g => g.curveId === i.curveId && g.range[0] === i.range[0] && g.range[1] === i.range[1]) : undefined
        const chord = g?.straightSegmentCoverage
        o.push(`| ${i.curveId} | ${escapeMd(i.kind)} | ${coordinates(i.range)} | ${measurement(g?.endpointChord)} | ${c ? `${c.indexedComponents} / ${c.geometricComponents}` : "N/A"} | ${chord ? `${chord.fullyCovered ? "Covered" : "Gaps remain"}; labels ${chord.coveringCurveIds.join(", ") || "none"}` : "N/A"} |`)
    }
    o.push("", "Chord coverage is an exact interval-union check on axis-aligned output edges, excluding invalid faces. It does not prove a curved reference arc is represented. No automatic curve-ID equivalence or repair is inferred.", "", "</details>", "", "<details>", "<summary>Complete settings, validation and phase/refinement records</summary>", "", "```json", JSON.stringify({ tuning: e.tuning, cube: e.cube, paddedBounds: e.paddedBounds, validation: v, octreeRounds: s.octreeRounds }, null, 2), "```", "", "</details>")
    if (row.investigation) {
        o.push("", "### Investigation findings", "", ...row.investigation.summary.map(s => `- ${escapeMd(s)}`), "")
        for (const [label, file] of Object.entries(row.investigation.files)) o.push(`[${escapeMd(label)}](${file})`)
        const replay = row.investigation.nativeReplay
        if (replay) {
            o.push("", `Native replay: ${number(replay.triangles)} triangles; exact equality to the original WASM unoriented triangle multiset: **${replay.savedGeometryMatches ? "yes" : "no"}**; dropped diagnostic records: ${replay.droppedRecords}. Native observations are not relabeled as the original WASM execution.`, "",
                "| Native final unresolved first reason | Cells |", "| --- | ---: |")
            for (const [reason, count] of Object.entries(replay.unresolvedFirstReasons).sort((a, b) => b[1] - a[1])) o.push(`| ${reason} | ${number(count)} |`)
        }
    }
    return o
}

export function classify(row: CaptureRow): void {
    if (["TIMEOUT", "ERROR", "UNSUPPORTED", "NOT_RUN"].includes(row.status) && !row.mesh) return
    const v = row.mesh?.validation
    if (!v || !row.mesh?.execution || typeof row.mesh.execution.ok !== "boolean") {
        row.status = "INCOMPLETE"; row.reasons.push("Required SFCC execution/validation metadata missing"); return
    }
    const failed = ["edgeIncidence", "vertexLinks", "faceSegments", "vertexResiduals", "triangleNondegeneracy"].filter(k => v[k] === "failed")
    if (v.featureChains?.status === "failed") failed.push("featureChains")
    const witnessFailures = row.diagnostics?.pointWitnesses.filter(w => !w.passed) ?? []
    const sfccFailed = v.status === "failed" || failed.length > 0 || v.invalidTriangles > 0
    if (sfccFailed || witnessFailures.length) {
        row.status = "FAIL"
        if (sfccFailed) row.reasons.push(`SFCC validation failed: ${failed.join(", ") || "see raw diagnostics"}`)
    } else {
        row.status = "INCOMPLETE"
        if (v.unresolvedCells > 0) row.reasons.push(`${v.unresolvedCells} unresolved cells`)
        if (row.mesh.execution.ok === false) row.reasons.push("Exporter returned best-effort output (ok=false)")
    }
    row.reasons.push("Independent full-surface coverage and human visual acceptance are not established in milestone 1")
    for (const w of witnessFailures) row.reasons.push(`Required geometric witness ${w.id} misses the mesh by ${measurement(w.distance)} mm (limit ${measurement(w.tolerance)} mm)`)
    if (row.views.some(v => v.error)) row.reasons.push("One or more image/compare operations failed; inspect per-view errors")
    row.reasons = [...new Set(row.reasons)]
}

function picture(view: CaptureRow["views"][number] | undefined, kind: string): string {
    const file = view?.images[kind]
    if (!file) return "Unavailable"
    const thumb = view?.images[`${kind}Thumb`] ?? file
    return `[![${kind}](${thumb})](${file})`
}

export function renderReport(manifest: Record<string, any>, rows: CaptureRow[]): string {
    const out = ["# SDF meshing acceptance — Manim torture models", "",
        `Run: **${escapeMd(manifest.runId)}** · revision **${escapeMd(manifest.commit)}${manifest.dirty ? " (dirty; source manifest retained)" : ""}**`, "",
        `Harness: **${escapeMd(manifest.harnessStatus ?? "RUNNING")}**.${manifest.infrastructureError ? ` Infrastructure error: ${escapeMd(manifest.infrastructureError)}` : ""}`, "",
        "One browser/WASM SFCC export per case; production meshing tuning, simplification disabled. Raw artifacts retain original vertex/feature identities. Images use a separate flat-face-normal display copy, matching the production viewer without moving triangle corners. Export times are single samples, not benchmark medians. Acceptance is separate from successful report generation.", "",
        ...(manifest.replayedFrom ? [`Images were regenerated from saved artifacts in **${escapeMd(manifest.replayedFrom)}**. Counts, SFCC diagnostics and export timings belong to that original capture; no meshing was repeated for this display correction.`, ""] : []),
        ...(manifest.diagnosticRevision ? ["This revision adds saved-buffer diagnostics and investigation records. The original mesh artifacts, images and export measurements are preserved; diagnostic replay results are labeled separately.", ""] : []),
        "Overall acceptance: **NOT PASSED**. Milestone 1 records existing diagnostics and images; independent full-surface coverage, image acceptance thresholds, and human review remain NOT_ESTABLISHED. Baseline comparison: **NOT_COMPARABLE** (first inventory).", "",
        "[Run manifest](manifest.json) · [Structured results](results.json)", "",
        "| Case | SDF reference | Mesh / wireframe | Difference | Triangles | Export time | Acceptance |",
        "| --- | --- | --- | --- | ---: | ---: | --- |"]
    for (const r of rows) {
        const hero = r.views.find(v => v.id === "hero")
        out.push(`| [${escapeMd(r.name)}](#${r.id}) | ${picture(hero, "sdf")} | ${picture(hero, "mesh")} ${hero?.images.wire ? `· [wireframe](${hero.images.wire})` : ""} | ${picture(hero, "diff")} | ${number(r.mesh?.triangles)} | ${r.status === "TIMEOUT" ? "Timed out; see case log" : seconds(r.mesh?.execution.exportMs)} | **${r.status}** |`)
    }
    out.push("", "## Separate acceptance dimensions", "", "| Case | Visual agreement: hero SSIM / pixel difference | Basic topology | Triangle validity | Compiled features | Refinement | Point witnesses | Independent coverage |", "| --- | --- | --- | --- | --- | --- | --- | --- |")
    for (const r of rows) {
        const v = r.mesh?.validation, m = r.views.find(v => v.id === "hero")?.metrics
        const witnesses = r.diagnostics?.pointWitnesses ?? []
        out.push(`| ${r.name} | ${m ? `${number(m.ssim)}% / ${number(m.errorPct)}% (diagnostic only)` : "N/A"} | ${topologyStatus(v)} | ${v?.triangleNondegeneracy ?? "N/A"} | ${v?.featureChains?.status ?? "N/A"} | ${v ? `${number(v.unresolvedCells)} unresolved` : "N/A"} | ${witnesses.length ? witnesses.every(w => w.passed) ? "PASS" : "FAIL" : "NOT_ESTABLISHED"} | NOT_ESTABLISHED |`)
    }
    out.push("", "## Diagnostics", "", "Counts below describe the actual exporter output. N/A means unavailable, not zero. Compiled-curve audits cannot detect curves never discovered. Coverage outside the narrow analytic scope is reported without being treated as a geometry failure.", "",
        "| Case | Components | Open / nonmanifold edges | Invalid triangles | Unresolved cells | Missing curves / gaps | Hero SSIM / differing pixels | Serial recovery |",
        "| --- | ---: | --- | ---: | ---: | --- | --- | --- |")
    for (const r of rows) {
        const s = r.mesh?.stats, v = r.mesh?.validation, m = r.views.find(v => v.id === "hero")?.metrics
        out.push(`| ${r.name} | ${number(s?.components)} | ${number(s?.openEdges)} / ${number(s?.nonManifoldEdges)} | ${number(v?.invalidTriangles)} | ${number(v?.unresolvedCells)} | ${number(v?.featureChains?.missingCurves)} / ${number(v?.featureChains?.intervalGaps)} | ${m ? `${number(m.ssim)}% / ${number(m.pixelDiff)} (${number(m.errorPct)}%)` : "N/A"} | ${typeof s?.serialRecovery === "boolean" ? s.serialRecovery : "N/A"} |`)
    }
    for (const r of rows) {
        const dir = `cases/${r.id}/default`
        out.push("", `<a id="${r.id}"></a>`, `## ${r.name}`, "", `**${r.status}**. ${r.reasons.map(escapeMd).join("; ")}`, "",
            `[Source](${dir}/source.yaml) · [Case record](${dir}/result.json) · [Log](${dir}/log.txt)`, "")
        if (r.mesh) out.push(`Mesh digest: \`${r.mesh.meshDigest}\`. ${number(r.mesh.vertices)} vertices; ${number(r.mesh.triangles)} triangles. Export ${seconds(r.mesh.execution.exportMs)}; transpile/build/export/transfer round trip ${seconds(r.mesh.pipelineMs)}; complete case ${seconds(r.totalMs)}.`, "", `[Raw SFCC stats](${dir}/stats.json) · [Effective settings and cube](${dir}/effective-config.json) · [Artifact hashes](${dir}/artifacts.json)`, "")
        else out.push(`Complete case elapsed: ${seconds(r.totalMs)}. Export limit: ${seconds(manifest.limits?.exportMs)}; capture limit: ${seconds(manifest.limits?.captureMs)}. No completed mesh/count is substituted for the failed export.`, "")
        out.push("| View | SDF | Mesh | Wireframe | Difference | SSIM / pixel difference |", "| --- | --- | --- | --- | --- | --- |")
        for (const v of r.views) out.push(`| ${escapeMd(v.label)} | ${picture(v, "sdf")} | ${picture(v, "mesh")} | ${picture(v, "wire")} | ${picture(v, "diff")} | ${v.metrics ? `${number(v.metrics.ssim)}% / ${number(v.metrics.pixelDiff)} (${number(v.metrics.errorPct)}%)` : escapeMd(v.error ?? "N/A")} |`)
        out.push("", r.visualReview ? `Human feedback: ${escapeMd(r.visualReview)} Image metrics remain diagnostic, not correctness thresholds.` : "Human review: **pending**. Fixed detail cameras are unreviewed; no claim that all features are visible. Image metrics are diagnostic, not correctness thresholds.")
        out.push(...detailedDiagnostics(r, dir))
    }
    out.push("", "## Limits of this inventory", "", "No automatic mesh repair or tuning changes were applied. Geometric bidirectional coverage, intersection classification, independent feature witnesses for all five models, calibrated image thresholds, foreground masks, and repeated timing belong to later milestones. Existing housing/bracket unit fixtures are separate checks and were not substituted for full-scene acceptance here. All scene-reference evaluation uses the application's GPU path.", "")
    return out.join("\n")
}
