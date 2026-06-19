/**
 * M6b nested-worker rayon smoke (the research-flagged day-1 risk).
 *
 * Behind the `sfccThreads` flag, this runs ONCE at render-worker startup to prove
 * the rayon Web Worker pool can spawn + run from INSIDE the render worker:
 *   1. confirm `crossOriginIsolated === true` (COOP/COEP + SharedArrayBuffer),
 *   2. `await initThreadPool(hardwareConcurrency)` — spawns the nested pool workers
 *      that share this worker's WebAssembly.Memory via SharedArrayBuffer,
 *   3. call `par_smoke(n)` (a rayon `par_iter().map(i*i).sum()`) and check it
 *      equals the closed-form Σ i² so we know work actually ran on the pool.
 *
 * Results go to the dev log (`SfccThreads` module, surfaced via `/_logs` /
 * agentcli) so the gate can be verified headlessly. The default (flag-off) render
 * path never imports this module — the threaded artifact only loads here.
 */

import { log } from "../../logging/debug-log.mjs"

/** Σ_{i=0}^{n-1} i² — the closed-form oracle for `par_smoke(n)`. */
function sumOfSquares(n: number): bigint {
    const bn = BigInt(n)
    // (n-1)·n·(2n-1)/6, evaluated over [0, n).
    return ((bn - 1n) * bn * (2n * bn - 1n)) / 6n
}

export interface ThreadsSmokeResult {
    ran: boolean
    crossOriginIsolated: boolean
    threads: number
    n: number
    parSmoke: string
    expected: string
    ok: boolean
    error?: string
}

/**
 * Run the nested-worker rayon smoke. Idempotent across calls (the threaded module
 * + pool init are themselves once-per-worker). `n` is the par_iter element count.
 */
export async function runThreadsSmoke(n = 100_000): Promise<ThreadsSmokeResult> {
    const coi = typeof crossOriginIsolated !== "undefined" && crossOriginIsolated
    const threads = (typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 0) || 1
    const expected = sumOfSquares(n)

    const result: ThreadsSmokeResult = {
        ran: false,
        crossOriginIsolated: coi,
        threads,
        n,
        parSmoke: "0",
        expected: expected.toString(),
        ok: false,
    }

    log("SfccThreads").info("nested-worker rayon smoke: starting", { crossOriginIsolated: coi, threads, n })

    if (!coi) {
        result.error = "crossOriginIsolated === false — SharedArrayBuffer/atomics unavailable; rayon pool cannot spawn"
        log("SfccThreads").error(result.error)
        return result
    }

    try {
        // Lazy import so the threaded artifact + its worker-spawning glue are only
        // pulled in when the flag is on (keeps the default bundle path untouched).
        const { ensureThreadedWasmReady, par_smoke } = await import("./wasm-loader-threads.mjs")
        await ensureThreadedWasmReady(threads)
        const value = par_smoke(n) // BigInt (u64 across the wasm boundary).
        result.ran = true
        result.parSmoke = value.toString()
        result.ok = value === expected
        if (result.ok) {
            log("SfccThreads").info("nested-worker rayon smoke: PASS — pool spawned + ran inside render worker", {
                threads,
                n,
                parSmoke: result.parSmoke,
            })
        } else {
            log("SfccThreads").error("nested-worker rayon smoke: par_smoke MISMATCH", {
                got: result.parSmoke,
                expected: result.expected,
            })
        }
    } catch (e) {
        result.error = e instanceof Error ? e.message : String(e)
        log("SfccThreads").error("nested-worker rayon smoke: threw", result.error)
    }

    return result
}
