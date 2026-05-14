/**
 * Message protocol for main thread <-> render worker communication.
 * Shared by SDFRendererProxy (main) and render-worker (worker).
 */

import type { CameraState } from "./controls/camera-controller.mjs"
import type { SelectionInfo } from "./components/preview-window.mjs"
import type { MeshData } from "./export/export.mjs"

/** Worker-reported `#doBuild` breakdown (ms); used for devtools / regression triage. */
export interface BuildTimingBreakdownMs {
    sceneConstructMs: number
    /** `getAllNodes()` after scene construction. */
    getAllNodesMs?: number
    fingerprintMs: number
    /** Polygon vertex buffer copy (`slice`). */
    polygonVertexMs?: number
    packSceneMs: number
    packPreviewMs: number
    serializeNodesMs: number
    /** WGSL scene codegen (full build only). */
    wgslSceneMs?: number
    /** Per-stage WGSL codegen (full build only); sums to ~`wgslSceneMs`. */
    compileAuxPreviewMs?: number
    compileAuxFastPreviewMs?: number
    compileAuxMidPreviewMs?: number
    compileForPreviewMs?: number
    compileFastForPreviewMs?: number
    compileMidForPreviewMs?: number
    compileEdgeHelpersMs?: number
    shaderModulesMs?: number
    pipelinesMs?: number
    gpuBuffersMs?: number
    totalMs: number
    paramOnly: boolean
}

/** Main-thread + worker timings for one end-to-end scene build (transpile → GPU). */
export interface SceneBuildPipelineMs {
    /** Wall time from posting transpile to transpile worker until `transpileComplete` (queue + CPU). */
    transpileWallMs: number
    /** CPU time inside transpile worker for `transpileCadSource`. */
    transpileCpuMs: number
    /** Wall time from posting `build` to render worker until `buildComplete`. */
    workerRoundTripMs: number
    /** Worker `#doBuild` breakdown (same as `getLastBuildTimingMs()`). */
    worker: BuildTimingBreakdownMs
}

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
    /** ThreadedRod: axial pitch, amplitude, meridional flank angle (deg), barrel profile. */
    turnPitch?: number
    threadAmp?: number
    threadFlankAngleDeg?: number
    /** `fdm` = sinusoidal; `iso` = triangular V-groove; `acme` = trapezoidal. */
    threadProfile?: "fdm" | "iso" | "acme"
    /** Default right-hand; left-hand flips helix. */
    threadHandedness?: "left" | "right"
    /** Polygon2D buffer offset in the shared vertex buffer (bytes / 8). */
    bufferOffset?: number
    /**
     * Start index (f32 slot) into `packSceneParams()` — uploaded to `boundsSceneParams` and `mdcSceneParams` only.
     * Not an address into `previewParamsF32` / `packPreviewParams()`; do not use for preview or cap-drag patches.
     * Present when `paramCount > 0` after build.
     */
    paramOffset?: number
    /**
     * Byte offset into the worker's `previewF32` CPU shadow / `previewCapParamDrag` uniform layout (vec4-packed, same as `previewParamsF32`).
     * Cap push/pull sends `writeBuffers.previewParamsF32Patch.byteOffset` equal to this value (two f32: `h`, `posYDelta`).
     * The worker patches the shadow then `writeBuffer`s **8 bytes** at that offset into `previewCapParamDrag` (not `previewParamsF32`).
     * Set for extrude, loft, and threaded_rod that support cap push/pull (`previewF32Slot * 4`, or threaded_rod `(previewF32Slot + 3) * 4` for cap scalars).
     */
    sceneCapParamsByteOffset?: number
    /** True if this is a virtual cap node (Extrude top/bottom). */
    isVirtualCap?: boolean
    /** For virtual cap nodes: which cap. */
    capSide?: "top" | "bottom"
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

/** Which GPU mesh pipeline runs for `renderMesh` (dev tools / export). */
export type MeshExporter = "mdc" | "iso"

/** ISO Phase-1 export tuning passed from main thread to render worker. */
export interface IsoExportTuning {
    voxelSizeMm: number
    padMm: number
    creaseAngleDeg: number
    adaptiveOctree?: boolean
    /** ISO adaptive octree max depth past base grid (default 2; worker clamps to implementation max). */
    octreeMaxDepth?: number
    /**
     * Fraction of highest-QEF cubes to subdivide when not using explicit `octreeResidualThreshold`
     * (default from app settings, typically ~0.28).
     */
    octreeRefineFraction?: number
    /** Default true — analytic ∇F creases for ISO (boxes/CSG); false uses geometric normals (lathe-friendly). */
    isoCreaseByAnalyticNormal?: boolean
    /** Hermite QEF boundary stencil density for ISO dual placement; default 2, clamp 1..4. */
    isoQefOversample?: number
    /**
     * Soft cap on total GPU buffer bytes the ISO exporter is allowed to size against. The
     * browser-reported `maxBufferSize` is a logical ceiling far above actual VRAM, and exceeding
     * VRAM crashes the shared Chromium GPU process. Default ~1 GiB (see `ISO_DEFAULT_MAX_GPU_BYTES`).
     */
    isoMaxGpuBytes?: number
    /**
     * Hard cap on per-dispatch GPU invocations. ISO Pass 1 walks every grid corner; on big
     * scenes the implied workgroup count can TDR the driver. Default 1e9
     * (see `ISO_DEFAULT_MAX_DISPATCH_INVOCATIONS`).
     */
    isoMaxDispatchInvocations?: number
}

export type MainToWorkerMessage =
    | { type: "init"; canvas: OffscreenCanvas; sharedBuffer?: SharedArrayBuffer }
    | { type: "renderKick"; version: number }
    | { type: "build"; body: string; documentName?: string | null; requestId?: number }
    | { type: "cancelBuilds" }
    | { type: "render"; cameraState: CameraState; viewTransform: Float32Array; cameraPosition: [number, number, number]; cameraRes: [number, number]; selectionState: RenderSelectionState; viewSettings: RenderViewSettings; viewCenter: [number, number]; resolutionScale: number }
    | { type: "click"; clickUV: [number, number]; shiftKey: boolean; altKey: boolean; documentName?: string }
    | { type: "doubleClick"; clickUV: [number, number]; documentName?: string }
    | { type: "hover"; clickUV: [number, number]; altKey: boolean; documentName?: string; hoverRequestId?: number }
    | { type: "resize"; fullWidth: number; fullHeight: number; devicePixelRatio: number }
    // previewParamsF32Patch: cap-drag only — patches #previewF32Shadow then 8-byte write to previewCapParamDrag at byteOffset.
    // Does not touch boundsSceneParams or mdcSceneParams (those refresh on build / param-only build).
    | { type: "writeBuffers"; faceSelection?: ArrayBuffer; polygonVertices?: { offset: number; data: ArrayBuffer }; previewParamsF32Patch?: { byteOffset: number; data: ArrayBuffer }; selectedObjectIds?: ArrayBuffer | { offset: number; data: ArrayBuffer }; colorPalette?: ArrayBuffer }
    | { type: "renderMesh"; body: string; requestId?: number; documentName?: string; simplifyOnExport?: boolean; exporter?: MeshExporter; isoTuning?: IsoExportTuning }
    | { type: "benchmark"; frameCount: number; waitForGPU: boolean; requestId?: number }
    | { type: "thumbnail"; body: string; width?: number; height?: number; requestId?: number; documentName?: string }
    | { type: "pickPos"; clickUV: [number, number]; requestId: number }
    | { type: "pickObject"; clickUV: [number, number]; requestId: number }
    | { type: "setBvhEnabled"; enabled: boolean }
    | { type: "setDebugLogModules"; modules: Record<string, boolean> }

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

/** Theme-aware selection styles for face tint and edge highlight (passed from main thread). */
export interface RenderSelectionStyles {
    face: { darken: number; tint: [number, number, number] }
    edge: { color: [number, number, number] }
}

/** Preview fragment shading (SDF raymarch); tunable from dev tools. */
export interface PreviewShadingParams {
    ambient: number
    diffuseWrap: number
    keyWeight: number
    fillWeight: number
    rimWeight: number
    backWeight: number
    specIntensity: number
    specShininess: number
    fresnelPower: number
    fresnelIntensity: number
    /** 0 = AO off; otherwise scales contact shadowing on diffuse only. */
    aoStrength: number
    /** World-space max distance along normal for AO samples. */
    aoRadius: number
    /** Integer step count 1–8 (stored as float for uniform packing). */
    aoSteps: number
    /** Surface offset along normal before sampling (avoids self-hit). */
    aoBias: number
}

export const DEFAULT_PREVIEW_SHADING: PreviewShadingParams = {
    ambient: 0.1,
    diffuseWrap: 0,
    keyWeight: 0.62,
    fillWeight: 0.16,
    rimWeight: 0.18,
    backWeight: 0.12,
    specIntensity: 0.13,
    specShininess: 246,
    fresnelPower: 8,
    fresnelIntensity: 0.27,
    aoStrength: 0.34,
    aoRadius: 0.5,
    aoSteps: 8,
    aoBias: 0,
}

export interface RenderViewSettings {
    xrayMode: boolean
    beamEnabled: boolean
    selectionMode: number
    outlineMode: number
    outlineThickness: number
    outlineColor: [number, number, number]
    selectionStyles: RenderSelectionStyles
    previewShading: PreviewShadingParams
    /** When true, SDF preview shades hits with scene-space normal RGB (matches mesh viewer opaque). */
    previewNormalShading: boolean
}

// ---------------------------------------------------------------------------
// Worker -> Main messages
// ---------------------------------------------------------------------------

export type WorkerToMainMessage =
    | { type: "devLogLine"; line: string; module?: string }
    | { type: "ready" }
    | { type: "initError"; error: string }
    | { type: "buildComplete"; sceneNodes: SerializedNode[]; compiledPosY: [number, number][]; error?: string; requestId?: number; documentName?: string; superseded?: boolean; timingMs?: BuildTimingBreakdownMs }
    | { type: "clickResult"; clickedId: number; edgeHits: EdgeHitData[]; hitPos: [number, number, number, number]; clickedNormal: [number, number, number]; shiftKey: boolean; altKey: boolean; documentName?: string }
    | { type: "selectionInfo"; info: SelectionInfo; documentName?: string; hoverRequestId?: number }
    | { type: "objectDoubleClick"; nodeId: number; hitPos?: [number, number, number]; documentName?: string }
    | { type: "renderMeshResult"; mesh?: MeshData; error?: string; requestId?: number; documentName?: string }
    | { type: "benchmarkResult"; result: BenchmarkResultPayload; requestId?: number }
    | { type: "thumbnailResult"; imageData?: ImageData; error?: string; requestId?: number; documentName?: string }
    | { type: "pickPosResult"; hitPos: [number, number, number] | null; requestId: number }
    | { type: "pickObjectResult"; objectId: number; requestId: number }
    | { type: "fps"; fps: number }
