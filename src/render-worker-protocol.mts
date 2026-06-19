/**
 * Message protocol for main thread <-> render worker communication.
 * Shared by SDFRendererProxy (main) and render-worker (worker).
 */

import type { CameraState } from "./controls/camera-controller.mjs"
import type { SelectionInfo } from "./components/preview-window.mjs"
import type { MeshData } from "./export/export.mjs"
// Per-exporter tuning types/defaults now live with each exporter (see
// `src/export/mesh-exporter.mts` + the `*-tuning.mts` files); the `renderMesh`
// message carries them as an opaque `exporterTuning` blob keyed by kind.
import type { ExporterKind } from "./export/mesh-exporter.mjs"

/**
 * Post-MDC meshoptimizer simplification (QEM). Used when mesh export runs the MDC
 * pipeline with simplification enabled; ignored for SHREC.
 */
export interface SimplifyTuning {
    /** Fraction of input triangles to keep (0–1). `1` skips simplification. */
    targetRatio: number
    /** Max geometric error (relative unless `errorAbsolute`). */
    targetError: number
    lockBorder: boolean
    sparse: boolean
    errorAbsolute: boolean
    prune: boolean
    regularize: boolean
    /** When positive, uses normal-aware simplification (protects sharp features). */
    normalWeight: number
    /**
     * Recompute vertex normals from triangle geometry on export (smooth shading).
     * Applied only in the worker post-pass after export (and after QEM if it ran);
     * not coupled to simplify enablement or `targetRatio`. Off keeps exporter normals.
     */
    renormalizeTriangles: boolean
}

export const DEFAULT_SIMPLIFY_TUNING: SimplifyTuning = {
    targetRatio: 0.1,
    targetError: 0.001,
    lockBorder: true,
    sparse: false,
    errorAbsolute: false,
    prune: false,
    regularize: false,
    normalWeight: 0,
    renormalizeTriangles: true,
}

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
    /** ThreadedRod helix: direction-indicator RIGHT (0x8) or LEFT (0x4). */
    handedness?: number
    /** ThreadedRod: barrel xz scale uses 1+femalePlay in denominator (0 = nominal). */
    femalePlay?: number
    /** Cylinder: rim fillet / chamfer on +y cap (0 if none). */
    filletTop?: number
    filletBottom?: number
    chamferTop?: number
    chamferBottom?: number
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

export type MainToWorkerMessage =
    | { type: "init"; canvas: OffscreenCanvas; sharedBuffer?: SharedArrayBuffer }
    | { type: "renderKick"; version: number }
    | { type: "build"; body: string; documentName?: string | null; requestId?: number }
    | { type: "cancelBuilds" }
    | {
          type: "render"
          cameraState: CameraState
          viewTransform: Float32Array
          cameraPosition: [number, number, number]
          cameraRes: [number, number]
          selectionState: RenderSelectionState
          viewSettings: RenderViewSettings
          viewCenter: [number, number]
          resolutionScale: number
          /** When true, GPU skips drawing the pivot cursor (welcome thumbnails, agent SDF capture). */
          hidePivotCursor?: boolean
      }
    | { type: "click"; clickUV: [number, number]; shiftKey: boolean; altKey: boolean; documentName?: string }
    | { type: "doubleClick"; clickUV: [number, number]; documentName?: string }
    | { type: "hover"; clickUV: [number, number]; altKey: boolean; documentName?: string; hoverRequestId?: number }
    | { type: "resize"; fullWidth: number; fullHeight: number; devicePixelRatio: number }
    // previewParamsF32Patch: cap-drag only — patches #previewF32Shadow then 8-byte write to previewCapParamDrag at byteOffset.
    // Does not touch boundsSceneParams or mdcSceneParams (those refresh on build / param-only build).
    | { type: "writeBuffers"; faceSelection?: ArrayBuffer; polygonVertices?: { offset: number; data: ArrayBuffer }; previewParamsF32Patch?: { byteOffset: number; data: ArrayBuffer }; selectedObjectIds?: ArrayBuffer | { offset: number; data: ArrayBuffer }; colorPalette?: ArrayBuffer }
    | {
          type: "renderMesh"
          body: string
          requestId?: number
          documentName?: string
          simplifyOnExport?: boolean
          exporter?: ExporterKind
          /** Per-exporter tuning keyed by kind; the worker reads `exporterTuning[exporter]`. */
          exporterTuning?: Partial<Record<ExporterKind, unknown>>
          simplifyTuning?: SimplifyTuning
          /**
           * Shared cancel flag (`Int32Array` slot 0): the main thread writes 1 on the
           * Cancel click; the sfcc-rs export polls it and bails. Present only when shared
           * memory is available; absent → export not cancellable.
           */
          cancelBuffer?: SharedArrayBuffer
      }
    | { type: "benchmark"; frameCount: number; waitForGPU: boolean; requestId?: number }
    | { type: "thumbnail"; body: string; width?: number; height?: number; requestId?: number; documentName?: string }
    | {
          type: "agentPreview"
          body: string
          width: number
          height: number
          requestId?: number
          documentName?: string
          cameraState: CameraState
          viewTransform: Float32Array
          cameraPosition: [number, number, number]
          viewCenter: [number, number]
      }
    // Screenshot the *current* live preview: render the supplied payload (the main thread's current
    // camera/view, forced to full resolution) of the already-built scene into an offscreen texture and
    // read it back. Unlike `agentPreview` it does not rebuild from source — the result is the live frame.
    | { type: "capturePreviewFrame"; requestId: number; payload: Extract<MainToWorkerMessage, { type: "render" }> }
    | { type: "pickPos"; clickUV: [number, number]; requestId: number }
    | { type: "pickObject"; clickUV: [number, number]; requestId: number }
    | { type: "setBvhEnabled"; enabled: boolean }
    | { type: "setFeatureGraphOverlayEnabled"; enabled: boolean }
    | { type: "setStepHeatmapEnabled"; enabled: boolean }
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

/** Tunable ray marching quality constants; passed as a uniform so they can be changed without recompilation. */
export interface RayMarchParams {
    /** Max ray march iterations (default 300). Higher = less chance of missing thin features. */
    maxSteps: number
    /**
     * Max ray march iterations used while the camera is actively moving
     * (default 100). Substituted for `maxSteps` in the per-frame payload
     * during drag/zoom — trades a small amount of surface precision for
     * cheaper fragments, complementing (but independent of) halfres scaling.
     */
    maxStepsMoving: number
    /** Far clipping distance (default 600). */
    maxDist: number
    /** Max beam pre-pass iterations (default 200). */
    maxBeamSteps: number
    /**
     * Max beam pre-pass iterations used while the camera is actively moving
     * (default 60). Same gating as `maxStepsMoving`. The beam is already
     * cheap, but reducing its budget during motion cuts pre-pass cost
     * roughly proportionally.
     */
    maxBeamStepsMoving: number
    /** Binary-search refinement iterations after a hit (default 6). Higher = sharper surface accuracy. */
    hitRefineSteps: number
    /**
     * Binary-search refinement iterations used while the camera is actively
     * moving (default 2). Lower precision during motion is visually
     * invisible (silhouettes are already smeared by motion / halfres),
     * and each saved iteration is one `sceneSDF_fast` call per hit pixel.
     */
    hitRefineStepsMoving: number
    /** Camera z-offset for ray origin (default 300). */
    rayOriginDepth: number
}

export const DEFAULT_RAY_MARCH_PARAMS: RayMarchParams = {
    maxSteps: 300,
    maxStepsMoving: 100,
    maxDist: 600,
    maxBeamSteps: 200,
    maxBeamStepsMoving: 200,
    hitRefineSteps: 16,
    hitRefineStepsMoving: 4,
    rayOriginDepth: 300,
}

/**
 * How a reduced-resolution scene frame is upscaled back to the display.
 *  - `off`   — no spatial filter; the reduced-res canvas is stretched by the
 *              browser compositor (bilinear). The legacy behavior.
 *  - `easu`  — AMD FSR1 Edge-Adaptive Spatial Upsampling (edge-directed,
 *              much crisper than bilinear), no post pass.
 *  - `easu-fxaa` — EASU followed by FXAA (luma post-process antialiasing). FXAA
 *              also runs on full-res frames (still camera / 100% scale), where it
 *              smooths all edge types (creases + silhouettes).
 */
export type UpscaleMode = "off" | "easu" | "easu-fxaa"

/**
 * Spatial-upscale (FSR1) tunables, adjustable from dev tools. Only takes effect
 * on the reduced-resolution frames produced while the camera is actively moving
 * (gated by the "Camera halfres" toggle); a still camera always renders at full
 * native resolution where these are a no-op (except FXAA, which also runs full-res).
 */
export interface UpscaleParams {
    /**
     * Fraction of full display resolution the scene is rendered at during
     * camera motion (e.g. 0.5 = half-res). `1` disables reduced-res entirely
     * (and therefore the upscale passes).
     */
    renderScale: number
    /** Upsampling filter. `off` keeps the old browser-bilinear stretch. */
    mode: UpscaleMode
}

export const DEFAULT_UPSCALE_PARAMS: UpscaleParams = {
    renderScale: 0.5,
    mode: "easu",
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
    // (formerly `specShininess` and `fresnelPower`) The Blinn-Phong specular
    // exponent is now hard-coded at 32 (canonical "medium plastic") and the
    // Fresnel exponent at 5 (Schlick's analytic approximation), both via
    // repeated-squaring in `specularAndFresnelRim` — eliminates two per-pixel
    // `pow()` calls. The SAB / camera-staging slots that previously carried
    // these values remain in the layout as dead bytes so downstream offsets
    // don't shift, but nothing reads or writes them anymore.
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
    rayMarchParams?: RayMarchParams
    /**
     * FSR1 spatial upscale tunables. The worker consumes `mode` here; the
     * effective render scale for the frame is carried separately by the
     * top-level `resolutionScale` (set from `renderScale` during motion).
     */
    upscaleParams?: UpscaleParams
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
    | { type: "renderMeshResult"; mesh?: MeshData; error?: string; requestId?: number; documentName?: string; cancelled?: boolean }
    | { type: "exportProgress"; requestId?: number; documentName?: string; phase: string; phaseIndex: number; totalPhases: number; elapsedMs: number }
    | { type: "benchmarkResult"; result: BenchmarkResultPayload; requestId?: number }
    | { type: "thumbnailResult"; imageData?: ImageData; error?: string; requestId?: number; documentName?: string }
    | { type: "pickPosResult"; hitPos: [number, number, number] | null; requestId: number }
    | { type: "pickObjectResult"; objectId: number; requestId: number }
    | { type: "fps"; fps: number }
