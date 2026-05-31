/**
 * Shared memory layout for main thread <-> render worker communication.
 * Replaces per-frame postMessage for render payload and FPS.
 *
 * Double-buffered layout: header + two payload slots. Main thread writes into
 * the inactive slot, then atomically publishes slot/version. Worker reads only
 * from the published slot, avoiding torn-frame reads.
 */

import { dollyFromOrthoHalf, orthoHalfFromDolly, type CameraState } from "./controls/camera-controller.mjs"
import {
    DEFAULT_PREVIEW_SHADING,
    DEFAULT_RAY_MARCH_PARAMS,
    type RenderSelectionState,
    type RenderViewSettings,
    type SelectedEdgePayload,
} from "./render-worker-protocol.mjs"
import type { MainToWorkerMessage } from "./render-worker-protocol.mjs"

/** FPS scale factor: stored as fps * FPS_SCALE for integer storage */
export const FPS_SCALE = 100

/** Edge layout matches render-worker-core SELECTED_EDGE_SIZE */
const SELECTED_EDGE_SIZE = 80
const SELECTED_EDGES_COUNT = 16

// ---------------------------------------------------------------------------
// Header layout (bytes 0–15)
// ---------------------------------------------------------------------------

const O_PUBLISHED_VERSION = 0
const O_PUBLISHED_SLOT = 4
const O_FPS = 8
const O_FPS_VERSION = 12

const HEADER_SIZE = 16

// ---------------------------------------------------------------------------
// Slot-relative payload layout (each slot is SLOT_SIZE bytes)
// ---------------------------------------------------------------------------

const S_O_FULL_WIDTH = 0
const S_O_FULL_HEIGHT = 4
const S_O_RESOLUTION_SCALE = 8
const S_O_VIEW_TRANSFORM = 12
const S_O_CAMERA_POSITION = 76
const S_O_CAMERA_RES = 88
const S_O_ZOOM = 96
const S_O_QUATERNION = 100
const S_O_TRANSLATION = 116
const S_O_VIEW_CENTER = 128
const S_O_CAMERA_PIVOT = 136
const S_O_VIEW_SETTINGS = 152
const S_O_OUTLINE_THICKNESS = 156
const S_O_OUTLINE_COLOR = 160
const S_O_SELECTION_STYLES = 172
const S_O_PREVIEW_SHADING = 200 // 14 floats: PreviewShadingParams
const S_O_SELECTED_OBJECT_IDS = 256
const S_O_SELECTED_EDGES_HEADER = 4352
const S_O_SELECTED_EDGES_DATA = 4368
const S_O_HOVERED_EDGES_HEADER = 5648
const S_O_HOVERED_EDGES_DATA = 5664
const S_O_HOVERED_OBJECT_ID = 6944
// Ray march quality params: 5 values packed as [maxSteps, maxBeamSteps, hitRefineSteps, _pad, maxDist, rayOriginDepth, _pad, _pad]
const S_O_RAY_MARCH_PARAMS = 6948

const SELECTED_OBJECT_IDS_SIZE = 1024 * 4 // 4096 bytes
const EDGES_HEADER_SIZE = 16
const EDGES_DATA_SIZE = SELECTED_EDGES_COUNT * SELECTED_EDGE_SIZE // 1280

/** Size of one payload slot in bytes */
export const SLOT_SIZE = 6980

/** Total buffer size in bytes */
export const SHARED_RENDER_BUFFER_SIZE = HEADER_SIZE + 2 * SLOT_SIZE

/**
 * Get the byte offset of the start of a slot (0 or 1).
 */
export function getSlotByteOffset(slot: 0 | 1): number {
    return HEADER_SIZE + slot * SLOT_SIZE
}

/**
 * Seed slot 0 with safe defaults so a pre-first-publish read (slot index defaults to 0)
 * yields an invertible camera matrix and non-zero zoom rather than all-zero garbage.
 */
export function initSharedRenderBuffer(buffer: SharedArrayBuffer): void {
    const f32 = new Float32Array(buffer)
    const base = HEADER_SIZE / 4
    const vt = base + S_O_VIEW_TRANSFORM / 4
    f32[vt + 0] = 1
    f32[vt + 5] = 1
    f32[vt + 10] = 1
    f32[vt + 15] = 1
    f32[base + S_O_ZOOM / 4] = 1
}

/**
 * Read the currently published slot index from the SAB header.
 */
export function getPublishedRenderSlot(buffer: SharedArrayBuffer): 0 | 1 {
    const u32 = new Uint32Array(buffer)
    return (Atomics.load(u32, O_PUBLISHED_SLOT / 4) & 1) as 0 | 1
}

/**
 * Layout constants for hot-path SAB reads (worker). All offsets are slot-relative.
 * Use getSlotByteOffset(slot) + SAB_LAYOUT.* to get absolute offset.
 */
export const SAB_LAYOUT = {
    O_FULL_WIDTH: S_O_FULL_WIDTH,
    O_VIEW_TRANSFORM: S_O_VIEW_TRANSFORM,
    O_CAMERA_POSITION: S_O_CAMERA_POSITION,
    O_CAMERA_RES: S_O_CAMERA_RES,
    O_ZOOM: S_O_ZOOM,
    O_VIEW_CENTER: S_O_VIEW_CENTER,
    O_CAMERA_PIVOT: S_O_CAMERA_PIVOT,
    O_VIEW_SETTINGS: S_O_VIEW_SETTINGS,
    O_OUTLINE_THICKNESS: S_O_OUTLINE_THICKNESS,
    O_OUTLINE_COLOR: S_O_OUTLINE_COLOR,
    O_SELECTION_STYLES: S_O_SELECTION_STYLES,
    O_PREVIEW_SHADING: S_O_PREVIEW_SHADING,
    O_SELECTED_OBJECT_IDS: S_O_SELECTED_OBJECT_IDS,
    O_SELECTED_EDGES_HEADER: S_O_SELECTED_EDGES_HEADER,
    O_HOVERED_EDGES_HEADER: S_O_HOVERED_EDGES_HEADER,
    O_RESOLUTION_SCALE: S_O_RESOLUTION_SCALE,
    O_RAY_MARCH_PARAMS: S_O_RAY_MARCH_PARAMS,
    SELECTED_OBJECT_IDS_SIZE,
    SELECTED_EDGES_TOTAL: EDGES_HEADER_SIZE + EDGES_DATA_SIZE,
} as const

/**
 * Read selection state from the published slot in SAB. Allocates; use only for
 * event handlers (hover) that need the full selection structure, not on the hot render path.
 */
export function readSelectionStateFromSAB(buffer: SharedArrayBuffer): RenderSelectionState {
    const slot = getPublishedRenderSlot(buffer)
    const base = getSlotByteOffset(slot)
    return readSelectionStateFromSlot(buffer, base)
}

/**
 * Read selection state from a specific slot base offset.
 */
function readSelectionStateFromSlot(buffer: SharedArrayBuffer, slotBase: number): RenderSelectionState {
    const u32 = new Uint32Array(buffer)
    const selectedObjectIds: number[] = []
    const selIds = new Uint32Array(buffer, slotBase + S_O_SELECTED_OBJECT_IDS, 1024)
    for (let i = 0; i < 1024; i++) {
        if (selIds[i]) selectedObjectIds.push(i)
    }
    const selectedEdges = readEdgesFromBuffer(buffer, slotBase + S_O_SELECTED_EDGES_HEADER, slotBase + S_O_SELECTED_EDGES_DATA, 6, 0.02)
    const hoveredEdges = readEdgesFromBuffer(buffer, slotBase + S_O_HOVERED_EDGES_HEADER, slotBase + S_O_HOVERED_EDGES_DATA, 6, 0.02)
    const hoveredObjectId = u32[(slotBase + S_O_HOVERED_OBJECT_ID) / 4]
    return { selectedObjectIds, selectedEdges, hoveredObjectId, hoveredEdges }
}

// ---------------------------------------------------------------------------
// Main thread: write render payload to a slot (no publish)
// ---------------------------------------------------------------------------

export function writeRenderPayloadSlot(
    buffer: SharedArrayBuffer,
    slot: 0 | 1,
    payload: Extract<MainToWorkerMessage, { type: "render" }>,
    fullWidth: number,
    fullHeight: number
): void {
    const base = getSlotByteOffset(slot)
    const u32 = new Uint32Array(buffer)
    const f32 = new Float32Array(buffer)

    const b4 = base / 4

    u32[b4 + S_O_FULL_WIDTH / 4] = fullWidth
    u32[b4 + S_O_FULL_HEIGHT / 4] = fullHeight
    f32[b4 + S_O_RESOLUTION_SCALE / 4] = payload.resolutionScale

    f32.set(payload.viewTransform, base / 4 + S_O_VIEW_TRANSFORM / 4)
    f32[b4 + S_O_CAMERA_POSITION / 4] = payload.cameraPosition[0]
    f32[b4 + S_O_CAMERA_POSITION / 4 + 1] = payload.cameraPosition[1]
    f32[b4 + S_O_CAMERA_POSITION / 4 + 2] = payload.cameraPosition[2]
    f32[b4 + S_O_CAMERA_RES / 4] = payload.cameraRes[0]
    f32[b4 + S_O_CAMERA_RES / 4 + 1] = payload.cameraRes[1]

    const cam = payload.cameraState
    f32[b4 + S_O_ZOOM / 4] = orthoHalfFromDolly(cam.dollyDistance)
    f32.set(cam.rotation, base / 4 + S_O_QUATERNION / 4)
    f32[b4 + S_O_TRANSLATION / 4] = cam.translation.x
    f32[b4 + S_O_TRANSLATION / 4 + 1] = cam.translation.y
    f32[b4 + S_O_TRANSLATION / 4 + 2] = cam.translation.z

    f32[b4 + S_O_VIEW_CENTER / 4] = payload.viewCenter[0]
    f32[b4 + S_O_VIEW_CENTER / 4 + 1] = payload.viewCenter[1]

    const piv = payload.cameraState.pivot
    f32[b4 + S_O_CAMERA_PIVOT / 4] = piv?.x ?? 0
    f32[b4 + S_O_CAMERA_PIVOT / 4 + 1] = piv?.y ?? 0
    f32[b4 + S_O_CAMERA_PIVOT / 4 + 2] = piv?.z ?? 0
    f32[b4 + S_O_CAMERA_PIVOT / 4 + 3] = 0

    const vs = payload.viewSettings
    const packed =
        (vs.xrayMode ? 1 : 0) |
        (vs.beamEnabled ? 2 : 0) |
        (vs.selectionMode << 2) |
        (vs.outlineMode << 5) |
        (vs.previewNormalShading ? 128 : 0)
    u32[b4 + S_O_VIEW_SETTINGS / 4] = packed
    u32[b4 + S_O_OUTLINE_THICKNESS / 4] = vs.outlineThickness
    f32.set(vs.outlineColor, base / 4 + S_O_OUTLINE_COLOR / 4)
    const ss = vs.selectionStyles
    f32[b4 + S_O_SELECTION_STYLES / 4] = ss.face.darken
    f32.set(ss.face.tint, base / 4 + S_O_SELECTION_STYLES / 4 + 1)
    f32.set(ss.edge.color, base / 4 + S_O_SELECTION_STYLES / 4 + 4)

    const ps = payload.viewSettings.previewShading ?? DEFAULT_PREVIEW_SHADING
    const psB = b4 + S_O_PREVIEW_SHADING / 4
    f32[psB] = ps.ambient
    f32[psB + 1] = ps.diffuseWrap
    f32[psB + 2] = ps.keyWeight
    f32[psB + 3] = ps.fillWeight
    f32[psB + 4] = ps.rimWeight
    f32[psB + 5] = ps.backWeight
    f32[psB + 6] = ps.specIntensity
    f32[psB + 7] = ps.specShininess
    f32[psB + 8] = ps.fresnelPower
    f32[psB + 9] = ps.fresnelIntensity
    f32[psB + 10] = ps.aoStrength
    f32[psB + 11] = ps.aoRadius
    f32[psB + 12] = ps.aoSteps
    f32[psB + 13] = ps.aoBias

    const rm = payload.viewSettings.rayMarchParams ?? DEFAULT_RAY_MARCH_PARAMS
    const rmI32 = new Int32Array(buffer, base + S_O_RAY_MARCH_PARAMS, 4)
    const rmF32 = new Float32Array(buffer, base + S_O_RAY_MARCH_PARAMS + 16, 4)
    rmI32[0] = rm.maxSteps
    rmI32[1] = rm.maxBeamSteps
    rmI32[2] = rm.hitRefineSteps
    rmI32[3] = 0
    rmF32[0] = rm.maxDist
    rmF32[1] = rm.rayOriginDepth

    const sel = payload.selectionState
    const selIds = new Uint32Array(buffer, base + S_O_SELECTED_OBJECT_IDS, 1024)
    selIds.fill(0)
    for (const id of sel.selectedObjectIds) {
        selIds[id] = 1
    }

    writeEdgesToBuffer(buffer, base + S_O_SELECTED_EDGES_HEADER, base + S_O_SELECTED_EDGES_DATA, sel.selectedEdges, 6, 0.02)
    writeEdgesToBuffer(buffer, base + S_O_HOVERED_EDGES_HEADER, base + S_O_HOVERED_EDGES_DATA, sel.hoveredEdges, 6, 0.02)
    u32[b4 + S_O_HOVERED_OBJECT_ID / 4] = sel.hoveredObjectId
}

/**
 * Atomically publish a slot and version. Call after writeRenderPayloadSlot.
 */
export function publishRenderSlot(buffer: SharedArrayBuffer, slot: 0 | 1, version: number): void {
    const u32 = new Uint32Array(buffer)
    Atomics.store(u32, O_PUBLISHED_SLOT / 4, slot)
    Atomics.store(u32, O_PUBLISHED_VERSION / 4, version)
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
    const slot = getPublishedRenderSlot(buffer)
    const base = getSlotByteOffset(slot)
    const u32 = new Uint32Array(buffer)
    const f32 = new Float32Array(buffer)
    const b4 = base / 4

    const packed = u32[b4 + S_O_VIEW_SETTINGS / 4]
    const psB = b4 + S_O_PREVIEW_SHADING / 4
    const viewSettings: RenderViewSettings = {
        xrayMode: (packed & 1) !== 0,
        beamEnabled: (packed & 2) !== 0,
        selectionMode: (packed >> 2) & 7,
        outlineMode: (packed >> 5) & 3,
        outlineThickness: u32[b4 + S_O_OUTLINE_THICKNESS / 4],
        outlineColor: [f32[b4 + S_O_OUTLINE_COLOR / 4], f32[b4 + S_O_OUTLINE_COLOR / 4 + 1], f32[b4 + S_O_OUTLINE_COLOR / 4 + 2]],
        selectionStyles: {
            face: {
                darken: f32[b4 + S_O_SELECTION_STYLES / 4],
                tint: [f32[b4 + S_O_SELECTION_STYLES / 4 + 1], f32[b4 + S_O_SELECTION_STYLES / 4 + 2], f32[b4 + S_O_SELECTION_STYLES / 4 + 3]],
            },
            edge: {
                color: [f32[b4 + S_O_SELECTION_STYLES / 4 + 4], f32[b4 + S_O_SELECTION_STYLES / 4 + 5], f32[b4 + S_O_SELECTION_STYLES / 4 + 6]],
            },
        },
        previewShading: {
            ambient: f32[psB],
            diffuseWrap: f32[psB + 1],
            keyWeight: f32[psB + 2],
            fillWeight: f32[psB + 3],
            rimWeight: f32[psB + 4],
            backWeight: f32[psB + 5],
            specIntensity: f32[psB + 6],
            specShininess: f32[psB + 7],
            fresnelPower: f32[psB + 8],
            fresnelIntensity: f32[psB + 9],
            aoStrength: f32[psB + 10],
            aoRadius: f32[psB + 11],
            aoSteps: f32[psB + 12],
            aoBias: f32[psB + 13],
        },
        previewNormalShading: (packed & 128) !== 0,
        // SAB carries only the *effective* values for this frame — the main
        // thread substitutes the *Moving variants when motion is active.
        // The Moving fields are zeroed here purely to satisfy the
        // `RayMarchParams` type.
        rayMarchParams: {
            maxSteps: new Int32Array(buffer, base + S_O_RAY_MARCH_PARAMS, 1)[0],
            maxStepsMoving: 0,
            maxBeamSteps: new Int32Array(buffer, base + S_O_RAY_MARCH_PARAMS + 4, 1)[0],
            maxBeamStepsMoving: 0,
            hitRefineSteps: new Int32Array(buffer, base + S_O_RAY_MARCH_PARAMS + 8, 1)[0],
            hitRefineStepsMoving: 0,
            maxDist: new Float32Array(buffer, base + S_O_RAY_MARCH_PARAMS + 16, 1)[0],
            rayOriginDepth: new Float32Array(buffer, base + S_O_RAY_MARCH_PARAMS + 20, 1)[0],
        },
    }

    const selectedObjectIds: number[] = []
    const selIds = new Uint32Array(buffer, base + S_O_SELECTED_OBJECT_IDS, 1024)
    for (let i = 0; i < 1024; i++) {
        if (selIds[i]) selectedObjectIds.push(i)
    }

    const selectedEdges = readEdgesFromBuffer(buffer, base + S_O_SELECTED_EDGES_HEADER, base + S_O_SELECTED_EDGES_DATA, 6, 0.02)
    const hoveredEdges = readEdgesFromBuffer(buffer, base + S_O_HOVERED_EDGES_HEADER, base + S_O_HOVERED_EDGES_DATA, 6, 0.02)
    const hoveredObjectId = u32[b4 + S_O_HOVERED_OBJECT_ID / 4]

    const cameraState: CameraState = {
        rotation: [f32[b4 + S_O_QUATERNION / 4], f32[b4 + S_O_QUATERNION / 4 + 1], f32[b4 + S_O_QUATERNION / 4 + 2], f32[b4 + S_O_QUATERNION / 4 + 3]],
        dollyDistance: dollyFromOrthoHalf(f32[b4 + S_O_ZOOM / 4]),
        translation: { x: f32[b4 + S_O_TRANSLATION / 4], y: f32[b4 + S_O_TRANSLATION / 4 + 1], z: f32[b4 + S_O_TRANSLATION / 4 + 2] } as CameraState["translation"],
        pivot: {
            x: f32[b4 + S_O_CAMERA_PIVOT / 4],
            y: f32[b4 + S_O_CAMERA_PIVOT / 4 + 1],
            z: f32[b4 + S_O_CAMERA_PIVOT / 4 + 2],
        } as CameraState["pivot"],
    }

    const viewTransform = new Float32Array(16)
    viewTransform.set(new Float32Array(buffer, base + S_O_VIEW_TRANSFORM, 16))

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
        cameraPosition: [f32[b4 + S_O_CAMERA_POSITION / 4], f32[b4 + S_O_CAMERA_POSITION / 4 + 1], f32[b4 + S_O_CAMERA_POSITION / 4 + 2]],
        cameraRes: [f32[b4 + S_O_CAMERA_RES / 4], f32[b4 + S_O_CAMERA_RES / 4 + 1]],
        selectionState,
        viewSettings,
        viewCenter: [f32[b4 + S_O_VIEW_CENTER / 4], f32[b4 + S_O_VIEW_CENTER / 4 + 1]],
        resolutionScale: f32[b4 + S_O_RESOLUTION_SCALE / 4],
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
// Worker: write FPS to shared buffer (header)
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
