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
import { MeshExportCancelledError } from "../mesh-exporter.mjs"
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

/** Timed phases the kernel reports through the progress callback (keep in sync with
 * `SFCC_PHASE_COUNT` in `gcad-wasm/kernel/src/sfcc/pipeline.rs`). The terminal "done"
 * tick arrives with `phaseIndex === SFCC_RS_PHASE_COUNT`. */
const SFCC_RS_PHASE_COUNT = 5

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
        // Serial path (flag off): the single-thread export_sfcc flow.
        await ensureWasmReady()
        const exportFn = export_sfcc
        // Live phase-progress: the kernel calls this synchronously at each phase boundary
        // (feature → octree → contour → cellmesh → assemble → done); we relay it to the
        // worker host via ctx.onProgress. Undefined when nobody is listening → no overhead,
        // byte-identical output. (Partitioned path has no single export_sfcc to hook.)
        const onProgress = ctx.onProgress
        const progressCb = onProgress
            ? (phaseIndex: number, phase: string, elapsedMs: number) =>
                  onProgress({ phaseIndex, phase, totalPhases: SFCC_RS_PHASE_COUNT, elapsedMs })
            : undefined
        // User-cancel: the kernel polls this at coarse checkpoints (octree rounds, contour
        // chunks, phase boundaries) and bails with `cancelled` when it returns true. The
        // flag is a SharedArrayBuffer slot the main thread writes on the Cancel click.
        const cancelFlag = ctx.cancelFlag
        const cancelCb = cancelFlag ? () => Atomics.load(cancelFlag, 0) !== 0 : undefined
        const t0 = performance.now()
        result = exportFn(sceneJson, tuningJson, minX, minY, minZ, size, progressCb, cancelCb)
        elapsedMs = performance.now() - t0
        if (result.cancelled) {
            result.free()
            throw new MeshExportCancelledError()
        }
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
