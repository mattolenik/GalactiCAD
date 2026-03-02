import { vec3 } from "../vecmat/vector.mjs"
import type { CameraSettings, PreviewSettings } from "../storage/settings.mjs"
import type { CameraState } from "../controls/camera-controller.mjs"
import { SDFRenderer } from "../sdf.mjs"
import { db } from "../storage/db.mjs"

// ---------------------------------------------------------------------------
// Benchmark suite types
// ---------------------------------------------------------------------------

export interface BenchmarkCase {
    /** Document/scene name */
    name: string
    /** Scene source code */
    source: string
    /** Camera settings (position, translation, zoom, rotation) */
    camera: CameraSettings
    /** Preview settings (xray, cameraOptimization, beamOptimization) */
    preview: PreviewSettings
}

export interface BenchmarkResult {
    totalTime: number
    averageFrameTime: number
    minFrameTime: number
    maxFrameTime: number
    framesPerSecond: number
    frameTimes: number[]
    /** Present when the benchmark failed */
    error?: string
}

export interface BenchmarkCaseResult {
    name: string
    result: BenchmarkResult
}

export type BenchmarkSuite = BenchmarkCase[]

const BENCHMARK_WIDTH = 800
const BENCHMARK_HEIGHT = 600
/** Duration in seconds to render each benchmark case (time-based, not frame count). */
const BENCHMARK_DURATION_SECONDS = 5

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export async function loadBenchmarkSuite(): Promise<BenchmarkSuite> {
    const row = await db.preferences.get("benchmark")
    const value = row?.value
    if (Array.isArray(value)) return value as BenchmarkSuite
    return []
}

export async function saveBenchmarkSuite(suite: BenchmarkSuite): Promise<void> {
    await db.preferences.put({ key: "benchmark", value: suite })
}

/** Format benchmark results as HTML table */
export function formatBenchmarkResultsHtml(results: BenchmarkCaseResult[]): string {
    const rows = results
        .map(r => {
            if (r.result.error) {
                return `<tr><td>${escapeHtml(r.name)}</td><td colspan="4" style="color:#f88">${escapeHtml(r.result.error)}</td></tr>`
            }
            return `<tr>
                <td>${escapeHtml(r.name)}</td>
                <td>${r.result.averageFrameTime.toFixed(2)}</td>
                <td>${r.result.framesPerSecond.toFixed(2)}</td>
                <td>${r.result.minFrameTime.toFixed(2)}</td>
                <td>${r.result.maxFrameTime.toFixed(2)}</td>
            </tr>`
        })
        .join("")
    return `
        <table>
            <thead><tr><th>Document</th><th>Avg (ms)</th><th>FPS</th><th>Min (ms)</th><th>Max (ms)</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>`
}

function escapeHtml(text: string): string {
    const div = document.createElement("div")
    div.textContent = text
    return div.innerHTML
}

// ---------------------------------------------------------------------------
// Offscreen host creation
// ---------------------------------------------------------------------------

/** Minimal host for offscreen benchmarking. Implements PreviewWindow interface with no-op stubs. */
function createOffscreenHost(width: number, height: number): import("../components/preview-window.mjs").PreviewWindow {
    const host = document.createElement("div") as unknown as HTMLElement & {
        canvas: HTMLCanvasElement
        updateSelectionInfo: (info: import("../components/preview-window.mjs").SelectionInfo) => void
        setSelectionInfoLeft: (offsetPx: number) => void
        updateFPS: (fps: number) => void
    }
    host.style.cssText =
        "position:fixed;left:-9999px;top:0;width:" + width + "px;height:" + height + "px;pointer-events:none"
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    host.appendChild(canvas)
    host.canvas = canvas
    host.updateSelectionInfo = () => {}
    host.setSelectionInfoLeft = () => {}
    host.updateFPS = () => {}
    document.body.appendChild(host)
    return host as unknown as import("../components/preview-window.mjs").PreviewWindow
}

function cameraStateFromSettings(cam: CameraSettings): CameraState {
    return {
        rotation: cam.rotation,
        zoom: cam.zoom,
        translation: vec3(cam.translation[0], cam.translation[1], cam.translation[2]),
    }
}

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------

/**
 * Run the benchmark suite using an offscreen renderer.
 * Returns results keyed by document name.
 * Renders each case for a fixed duration (not a fixed frame count). FPS = frames / duration.
 * @param durationSeconds - How long to render each case (default BENCHMARK_DURATION_SECONDS).
 * @param viewport - When provided, uses these dimensions for the offscreen canvas. Otherwise 800×600.
 */
export async function runBenchmarkSuite(
    suite: BenchmarkSuite,
    durationSeconds = BENCHMARK_DURATION_SECONDS,
    viewport?: { width: number; height: number }
): Promise<BenchmarkCaseResult[]> {
    const results: BenchmarkCaseResult[] = []

    if (suite.length === 0) {
        return results
    }

    const width = viewport?.width ?? BENCHMARK_WIDTH
    const height = viewport?.height ?? BENCHMARK_HEIGHT
    const host = createOffscreenHost(width, height)
    const renderer = new SDFRenderer(host, null)

    try {
        await renderer.ready()

        // Wait for ResizeObserver to set dimensions on the offscreen host
        await new Promise<void>(resolve => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        })

        for (const benchCase of suite) {
            try {
                await renderer.build(benchCase.source)
                renderer.controls.applyState(cameraStateFromSettings(benchCase.camera), { emit: false })
                renderer.xrayMode = benchCase.preview.xrayMode
                renderer.beamEnabled = benchCase.preview.beamOptimization
                renderer.cameraOptimization = benchCase.preview.cameraOptimization

                const result = await renderer.benchmark(durationSeconds, true)
                results.push({ name: benchCase.name, result })
            } catch (err) {
                const errorMsg = err instanceof Error ? err.message : String(err)
                results.push({
                    name: benchCase.name,
                    result: {
                        totalTime: 0,
                        averageFrameTime: 0,
                        minFrameTime: 0,
                        maxFrameTime: 0,
                        framesPerSecond: 0,
                        frameTimes: [],
                        error: errorMsg,
                    },
                })
            }
        }
    } finally {
        host.remove()
    }

    return results
}
