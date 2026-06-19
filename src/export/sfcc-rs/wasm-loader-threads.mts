/**
 * Lazy, once-per-worker loader for the THREADED gcad-wasm SFCC kernel (M6b).
 *
 * This mirrors `wasm-loader.mts` but targets the `pkg-threads/` artifact — the
 * wasm-bindgen-rayon build (`--features threads`, `-Zbuild-std`,
 * `+atomics,+bulk-memory`) that ships a shared `WebAssembly.Memory` plus the
 * rayon Web Worker pool glue (`snippets/.../workerHelpers.js`).
 *
 * It is loaded ONLY behind the `sfccThreads` flag (see `render-worker.mts`); the
 * default render path stays on the single-thread `pkg/` loader and never imports
 * this module. Keeping the two loaders separate means the threaded artifact (and
 * its worker-spawning glue) is only pulled into the bundle when the flag wires it
 * in — the non-threaded build is byte-identical to before.
 *
 * `initThreadPool` must be awaited ONCE at worker start before any rayon call;
 * it self-spawns `navigator.hardwareConcurrency` Web Workers that share this
 * module's memory via SharedArrayBuffer. That spawn is the nested-worker risk the
 * M6b smoke retires: these workers are created from INSIDE the render worker.
 */

import init, { export_sfcc, initThreadPool, par_smoke, version } from "../../../gcad-wasm/wasm/pkg-threads/gcad_wasm.js"
import wasmUrl from "../../../gcad-wasm/wasm/pkg-threads/gcad_wasm_bg.wasm"

let ready: Promise<void> | null = null

/**
 * Initialize the threaded wasm module + the rayon thread pool exactly once.
 * `numThreads` defaults to the hardware concurrency reported by the worker's
 * navigator. Idempotent across calls (the pool is built only on the first await).
 */
export async function ensureThreadedWasmReady(numThreads?: number): Promise<void> {
    if (!ready) {
        const hw = typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 0
        const threads = numThreads ?? (hw || 1)
        ready = init(wasmUrl as unknown as string)
            .then(() => initThreadPool(threads))
            .then(() => undefined)
    }
    return ready
}

// `export_sfcc` here runs the rayon-PARALLELIZED refine frontier
// (classifyCellFeatures) on the pool spawned by `ensureThreadedWasmReady`. The
// mesh is byte-identical to the single-thread `pkg/` export (M6d determinism
// gate); only the wall-clock differs. The M6d exporter routes to this when the
// `sfccThreads` flag is on, falling back to the single-thread loader otherwise.
export { export_sfcc, initThreadPool, par_smoke, version }
