/**
 * SFCC-rs — the Rust/WASM SFCC exporter (M5).
 *
 * Identical algorithm + tuning to the TS `sfcc` exporter, but the meshing runs in
 * the gcad-wasm Rust kernel across the WASM boundary. It serializes the live scene
 * (`ctx.scene.root`) to the `BridgeNode` JSON, hands it + the tuning to
 * `export_sfcc`, and returns the OWNED verts/tris as `MeshData`. Registered
 * ALONGSIDE the TS `sfcc` (not replacing it — M7 is the cutover), so both can be
 * compared head-to-head behind the Dev Tools exporter dropdown.
 */

import type { MeshExportContext, MeshExporter } from "../mesh-exporter.mjs"
import type { MeshData } from "../export.mjs"
import { DEFAULT_SFCC_TUNING, normalizeSfccTuning, type SfccTuning } from "../sfcc/sfcc-tuning.mjs"
import { serializeSceneToBridgeJson } from "./scene-bridge.mjs"
import { ensureWasmReady, export_sfcc } from "./wasm-loader.mjs"
import { log } from "../../logging/debug-log.mjs"

export const SFCC_RS_DISPLAY_NAME = "SFCC (Rust/WASM)"

/**
 * M6d: the `sfccThreads` flag (forwarded onto the render-worker URL by
 * `src/sdf.mts`) routes the Rust SFCC export through the THREADED `pkg-threads/`
 * artifact, whose `export_sfcc` runs the rayon-parallelized refine frontier
 * (classifyCellFeatures). The mesh is byte-identical to the single-thread path
 * (M6d determinism gate) — only the wall-clock changes. Default (flag off):
 * single-thread `pkg/`, untouched. crossOriginIsolated must hold for the pool to
 * spawn; if anything in the threaded path throws we fall back to single-thread.
 */
function threadsRequested(): boolean {
    try {
        return new URL(self.location.href).searchParams.has("sfccThreads")
    } catch {
        return false
    }
}

/** Resolve the export entry: threaded (parallel refine) when the flag is on and
 * cross-origin isolation is available, else the single-thread path. */
async function resolveExportFn(): Promise<{ fn: typeof export_sfcc; threaded: boolean }> {
    if (threadsRequested() && typeof crossOriginIsolated !== "undefined" && crossOriginIsolated) {
        try {
            const m = await import("./wasm-loader-threads.mjs")
            await m.ensureThreadedWasmReady()
            return { fn: m.export_sfcc as typeof export_sfcc, threaded: true }
        } catch (e) {
            log("MeshExport").warn("sfcc-rs threaded path unavailable; falling back to single-thread", {
                error: e instanceof Error ? e.message : String(e),
            })
        }
    }
    await ensureWasmReady()
    return { fn: export_sfcc, threaded: false }
}

async function runSfccRs(ctx: MeshExportContext, tuning: SfccTuning): Promise<MeshData> {
    const { fn: exportFn, threaded } = await resolveExportFn()

    // Serialize the live scene to the boundary shape (throws on unsupported nodes,
    // mirroring SfccUnsupportedError — the Rust side rejects the same set).
    const sceneJson = serializeSceneToBridgeJson(ctx.scene.root)
    const tuningJson = JSON.stringify(tuning)

    const cube = ctx.worldBoundsCube()
    const t0 = performance.now()
    const result = exportFn(
        sceneJson,
        tuningJson,
        cube.min[0],
        cube.min[1],
        cube.min[2],
        cube.max[0] - cube.min[0],
    )
    const elapsedMs = performance.now() - t0

    let stats: Record<string, unknown> = {}
    try {
        stats = JSON.parse(result.stats_json)
    } catch {
        /* stats are advisory; ignore parse failures */
    }

    // Copy out of the wasm-owned getters into fresh JS-owned buffers on plain
    // ArrayBuffers (the MeshData contract), then release the wasm result.
    const verts = new Float32Array(result.verts)
    const tris = new Uint32Array(result.tris)
    const ok = result.ok
    result.free()

    if (!ok) {
        console.warn("[sfcc-rs] certification failed", stats)
    }
    log("MeshExport").info("sfcc-rs stats", {
        ...stats,
        exportMs: Math.round(elapsedMs),
        threaded,
        threads: threaded && typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 1,
    })

    const mesh: MeshData = { verts, tris }
    mesh.debug = {
        sfcc: {
            stats: stats as Record<string, number | number[]>,
            // The wasm boundary doesn't surface failed-cell overlays (debug-only);
            // an empty buffer satisfies the MeshData contract.
            failedCellBoxes: new Float32Array(0),
        },
    }
    return mesh
}

export const sfccRsExporter: MeshExporter<SfccTuning> = {
    displayName: SFCC_RS_DISPLAY_NAME,
    defaultTuning: DEFAULT_SFCC_TUNING,
    normalizeTuning: normalizeSfccTuning,
    run: runSfccRs,
}
