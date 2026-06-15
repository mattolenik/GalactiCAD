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

async function runSfccRs(ctx: MeshExportContext, tuning: SfccTuning): Promise<MeshData> {
    await ensureWasmReady()

    // Serialize the live scene to the boundary shape (throws on unsupported nodes,
    // mirroring SfccUnsupportedError — the Rust side rejects the same set).
    const sceneJson = serializeSceneToBridgeJson(ctx.scene.root)
    const tuningJson = JSON.stringify(tuning)

    const cube = ctx.worldBoundsCube()
    const t0 = performance.now()
    const result = export_sfcc(
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
    log("MeshExport").info("sfcc-rs stats", { ...stats, exportMs: Math.round(elapsedMs) })

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
