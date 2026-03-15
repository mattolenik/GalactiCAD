/**
 * Shared memory layout for main thread <-> render worker communication.
 * Replaces per-frame postMessage for render payload and FPS.
 */

import type { CameraState } from "./controls/camera-controller.mjs"
import type { RenderSelectionState, RenderViewSettings, SelectedEdgePayload } from "./render-worker-protocol.mjs"
import type { MainToWorkerMessage } from "./render-worker-protocol.mjs"

/** FPS scale factor: stored as fps * FPS_SCALE for integer storage */
export const FPS_SCALE = 100

/** Edge layout matches render-worker-core SELECTED_EDGE_SIZE */
const SELECTED_EDGE_SIZE = 80
const SELECTED_EDGES_COUNT = 16

// ---------------------------------------------------------------------------
// Layout offsets (bytes)
// ---------------------------------------------------------------------------

const O_VERSION = 0
const O_FPS = 4
const O_FPS_VERSION = 8
const O_FULL_WIDTH = 12
const O_FULL_HEIGHT = 16
const O_RESOLUTION_SCALE = 20
const O_VIEW_TRANSFORM = 24
const O_CAMERA_POSITION = 88
const O_CAMERA_RES = 100
const O_ZOOM = 108
const O_QUATERNION = 112
const O_TRANSLATION = 128
const O_VIEW_CENTER = 140
const O_VIEW_SETTINGS = 148
const O_OUTLINE_THICKNESS = 152
const O_OUTLINE_COLOR = 156
const O_SELECTED_OBJECT_IDS = 168
const O_SELECTED_EDGES_HEADER = 4264
const O_SELECTED_EDGES_DATA = 4280
const O_HOVERED_EDGES_HEADER = 5560
const O_HOVERED_EDGES_DATA = 5576
const O_HOVERED_OBJECT_ID = 6856

const SELECTED_OBJECT_IDS_SIZE = 1024 * 4 // 4096 bytes
const EDGES_HEADER_SIZE = 16
const EDGES_DATA_SIZE = SELECTED_EDGES_COUNT * SELECTED_EDGE_SIZE // 1280

/** Total buffer size in bytes */
export const SHARED_RENDER_BUFFER_SIZE = O_HOVERED_OBJECT_ID + 4

/**
 * Layout constants for hot-path SAB reads (worker). Use these to read directly from
 * typed-array views without rebuilding a full payload object.
 */
export const SAB_LAYOUT = {
    O_VIEW_TRANSFORM,
    O_CAMERA_POSITION,
    O_CAMERA_RES,
    O_ZOOM,
    O_VIEW_CENTER,
    O_VIEW_SETTINGS,
    O_OUTLINE_THICKNESS,
    O_OUTLINE_COLOR,
    O_SELECTED_OBJECT_IDS,
    O_SELECTED_EDGES_HEADER,
    O_HOVERED_EDGES_HEADER,
    O_RESOLUTION_SCALE,
    SELECTED_OBJECT_IDS_SIZE,
    SELECTED_EDGES_TOTAL: EDGES_HEADER_SIZE + EDGES_DATA_SIZE,
} as const

/**
 * Read selection state from SAB. Allocates; use only for event handlers (hover) that need
 * the full selection structure, not on the hot render path.
 */
export function readSelectionStateFromSAB(buffer: SharedArrayBuffer): RenderSelectionState {
    const u32 = new Uint32Array(buffer)
    const selectedObjectIds: number[] = []
    const selIds = new Uint32Array(buffer, O_SELECTED_OBJECT_IDS, 1024)
    for (let i = 0; i < 1024; i++) {
        if (selIds[i]) selectedObjectIds.push(i)
    }
    const selectedEdges = readEdgesFromBuffer(buffer, O_SELECTED_EDGES_HEADER, O_SELECTED_EDGES_DATA, 6, 0.02)
    const hoveredEdges = readEdgesFromBuffer(buffer, O_HOVERED_EDGES_HEADER, O_HOVERED_EDGES_DATA, 6, 0.02)
    const hoveredObjectId = u32[O_HOVERED_OBJECT_ID / 4]
    return { selectedObjectIds, selectedEdges, hoveredObjectId, hoveredEdges }
}

// ---------------------------------------------------------------------------
// Main thread: write render payload to shared buffer
// ---------------------------------------------------------------------------

export function writeRenderPayload(
    buffer: SharedArrayBuffer,
    payload: Extract<MainToWorkerMessage, { type: "render" }>,
    fullWidth: number,
    fullHeight: number,
    version: number
): void {
    const u32 = new Uint32Array(buffer)
    const f32 = new Float32Array(buffer)

    u32[O_FULL_WIDTH / 4] = fullWidth
    u32[O_FULL_HEIGHT / 4] = fullHeight
    f32[O_RESOLUTION_SCALE / 4] = payload.resolutionScale

    f32.set(payload.viewTransform, O_VIEW_TRANSFORM / 4)
    f32[O_CAMERA_POSITION / 4] = payload.cameraPosition[0]
    f32[O_CAMERA_POSITION / 4 + 1] = payload.cameraPosition[1]
    f32[O_CAMERA_POSITION / 4 + 2] = payload.cameraPosition[2]
    f32[O_CAMERA_RES / 4] = payload.cameraRes[0]
    f32[O_CAMERA_RES / 4 + 1] = payload.cameraRes[1]

    const cam = payload.cameraState
    f32[O_ZOOM / 4] = cam.zoom
    f32.set(cam.rotation, O_QUATERNION / 4)
    f32[O_TRANSLATION / 4] = cam.translation.x
    f32[O_TRANSLATION / 4 + 1] = cam.translation.y
    f32[O_TRANSLATION / 4 + 2] = cam.translation.z

    f32[O_VIEW_CENTER / 4] = payload.viewCenter[0]
    f32[O_VIEW_CENTER / 4 + 1] = payload.viewCenter[1]

    const vs = payload.viewSettings
    const packed =
        (vs.xrayMode ? 1 : 0) |
        (vs.beamEnabled ? 2 : 0) |
        (vs.selectionMode << 2) |
        (vs.outlineMode << 5)
    u32[O_VIEW_SETTINGS / 4] = packed
    u32[O_OUTLINE_THICKNESS / 4] = vs.outlineThickness
    f32.set(vs.outlineColor, O_OUTLINE_COLOR / 4)

    const sel = payload.selectionState
    const selIds = new Uint32Array(buffer, O_SELECTED_OBJECT_IDS, 1024)
    selIds.fill(0)
    for (const id of sel.selectedObjectIds) {
        selIds[id] = 1
    }

    writeEdgesToBuffer(buffer, O_SELECTED_EDGES_HEADER, O_SELECTED_EDGES_DATA, sel.selectedEdges, 6, 0.02)
    writeEdgesToBuffer(buffer, O_HOVERED_EDGES_HEADER, O_HOVERED_EDGES_DATA, sel.hoveredEdges, 6, 0.02)
    u32[O_HOVERED_OBJECT_ID / 4] = sel.hoveredObjectId

    Atomics.store(u32, O_VERSION / 4, version)
}

function writeEdgesToBuffer(
    buffer: SharedArrayBuffer,
    headerOffset: number,
    dataOffset: number,
    edges: SelectedEdgePayload[],
    defaultLineWidth: number,
    defaultEpsilon: number
): void {
    const u32 = new Uint32Array(buffer)
    const f32 = new Float32Array(buffer)
    const count = Math.min(edges.length, SELECTED_EDGES_COUNT)
    u32[headerOffset / 4] = count
    for (let i = 0; i < count; i++) {
        const e = edges[i]
        const base = dataOffset / 4 + i * (SELECTED_EDGE_SIZE / 4)
        u32[base] = e.kind
        u32[base + 1] = e.primaryId
        u32[base + 2] = e.secondaryId
        u32[base + 3] = e.featureA
        u32[base + 4] = e.opType
        f32[base + 5] = e.lineWidthPx ?? defaultLineWidth
        f32[base + 6] = e.epsilon ?? defaultEpsilon
        const sp = e.seedPoint ?? [0, 0, 0]
        f32[base + 8] = sp[0]
        f32[base + 9] = sp[1]
        f32[base + 10] = sp[2]
        const st = e.seedTangent ?? [0, 0, 0]
        f32[base + 12] = st[0]
        f32[base + 13] = st[1]
        f32[base + 14] = st[2]
        const sn = e.seedNormal ?? [0, 0, 0]
        f32[base + 16] = sn[0]
        f32[base + 17] = sn[1]
        f32[base + 18] = sn[2]
    }
}

// ---------------------------------------------------------------------------
// Worker: read render payload from shared buffer -> message-like object
// ---------------------------------------------------------------------------

export function readRenderPayload(buffer: SharedArrayBuffer): Extract<MainToWorkerMessage, { type: "render" }> {
    const u32 = new Uint32Array(buffer)
    const f32 = new Float32Array(buffer)

    const packed = u32[O_VIEW_SETTINGS / 4]
    const viewSettings: RenderViewSettings = {
        xrayMode: (packed & 1) !== 0,
        beamEnabled: (packed & 2) !== 0,
        selectionMode: (packed >> 2) & 7,
        outlineMode: (packed >> 5) & 3,
        outlineThickness: u32[O_OUTLINE_THICKNESS / 4],
        outlineColor: [f32[O_OUTLINE_COLOR / 4], f32[O_OUTLINE_COLOR / 4 + 1], f32[O_OUTLINE_COLOR / 4 + 2]],
    }

    const selectedObjectIds: number[] = []
    const selIds = new Uint32Array(buffer, O_SELECTED_OBJECT_IDS, 1024)
    for (let i = 0; i < 1024; i++) {
        if (selIds[i]) selectedObjectIds.push(i)
    }

    const selectedEdges = readEdgesFromBuffer(buffer, O_SELECTED_EDGES_HEADER, O_SELECTED_EDGES_DATA, 6, 0.02)
    const hoveredEdges = readEdgesFromBuffer(buffer, O_HOVERED_EDGES_HEADER, O_HOVERED_EDGES_DATA, 6, 0.02)
    const hoveredObjectId = u32[O_HOVERED_OBJECT_ID / 4]

    const cameraState: CameraState = {
        rotation: [f32[O_QUATERNION / 4], f32[O_QUATERNION / 4 + 1], f32[O_QUATERNION / 4 + 2], f32[O_QUATERNION / 4 + 3]],
        zoom: f32[O_ZOOM / 4],
        translation: { x: f32[O_TRANSLATION / 4], y: f32[O_TRANSLATION / 4 + 1], z: f32[O_TRANSLATION / 4 + 2] } as CameraState["translation"],
    }

    const viewTransform = new Float32Array(16)
    viewTransform.set(new Float32Array(buffer, O_VIEW_TRANSFORM, 16))

    const selectionState: RenderSelectionState = {
        selectedObjectIds,
        selectedEdges,
        hoveredObjectId,
        hoveredEdges,
    }

    return {
        type: "render",
        cameraState,
        viewTransform,
        cameraPosition: [f32[O_CAMERA_POSITION / 4], f32[O_CAMERA_POSITION / 4 + 1], f32[O_CAMERA_POSITION / 4 + 2]],
        cameraRes: [f32[O_CAMERA_RES / 4], f32[O_CAMERA_RES / 4 + 1]],
        selectionState,
        viewSettings,
        viewCenter: [f32[O_VIEW_CENTER / 4], f32[O_VIEW_CENTER / 4 + 1]],
        resolutionScale: f32[O_RESOLUTION_SCALE / 4],
    }
}

function readEdgesFromBuffer(
    buffer: SharedArrayBuffer,
    headerOffset: number,
    dataOffset: number,
    defaultLineWidth: number,
    defaultEpsilon: number
): SelectedEdgePayload[] {
    const u32 = new Uint32Array(buffer)
    const f32 = new Float32Array(buffer)
    const count = u32[headerOffset / 4]
    const result: SelectedEdgePayload[] = []
    for (let i = 0; i < Math.min(count, SELECTED_EDGES_COUNT); i++) {
        const base = dataOffset / 4 + i * (SELECTED_EDGE_SIZE / 4)
        result.push({
            kind: u32[base],
            primaryId: u32[base + 1],
            secondaryId: u32[base + 2],
            featureA: u32[base + 3],
            opType: u32[base + 4],
            lineWidthPx: f32[base + 5] || defaultLineWidth,
            epsilon: f32[base + 6] || defaultEpsilon,
            seedPoint: [f32[base + 8], f32[base + 9], f32[base + 10]],
            seedTangent: [f32[base + 12], f32[base + 13], f32[base + 14]],
            seedNormal: [f32[base + 16], f32[base + 17], f32[base + 18]],
        })
    }
    return result
}

// ---------------------------------------------------------------------------
// Worker: write FPS to shared buffer
// ---------------------------------------------------------------------------

export function writeFps(buffer: SharedArrayBuffer, fps: number, version: number): void {
    const u32 = new Uint32Array(buffer)
    u32[O_FPS / 4] = Math.round(fps * FPS_SCALE)
    Atomics.store(u32, O_FPS_VERSION / 4, version)
}

// ---------------------------------------------------------------------------
// Main thread: read FPS from shared buffer
// ---------------------------------------------------------------------------

export function readFps(buffer: SharedArrayBuffer): number {
    const u32 = new Uint32Array(buffer)
    return u32[O_FPS / 4] / FPS_SCALE
}

/** Check if SharedArrayBuffer is available (cross-origin isolated). */
export function isSharedMemoryAvailable(): boolean {
    return typeof SharedArrayBuffer !== "undefined" && typeof crossOriginIsolated !== "undefined" && crossOriginIsolated
}

/**
 * Note on performance: The benchmark (runBenchmarkSuite) measures GPU render throughput in a
 * tight worker loop reusing a single payload. It does NOT use shared memory—it sends one payload
 * via postMessage, then the worker loops #renderFrameAndWait() with no further IPC. Shared memory
 * only affects the interactive preview path (main writes each frame, worker polls). Expected gains
 * there are modest (1–5%) since the bottleneck is GPU ray marching, not message passing.
 */
