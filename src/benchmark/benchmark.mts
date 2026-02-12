import { vec3 } from "../vecmat/vector.mjs"
import type { CameraSettings, PreviewSettings } from "../storage/settings.mjs"
import type { CameraState } from "../controls/camera-controller.mjs"
import { SDFRenderer } from "../sdf.mjs"

// ---------------------------------------------------------------------------
// Benchmark suite types
// ---------------------------------------------------------------------------

export interface BenchmarkCase {
    /** Document/sketch name */
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

const BENCHMARK_STORAGE_KEY = "benchmark"

const BENCHMARK_WIDTH = 800
const BENCHMARK_HEIGHT = 600

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export function loadBenchmarkSuite(): BenchmarkSuite {
    const raw = localStorage.getItem(BENCHMARK_STORAGE_KEY)
    if (!raw) return []
    try {
        return JSON.parse(raw) as BenchmarkSuite
    } catch {
        return []
    }
}

export function saveBenchmarkSuite(suite: BenchmarkSuite): void {
    localStorage.setItem(BENCHMARK_STORAGE_KEY, JSON.stringify(suite))
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

/** Create a hidden host element with canvas for offscreen benchmarking */
function createOffscreenHost(width: number, height: number): HTMLElement & { canvas: HTMLCanvasElement } {
    const host = document.createElement("div")
    host.style.cssText =
        "position:fixed;left:-9999px;top:0;width:" + width + "px;height:" + height + "px;pointer-events:none"
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    host.appendChild(canvas)
    ;(host as HTMLElement & { canvas: HTMLCanvasElement }).canvas = canvas
    document.body.appendChild(host)
    return host as HTMLElement & { canvas: HTMLCanvasElement }
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
 */
export async function runBenchmarkSuite(suite: BenchmarkSuite, frameCount = 100): Promise<BenchmarkCaseResult[]> {
    const results: BenchmarkCaseResult[] = []

    if (suite.length === 0) {
        return results
    }

    const host = createOffscreenHost(BENCHMARK_WIDTH, BENCHMARK_HEIGHT)
    const renderer = new SDFRenderer(host as import("../components/preview-window.mjs").PreviewWindow, null)

    try {
        await renderer.ready()

        // Wait for ResizeObserver to set dimensions on the offscreen host
        await new Promise<void>(resolve => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        })

        for (const benchCase of suite) {
            try {
                renderer.build(benchCase.source)
                renderer.controls.applyState(cameraStateFromSettings(benchCase.camera), { emit: false })
                renderer.xrayMode = benchCase.preview.xrayMode
                renderer.beamEnabled = benchCase.preview.beamOptimization
                renderer.cameraOptimization = benchCase.preview.cameraOptimization

                const result = await renderer.benchmark(frameCount, true)
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
