/**
 * Message protocol for main thread <-> render worker communication.
 * Shared by SDFRendererProxy (main) and render-worker (worker).
 */

import type { CameraState } from "./controls/camera-controller.mjs"
import type { SelectionInfo } from "./components/preview-window.mjs"
import type { MeshData } from "./export/export.mjs"

/** Benchmark result (inlined to avoid circular deps with benchmark.mts) */
export interface BenchmarkResultPayload {
    totalTime: number
    averageFrameTime: number
    minFrameTime: number
    maxFrameTime: number
    framesPerSecond: number
    frameTimes: number[]
    error?: string
}

/** Serializable representation of a scene node for main-thread getSceneNodes/matchNodesToSource. */
export interface SerializedNode {
    id: number
    shapeType: string
    indicatorSvg?: string
    /** Parent node id, -1 if root */
    parentId: number
    /** Child node ids */
    children: number[]
    // Shape-specific properties for matchNodesToSource
    pos?: [number, number, number]
    size?: [number, number, number]
    r?: number
    h?: number
    sr?: number
    lr?: number
    c?: number
    normal?: [number, number, number]
    planeOffset?: number
    vertices?: [number, number][]
    twistDegrees?: number
    /** Polygon2D buffer offset in the shared vertex buffer (bytes / 8). */
    bufferOffset?: number
}

/** Edge hit data from GPU readback. */
export interface EdgeHitData {
    kind: number
    primaryId: number
    secondaryId: number
    featureA: number
    opType: number
    objectId: number
    seedPoint: [number, number, number]
    seedTangent?: [number, number, number]
    seedNormal?: [number, number, number]
}

// ---------------------------------------------------------------------------
// Main -> Worker messages
// ---------------------------------------------------------------------------

export type MainToWorkerMessage =
    | { type: "init"; canvas: OffscreenCanvas; sharedBuffer?: SharedArrayBuffer }
    | { type: "build"; body: string; documentName?: string | null; requestId?: number }
    | { type: "render"; cameraState: CameraState; viewTransform: Float32Array; cameraPosition: [number, number, number]; cameraRes: [number, number]; selectionState: RenderSelectionState; viewSettings: RenderViewSettings; viewCenter: [number, number]; resolutionScale: number }
    | { type: "click"; clickUV: [number, number]; shiftKey: boolean; altKey: boolean; documentName?: string }
    | { type: "doubleClick"; clickUV: [number, number]; documentName?: string }
    | { type: "hover"; clickUV: [number, number]; altKey: boolean; documentName?: string }
    | { type: "resize"; fullWidth: number; fullHeight: number; devicePixelRatio: number }
    | { type: "writeBuffers"; faceSelection?: ArrayBuffer; polygonVertices?: { offset: number; data: ArrayBuffer }; nodeParams?: { nodeId: number; data: ArrayBuffer }; selectedObjectIds?: ArrayBuffer | { offset: number; data: ArrayBuffer } }
    | { type: "renderMesh"; body: string; requestId?: number; documentName?: string; simplifyOnExport?: boolean }
    | { type: "benchmark"; durationSeconds: number; waitForGPU: boolean; requestId?: number }
    | { type: "thumbnail"; body: string; width?: number; height?: number; requestId?: number; documentName?: string }

export interface RenderSelectionState {
    selectedObjectIds: number[]
    selectedEdges: SelectedEdgePayload[]
    hoveredObjectId: number
    hoveredEdges: SelectedEdgePayload[]
}

export interface SelectedEdgePayload {
    kind: number
    primaryId: number
    secondaryId: number
    featureA: number
    opType: number
    lineWidthPx: number
    epsilon: number
    seedPoint?: [number, number, number]
    seedTangent?: [number, number, number]
    seedNormal?: [number, number, number]
}

export interface RenderViewSettings {
    xrayMode: boolean
    beamEnabled: boolean
    selectionMode: number
    outlineMode: number
    outlineThickness: number
    outlineColor: [number, number, number]
}

// ---------------------------------------------------------------------------
// Worker -> Main messages
// ---------------------------------------------------------------------------

export type WorkerToMainMessage =
    | { type: "ready" }
    | { type: "initError"; error: string }
    | { type: "buildComplete"; sceneNodes: SerializedNode[]; compiledPosY: [number, number][]; error?: string; requestId?: number; documentName?: string; superseded?: boolean }
    | { type: "clickResult"; clickedId: number; edgeHits: EdgeHitData[]; hitPos: [number, number, number, number]; clickedNormal: [number, number, number]; shiftKey: boolean; altKey: boolean; documentName?: string }
    | { type: "selectionInfo"; info: SelectionInfo; documentName?: string }
    | { type: "objectDoubleClick"; nodeId: number; hitPos?: [number, number, number]; documentName?: string }
    | { type: "renderMeshResult"; mesh?: MeshData; error?: string; requestId?: number; documentName?: string }
    | { type: "benchmarkResult"; result: BenchmarkResultPayload; requestId?: number }
    | { type: "thumbnailResult"; imageData?: ImageData; error?: string; requestId?: number; documentName?: string }
    | { type: "fps"; fps: number }
