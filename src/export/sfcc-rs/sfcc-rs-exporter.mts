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
import {
    ensureWasmReady,
    export_sfcc,
    sfcc_worker_prepare,
    sfcc_worker_merge,
} from "./wasm-loader.mjs"
import { SfccPartitionPool } from "./sfcc-partition-pool.mjs"
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

/**
 * Slice 5: the `sfccPartitions=N` flag (forwarded onto the render-worker URL by
 * `src/sdf.mts`) routes the Rust SFCC export through a pool of N separate (non-atomics)
 * `pkg/` wasm instances in module workers. Main runs `sfcc_worker_prepare` once (the
 * expensive ~60% octree decision), scatters N Morton partitions, then `sfcc_worker_merge`
 * recombines the partials into the same `SfccExportResult` shape as `export_sfcc`. The
 * mesh is identical to the serial path (correctness gate). Default (flag off): N=1, the
 * untouched serial `export_sfcc` path.
 */
function partitionsRequested(): number {
    try {
        const raw = new URL(self.location.href).searchParams.get("sfccPartitions")
        if (!raw) return 1
        const n = Math.floor(Number(raw))
        return Number.isFinite(n) && n >= 1 ? n : 1
    } catch {
        return 1
    }
}

// Warm, module-scoped partition pool — reused across export calls. Rebuilt only when the
// requested partition count changes (or the first call).
let warmPool: SfccPartitionPool | null = null
let warmPoolCount = 0

function getOrCreatePartitionPool(count: number): SfccPartitionPool {
    if (warmPool && warmPoolCount === count) return warmPool
    if (warmPool) warmPool.destroy()
    // `import.meta.url` here resolves to the render-worker bundle; the partition worker is
    // emitted at its source-tree path under dist (mirrors iso-qef-worker URL formation).
    const workerUrl = new URL("./export/sfcc-rs/partition-worker.js", import.meta.url)
    warmPool = new SfccPartitionPool({ workerUrl, workerCount: count })
    warmPoolCount = count
    return warmPool
}

async function runSfccRs(ctx: MeshExportContext, tuning: SfccTuning): Promise<MeshData> {
    // Serialize the live scene to the boundary shape (throws on unsupported nodes,
    // mirroring SfccUnsupportedError — the Rust side rejects the same set).
    const sceneJson = serializeSceneToBridgeJson(ctx.scene.root)
    const tuningJson = JSON.stringify(tuning)
    const cube = ctx.worldBoundsCube()
    const minX = cube.min[0]
    const minY = cube.min[1]
    const minZ = cube.min[2]
    const size = cube.max[0] - cube.min[0]

    const partitions = partitionsRequested()

    let result: ReturnType<typeof export_sfcc>
    let elapsedMs: number
    let threaded = false
    let partitionsUsed = 1

    if (partitions > 1) {
        // Partitioned path: prepare once, scatter N Morton groups across the warm pool,
        // merge the partials. Same SfccExportResult shape as export_sfcc.
        await ensureWasmReady()
        const t0 = performance.now()
        const leaves = sfcc_worker_prepare(sceneJson, tuningJson, minX, minY, minZ, size)
        const pool = getOrCreatePartitionPool(partitions)
        const partials = await pool.meshAll({
            sceneJson,
            tuningJson,
            cube,
            leaves,
            count: partitions,
        })
        result = sfcc_worker_merge(sceneJson, tuningJson, minX, minY, minZ, size, partials)
        elapsedMs = performance.now() - t0
        partitionsUsed = partitions
    } else {
        // Serial path (flag off): byte-identical to the original export_sfcc flow.
        const { fn: exportFn, threaded: t } = await resolveExportFn()
        threaded = t
        const t0 = performance.now()
        result = exportFn(sceneJson, tuningJson, minX, minY, minZ, size)
        elapsedMs = performance.now() - t0
    }

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
        partitions: partitionsUsed,
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
