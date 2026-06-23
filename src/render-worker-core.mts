/**
 * Render worker core - GPU logic extracted from SDFRenderer.
 * Runs in the render worker; owns device, buffers, pipelines.
 */

import { AveragedBuffer } from "./collections/averagedbuffer.mjs"
import { GPUHelper } from "./gpu/helper.mjs"
import { PALETTE_SIZE, DEFAULT_PALETTE, paletteToFloat32Array } from "./colorPalette.mjs"
import { orthoHalfFromDolly } from "./controls/camera-controller.mjs"
import { DEFAULT_SELECTION_STYLES } from "./selectionStyles.mjs"
import outlineShader from "./shaders/outline.wgsl"
import easuShader from "./shaders/easu.wgsl"
import fxaaShader from "./shaders/fxaa.wgsl"
import previewShader from "./shaders/preview.wgsl"
import boundsShader from "./shaders/bounds.wgsl"
import isoSampleBatchShaderSource from "./shaders/iso_sample_batch.wgsl"
import { ShaderCompiler, scheduleShaderModuleCompilationLogging } from "./shaders/shader.mjs"
import { getExporter } from "./export/exporters.mjs"
import {
    DEFAULT_MESH_EXPORT_VOXEL_SIZE_MM,
    MeshExportCancelledError,
    type ExporterKind,
    type MeshExportContext,
} from "./export/mesh-exporter.mjs"
import { IsoSampleBatch } from "./export/iso-simplicial/index.mjs"
import { FeatureGraphBuilder, type FeatureGraphCpu } from "./scene/feature-graph-buffer.mjs"
import {
    FeatureGraphGpu,
    type FeatureGraphBuildResult,
} from "./feature-graph/feature-graph-gpu.mjs"
import { featureGraphToContours } from "./feature-graph/feature-graph-to-contours.mjs"
import { groupChains, FgChainKind, type FgChainGrouping } from "./feature-graph/feature-graph-chains.mjs"
import { FeatureGraphHitTester, type FgCameraParams } from "./feature-graph/feature-graph-hit-test.mjs"
import type { FeatureGraphWorldPositions } from "./feature-graph/feature-graph-stages.mjs"
import {
    FeatureGraphOverlay,
    occlusionModeToInt,
    type FeatureGraphOcclusionMode,
} from "./feature-graph/feature-graph-overlay.mjs"
import { GizmoOverlay } from "./gizmo/gizmo-overlay.mjs"
import { nodePlacement, getNodeTranslation, setNodeTranslation, setNodeRotation } from "./gizmo/world-transform.mjs"
import { GIZMO_DEFAULT_SIZE_WORLD } from "./gizmo/gizmo-geometry.mjs"
import { SceneInfo } from "./scene/scene.mjs"
import { Extrude, Loft, ThreadedRod } from "./scene/scene.mjs"
import { setPath2DChordTol } from "./scene/primitives/path2d.mjs"
import type { Node } from "./scene/base.mjs"
import {
    SCENE_PARAMS_BYTE_SIZE,
    SCENE_PARAMS_F32_CAPACITY,
    PREVIEW_PARAMS_F32_BYTE_SIZE,
    PREVIEW_PARAMS_MAT3_BYTE_SIZE,
    PREVIEW_PARAMS_VEC2_BYTE_SIZE,
    PREVIEW_PARAMS_VEC3_BYTE_SIZE,
    PREVIEW_UNIFORM_F32_COUNT,
    PREVIEW_UNIFORM_MAT3_COUNT,
    PREVIEW_UNIFORM_VEC2_COUNT,
    PREVIEW_UNIFORM_VEC3_COUNT,
    PREVIEW_MAT3_PACK_FLOATS,
    packMat3ColumnMajorToPreviewOut,
    type PreviewParamsOut,
} from "./scene/scene-params.mjs"
import { eulerMatrices } from "./scene/transform-math.mjs"
import { Rotate } from "./scene/operators/rotate.mjs"
import { serializeSceneNodes } from "./scene-serializer.mjs"
import { vec3, Vec3f } from "./vecmat/vector.mjs"
import { lookAt, Mat4x4f } from "./vecmat/matrix.mjs"
import {
    DEFAULT_PREVIEW_SHADING,
    DEFAULT_RAY_MARCH_PARAMS,
    DEFAULT_SIMPLIFY_TUNING,
    type BuildTimingBreakdownMs,
    type MainToWorkerMessage,
    type PreviewShadingParams,
    type RayMarchParams,
    type RenderSelectionState,
    type SelectedEdgePayload,
    type SimplifyTuning,
} from "./render-worker-protocol.mjs"
import type { SelectionInfo } from "./components/preview-window.mjs"
import { EdgeKind } from "./edge-kind.mjs"
import { log, logWgsl } from "./logging/debug-log.mjs"
import { writeFps, SAB_LAYOUT, readSelectionStateFromSAB, getPublishedRenderSlot, getSlotByteOffset, SLOT_SIZE } from "./shared-render-buffer.mjs"

if (!isoSampleBatchShaderSource.includes("fn isoSampleBatch") || !isoSampleBatchShaderSource.includes("fn isoSampleBatchMid")) {
    throw new Error("iso_sample_batch.wgsl failed to bundle for render worker")
}

const MAX_POLYGON_VERTICES = 1024
// ×2: the buffer holds the vertex region [0, total) followed by a parallel
// per-vertex outward-normal region [total, 2·total) for smooth extrude shading
// (see SceneInfo.getPolygonVertexData). total ≤ MAX, so the normal region ends
// at ≤ 2·MAX vec2f.
const POLYGON_VERTEX_BUFFER_SIZE = MAX_POLYGON_VERTICES * 8 * 2
const EDGE_HITS_SIZE = 320
const SELECTED_EDGES_HEADER = 16
const SELECTED_EDGE_SIZE = 80
const SELECTED_EDGES_COUNT = 16
const SELECTED_EDGES_TOTAL = SELECTED_EDGES_HEADER + SELECTED_EDGES_COUNT * SELECTED_EDGE_SIZE

/**
 * Module-level zero buffers reused for the `writeBuffer` reset writes in
 * `handleClick` / `handleHover` / `handleDoubleClick` / `handlePickObject` /
 * `handlePickPos`. Each click/hover event used to allocate fresh small
 * ArrayBuffers (`new Uint32Array([0])`, `new Float32Array(4).buffer`,
 * `new ArrayBuffer(320)`); sharing read-only zero buffers avoids the alloc
 * churn — the contents are never mutated, just handed to `writeBuffer` which
 * copies into the GPU staging.
 */
const ZERO_U32 = new Uint32Array(1)
const ZERO_VEC4 = new ArrayBuffer(16)
const ZERO_EDGE_HITS = new ArrayBuffer(EDGE_HITS_SIZE)
// Bytes per deferred-shading G-buffer pixel — must match `GBufferPixel` in
// preview.wgsl (std430: five 16-byte rows). GPU-internal, never CPU-mapped.
const GBUFFER_STRIDE_BYTES = 80
// Auto-mode hovered-feature fade-in duration (ms) — quick, just enough to smooth
// the appearance from hidden.
const FG_HOVER_FADE_MS = 70
/**
 * Ray-origin push-back used when projecting FeatureGraph features for CPU
 * hit-testing — must match `PREVIEW_RAY_ORIGIN_DEPTH` in `camera-controller` /
 * the overlay shader's `camera.origin` (= cameraPosition + (0,0,this)).
 */
const FG_PICK_RAY_ORIGIN_DEPTH = 300
/** SAB `selectionMode` int encoding for the interactive feature modes. */
const SEL_MODE_EDGE = 2
const SEL_MODE_AUTO = 4
const SEL_MODE_CORNER = 5
/**
 * Used as the dummy 1-float upload when the scene has zero scene-params
 * (empty/default scene). Reused across builds — the GPU never reads more
 * than the bound buffer's first byte and only when nothing else does.
 */
const EMPTY_F32_SINGLE = new Float32Array([0])

/**
 * Pass names recognised by the per-pass GPU timestamp profiler. Order is the
 * encoding order in {@link RenderWorkerCore.render} / `#renderFromSAB` and is
 * the canonical layout for `#timestampFilledPasses` and `#passTimeAverages`.
 */
// "scene" = the SDF march (full fragmentMain pass, or the deferred geometry
// pass). "shade" = the deferred shade pass (G-buffer → frame, no SDF). On a
// selection-only repaint only "shade" runs, so scene-vs-shade is the win.
type ProfiledPassName = "beam" | "scene" | "shade" | "easu" | "fxaa" | "outline" | "overlay"
/** Max pass-time pairs per frame — sized to {@link ProfiledPassName}. */
const TIMESTAMP_MAX_PAIRS = 7
const TIMESTAMP_QUERY_COUNT = TIMESTAMP_MAX_PAIRS * 2
const TIMESTAMP_BYTES = TIMESTAMP_QUERY_COUNT * 8
/** Round to 2 decimal places for log output; avoids logging long fractional ms. */
const roundMs2 = (x: number): number => Math.round(x * 100) / 100

function float32SubarrayEqual(a: Float32Array, b: Float32Array, len: number): boolean {
    for (let i = 0; i < len; i++) {
        if (a[i] !== b[i]) return false
    }
    return true
}

/** Order-sensitive equality for isolate-id lists (small arrays). */
function sameIdList(a: readonly number[], b: readonly number[]): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false
    }
    return true
}

class UniformBuffers {
    camera!: GPUBuffer
    scene!: GPUBuffer
    clickState!: GPUBuffer
    clickedObjectId!: GPUBuffer
    selectedObjectIds!: GPUBuffer
    colorPalette!: GPUBuffer
    viewSettings!: GPUBuffer
    selectionStyles!: GPUBuffer
    polygonVertices!: GPUBuffer
    clickedHitPos!: GPUBuffer
    clickedNormal!: GPUBuffer
    faceSelection!: GPUBuffer
    /**
     * Flat f32 layout from `packSceneParams`. Bound at slot 6 in `bounds.wgsl`
     * (preview/exit-bounds compute) and slot 30 in `mdc.wgsl` / `sample_grid.wgsl`
     * / `iso_sample_batch.wgsl` (export + FG sampling). Same data either way,
     * so {@link boundsSceneParams} and {@link mdcSceneParams} alias one
     * `GPUBuffer` — eliminates a duplicate ~32–128KB allocation + a redundant
     * `writeBuffer` on every param-only build.
     */
    boundsSceneParams!: GPUBuffer
    /** Alias of {@link boundsSceneParams}; see that field for details. */
    mdcSceneParams!: GPUBuffer
    previewParamsF32!: GPUBuffer
    previewParamsVec2!: GPUBuffer
    previewParamsVec3!: GPUBuffer
    previewParamsMat3!: GPUBuffer
    /** Dense f32 mirror for cap drag (same logical indices as preview f32 uniforms). */
    previewCapParamDrag!: GPUBuffer
    rayMarchParams!: GPUBuffer
    edgeHit!: GPUBuffer
    selectedEdges!: GPUBuffer
    hoverEdgeHit!: GPUBuffer
    hoveredEdge!: GPUBuffer
    /** FSR1 EASU constants (con0..con3, 4x vec4<u32> = 64 bytes). */
    easuConst!: GPUBuffer
}

class ExportBuffers {
    scene!: GPUBuffer
    vertexBuffer!: GPUBuffer
    triangleBuffer!: GPUBuffer
    triCountBuffer!: GPUBuffer
}

export class RenderWorkerCore {
    #canvas!: OffscreenCanvas
    #device!: GPUDevice
    #context!: GPUCanvasContext
    #format!: GPUTextureFormat
    #helper!: GPUHelper
    #uniformBuffers = new UniformBuffers()
    #exportBuffers = new ExportBuffers()
    #colorSampler!: GPUSampler
    #outlineShaderModule!: GPUShaderModule
    #outlinePipeline!: GPURenderPipeline
    #outlineBindGroup!: GPUBindGroup | undefined
    // FSR1 spatial upscale (EASU) + optional FXAA post pass. Pipelines built
    // once in init(); bind groups + the full-res EASU output texture are
    // (re)created in `#ensureUpscaleTextures` when the scene/display size changes.
    #easuShaderModule!: GPUShaderModule
    #fxaaShaderModule!: GPUShaderModule
    #easuPipeline!: GPURenderPipeline
    #fxaaPipeline!: GPURenderPipeline
    #easuBindGroup: GPUBindGroup | undefined
    #fxaaBindGroup: GPUBindGroup | undefined
    #easuOutTexture: GPUTexture | undefined
    #easuOutView: GPUTextureView | undefined
    #easuOutWidth = 0
    #easuOutHeight = 0
    // EASU constants staging (16 f32 = con0..con3 bit-cast into the buffer).
    #easuConstBuf = new ArrayBuffer(64)
    #easuConstF32 = new Float32Array(this.#easuConstBuf)
    /** Key (`inW,inH,outW,outH`) the uploaded EASU constants were computed for. */
    #lastEasuKey = ""
    #scene: SceneInfo | null = null
    /** Aborts the in-flight mesh export when a newer `renderMesh` supersedes it. */
    #meshExportAbort?: AbortController
    /**
     * Feature-aware meshing scaffold. Phase A: extract + log; phase B: CPU
     * transform; phase D: GPU survival test via {@link IsoSampleBatch} + CPU
     * spatial index. Refreshed in the background by `#kickFeatureGraphBuild`
     * after every `#doBuild` completes — only when the overlay is enabled,
     * and only the latest kick wins (older kicks are superseded via
     * `#fgGeneration`) so slider-drag floods don't queue stale builds.
     */
    #featureGraph = new FeatureGraphGpu()
    /**
     * Cached iso_sample_batch shader module — compiled lazily by
     * `#ensureFeatureGraphIsoModule` the first time the FeatureGraph or
     * `handleRenderMesh` needs it, then reused until the scene's structural
     * fingerprint changes. Stays null when nothing has asked for it, which
     * keeps overlay-disabled sessions from paying a second WGSL codegen
     * pass on every structural rebuild.
     */
    #featureGraphIsoModule: GPUShaderModule | null = null
    /** Structural fingerprint the cached `#featureGraphIsoModule` was compiled against; null when stale. */
    #builtIsoModuleFingerprint: string | null = null
    /**
     * Lazy-constructed `IsoSampleBatch` shared by all FeatureGraph builds. The
     * underlying buffers (`polygonVertices`, `faceSelection`, `mdcSceneParams`)
     * are stable across builds, so one instance can be reused indefinitely;
     * its pipeline cache rebinds when `#featureGraphIsoModule` changes.
     */
    #featureGraphIsoBatch: IsoSampleBatch | null = null
    /** Lazy-constructed debug overlay pipeline; created on first frame. */
    #featureGraphOverlay: FeatureGraphOverlay | null = null
    // ----- Transform gizmo overlay (translate arrows + rotate rings) -----
    /** Lazy-constructed gizmo overlay pipeline; created when first shown. */
    #gizmoOverlay: GizmoOverlay | null = null
    #gizmoVisible = false
    #gizmoCenter: [number, number, number] = [0, 0, 0]
    /** Gizmo radius in world units (fixed world size; scales with zoom). */
    #gizmoWorldSize = GIZMO_DEFAULT_SIZE_WORLD
    #gizmoHoverHandle = -1
    #gizmoActiveHandle = -1
    /** Object world orientation (column-major 3×3) for the rotation rings. */
    #gizmoOrient: number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1]
    /** Active gizmo drag: the node + its base translation captured at drag start. */
    #gizmoDrag: { nodeId: number; base: [number, number, number] } | null = null
    // ----- Interactive FeatureGraph feature selection (edge/corner/auto) -----
    // Retained from the latest build so CPU hit-testing can run on click/hover.
    #fgCpu: FeatureGraphCpu | null = null
    #fgWorld: FeatureGraphWorldPositions | null = null
    #fgChains: FgChainGrouping | null = null
    #fgHitTester: FeatureGraphHitTester | null = null
    /** Selected polyline/ring chain ids (indices into `#fgChains.chains`). */
    #fgSelectedChains = new Set<number>()
    /** Selected corner FG vertex indices. */
    #fgSelectedCorners = new Set<number>()
    /** Auto-mode type lock: the first pick after a clear constrains the rest of the multiselect. */
    #fgAutoLockedType: "edge" | "corner" | null = null
    /** Currently hovered chain / corner-vertex (-1 = none). */
    #fgHoverChain = -1
    #fgHoverCorner = -1
    // Auto-mode hover fade-in: start time of the current hovered feature's fade
    // (-1 = no active fade), the previous hover key (to detect feature changes),
    // and the self-scheduled re-render timer that animates the fade.
    #fgHoverFadeStartMs = -1
    #fgLastHoverKey = ""
    #fgFadeTimer: ReturnType<typeof setTimeout> | null = null
    /**
     * Overlay depth-occlusion mode: 0 = off (draw on top), 1 = hard (hide
     * occluded edges, the default), 2 = dim (fade occluded edges). When non-zero
     * the renderer runs an extra depth-only raymarch pass ({@link #depthPipeline})
     * into {@link #sceneDepthTexture} so the overlay can depth-sort its lines
     * against the SDF surface. The always-on overlay defaults to hard; "off" is
     * no longer set from the app (kept for completeness).
     */
    #featureGraphOcclusionMode = 1
    /** Edge line width (framebuffer px) for the FeatureGraph overlay. */
    #featureGraphLineWidth = 2
    /** Color original creases green vs subdivided cyan in the overlay (default off ⇒ all cyan). */
    #featureGraphDifferentiateSegments = false
    /**
     * Lazily-built depth-only pipeline (preview shader's `depthOnlyMain` entry,
     * rgba32float target). Compiled from {@link #sceneShader} on first use of an
     * occlusion mode and rebuilt whenever the scene shader changes — tracked via
     * {@link #depthPipelineShader} so neither build path needs to invalidate it.
     */
    #depthPipeline: GPURenderPipeline | null = null
    #depthPipelineShader: GPUShaderModule | null = null
    #depthBindGroup: GPUBindGroup | null = null
    #sceneDepthTexture?: GPUTexture
    #sceneDepthTextureView?: GPUTextureView
    /** 1-pixel MAP_READ staging for reading cursor surface depth (FG occlusion). */
    #occlusionReadback?: GPUBuffer
    #occlusionReadbackBusy = false
    #sceneDepthW = 0
    #sceneDepthH = 0
    /**
     * When true, the preview shader replaces shaded color with a per-pixel
     * `sceneSDF_fast` step-count heatmap (blue → green → yellow → red,
     * normalised against `rayMarchParams.maxSteps`). Pixel-level cost
     * visualisation, complement to the per-pass timestamp profiler.
     */
    #stepHeatmapEnabled = false
    /**
     * Serializes background FeatureGraph builds kicked off from `#doBuild`
     * (the build path no longer awaits them). Each kick chains onto the
     * previous, and a generation counter lets newer kicks supersede older
     * ones queued behind the chain.
     */
    #fgBuildLock: Promise<void> = Promise.resolve()
    #fgGeneration = 0
    #sceneShader: GPUShaderModule | null = null
    #pipeline: GPURenderPipeline | null = null
    #beamPipeline: GPUComputePipeline | null = null
    #beamBindGroupInvalid = false
    #sceneBindGroupInvalid = false
    // Deferred selection shading (knob: #deferredShading). geometryMain marches
    // the SDF + bakes AO/lighting into the per-pixel G-buffer; shadeMain runs
    // only the selection-dependent tail. Lets selection/hover repaints skip the
    // SDF entirely (Phase 2). Best-effort: `#prepareDeferred` falls back to the
    // proven single-pass `fragmentMain` whenever it can't run (pipelines not yet
    // compiled, x-ray mode, or G-buffer over maxStorageBufferBindingSize).
    // ON by default: the dominant CAD interaction is selecting/hovering on a
    // static view, which deferred makes a no-march repaint.
    #deferredShading = true
    #geometryPipeline: GPURenderPipeline | null = null
    #shadePipeline: GPURenderPipeline | null = null
    // FeatureGraph overlay occlusion depth reconstructed from the G-buffer (no
    // 2nd SDF march) — used in place of #depthPipeline when deferred is active.
    #occlusionGbufferPipeline: GPURenderPipeline | null = null
    #geometryBindGroup: GPUBindGroup | null = null
    #shadeBindGroup: GPUBindGroup | null = null
    #occlusionGbufferBindGroup: GPUBindGroup | null = null
    // Bumped on every scene rebuild / invalidation so an in-flight async
    // deferred-pipeline compile for a stale shader is discarded.
    #deferredPipelineGen = 0
    // Phase 2 fast path: hash of the geometry-relevant SAB fields (camera /
    // resolution / shading / ray-march — everything the G-buffer depends on)
    // from the last frame that ran the geometry pass, plus the build generation
    // it was valid for. A new frame whose geometry hash + build gen match can
    // reuse the retained G-buffer and run shade-only (selection/hover changed,
    // geometry didn't). -1 = no geometry pass recorded yet.
    #lastGeometryHash = -1
    #lastGeometryBuildGen = -1
    #gbuffer: GPUBuffer | null = null
    // Grow-only capacity in pixels: a reduced-res motion frame reuses the
    // full-res allocation rather than churning a ~hundreds-of-MB buffer on every
    // resolution-scale flip. Shader stride uses the per-frame camera.res, so any
    // frame with w*h ≤ capacity indexes a valid prefix.
    #gbufferCapacityPx = 0
    #bvhEnabled = true
    #buildGeneration = 0
    #buildLock: Promise<void> = Promise.resolve()
    #compiledPosY = new Map<number, number>()
    #colorTexture!: GPUTexture
    #tStartTexture!: GPUTexture
    #colorTextureView!: GPUTextureView
    #tStartTextureView!: GPUTextureView
    #bindGroup?: GPUBindGroup
    #beamBindGroup?: GPUBindGroup
    #renderTextureWidth = 0
    #renderTextureHeight = 0
    #fullWidth = 0
    #fullHeight = 0
    #framerate = new AveragedBuffer(4)
    #lastRenderTime = 0
    #fpsFrameCount = 0
    #lastFpsSendTime = 0
    #lightDirBuf = new Float32Array(12)
    // [0..6]=xray,heatmap,beam,selMode,ghost,flatShading,debugTessEdges (matches
    // ViewSettings in preview.wgsl); padded to 8 (32 bytes) for uniform 16-byte alignment.
    #viewSettingsBuf = new Uint32Array(8)
    #selDataBuf = new Uint32Array(1024)
    // OutlineSettings CPU mirrors removed — selection rendering moved
    // inline into preview.wgsl, so the post-process pass has no per-frame
    // uniforms to upload.
    #selectionStylesBuf = new ArrayBuffer(80)
    #selectionStylesF32 = new Float32Array(this.#selectionStylesBuf)
    #edgeHeaderBuf = new ArrayBuffer(SELECTED_EDGES_HEADER)
    #edgeHeaderU32 = new Uint32Array(this.#edgeHeaderBuf)
    #edgeStrideBuf = new ArrayBuffer(SELECTED_EDGE_SIZE)
    #edgeStrideU32 = new Uint32Array(this.#edgeStrideBuf)
    #edgeStrideF32 = new Float32Array(this.#edgeStrideBuf)
    #camTransform = new Mat4x4f(new Float32Array(16))
    /** Dirty-state caches: last uploaded bytes. Compare before writeBuffer to skip redundant uploads. */
    #cameraCache = new ArrayBuffer(256)
    #viewSettingsCache = new ArrayBuffer(32)
    #selectionStylesCache = new ArrayBuffer(80)
    #selectedIdsCache = new ArrayBuffer(4096)
    #selectedEdgesCache = new ArrayBuffer(SELECTED_EDGES_TOTAL)
    #hoveredEdgesCache = new ArrayBuffer(SELECTED_EDGES_TOTAL)
    #cameraStagingBuf = new ArrayBuffer(256)
    /**
     * Cache of the 39 input scalars passed to `#uploadCameraIfDirty`
     * (viewTransform[16] + cameraPosition[3] + width/height[2] + zoom[1] +
     * viewCenter[2] + previewShading[14] + previewNormalShading[1]).
     * Compared per-frame to short-circuit the matrix inverse + 4 light-dir
     * transforms when nothing actually changed — the steady-state idle case
     * while the user isn't moving the camera.
     */
    #cameraInputCache = new Float32Array(39)
    #cameraInputValid = false
    #rayMarchParamsBuf = new ArrayBuffer(32)
    #rayMarchParamsI32 = new Int32Array(this.#rayMarchParamsBuf)
    #rayMarchParamsF32 = new Float32Array(this.#rayMarchParamsBuf)
    #rayMarchParamsCache = new ArrayBuffer(32)
    #edgesStagingBuf = new ArrayBuffer(SELECTED_EDGES_TOTAL)
    /** Worker-owned staging for SAB snapshot; max(SELECTED_OBJECT_IDS_SIZE, SELECTED_EDGES_TOTAL) */
    #sabStagingBuf = new ArrayBuffer(4096)
    #lastRenderMsg: Extract<MainToWorkerMessage, { type: "render" }> | null = null
    #lastSharedBuffer: SharedArrayBuffer | null = null
    /**
     * Hash (FNV-1a, u32) of the SAB slot bytes the worker most recently
     * rendered from. `#renderFromSAB` short-circuits when the freshly
     * published slot hashes to the same value AND `#forceNextRender` is
     * unset — catches main-thread version bumps that didn't actually
     * change any render-relevant state.
     */
    #lastRenderedSabHash = 0
    /**
     * Force the next frame to render even if its SAB hash matches the
     * previous one. Set by async worker-side state changes that don't go
     * through SAB (FeatureGraph overlay vertex/index upload; overlay/heatmap
     * toggles; pipeline rebuild). Reset to `false` after each rendered frame.
     * Starts `true` so the very first frame always renders.
     */
    #forceNextRender = true
    /** CPU mirrors for preview param banks: `#uploadBuildBuffers` syncs packed arrays into shadows and uploads used prefixes. */
    #previewF32Shadow!: Float32Array
    #previewVec2Shadow!: Float32Array
    #previewVec3Shadow!: Float32Array
    #previewMat3Shadow!: Float32Array
    /**
     * Reusable target struct handed to `scene.packPreviewParamsInto`. Always
     * points at the four shadow arrays above so the pack call writes
     * directly into the worker's CPU mirror — no per-build allocations and
     * no follow-up `shadow.set(p.f32)` mirror copy.
     */
    #previewPackTarget!: PreviewParamsOut
    /**
     * Reusable scratch handed to `scene.packSceneParamsInto`. Sized for the
     * worst case (`SCENE_PARAMS_F32_CAPACITY`) so the pack call never
     * allocates. Distinct from `#lastSceneParamUpload` (the dedup cache) so
     * we don't poison the cache mid-pack.
     */
    #sceneParamPackScratch = new Float32Array(SCENE_PARAMS_F32_CAPACITY)
    #lastSelectionMode = 0
    #builtBody: string | null = null
    /** Set after a successful full shader rebuild; used to skip compilation when `structuralFingerprint()` is unchanged. */
    #builtStructuralFingerprint: string | null = null
    /** "View Isolated" node ids (empty = full scene). The preview SDF is RECOMPILED
     * from {@link SceneInfo.isolationRoot} when this changes — there is no render-time
     * isolate scaffolding in the live shader. Drives the compile root in `#doBuild`. */
    #isolatedIds: number[] = []
    /** The `#isolatedIds` the current `#sceneShader` was compiled against — lets a
     * param-only rebuild stay param-only when isolation is unchanged, and forces a
     * full recompile (agent path) when it differs. */
    #builtIsolatedIds: number[] = []
    #fpsVersion = 0
    /** Pre-allocated dedup caches (param-only); `-1` length = never uploaded. */
    #lastSceneParamUpload = new Float32Array(SCENE_PARAMS_F32_CAPACITY)
    #lastSceneParamLen = -1
    #lastPolygonVertexUpload = new Float32Array(POLYGON_VERTEX_BUFFER_SIZE / Float32Array.BYTES_PER_ELEMENT)
    /** Length in *f32 elements* of the most recently uploaded polygon payload, or `-1` if never. */
    #lastPolygonVertexLen = -1
    #lastPreviewF32Upload = new Float32Array(PREVIEW_UNIFORM_F32_COUNT)
    #lastPreviewF32Len = -1
    #lastPreviewVec2Upload = new Float32Array(PREVIEW_UNIFORM_VEC2_COUNT * 2)
    #lastPreviewVec2Len = -1
    #lastPreviewVec3Upload = new Float32Array(PREVIEW_UNIFORM_VEC3_COUNT * 4)
    #lastPreviewVec3Len = -1
    #lastPreviewMat3Upload = new Float32Array(PREVIEW_UNIFORM_MAT3_COUNT * PREVIEW_MAT3_PACK_FLOATS)
    #lastPreviewMat3Len = -1
    /**
     * Per-pass GPU profiling. Null when the device wasn't created with
     * `timestamp-query` (e.g. Chrome without `--enable-unsafe-webgpu`); in
     * that case `render()` simply omits `timestampWrites` from pass
     * descriptors and the four `AveragedBuffer`s stay empty.
     *
     * Layout: up to 4 pairs of timestamps (beam, scene, outline, overlay)
     * × 8 bytes each = 64 bytes. `#timestampFilledPasses` records which
     * passes actually wrote a pair this frame — overlay (and beam, when
     * disabled) may skip, in which case its slot stays empty for that frame.
     */
    #timestampQuerySet: GPUQuerySet | null = null
    #timestampResolveBuffer: GPUBuffer | null = null
    #timestampStagingBuffer: GPUBuffer | null = null
    /** True between submit and `mapAsync` resolution. Skips profiling for frames that arrive while we're still reading the previous one back. */
    #timestampBusy = false
    /** Names of the passes whose timestamp pairs were written this frame, in encode order. */
    #timestampFilledPasses: ProfiledPassName[] = []
    /** Rolling pass-time averages in milliseconds. Empty when timestamp-query unavailable. */
    #passTimeAverages: Record<ProfiledPassName, AveragedBuffer> = {
        beam: new AveragedBuffer(30),
        scene: new AveragedBuffer(30),
        shade: new AveragedBuffer(30),
        easu: new AveragedBuffer(30),
        fxaa: new AveragedBuffer(30),
        outline: new AveragedBuffer(30),
        overlay: new AveragedBuffer(30),
    }
    /** Frames since last profiling log. Reported every ~60 frames to avoid console spam. */
    #passTimeLogFrames = 0
    /**
     * Per-frame context surfaced in the `gpu pass times` log so each emitted
     * line is self-describing. Lets a lighting-cost A/B (read `scene` ms with
     * AO on vs off) be read straight from the devserver `/_logs` bridge: filter
     * to full-res lines (`scale:1`) and compare `scene` across `ao:0` vs `ao:>0`.
     * `xray`/`deferred` are logged too because both change scene-pass cost.
     */
    #profileCtx = { ao: 0, scale: 1, w: 0, h: 0 }
    /** Persistent MAP_READ staging for click/hover (no per-interaction alloc). */
    #clickIdReadback!: GPUBuffer
    #edgeHitReadback!: GPUBuffer
    #hitPosReadback!: GPUBuffer
    #clickNormalReadback!: GPUBuffer
    #hoverEdgeHitReadback!: GPUBuffer
    /** Guards against concurrent mapAsync on persistent readback buffers (async onmessage can interleave). */
    #clickReadbackBusy = false
    #hoverReadbackBusy = false

    async init(canvas: OffscreenCanvas): Promise<void> {
        this.#canvas = canvas
        const helper = await GPUHelper.create()
        if (!helper) {
            throw new Error("No GPU adapter found", { cause: "unsupported" })
        }
        this.#helper = helper
        this.#device = this.#helper.device
        this.#context = canvas.getContext("webgpu") as GPUCanvasContext
        if (!this.#context) {
            throw new Error("Failed to get WebGPU context from OffscreenCanvas")
        }

        this.#format = navigator.gpu.getPreferredCanvasFormat()
        this.#context.configure({
            device: this.#device,
            format: this.#format,
            alphaMode: "premultiplied",
            // RENDER_ATTACHMENT for the FG overlay pass + the (now-fallback)
            // outline blit pass; COPY_DST for the copyTextureToTexture fast
            // path that replaces the outline pass when the scene-color
            // texture is already at canvas resolution (no halfres in effect).
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
        })

        this.#createBuffers()

        this.#colorSampler = this.#device.createSampler({
            magFilter: "linear",
            minFilter: "linear",
        })

        // Post-process pipelines (outline blit, FSR1 EASU, FXAA). Their pipelines
        // are compiled CONCURRENTLY via createRenderPipelineAsync + Promise.all
        // instead of three sequential synchronous createRenderPipeline calls, which
        // blocked worker startup. None of these are needed for the first
        // interactive frame, but awaiting here (in parallel) keeps the fields
        // populated before any render runs, so no readiness guards are needed.
        // Bind groups for EASU/FXAA are created lazily in `#ensureUpscaleTextures`.
        this.#outlineShaderModule = this.#device.createShaderModule({ label: "Outline Post-Process", code: outlineShader })
        scheduleShaderModuleCompilationLogging(this.#outlineShaderModule, "Outline Post-Process", outlineShader)
        this.#easuShaderModule = this.#device.createShaderModule({ label: "FSR1 EASU", code: easuShader })
        scheduleShaderModuleCompilationLogging(this.#easuShaderModule, "FSR1 EASU", easuShader)
        this.#fxaaShaderModule = this.#device.createShaderModule({ label: "FXAA", code: fxaaShader })
        scheduleShaderModuleCompilationLogging(this.#fxaaShaderModule, "FXAA", fxaaShader)
        try {
            const [outlinePipeline, easuPipeline, fxaaPipeline] = await Promise.all([
                this.#device.createRenderPipelineAsync({
                    label: "Outline Pipeline",
                    layout: "auto",
                    vertex: { module: this.#outlineShaderModule, entryPoint: "vertexMain" },
                    fragment: { module: this.#outlineShaderModule, entryPoint: "fragmentMain", targets: [{ format: this.#format }] },
                    primitive: { topology: "triangle-strip", stripIndexFormat: "uint32" },
                }),
                this.#device.createRenderPipelineAsync({
                    label: "FSR1 EASU Pipeline",
                    layout: "auto",
                    vertex: { module: this.#easuShaderModule, entryPoint: "vertexMain" },
                    fragment: { module: this.#easuShaderModule, entryPoint: "fragmentMain", targets: [{ format: this.#format }] },
                    primitive: { topology: "triangle-strip", stripIndexFormat: "uint32" },
                }),
                this.#device.createRenderPipelineAsync({
                    label: "FXAA Pipeline",
                    layout: "auto",
                    vertex: { module: this.#fxaaShaderModule, entryPoint: "vertexMain" },
                    fragment: { module: this.#fxaaShaderModule, entryPoint: "fragmentMain", targets: [{ format: this.#format }] },
                    primitive: { topology: "triangle-strip", stripIndexFormat: "uint32" },
                }),
            ])
            this.#outlinePipeline = outlinePipeline
            this.#easuPipeline = easuPipeline
            this.#fxaaPipeline = fxaaPipeline
        } catch (err) {
            const text = err instanceof Error ? (err.stack ?? err.message) : String(err)
            logWgsl("error", `Post-process pipeline creation failed: ${text}`)
            throw err
        }

        // Outline bind group created in ensureRenderTextures when we have color/id textures

        // Init click/selection/face buffers
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickState, 0, new ArrayBuffer(32))
        this.#device.queue.writeBuffer(this.#uniformBuffers.selectedObjectIds, 0, new Uint32Array(1024))
        this.#device.queue.writeBuffer(this.#uniformBuffers.faceSelection, 0, new ArrayBuffer(32))

        // Init empty edges
        this.#writeEdgesToBuffer(
            this.#uniformBuffers.selectedEdges,
            [],
            DEFAULT_SELECTION_STYLES.edge.lineWidthPx,
            DEFAULT_SELECTION_STYLES.edge.epsilon,
        )
        this.#writeEdgesToBuffer(this.#uniformBuffers.hoveredEdge, [], 6.0, 0.02)

        // Allocate per-pass GPU timestamp infrastructure when the device
        // exposes `timestamp-query`. One staging buffer + busy flag: frames
        // arriving while a readback is still in flight render without
        // profiling, so the sampler self-throttles instead of stalling the
        // render loop on `mapAsync`.
        if (this.#helper.hasTimestampQuery) {
            this.#timestampQuerySet = this.#device.createQuerySet({
                label: "RenderPassTimestamps",
                type: "timestamp",
                count: TIMESTAMP_QUERY_COUNT,
            })
            this.#timestampResolveBuffer = this.#device.createBuffer({
                label: "RenderPassTimestamps.Resolve",
                size: TIMESTAMP_BYTES,
                usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
            })
            this.#timestampStagingBuffer = this.#device.createBuffer({
                label: "RenderPassTimestamps.Staging",
                size: TIMESTAMP_BYTES,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            })
        }
    }

    async build(
        body: string,
        _documentName?: string | null,
        tessDetailFactor?: number,
    ): Promise<
        | {
              sceneNodes: import("./render-worker-protocol.mjs").SerializedNode[]
              compiledPosY: [number, number][]
              timingMs: BuildTimingBreakdownMs
          }
        | { superseded: true }
    > {
        const prev = this.#buildLock
        let release!: () => void
        this.#buildLock = new Promise<void>(r => (release = r))
        await prev
        try {
            // Build-time tessellation density. The size-adaptive default
            // (absolute floor + world-extent term) is scaled by the dev-tools
            // "Tess detail" factor (1 = default; higher = denser). This is a
            // manual, zoom-independent control — the extrude preview shades
            // smoothly at any zoom via precomputed per-vertex normals, so density
            // only trades curve/silhouette fidelity against per-pixel SDF cost.
            const f = tessDetailFactor && tessDetailFactor > 0 ? tessDetailFactor : 1
            setPath2DChordTol(0.01 / f, 0.0015 / f)
            return await this.#doBuild(body)
        } finally {
            release()
        }
    }

    setBvhEnabled(enabled: boolean): void {
        this.#bvhEnabled = enabled
    }

    /**
     * Toggle deferred selection shading. When on (and the geometry/shade
     * pipelines built), the scene pass runs as geometryMain (SDF → G-buffer)
     * then shadeMain (G-buffer → selection-tinted frame) instead of a single
     * fragmentMain pass — the prerequisite for the selection-only fast repaint.
     * x-ray and any frame whose G-buffer would exceed the storage limit fall
     * back to the single pass automatically. Worker-internal, so force the next
     * render past the SAB-hash idle skip.
     */
    setDeferredShading(enabled: boolean): void {
        if (this.#deferredShading === enabled) return
        this.#deferredShading = enabled
        // Compile the geometry/shade pipelines on first enable (lazy — the
        // default-off path never pays for them). Until they're ready, renders
        // fall back to the single pass.
        if (enabled) void this.#ensureDeferredPipelines()
        this.#forceNextRender = true
    }

    /**
     * Toggle the per-pixel `sceneSDF_fast` step-count heatmap in the preview
     * shader. Picked up on the next render frame; no immediate re-render is
     * triggered (the user typically toggles and then interacts, which kicks
     * a render naturally).
     */
    setStepHeatmapEnabled(enabled: boolean): void {
        if (this.#stepHeatmapEnabled === enabled) return
        this.#stepHeatmapEnabled = enabled
        // Worker-internal state change — SAB hasn't moved, but the rendered
        // output would differ, so the SAB-hash idle skip needs a one-shot
        // override to actually pick this up on the next render kick.
        this.#forceNextRender = true
    }


    /**
     * Set the FeatureGraph overlay's depth-occlusion mode (toolbar toggle):
     * "hard" hides edges behind the SDF surface (default), "dim" fades them
     * ("off" draws on top but is no longer set from the app). Picked up on the
     * next frame; the depth pipeline + texture are allocated lazily.
     */
    setFeatureGraphOcclusionMode(mode: FeatureGraphOcclusionMode): void {
        const next = occlusionModeToInt(mode)
        if (this.#featureGraphOcclusionMode === next) return
        this.#featureGraphOcclusionMode = next
        this.#forceNextRender = true
    }

    /** Set the FeatureGraph overlay edge line width (framebuffer px). */
    setFeatureGraphLineWidth(px: number): void {
        if (this.#featureGraphLineWidth === px) return
        this.#featureGraphLineWidth = px
        this.#forceNextRender = true
    }

    /** Toggle original-vs-subdivided overlay edge coloring (off ⇒ all cyan). */
    setFeatureGraphDifferentiateSegments(on: boolean): void {
        if (this.#featureGraphDifferentiateSegments === on) return
        this.#featureGraphDifferentiateSegments = on
        this.#forceNextRender = true
    }

    /** Reply with the world-space center (+ local half-extents + world→local
     * linear inverse) of a scene node, for gizmo placement and drag conversion.
     * The center pushes the node's local bbox center back out through ancestor
     * transforms so it lines up with the rendered surface. */
    handleGetNodeBounds(nodeId: number, requestId: number): void {
        let bounds:
            | { center: [number, number, number]; half: [number, number, number]; invLinear: number[]; orient: number[]; rotateNodeId: number; rotateEuler: [number, number, number] }
            | null = null
        const scene = this.#scene
        const node = scene?.get(nodeId)
        const b = node?.computeBounds()
        if (scene && b) {
            const placed = nodePlacement(scene.root, nodeId)
            bounds = {
                center: placed?.center ?? [b.cx, b.cy, b.cz],
                half: [b.hx, b.hy, b.hz],
                invLinear: placed?.invLinear ?? [1, 0, 0, 0, 1, 0, 0, 0, 1],
                orient: placed?.orient ?? [1, 0, 0, 0, 1, 0, 0, 0, 1],
                rotateNodeId: placed?.rotateNodeId ?? 0,
                rotateEuler: placed?.rotateEuler ?? [0, 0, 0],
            }
        }
        self.postMessage({ type: "nodeBoundsResult", bounds, requestId })
    }

    /** Begin a gizmo drag: capture the node's base translation (translate) for
     * live preview. For rotate, `nodeId` is the Rotate node (set absolutely). */
    gizmoBegin(nodeId: number, kind: "translate" | "rotate"): void {
        const node = this.#scene?.get(nodeId)
        if (!node) { this.#gizmoDrag = null; return }
        const base = kind === "translate" ? getNodeTranslation(node) : ([0, 0, 0] as [number, number, number])
        this.#gizmoDrag = base ? { nodeId, base } : null
    }

    /** Live-preview a gizmo drag with a TARGETED slot patch (one tiny
     * `writeBuffer`, no full repack/recompile) so it stays interactive on big
     * scenes. Falls back to a full param re-pack for nodes whose slots we don't
     * recognise. */
    gizmoPreview(msg: Extract<MainToWorkerMessage, { type: "gizmoPreview" }>): void {
        const drag = this.#gizmoDrag
        const node = drag ? this.#scene?.get(drag.nodeId) : null
        if (!drag || !node) return
        let patched = false
        if (msg.translate) {
            const t = msg.translate
            const p: [number, number, number] = [drag.base[0] + t[0], drag.base[1] + t[1], drag.base[2] + t[2]]
            setNodeTranslation(node, p)
            if (node.previewVec3Slot >= 0) {
                this.#patchPreviewVec3(node.previewVec3Slot, p)
                patched = true
            }
        } else if (msg.rotate) {
            setNodeRotation(node, msg.rotate)
            if (node.rotPreviewMat3Slot >= 0) {
                // Primitive rot field: only the inverse matrix is read by warpRot.
                this.#patchPreviewMat3(node.rotPreviewMat3Slot, eulerMatrices(node.rot.x, node.rot.y, node.rot.z).inv)
                patched = true
            } else if (node instanceof Rotate && node.previewMat3Slot >= 0) {
                const { inv, fwd } = node.getWgslMatrices()
                this.#patchPreviewMat3(node.previewMat3Slot, inv)
                this.#patchPreviewMat3(node.previewMat3Slot + 1, fwd)
                patched = true
            }
        }
        if (!patched) this.#repackAndUploadParams()
        this.#forceNextRender = true
    }

    /** Write one vec3 (vec4-packed) slot of `previewParamsVec3` from the shadow. */
    #patchPreviewVec3(slot: number, v: readonly [number, number, number]): void {
        const f = this.#previewVec3Shadow
        const b = slot * 4
        f[b] = v[0]; f[b + 1] = v[1]; f[b + 2] = v[2]; f[b + 3] = 0
        this.#device.queue.writeBuffer(this.#uniformBuffers.previewParamsVec3, slot * 16, f.buffer, f.byteOffset + slot * 16, 16)
        this.#lastPreviewVec3Len = -1 // patched out-of-band; force full re-upload on next build
    }

    /** Write one mat3 slot of `previewParamsMat3` (column-major flat 9) from the shadow. */
    #patchPreviewMat3(slot: number, colMajor9: number[]): void {
        const f = this.#previewMat3Shadow
        packMat3ColumnMajorToPreviewOut(f, slot, colMajor9)
        const stride = PREVIEW_MAT3_PACK_FLOATS * 4
        this.#device.queue.writeBuffer(this.#uniformBuffers.previewParamsMat3, slot * stride, f.buffer, f.byteOffset + slot * stride, stride)
        this.#lastPreviewMat3Len = -1
    }

    /** End a gizmo drag; the pointer-up source edit + rebuild re-syncs the scene. */
    gizmoEnd(): void {
        this.#gizmoDrag = null
    }

    /**
     * Apply a structure-preserving incremental param edit: set one node's
     * transform absolutely and patch its (stable) preview slot in place — no DSL
     * re-eval, full re-pack, or shader recompile. Used by the gizmo commit, a
     * manual numeric-literal edit, and undo/redo of either (the main thread gates
     * eligibility; see docs/plans/gizmo-incremental-param-edit.md). A missing node
     * means the structure changed under us — the caller falls back to a full build.
     */
    paramPatch(msg: Extract<MainToWorkerMessage, { type: "paramPatch" }>): void {
        const scene = this.#scene
        const node = scene?.get(msg.nodeId)
        if (!scene || !node) return
        let patched = false
        if (msg.kind === "translate") {
            setNodeTranslation(node, msg.value)
            if (node.previewVec3Slot >= 0) {
                this.#patchPreviewVec3(node.previewVec3Slot, msg.value)
                patched = true
            }
        } else {
            setNodeRotation(node, msg.value)
            if (node.rotPreviewMat3Slot >= 0) {
                this.#patchPreviewMat3(node.rotPreviewMat3Slot, eulerMatrices(node.rot.x, node.rot.y, node.rot.z).inv)
                patched = true
            } else if (node instanceof Rotate && node.previewMat3Slot >= 0) {
                const { inv, fwd } = node.getWgslMatrices()
                this.#patchPreviewMat3(node.previewMat3Slot, inv)
                this.#patchPreviewMat3(node.previewMat3Slot + 1, fwd)
                patched = true
            }
        }
        if (!patched) this.#repackAndUploadParams()
        // The node's transform changed in place; its memoized bounds (used by the
        // gizmo re-anchor's getNodeBounds) are now stale. Drop the memo so the gizmo
        // follows the moved/rotated object instead of snapping to the old center.
        scene.invalidateBoundsCache()
        this.#forceNextRender = true
    }

    /** Re-pack scene + preview param banks from the (mutated) in-memory scene and
     * re-upload them — the param-only build path minus the DSL re-eval. No shader
     * recompile; just new buffer contents. */
    #repackAndUploadParams(): void {
        const scene = this.#scene
        if (!scene) return
        const sceneParamLen = scene.packSceneParamsInto(this.#sceneParamPackScratch)
        const sceneParamUpload = sceneParamLen > 0 ? this.#sceneParamPackScratch.subarray(0, sceneParamLen) : EMPTY_F32_SINGLE
        const previewLens = scene.packPreviewParamsInto(this.#previewPackTarget)
        const previewPacked: PreviewParamsOut = {
            f32: this.#previewF32Shadow.subarray(0, previewLens.f32),
            vec2: this.#previewVec2Shadow.subarray(0, previewLens.vec2),
            vec3: this.#previewVec3Shadow.subarray(0, previewLens.vec3),
            mat3: this.#previewMat3Shadow.subarray(0, previewLens.mat3),
        }
        const polygonVertexData = scene.totalPolygonVertices > 0 ? scene.getPolygonVertexData() : null
        this.#uploadBuildBuffers(scene, polygonVertexData, sceneParamUpload, previewPacked, true)
        this.#forceNextRender = true
    }

    /** Update the transform-gizmo overlay state. The gizmo is drawn each frame
     * (re-projected from its stored world anchor) so it tracks camera moves with
     * no further messages; this just sets visibility / anchor / handle state. */
    setGizmo(msg: Extract<MainToWorkerMessage, { type: "setGizmo" }>): void {
        this.#gizmoVisible = msg.visible
        // Construct the overlay (compiles its shader + pipelines) here, outside
        // the frame encode, the first time the gizmo is shown.
        if (msg.visible && !this.#gizmoOverlay) {
            this.#gizmoOverlay = new GizmoOverlay(this.#helper, this.#format)
        }
        if (msg.center) this.#gizmoCenter = msg.center
        if (msg.sizeWorld !== undefined) this.#gizmoWorldSize = msg.sizeWorld
        if (msg.orient) this.#gizmoOrient = msg.orient
        this.#gizmoHoverHandle = msg.hoverHandle ?? -1
        this.#gizmoActiveHandle = msg.activeHandle ?? -1
        this.#forceNextRender = true
    }

    cancelBuilds(): void {
        this.#buildGeneration++
        // Supersede any in-flight background FG build too — its upload is
        // gated on `#fgGeneration` matching, so newer kicks always win.
        this.#fgGeneration++
    }

    /** Record the "View Isolated" selection. Pure state — the recompile + render
     * is done by {@link recompileIsolation} (interactive) or the next `#doBuild`
     * (agent / structural edit). Kept separate so the message handler can update
     * state synchronously before either path runs. */
    setIsolatedIds(ids: readonly number[]): void {
        this.#isolatedIds = [...ids]
    }

    /**
     * Compile the preview SDF (from `sdfRoot`) + aux/edge helpers into the
     * Preview+Beam shader module and its render/beam pipelines. Shared by full
     * builds (`#doBuild`) and isolate recompiles (`recompileIsolation`). Does NOT
     * touch GPU param buffers — callers own buffer upload; the isolate root reuses
     * the already-uploaded full-scene params. Bumps `#buildGeneration`; returns
     * `{ superseded: true }` if a newer build/recompile started while the async
     * pipelines were compiling.
     */
    async #buildScenePipelines(
        scene: SceneInfo,
        sdfRoot: Node,
    ): Promise<
        | {
              pipeline: GPURenderPipeline
              beamPipeline: GPUComputePipeline
              shader: GPUShaderModule
              t: {
                  wgslSceneMs: number
                  compileAuxPreviewMs: number
                  compileAuxFastPreviewMs: number
                  compileForPreviewMs: number
                  compileFastForPreviewMs: number
                  compileEdgeHelpersMs: number
                  shaderModulesMs: number
                  pipelinesMs: number
              }
          }
        | { superseded: true }
    > {
        const tWgsl0 = performance.now()
        const sceneAux = scene.compileAuxPreview()
        const tAux = performance.now()
        const sceneAuxFast = scene.compileAuxFastPreview()
        const tAuxFast = performance.now()
        // NOTE: the MID variant (sceneAuxMid/sceneSDF_mid) is NOT generated here —
        // preview.wgsl has no `//:) insert sceneSDF_mid` marker and the preview/beam
        // shader never references it. The mesh-export / feature-graph path compiles
        // MID separately (see compileAuxMid()/compileMid()).
        const sceneSDF = scene.compileForPreview(sdfRoot)
        const tSdf = performance.now()
        const sceneSDF_fast = scene.compileFastForPreview(sdfRoot)
        const tSdfFast = performance.now()
        const ghostSDFFast = scene.compileGhostFastForPreview()
        const sceneEdgeHelpers = scene.compileEdgeHelpers()
        const sceneLatheEdgeHitCases = scene.compileLathePrimitiveEdgeHitCases()
        const sceneLatheRingDistanceCases = scene.compileLathePrimitiveRingDistanceCases()
        const tWgsl1 = performance.now()

        const shaderCompiler = new ShaderCompiler(this.#device)
            .replace("insert", "sceneAuxFast", sceneAuxFast)
            .replace("insert", "sceneAux", sceneAux)
            .replace("insert", "sceneSDF_fast", sceneSDF_fast)
            .replace("insert", "sceneSDF", sceneSDF)
            .replace("insert", "ghostSDF_fast", ghostSDFFast)
            .replace("insert", "sceneEdgeHelpers", sceneEdgeHelpers)
            .replace("insert", "sceneLatheEdgeHitCases", sceneLatheEdgeHitCases)
            .replace("insert", "sceneLatheRingDistanceCases", sceneLatheRingDistanceCases)

        const tShaderMod0 = performance.now()
        const nextShader = shaderCompiler.compile(previewShader, "Preview + Beam")
        const tShaderMod1 = performance.now()

        // Iso_sample_batch module is deferred — `#ensureFeatureGraphIsoModule`
        // produces it on demand. Invalidate it here: a new scene SDF was emitted.
        this.#featureGraphIsoModule = null
        this.#builtIsoModuleFingerprint = null

        this.#buildGeneration++
        const generation = this.#buildGeneration

        const tPipeline0 = performance.now()
        let pipeline: GPURenderPipeline
        let beamPipeline: GPUComputePipeline
        try {
            ;[pipeline, beamPipeline] = await Promise.all([
                this.#device.createRenderPipelineAsync({
                    label: "Preview Pipeline",
                    layout: "auto",
                    vertex: { module: nextShader, entryPoint: "vertexMain" },
                    fragment: {
                        module: nextShader,
                        entryPoint: "fragmentMain",
                        // Single target: the canvas swapchain. Click picking uses
                        // the `clickedObjectId` atomic written from the fragment shader.
                        targets: [{ format: this.#format }],
                    },
                    primitive: { topology: "triangle-strip", stripIndexFormat: "uint32" },
                }),
                this.#device.createComputePipelineAsync({
                    label: "Beam Pre-Pass Pipeline",
                    layout: "auto",
                    compute: { module: nextShader, entryPoint: "beamMarch" },
                }),
            ])
        } catch (err) {
            const text = err instanceof Error ? (err.stack ?? err.message) : String(err)
            logWgsl("error", `Pipeline creation failed for Preview + Beam shader: ${text}`)
            throw err
        }
        const tPipeline1 = performance.now()
        if (generation !== this.#buildGeneration) {
            return { superseded: true }
        }
        return {
            pipeline,
            beamPipeline,
            shader: nextShader,
            t: {
                wgslSceneMs: roundMs2(tWgsl1 - tWgsl0),
                compileAuxPreviewMs: roundMs2(tAux - tWgsl0),
                compileAuxFastPreviewMs: roundMs2(tAuxFast - tAux),
                compileForPreviewMs: roundMs2(tSdf - tAuxFast),
                compileFastForPreviewMs: roundMs2(tSdfFast - tSdf),
                compileEdgeHelpersMs: roundMs2(tWgsl1 - tSdfFast),
                shaderModulesMs: roundMs2(tShaderMod1 - tShaderMod0),
                pipelinesMs: roundMs2(tPipeline1 - tPipeline0),
            },
        }
    }

    /**
     * "View Isolated" toggle/retarget (interactive path). Reuses the already-built
     * `#scene` — no DSL re-eval, no tree rebuild, no param re-upload — and just
     * recompiles the preview SDF from the chosen isolation root, swaps in the new
     * pipelines, and re-renders the current SAB frame. Serialized with builds by
     * the worker's job queue (see render-worker.mts), so it never races `#doBuild`.
     */
    async recompileIsolation(ids: readonly number[], sab?: SharedArrayBuffer): Promise<void> {
        this.#isolatedIds = [...ids]
        // No scene yet, or its body is mid-flight: the next `#doBuild` will apply
        // `#isolatedIds` (it compiles from `scene.isolationRoot(this.#isolatedIds)`).
        if (!this.#scene) return
        // Already compiled for this isolation (e.g. a build that ran just before
        // this queued recompile applied it) — skip the recompile, just re-render.
        if (this.#pipeline && sameIdList(this.#builtIsolatedIds, this.#isolatedIds)) {
            this.#forceNextRender = true
            const buf0 = sab ?? this.#lastSharedBuffer
            if (buf0) this.#renderFromSAB(buf0)
            return
        }
        const built = await this.#buildScenePipelines(this.#scene, this.#scene.isolationRoot(this.#isolatedIds))
        if ("superseded" in built) return
        this.#pipeline = built.pipeline
        this.#beamPipeline = built.beamPipeline
        this.#sceneShader = built.shader
        this.#invalidateDeferredPipelines()
        this.#builtIsolatedIds = [...this.#isolatedIds]
        this.#beamBindGroupInvalid = true
        this.#sceneBindGroupInvalid = true
        // Rebuild deferred pipelines from the new shader if the knob is on.
        if (this.#deferredShading) void this.#ensureDeferredPipelines()
        this.#forceNextRender = true
        const buf = sab ?? this.#lastSharedBuffer
        if (buf) this.#renderFromSAB(buf)
    }

    async #doBuild(body: string): Promise<
        | {
              sceneNodes: import("./render-worker-protocol.mjs").SerializedNode[]
              compiledPosY: [number, number][]
              timingMs: BuildTimingBreakdownMs
          }
        | { superseded: true }
    > {
        const roundMs = (x: number) => Math.round(x * 100) / 100
        this.#builtBody = body
        const t0 = performance.now()
        this.#scene = new SceneInfo(body, { bvhEnabled: this.#bvhEnabled })
        const tSceneConstruct = performance.now()
        const scene = this.#scene
        const allNodes = scene.getAllNodes()
        const tGetNodes1 = performance.now()
        const tFp0 = performance.now()
        const fingerprint = scene.structuralFingerprint()
        const tFingerprint = performance.now()

        const paramOnly =
            this.#builtStructuralFingerprint !== null &&
            fingerprint === this.#builtStructuralFingerprint &&
            this.#pipeline !== null &&
            this.#beamPipeline !== null &&
            this.#sceneShader !== null &&
            sameIdList(this.#isolatedIds, this.#builtIsolatedIds)

        const tPoly0 = performance.now()
        // `getPolygonVertexData()` allocates a fresh Float32Array on every call
        // and nothing else holds a reference, so the previous `.buffer.slice(0)`
        // was a defensive copy with no real owner to defend against. Pass the
        // Float32Array through to `writeBuffer` directly — it accepts any
        // BufferSource.
        const polygonVertexData: Float32Array | null =
            scene.totalPolygonVertices > 0 ? scene.getPolygonVertexData() : null
        const tPoly1 = performance.now()
        const newCompiledPosY = new Map<number, number>()
        for (const node of allNodes) {
            if (node instanceof Extrude || node instanceof Loft || node instanceof ThreadedRod) {
                newCompiledPosY.set(node.id, node.pos.y)
            }
        }
        const tPackScene0 = performance.now()
        // Pack straight into the persistent dedup scratch (`#lastSceneParamUpload`-
        // sized buffer) — drops the per-build `new Float32Array(used)`.
        const sceneParamLen = scene.packSceneParamsInto(this.#sceneParamPackScratch)
        const tPackScene1 = performance.now()
        const sceneParamUpload =
            sceneParamLen > 0 ? this.#sceneParamPackScratch.subarray(0, sceneParamLen) : EMPTY_F32_SINGLE
        const tPackPrev0 = performance.now()
        // Pack preview banks straight into the shadow arrays (the worker's
        // existing CPU mirror, kept at PREVIEW_UNIFORM_*_COUNT capacity).
        // Eliminates 4 fresh `new Float32Array` calls per build *and* the
        // follow-up `this.#previewF32Shadow.set(p.f32)` mirror copy.
        const previewLens = scene.packPreviewParamsInto(this.#previewPackTarget)
        const previewPacked: PreviewParamsOut = {
            f32: this.#previewF32Shadow.subarray(0, previewLens.f32),
            vec2: this.#previewVec2Shadow.subarray(0, previewLens.vec2),
            vec3: this.#previewVec3Shadow.subarray(0, previewLens.vec3),
            mat3: this.#previewMat3Shadow.subarray(0, previewLens.mat3),
        }
        const tPackPreview = performance.now()

        if (paramOnly) {
            const tBuf0 = performance.now()
            this.#compiledPosY = newCompiledPosY
            this.#uploadBuildBuffers(scene, polygonVertexData, sceneParamUpload, previewPacked, true)
            // Param-only built: preview uniform banks were re-uploaded with
            // new values, so the next render's pixels would differ even if
            // the SAB hasn't bumped yet. Defeat the idle-skip hash gate.
            this.#forceNextRender = true
            // FG build runs in the background after buildComplete is posted —
            // it stalls on a GPU readback (mapAsync) that used to add tens of
            // ms to every slider-tick. The overlay refreshes a frame or two
            // late, which is fine for a debug overlay.
            this.#kickFeatureGraphBuild(scene, fingerprint)
            const tBuf1 = performance.now()
            const tSer0 = performance.now()
            const sceneNodes = serializeSceneNodes(scene, allNodes)
            const tSer1 = performance.now()
            const total = performance.now() - t0
            const timingMs: BuildTimingBreakdownMs = {
                sceneConstructMs: roundMs(tSceneConstruct - t0),
                getAllNodesMs: roundMs(tGetNodes1 - tSceneConstruct),
                fingerprintMs: roundMs(tFingerprint - tFp0),
                polygonVertexMs: roundMs(tPoly1 - tPoly0),
                packSceneMs: roundMs(tPackScene1 - tPackScene0),
                packPreviewMs: roundMs(tPackPreview - tPackPrev0),
                serializeNodesMs: roundMs(tSer1 - tSer0),
                gpuBuffersMs: roundMs(tBuf1 - tBuf0),
                totalMs: roundMs(total),
                paramOnly: true,
            }
            log("RenderWorker").debug("scene build param-only (ms)", {
                sceneConstruct: timingMs.sceneConstructMs,
                fingerprint: timingMs.fingerprintMs,
                packScene: timingMs.packSceneMs,
                packPreview: timingMs.packPreviewMs,
                serializeNodes: timingMs.serializeNodesMs,
                gpuBuffers: timingMs.gpuBuffersMs,
                total: timingMs.totalMs,
                under10msTarget: total < 10,
            })
            return { sceneNodes, compiledPosY: Array.from(this.#compiledPosY), timingMs }
        }

        // Compile the preview SDF from the isolation root (= full scene root when
        // nothing is isolated) → shader module → pipelines. Shared with isolate
        // recompiles via #buildScenePipelines.
        const built = await this.#buildScenePipelines(scene, scene.isolationRoot(this.#isolatedIds))
        if ("superseded" in built) {
            return { superseded: true } as { superseded: true }
        }
        const { pipeline, beamPipeline, shader: nextShader, t } = built

        log("RenderWorker").debug("scene build full (ms)", {
            sceneConstruct: roundMs(tSceneConstruct - t0),
            fingerprint: roundMs(tFingerprint - tFp0),
            packScene: roundMs(tPackScene1 - tPackScene0),
            packPreview: roundMs(tPackPreview - tPackPrev0),
            wgslScene: t.wgslSceneMs,
            shaderModules: t.shaderModulesMs,
            pipelines: t.pipelinesMs,
            total: roundMs(performance.now() - t0),
        })

        // WebGPU: only buffers, textures, and query sets have destroy(). Pipelines, shader modules,
        // and bind groups do not — replace fields so previous objects can be GC'd.
        this.#pipeline = pipeline
        this.#beamPipeline = beamPipeline
        this.#sceneShader = nextShader
        this.#invalidateDeferredPipelines()
        if (this.#deferredShading) void this.#ensureDeferredPipelines()
        this.#builtStructuralFingerprint = fingerprint
        this.#builtIsolatedIds = [...this.#isolatedIds]
        // New pipeline + uploaded buffers — defeat the SAB-hash idle skip so
        // the next render actually picks up the freshly compiled shader.
        this.#forceNextRender = true

        // Write GPU buffers only after the new pipeline is ready so the old pipeline
        // continues rendering with the correct drag-time preview cap slots (posYDelta != 0)
        // until the atomic swap. This prevents the visible jump where the object briefly
        // snaps back to its pre-drag position during pipeline compilation.
        const tBuf0 = performance.now()
        this.#compiledPosY = newCompiledPosY
        this.#uploadBuildBuffers(scene, polygonVertexData, sceneParamUpload, previewPacked, true)
        this.#beamBindGroupInvalid = true
        this.#sceneBindGroupInvalid = true
        // FG build runs in the background after buildComplete is posted; see
        // the param-only branch for the rationale.
        this.#kickFeatureGraphBuild(scene, fingerprint)
        const tBuf1 = performance.now()
        log("RenderWorker").debug("scene build full buffer upload (ms)", { gpuBuffers: roundMs(tBuf1 - tBuf0) })

        const tSer0 = performance.now()
        const sceneNodes = serializeSceneNodes(scene, allNodes)
        const tSer1 = performance.now()
        const total = performance.now() - t0
        const timingMs: BuildTimingBreakdownMs = {
            sceneConstructMs: roundMs(tSceneConstruct - t0),
            getAllNodesMs: roundMs(tGetNodes1 - tSceneConstruct),
            fingerprintMs: roundMs(tFingerprint - tFp0),
            polygonVertexMs: roundMs(tPoly1 - tPoly0),
            packSceneMs: roundMs(tPackScene1 - tPackScene0),
            packPreviewMs: roundMs(tPackPreview - tPackPrev0),
            serializeNodesMs: roundMs(tSer1 - tSer0),
            wgslSceneMs: t.wgslSceneMs,
            compileAuxPreviewMs: t.compileAuxPreviewMs,
            compileAuxFastPreviewMs: t.compileAuxFastPreviewMs,
            compileAuxMidPreviewMs: 0, // MID not generated in the preview build
            compileForPreviewMs: t.compileForPreviewMs,
            compileFastForPreviewMs: t.compileFastForPreviewMs,
            compileMidForPreviewMs: 0, // MID not generated in the preview build
            compileEdgeHelpersMs: t.compileEdgeHelpersMs,
            shaderModulesMs: t.shaderModulesMs,
            pipelinesMs: t.pipelinesMs,
            gpuBuffersMs: roundMs(tBuf1 - tBuf0),
            totalMs: roundMs(total),
            paramOnly: false,
        }
        return { sceneNodes, compiledPosY: Array.from(this.#compiledPosY), timingMs }
    }

    /**
     * Open a render pass on the canvas target with `loadOp: "load"` (preserves
     * the outline pass output) and draw the FeatureGraph debug overlay.
     * No-op when the overlay is disabled, hasn't been uploaded yet, or has
     * zero alive features.
     *
     * Same command encoder as the caller's scene/outline passes — the entire
     * frame still submits as a single command buffer.
     */
    #renderFeatureGraphOverlay(
        commandEncoder: GPUCommandEncoder,
        target: GPUTextureView,
        viewTransform: Float32Array | ArrayBuffer,
        cameraPosition: readonly [number, number, number],
        width: number,
        height: number,
        zoom: number,
        viewCenter: readonly [number, number],
        sceneWidth: number,
        sceneHeight: number,
        deferred = false,
    ): void {
        const overlay = this.#featureGraphOverlay
        if (!overlay || !overlay.hasAliveFeatures) return
        // Per-mode feature-type gate: each selection mode draws only its own
        // feature type — edges in edge mode, corners in corner mode, both in
        // auto, neither in face/object/seam. Skip the whole overlay (incl. the
        // occlusion depth pass) when nothing would draw.
        const mode = this.#lastSelectionMode
        const isAuto = mode === SEL_MODE_AUTO
        const drawEdges = mode === SEL_MODE_EDGE || isAuto
        const drawCorners = mode === SEL_MODE_CORNER || isAuto
        if (!drawEdges && !drawCorners) return
        // Auto mode is subtle: hide everything except the hovered (fading in) and
        // selected features. When nothing is highlighted, skip the overlay (incl.
        // the occlusion depth pass) entirely.
        const anyHighlighted =
            this.#fgHoverChain >= 0 ||
            this.#fgHoverCorner >= 0 ||
            this.#fgSelectedChains.size > 0 ||
            this.#fgSelectedCorners.size > 0
        if (isAuto && !anyHighlighted) return
        overlay.setDrawTypes(drawEdges, drawCorners)
        const hoverFade =
            isAuto && this.#fgHoverFadeStartMs >= 0 ?
                Math.min(1, (performance.now() - this.#fgHoverFadeStartMs) / FG_HOVER_FADE_MS)
            :   1
        overlay.setAutoMode(isAuto, hoverFade)
        // Optional depth-occlusion: render the SDF surface depth into an
        // rgba32float world-position texture, then hand it (+ the mode) to the
        // overlay so it can hide/dim lines that sit behind the geometry. Returns
        // null (→ mode 0) when occlusion is off, so the default path is byte-for-
        // byte the legacy draw-on-top behavior with no extra pass.
        const depthView = this.#renderSceneDepthForOcclusion(commandEncoder, sceneWidth, sceneHeight, deferred)
        overlay.setDepthSource(depthView, depthView ? this.#featureGraphOcclusionMode : 0)
        overlay.setLineWidth(this.#featureGraphLineWidth)
        overlay.setDifferentiateSegments(this.#featureGraphDifferentiateSegments)
        overlay.uploadCamera(viewTransform, cameraPosition, width, height, zoom, viewCenter)
        const pass = commandEncoder.beginRenderPass({
            label: "FeatureGraph Overlay",
            colorAttachments: [{ view: target, loadOp: "load", storeOp: "store" }],
            timestampWrites: this.#timestampWritesFor("overlay"),
        })
        overlay.render(pass)
        pass.end()
    }

    /**
     * Open a render pass on the canvas target with `loadOp: "load"` and draw the
     * transform gizmo (translate arrows + rotate rings) for the selected object.
     * No-op when hidden. Lazily constructs the overlay on first show. Always
     * draws on top (no depth attachment) so handles stay grabbable.
     */
    #renderGizmoOverlay(
        commandEncoder: GPUCommandEncoder,
        target: GPUTextureView,
        viewTransform: Float32Array | ArrayBuffer,
        cameraPosition: readonly [number, number, number],
        width: number,
        height: number,
        zoom: number,
        viewCenter: readonly [number, number],
    ): void {
        const overlay = this.#gizmoOverlay
        if (!this.#gizmoVisible || !overlay) return
        overlay.uploadCamera(viewTransform, cameraPosition, width, height, zoom, viewCenter)
        overlay.setState(this.#gizmoCenter, this.#gizmoWorldSize, true, this.#gizmoOrient, this.#gizmoHoverHandle, this.#gizmoActiveHandle)
        const pass = commandEncoder.beginRenderPass({
            label: "Gizmo Overlay",
            colorAttachments: [{ view: target, loadOp: "load", storeOp: "store" }],
        })
        overlay.render(pass)
        pass.end()
    }

    /**
     * Run the depth-only raymarch pass that feeds the overlay's occlusion modes.
     * No-op (returns null) when occlusion is off; otherwise lazily builds the
     * depth pipeline / texture / bind group and renders the SDF surface (world
     * hit position + hit mask) at the scene render resolution. Caller has already
     * confirmed the overlay is enabled with alive features.
     */
    #renderSceneDepthForOcclusion(
        commandEncoder: GPUCommandEncoder,
        sceneWidth: number,
        sceneHeight: number,
        deferred: boolean,
    ): GPUTextureView | null {
        if (this.#featureGraphOcclusionMode === 0) return null
        // Fast path: when the frame ran the deferred pipeline, the G-buffer
        // already holds the surface depth — reconstruct the world-position
        // texture from it instead of a second full SDF raymarch (depthOnlyMain).
        // Output is identical, so the overlay consumes it unchanged.
        const useGbuffer = deferred && !!this.#occlusionGbufferPipeline && !!this.#occlusionGbufferBindGroup && !!this.#gbuffer
        if (!useGbuffer && !this.#ensureDepthPipeline()) return null
        const view = this.#ensureSceneDepthTexture(sceneWidth, sceneHeight)
        const bindGroup = useGbuffer ? this.#occlusionGbufferBindGroup! : this.#ensureDepthBindGroup()
        if (!bindGroup) return null
        const pass = commandEncoder.beginRenderPass({
            label: useGbuffer ? "FeatureGraph Depth (G-buffer)" : "FeatureGraph Depth",
            colorAttachments: [
                { view, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" },
            ],
        })
        pass.setPipeline(useGbuffer ? this.#occlusionGbufferPipeline! : this.#depthPipeline!)
        pass.setBindGroup(0, bindGroup)
        pass.draw(4)
        pass.end()
        return view
    }

    /**
     * Lazily compile {@link #depthPipeline} from the current scene shader's
     * `depthOnlyMain` entry (rgba32float target). Returns false when no scene
     * shader is built yet. Rebuilds whenever {@link #sceneShader} changes, so no
     * build path needs to explicitly invalidate it.
     */
    #ensureDepthPipeline(): boolean {
        if (this.#depthPipeline && this.#depthPipelineShader === this.#sceneShader) return true
        if (!this.#sceneShader) return false
        this.#depthPipeline = this.#device.createRenderPipeline({
            label: "Preview Depth Pipeline",
            layout: "auto",
            vertex: { module: this.#sceneShader, entryPoint: "vertexMain" },
            fragment: {
                module: this.#sceneShader,
                entryPoint: "depthOnlyMain",
                // World-space hit position (xyz) + hit mask (w). Renderable but
                // unfilterable/non-blendable, which is fine — we only write it.
                targets: [{ format: "rgba32float" }],
            },
            primitive: { topology: "triangle-strip", stripIndexFormat: "uint32" },
        })
        this.#depthPipelineShader = this.#sceneShader
        this.#depthBindGroup = null // new pipeline ⇒ new auto layout
        return true
    }

    /** (Re)allocate the scene-depth texture at the scene render resolution. */
    #ensureSceneDepthTexture(width: number, height: number): GPUTextureView {
        const w = Math.max(1, width)
        const h = Math.max(1, height)
        if (this.#sceneDepthTextureView && this.#sceneDepthW === w && this.#sceneDepthH === h) {
            return this.#sceneDepthTextureView
        }
        this.#sceneDepthTexture?.destroy()
        this.#sceneDepthTexture = this.#device.createTexture({
            label: "FeatureGraph Scene Depth",
            size: [w, h],
            format: "rgba32float",
            // COPY_SRC: the CPU FG hit-test reads the cursor pixel back to depth-
            // occlude features (hide-behind), matching what the overlay draws.
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
        })
        this.#sceneDepthTextureView = this.#sceneDepthTexture.createView()
        this.#sceneDepthW = w
        this.#sceneDepthH = h
        return this.#sceneDepthTextureView
    }

    /**
     * Build the depth pipeline's scene bind group, reusing the exact same entry
     * set as the preview pipeline ({@link #sceneBindGroupEntries}). `depthOnlyMain`
     * force-references the full binding set, so its auto layout matches the
     * preview pipeline's and these entries bind cleanly. Invalidated together
     * with the scene bind group (see {@link #ensureRenderTextures}).
     */
    #ensureDepthBindGroup(): GPUBindGroup | null {
        if (this.#depthBindGroup) return this.#depthBindGroup
        if (!this.#depthPipeline) return null
        this.#depthBindGroup = this.#device.createBindGroup({
            label: "scenePreviewDepth",
            layout: this.#depthPipeline.getBindGroupLayout(0),
            entries: this.#sceneBindGroupEntries(),
        })
        return this.#depthBindGroup
    }

    /** Reset per-frame profiling state; called at the top of `render()` / `#renderFromSAB`. */
    #beginFrameProfiling(): void {
        this.#timestampFilledPasses.length = 0
    }

    /**
     * Allocate the next pair of timestamp query slots for `name` and return a
     * `timestampWrites` descriptor (assignable to both
     * `GPURenderPassDescriptor.timestampWrites` and
     * `GPUComputePassDescriptor.timestampWrites`). Returns `undefined` when
     * timestamp-query is unavailable, the previous frame's readback is still
     * in flight, or we've already used all {@link TIMESTAMP_MAX_PAIRS} pairs
     * — callers spread it unconditionally and WebGPU treats `undefined` as
     * "no timestamps written."
     */
    #timestampWritesFor(name: ProfiledPassName): GPURenderPassTimestampWrites | undefined {
        const querySet = this.#timestampQuerySet
        if (!querySet) return undefined
        if (this.#timestampBusy) return undefined
        const pairIdx = this.#timestampFilledPasses.length
        if (pairIdx >= TIMESTAMP_MAX_PAIRS) return undefined
        this.#timestampFilledPasses.push(name)
        return {
            querySet,
            beginningOfPassWriteIndex: pairIdx * 2,
            endOfPassWriteIndex: pairIdx * 2 + 1,
        }
    }

    /**
     * Encode `resolveQuerySet` + `copyBufferToBuffer` for any timestamps
     * written this frame, then mark the staging buffer busy. Returns the
     * snapshot of which passes filled their slots (in order) so the async
     * drain knows what to attribute the deltas to.
     */
    #endFrameProfiling(encoder: GPUCommandEncoder): ProfiledPassName[] {
        const n = this.#timestampFilledPasses.length
        if (n === 0) return []
        const querySet = this.#timestampQuerySet
        const resolve = this.#timestampResolveBuffer
        const staging = this.#timestampStagingBuffer
        if (!querySet || !resolve || !staging) return []
        encoder.resolveQuerySet(querySet, 0, n * 2, resolve, 0)
        encoder.copyBufferToBuffer(resolve, 0, staging, 0, n * 2 * 8)
        this.#timestampBusy = true
        // Snapshot — `#timestampFilledPasses` will be reset on the next frame
        // while the drain is still awaiting `mapAsync`.
        return this.#timestampFilledPasses.slice()
    }

    /**
     * Async map + parse for the timestamps written by the most recent frame.
     * Fire-and-forget: callers `void` this; it self-clears `#timestampBusy`
     * on completion or error so the next render that arrives after the GPU
     * finishes will re-profile.
     */
    async #drainTimestampReadback(filled: ProfiledPassName[]): Promise<void> {
        const staging = this.#timestampStagingBuffer
        if (!staging || filled.length === 0) {
            this.#timestampBusy = false
            return
        }
        const byteLen = filled.length * 2 * 8
        try {
            await staging.mapAsync(GPUMapMode.READ, 0, byteLen)
        } catch (err) {
            log("RenderWorker").debug("timestamp readback mapAsync failed", err)
            this.#timestampBusy = false
            return
        }
        try {
            const bi = new BigInt64Array(staging.getMappedRange(0, byteLen).slice(0))
            for (let i = 0; i < filled.length; i++) {
                const t0 = bi[i * 2]!
                const t1 = bi[i * 2 + 1]!
                const ns = Number(t1 - t0)
                // Timestamps are unordered across queues only when the GPU
                // reorders work; for pass-pair writes inside one encoder we
                // expect t1 >= t0. Guard anyway against driver weirdness.
                if (ns >= 0) this.#passTimeAverages[filled[i]!].update(ns / 1_000_000)
            }
        } finally {
            staging.unmap()
            this.#timestampBusy = false
        }
        this.#passTimeLogFrames++
        if (this.#passTimeLogFrames >= 60) {
            this.#passTimeLogFrames = 0
            const avg = this.#passTimeAverages
            // Context tags make this line a self-contained A/B sample: `ao` and
            // `scale` let you filter `/_logs` to full-res (`scale:1`) frames and
            // compare `scene` with AO on (`ao:0.34`) vs off (`ao:0`). `xray` and
            // `deferred` both shift scene-pass cost, so they're tagged too.
            log("RenderWorker").debug("gpu pass times (avg ms, 30-frame window)", {
                res: `${this.#profileCtx.w}x${this.#profileCtx.h}`,
                scale: roundMs2(this.#profileCtx.scale),
                ao: roundMs2(this.#profileCtx.ao),
                xray: this.#viewSettingsBuf[0],
                deferred: this.#deferredShading ? 1 : 0,
                beam: roundMs2(avg.beam.average),
                scene: roundMs2(avg.scene.average),
                shade: roundMs2(avg.shade.average),
                easu: roundMs2(avg.easu.average),
                fxaa: roundMs2(avg.fxaa.average),
                outline: roundMs2(avg.outline.average),
                overlay: roundMs2(avg.overlay.average),
            })
        }
    }

    /**
     * Walk the scene tree, extract per-primitive feature-graph data, and run
     * the FG pipeline (extract → transform → subdivide → survive → bin).
     *
     * Called from two places:
     *  - `#doBuild` tail: at `DEFAULT_MESH_EXPORT_VOXEL_SIZE_MM`, for
     *    instrumentation/preview. Throttle (200 ms debounce) and drag-pause
     *    live on the main thread — see `app.mts` `CONTENT_CHANGE_DEBOUNCE_MS`
     *    and `isPushPullActive`.
     *  - `handleRenderMesh` at the SHREC export branch: at the export's
     *    actual `voxelSizeMm`, with the result fed into SHREC as
     *    CSG-survival-aware snap features (Stage 6).
     *
     * Stage 4 runs the iso_sample_batch shader against the same `polygonVertices`
     * / `mdcSceneParams` GPU buffers the export path uses. If the iso module
     * hasn't been compiled yet (e.g. very first call before any full build
     * completes), returns `null`.
     */
    async #buildFeatureGraph(
        scene: SceneInfo,
        cellSize: number,
        generation?: number,
    ): Promise<FeatureGraphBuildResult | null> {
        const builder = new FeatureGraphBuilder()
        scene.root.accumulateFeatureGraph(builder)
        const cpu = builder.finish()
        this.#ensureFeatureGraphIsoModule(scene)
        const isoModule = this.#featureGraphIsoModule
        if (!isoModule) return null
        if (!this.#featureGraphIsoBatch) {
            this.#featureGraphIsoBatch = new IsoSampleBatch(
                this.#helper,
                this.#uniformBuffers.polygonVertices,
                this.#uniformBuffers.faceSelection,
                this.#uniformBuffers.mdcSceneParams,
            )
        }
        const result = await this.#featureGraph.build(
            cpu,
            cellSize,
            this.#featureGraphIsoBatch,
            isoModule,
        )
        // Background kicks pass a generation; if a newer kick (or
        // `cancelBuilds`) bumped `#fgGeneration` during our await, skip the
        // overlay upload so we don't clobber whatever the newer build will
        // produce.
        if (generation !== undefined && generation !== this.#fgGeneration) return null
        // Push the latest features into the debug overlay so the next render
        // frame draws them. Lazy-init the overlay here — first build is the
        // earliest we know the canvas format is settled.
        if (!this.#featureGraphOverlay) {
            this.#featureGraphOverlay = new FeatureGraphOverlay(this.#helper, this.#format)
        }
        this.#featureGraphOverlay.upload(result.cpu, result.worldPositions)
        // Retain the snapshot + build the chain grouping / hit-tester so click
        // and hover can do CPU screen-space feature picking. The FG rebuild
        // renumbers vertices/edges, so any prior feature selection is stale —
        // drop it (v1: selection does not survive rebuilds). `upload()` already
        // zeroed the overlay highlight state to match.
        this.#fgCpu = result.cpu
        this.#fgWorld = result.worldPositions
        this.#fgChains = groupChains(result.cpu)
        this.#fgHitTester = new FeatureGraphHitTester(result.cpu, result.worldPositions, this.#fgChains)
        this.#fgSelectedChains.clear()
        this.#fgSelectedCorners.clear()
        this.#fgAutoLockedType = null
        this.#fgHoverChain = -1
        this.#fgHoverCorner = -1
        // Worker-internal state change (vertex/index buffers were uploaded)
        // — defeat the SAB-hash idle skip so the next render actually
        // composites the new overlay geometry.
        this.#forceNextRender = true
        return result
    }

    /**
     * Compile `iso_sample_batch.wgsl` with the EXPORT-variant `sceneSDF` /
     * `sceneAux*` emitters so the FeatureGraph stage-4 survival pass (and
     * `handleRenderMesh`'s FG plumbing) can evaluate the scene SDF. The
     * preview shader injects the *preview* variants (which reference
     * `previewParamsF32` etc.); iso_sample_batch uses the export bind set
     * (`mdcSceneParams` / `polygonVertices`), so it needs its own module.
     *
     * Cached against `#builtStructuralFingerprint` — recompiled only when
     * the scene structure changes. Deferred out of `#doBuild` so structural
     * rebuilds don't pay double WGSL codegen + `createShaderModule` when the
     * overlay is disabled and nothing actually consumes the module.
     */
    #ensureFeatureGraphIsoModule(scene: SceneInfo): void {
        if (
            this.#featureGraphIsoModule &&
            this.#builtIsoModuleFingerprint === this.#builtStructuralFingerprint
        ) {
            return
        }
        const fgSceneAux = scene.compileAux()
        const fgSceneAuxFast = scene.compileAuxFast()
        const fgSceneAuxMid = scene.compileAuxMid()
        const fgSceneSDF = scene.compile()
        const fgSceneSDF_mid = scene.compileMid()
        const featureGraphIsoCompiler = new ShaderCompiler(this.#device)
            .replace("insert", "sceneAuxFast", fgSceneAuxFast)
            .replace("insert", "sceneAux", fgSceneAux)
            .replace("insert", "sceneAuxMid", fgSceneAuxMid)
            .replace("insert", "sceneSDF", fgSceneSDF)
            .replace("insert", "sceneSDF_mid", fgSceneSDF_mid)
        this.#featureGraphIsoModule = featureGraphIsoCompiler.compile(
            isoSampleBatchShaderSource,
            "Iso sample batch (FG)",
        )
        // `IsoSampleBatch.#ensurePipeline` detects the module change and
        // invalidates its cached pipeline + bind group on next run() — no
        // need to destroy the batch instance here.
        this.#builtIsoModuleFingerprint = this.#builtStructuralFingerprint
    }

    /**
     * Schedule a background FeatureGraph build for the latest scene. No-op
     * when the overlay is disabled. Kicks chain through `#fgBuildLock` so we
     * never run two builds against the same `IsoSampleBatch` concurrently;
     * the generation counter lets newer kicks supersede older ones that are
     * still queued.
     */
    #kickFeatureGraphBuild(scene: SceneInfo, fingerprint: string): void {
        this.#fgGeneration++
        const gen = this.#fgGeneration
        const prev = this.#fgBuildLock
        this.#fgBuildLock = (async () => {
            await prev
            // Skip stale kicks queued behind a newer one — only the latest
            // kick should pay for the GPU compute + readback round-trip.
            if (gen !== this.#fgGeneration) return
            // If a structural rebuild landed since the kick was scheduled
            // (`fingerprint` no longer matches what's compiled), let the
            // newer kick take it — bail rather than build against a stale
            // scene shape.
            if (this.#builtStructuralFingerprint !== fingerprint) return
            try {
                await this.#buildFeatureGraph(scene, DEFAULT_MESH_EXPORT_VOXEL_SIZE_MM, gen)
            } catch (err) {
                log("RenderWorker").debug("background feature-graph build failed", err)
            }
        })()
    }

    /**
     * Upload polygon, bounds/MDC scene params, and preview uniform banks; optionally skips
     * `writeBuffer` when packed payload matches the last upload (param-only and full builds).
     */
    #uploadBuildBuffers(
        scene: SceneInfo,
        polygonVertexData: Float32Array | null,
        sceneParamUpload: Float32Array,
        p: PreviewParamsOut,
        dedup: boolean,
    ): void {
        const q = this.#device.queue
        if (polygonVertexData && scene.totalPolygonVertices > 0) {
            const polyLen = polygonVertexData.length
            if (
                !dedup ||
                this.#lastPolygonVertexLen !== polyLen ||
                !float32SubarrayEqual(this.#lastPolygonVertexUpload, polygonVertexData, polyLen)
            ) {
                q.writeBuffer(this.#uniformBuffers.polygonVertices, 0, polygonVertexData as BufferSource)
                if (dedup) {
                    this.#lastPolygonVertexUpload.set(polygonVertexData)
                    this.#lastPolygonVertexLen = polyLen
                }
            }
        } else if (dedup) {
            this.#lastPolygonVertexLen = -1
        }

        const spLen = sceneParamUpload.length
        if (!dedup || this.#lastSceneParamLen !== spLen || !float32SubarrayEqual(this.#lastSceneParamUpload, sceneParamUpload, spLen)) {
            // `boundsSceneParams` and `mdcSceneParams` alias the same GPUBuffer
            // — one upload feeds both binding sites.
            q.writeBuffer(this.#uniformBuffers.boundsSceneParams, 0, sceneParamUpload as BufferSource)
            if (dedup) {
                this.#lastSceneParamUpload.set(sceneParamUpload)
                this.#lastSceneParamLen = spLen
            }
        }

        // Preview banks: `p.{f32,vec2,vec3,mat3}` are subarrays of the
        // worker's `#preview*Shadow` arrays (scene.packPreviewParamsInto
        // writes straight into them), so there's no shadow-mirror copy to
        // make here. The dedup cache (`#lastPreview*Upload`) is still
        // separate — that's the "what's currently on the GPU" mirror.
        if (p.f32.byteLength > 0) {
            const f32Len = p.f32.length
            const reupload = !dedup || this.#lastPreviewF32Len !== f32Len || !float32SubarrayEqual(this.#lastPreviewF32Upload, p.f32, f32Len)
            if (reupload) {
                q.writeBuffer(this.#uniformBuffers.previewParamsF32, 0, p.f32 as BufferSource)
                q.writeBuffer(this.#uniformBuffers.previewCapParamDrag, 0, p.f32 as BufferSource)
                if (dedup) {
                    this.#lastPreviewF32Upload.set(p.f32)
                    this.#lastPreviewF32Len = f32Len
                }
            }
        } else if (dedup) {
            this.#lastPreviewF32Len = -1
        }

        if (p.vec2.byteLength > 0) {
            const v2Len = p.vec2.length
            if (!dedup || this.#lastPreviewVec2Len !== v2Len || !float32SubarrayEqual(this.#lastPreviewVec2Upload, p.vec2, v2Len)) {
                q.writeBuffer(this.#uniformBuffers.previewParamsVec2, 0, p.vec2 as BufferSource)
                if (dedup) {
                    this.#lastPreviewVec2Upload.set(p.vec2)
                    this.#lastPreviewVec2Len = v2Len
                }
            }
        } else if (dedup) {
            this.#lastPreviewVec2Len = -1
        }

        if (p.vec3.byteLength > 0) {
            const v3Len = p.vec3.length
            if (!dedup || this.#lastPreviewVec3Len !== v3Len || !float32SubarrayEqual(this.#lastPreviewVec3Upload, p.vec3, v3Len)) {
                q.writeBuffer(this.#uniformBuffers.previewParamsVec3, 0, p.vec3 as BufferSource)
                if (dedup) {
                    this.#lastPreviewVec3Upload.set(p.vec3)
                    this.#lastPreviewVec3Len = v3Len
                }
            }
        } else if (dedup) {
            this.#lastPreviewVec3Len = -1
        }

        if (p.mat3.byteLength > 0) {
            const m3Len = p.mat3.length
            if (!dedup || this.#lastPreviewMat3Len !== m3Len || !float32SubarrayEqual(this.#lastPreviewMat3Upload, p.mat3, m3Len)) {
                q.writeBuffer(this.#uniformBuffers.previewParamsMat3, 0, p.mat3 as BufferSource)
                if (dedup) {
                    this.#lastPreviewMat3Upload.set(p.mat3)
                    this.#lastPreviewMat3Len = m3Len
                }
            }
        } else if (dedup) {
            this.#lastPreviewMat3Len = -1
        }
    }

    resize(fullWidth: number, fullHeight: number): void {
        this.#fullWidth = Math.max(0, fullWidth)
        this.#fullHeight = Math.max(0, fullHeight)
        // Don't size the canvas drawing buffer here anymore — `#renderFromSAB`
        // and `render()` set it to the current scene render resolution each
        // frame (via `#resizeCanvasIfNeeded`) so the browser CSS handles
        // halfres → display upsample for free.
        // Resize changes the canvas/texture geometry, so the next render
        // must actually fire even if the SAB hash hasn't moved yet.
        this.#forceNextRender = true
    }

    render(
        msg: Extract<MainToWorkerMessage, { type: "render" }>,
        outputTextureView?: GPUTextureView,
        sharedBuffer?: SharedArrayBuffer,
    ): void {
        const now = performance.now()
        if (this.#lastRenderTime > 0) {
            const delta = now - this.#lastRenderTime
            if (delta > 0) {
                this.#framerate.update(1000 / delta)
                this.#fpsFrameCount++
                const timeSinceFps = now - this.#lastFpsSendTime
                if (this.#fpsFrameCount >= 5 || timeSinceFps >= 100) {
                    this.#fpsFrameCount = 0
                    this.#lastFpsSendTime = now
                    if (sharedBuffer) {
                        this.#fpsVersion++
                        writeFps(sharedBuffer, this.#framerate.average, this.#fpsVersion)
                    } else {
                        self.postMessage({ type: "fps", fps: this.#framerate.average })
                    }
                }
            }
        }
        this.#lastRenderTime = now

        this.#lastRenderMsg = msg
        this.#lastSelectionMode = msg.viewSettings.selectionMode
        const { viewTransform, cameraPosition, cameraRes, viewSettings, viewCenter, resolutionScale, selectionState } = msg
        if (!this.#pipeline) return
        const sceneWidth = Math.max(1, Math.round(cameraRes[0] * resolutionScale))
        const sceneHeight = Math.max(1, Math.round(cameraRes[1] * resolutionScale))
        if (sceneWidth === 0 || sceneHeight === 0) return
        if (!outputTextureView && (this.#fullWidth <= 0 || this.#fullHeight <= 0)) return

        this.#profileCtx.ao = (msg.viewSettings.previewShading ?? DEFAULT_PREVIEW_SHADING).aoStrength
        this.#profileCtx.scale = resolutionScale
        this.#profileCtx.w = sceneWidth
        this.#profileCtx.h = sceneHeight

        this.#ensureRenderTextures(sceneWidth, sceneHeight)

        this.#uploadCameraIfDirty(
            viewTransform,
            cameraPosition,
            sceneWidth,
            sceneHeight,
            orthoHalfFromDolly(msg.cameraState.dollyDistance),
            viewCenter,
            msg.viewSettings.previewShading ?? DEFAULT_PREVIEW_SHADING,
            msg.viewSettings.previewNormalShading,
        )

        this.#viewSettingsBuf[0] = viewSettings.xrayMode ? 1 : 0
        this.#viewSettingsBuf[1] = this.#stepHeatmapEnabled ? 1 : 0 // matches `debugHeatmap` in preview.wgsl ViewSettings
        this.#viewSettingsBuf[2] = viewSettings.beamEnabled ? 1 : 0
        this.#viewSettingsBuf[3] = viewSettings.selectionMode
        this.#viewSettingsBuf[4] = viewSettings.ghostMode ? 1 : 0
        this.#viewSettingsBuf[5] = viewSettings.flatShading ? 1 : 0 // matches `flatShading` in preview.wgsl ViewSettings
        this.#viewSettingsBuf[6] = viewSettings.debugTessEdges ? 1 : 0 // matches `debugTessEdges` in preview.wgsl ViewSettings
        this.#writeBufferViewIfDirty(this.#uniformBuffers.viewSettings, this.#viewSettingsBuf, this.#viewSettingsCache)

        this.#uploadRayMarchParams(viewSettings.rayMarchParams ?? DEFAULT_RAY_MARCH_PARAMS)

        // OutlineSettings upload removed — the outline shader is now a pure
        // blit and reads none of these fields. Selection rendering lives
        // inline in preview.wgsl.

        const ss = viewSettings.selectionStyles
        const def = DEFAULT_SELECTION_STYLES
        this.#selectionStylesF32[0] = ss.face.darken
        this.#selectionStylesF32[4] = ss.face.tint[0]
        this.#selectionStylesF32[5] = ss.face.tint[1]
        this.#selectionStylesF32[6] = ss.face.tint[2]
        this.#selectionStylesF32[8] = ss.edge.color[0]
        this.#selectionStylesF32[9] = ss.edge.color[1]
        this.#selectionStylesF32[10] = ss.edge.color[2]
        this.#selectionStylesF32[12] = def.edge.selectedStrength
        this.#selectionStylesF32[13] = def.edge.hoverStrength
        this.#selectionStylesF32[14] = def.face.dotSpacing
        this.#selectionStylesF32[15] = def.face.dotRadius
        this.#selectionStylesF32[16] = def.face.dotDarken
        this.#selectionStylesF32[17] = resolutionScale
        this.#writeBufferViewIfDirty(this.#uniformBuffers.selectionStyles, this.#selectionStylesF32, this.#selectionStylesCache)

        this.#selDataBuf.fill(0)
        for (const id of selectionState.selectedObjectIds) {
            this.#selDataBuf[id] = 1
        }
        this.#writeBufferViewIfDirty(this.#uniformBuffers.selectedObjectIds, this.#selDataBuf, this.#selectedIdsCache)

        this.#writeEdgesToBufferIfDirty(
            this.#uniformBuffers.selectedEdges,
            selectionState.selectedEdges,
            DEFAULT_SELECTION_STYLES.edge.lineWidthPx,
            DEFAULT_SELECTION_STYLES.edge.epsilon,
            this.#selectedEdgesCache,
        )
        this.#writeEdgesToBufferIfDirty(this.#uniformBuffers.hoveredEdge, selectionState.hoveredEdges, 6.0, 0.02, this.#hoveredEdgesCache)

        // FSR1 spatial upscale (mirrors `#renderFromSAB`). Engages only on
        // reduced-res frames with a non-"off" mode. The `outputTextureView`
        // path supports it too so captures can A/B EASU headlessly; otherwise
        // off-screen renders keep the legacy intermediate + bilinear blit.
        const up = viewSettings.upscaleParams
        const fsrEnabled = (up?.mode ?? "off") !== "off" && resolutionScale < 1.0
        const fsrFxaa = fsrEnabled && up?.mode === "easu-fxaa"
        // FXAA ("easu-fxaa") also applies on full-res frames (still / 100%): the
        // scene renders into the full-res intermediate and FXAA composites it.
        const wantFxaa = up?.mode === "easu-fxaa"
        const fullResFxaa = wantFxaa && !fsrEnabled
        const fullW = Math.max(1, Math.round(cameraRes[0]))
        const fullH = Math.max(1, Math.round(cameraRes[1]))

        // For canvas renders, size the OffscreenCanvas drawing buffer: full
        // display res when upscaling or applying full-res FXAA (a post pass
        // resolves into the swapchain), else the scene render resolution with a
        // free browser CSS upscale. Off-screen (`outputTextureView`) leaves the
        // canvas untouched.
        if (!outputTextureView) {
            this.#resizeCanvasIfNeeded(fsrEnabled || wantFxaa ? fullW : sceneWidth, fsrEnabled || wantFxaa ? fullH : sceneHeight)
        }
        if (fullResFxaa) this.#ensureUpscaleTextures(fullW, fullH, true)
        const canvasTexture = outputTextureView ? null : this.#context.getCurrentTexture()
        const finalTarget = outputTextureView ?? canvasTexture!.createView()
        const commandEncoder = this.#device.createCommandEncoder()
        this.#beginFrameProfiling()

        if (viewSettings.beamEnabled && this.#beamPipeline) {
            if (this.#beamBindGroupInvalid) {
                this.#beamBindGroup = this.#device.createBindGroup({
                    label: "beamPrePass",
                    layout: this.#beamPipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 1, resource: { buffer: this.#uniformBuffers.camera } },
                        // viewSettings (binding 6): the beam shader force-references it (`_ = viewSettings.selectionMode`)
                        // so its auto bind-group layout keeps binding 6 even when the fast SDF doesn't read viewSettings.
                        { binding: 6, resource: { buffer: this.#uniformBuffers.viewSettings } },
                        { binding: 8, resource: this.#tStartTextureView },
                        { binding: 9, resource: { buffer: this.#uniformBuffers.polygonVertices } },
                        { binding: 19, resource: { buffer: this.#uniformBuffers.previewParamsF32 } },
                        { binding: 20, resource: { buffer: this.#uniformBuffers.previewParamsVec2 } },
                        { binding: 21, resource: { buffer: this.#uniformBuffers.previewParamsVec3 } },
                        { binding: 23, resource: { buffer: this.#uniformBuffers.previewParamsMat3 } },
                        { binding: 24, resource: { buffer: this.#uniformBuffers.previewCapParamDrag } },
                        { binding: 25, resource: { buffer: this.#uniformBuffers.rayMarchParams } },
                    ],
                })
                this.#beamBindGroupInvalid = false
            }
            const BEAM_TILE_SIZE = 8
            const tilesX = Math.ceil(sceneWidth / BEAM_TILE_SIZE)
            const tilesY = Math.ceil(sceneHeight / BEAM_TILE_SIZE)
            const beamPass = commandEncoder.beginComputePass({
                label: "Beam Pre-Pass",
                timestampWrites: this.#timestampWritesFor("beam"),
            })
            beamPass.setPipeline(this.#beamPipeline)
            beamPass.setBindGroup(0, this.#beamBindGroup!)
            beamPass.dispatchWorkgroups(Math.ceil(tilesX / 8), Math.ceil(tilesY / 8))
            beamPass.end()
        }

        // Scene-color attachment: reduced-res `#colorTextureView` when upscaling
        // (FSR) or doing the legacy off-screen bilinear blit; full-res
        // `#easuOutView` when applying full-res FXAA; otherwise the canvas
        // swapchain directly.
        const offscreenBlit = !!outputTextureView && !fullResFxaa
        const sceneColorView =
            fsrEnabled || offscreenBlit ? this.#colorTextureView : fullResFxaa ? this.#easuOutView! : finalTarget
        const deferred = this.#prepareDeferred(viewSettings.xrayMode, sceneWidth, sceneHeight)
        this.#encodeScenePass(commandEncoder, sceneColorView, deferred)

        if (fsrEnabled) {
            // EASU (+FXAA) resolves the reduced-res scene into the final target.
            this.#encodeUpscale(commandEncoder, finalTarget, sceneWidth, sceneHeight, fullW, fullH, fsrFxaa)
        } else if (fullResFxaa) {
            // Full-res native frame: FXAA the scene intermediate into the target.
            this.#encodeFxaaPass(commandEncoder, finalTarget)
        } else if (outputTextureView) {
            // Legacy bilinear blit of the intermediate into the caller's target
            // (which may differ in size / format from the canvas swapchain).
            const outlinePass = commandEncoder.beginRenderPass({
                colorAttachments: [{ view: finalTarget, loadOp: "clear", storeOp: "store" }],
                timestampWrites: this.#timestampWritesFor("outline"),
            })
            outlinePass.setPipeline(this.#outlinePipeline)
            outlinePass.setBindGroup(0, this.#outlineBindGroup!)
            outlinePass.draw(4)
            outlinePass.end()
        }

        // Overlay: at full display res when upscaling or full-res FXAA (crisp
        // lines), else at the scene resolution the target currently holds.
        const overlayW = fsrEnabled || fullResFxaa ? fullW : sceneWidth
        const overlayH = fsrEnabled || fullResFxaa ? fullH : sceneHeight
        this.#renderFeatureGraphOverlay(
            commandEncoder,
            finalTarget,
            viewTransform,
            cameraPosition,
            overlayW,
            overlayH,
            orthoHalfFromDolly(msg.cameraState.dollyDistance),
            viewCenter,
            sceneWidth,
            sceneHeight,
            deferred,
        )
        this.#renderGizmoOverlay(
            commandEncoder,
            finalTarget,
            viewTransform,
            cameraPosition,
            overlayW,
            overlayH,
            orthoHalfFromDolly(msg.cameraState.dollyDistance),
            viewCenter,
        )

        const filledSnap = this.#endFrameProfiling(commandEncoder)
        this.#device.queue.submit([commandEncoder.finish()])
        if (filledSnap.length > 0) void this.#drainTimestampReadback(filledSnap)
    }

    /**
     * Render from SAB-backed scratch storage. Reads directly from typed-array views
     * without rebuilding a full payload object. Use for the interactive preview hot path.
     */
    renderFromSharedBuffer(buffer: SharedArrayBuffer): void {
        this.#lastSharedBuffer = buffer
        this.#renderFromSAB(buffer)
    }

    // `pickClickUV` triggers the fast-pick path: the scene is rendered into a
    // tiny scissored region of the offscreen `#colorTexture` (just enough to
    // cover the clicked pixel and write the `clickedObjectId`/edge atomics),
    // skipping the full-frame raymarch, the canvas, and the post/overlay passes.
    // It leaves the canvas frame untouched, so the idle hash / `forceNextRender`
    // bookkeeping is left alone (the next real render still repaints the canvas
    // with the new selection).
    #renderFromSAB(buffer: SharedArrayBuffer, pickClickUV?: [number, number]): void {
        const slot = getPublishedRenderSlot(buffer)
        const slotBase = getSlotByteOffset(slot)

        // Idle short-circuit: hash the active slot bytes and bail out when
        // the result matches what we last rendered (and nothing forced a
        // refresh). Catches the case where the SAB version was bumped but
        // no render-relevant state actually changed. FNV-1a on u32 words —
        // SLOT_SIZE / 4 ≈ 1745 iterations, well under 100 µs on typical
        // hardware vs the 35 ms+ frame we're skipping. Picks always proceed
        // (and don't consume the bookkeeping — they don't touch the canvas).
        const slotU32View = new Uint32Array(buffer, slotBase, SLOT_SIZE / 4)
        let hash = 2166136261
        for (let i = 0; i < slotU32View.length; i++) {
            hash = Math.imul(hash ^ slotU32View[i]!, 16777619)
        }
        if (!pickClickUV) {
            if (hash === this.#lastRenderedSabHash && !this.#forceNextRender) {
                // Identical to last rendered frame — skip GPU work entirely.
                // The swapchain texture still holds the previous frame's
                // pixels, which is exactly what the user should see.
                return
            }
            this.#lastRenderedSabHash = hash
            this.#forceNextRender = false
        }

        const now = performance.now()
        if (!pickClickUV && this.#lastRenderTime > 0) {
            const delta = now - this.#lastRenderTime
            if (delta > 0) {
                this.#framerate.update(1000 / delta)
                this.#fpsFrameCount++
                const timeSinceFps = now - this.#lastFpsSendTime
                if (this.#fpsFrameCount >= 5 || timeSinceFps >= 100) {
                    this.#fpsFrameCount = 0
                    this.#lastFpsSendTime = now
                    this.#fpsVersion++
                    writeFps(buffer, this.#framerate.average, this.#fpsVersion)
                }
            }
        }
        this.#lastRenderTime = now

        const L = SAB_LAYOUT
        const u32 = new Uint32Array(buffer)
        const f32 = new Float32Array(buffer)
        const b4 = slotBase / 4

        const resolutionScale = f32[b4 + L.O_RESOLUTION_SCALE / 4]
        const cameraRes0 = f32[b4 + L.O_CAMERA_RES / 4]
        const cameraRes1 = f32[b4 + L.O_CAMERA_RES / 4 + 1]
        const sceneWidth = Math.max(1, Math.round(cameraRes0 * resolutionScale))
        const sceneHeight = Math.max(1, Math.round(cameraRes1 * resolutionScale))

        // FSR1 spatial upscale engages only on reduced-res frames. At scale 1.0
        // (still camera) or mode "off" it stays disabled and we keep the legacy
        // browser-bilinear stretch path below.
        const upscaleMode = u32[b4 + L.O_UPSCALE_MODE / 4]
        const fsrEnabled = upscaleMode !== 0 && resolutionScale < 1.0
        const fsrFxaa = fsrEnabled && upscaleMode === 2
        // FXAA (mode "easu-fxaa") also runs on full-res frames — after EASU
        // during motion, or directly on the native scene when not upscaling
        // (still camera / 100% render scale). `fullOutput` = the frame ends up
        // at full display resolution (so the canvas is sized full and a final
        // post pass composites into it).
        const wantFxaa = upscaleMode === 2
        const fullResFxaa = wantFxaa && !fsrEnabled
        const fullOutput = fsrEnabled || wantFxaa

        if (!this.#pipeline) return
        if (sceneWidth === 0 || sceneHeight === 0) return
        if (this.#fullWidth <= 0 || this.#fullHeight <= 0) return

        const packed = u32[b4 + L.O_VIEW_SETTINGS / 4]
        this.#lastSelectionMode = (packed >> 2) & 7
        const beamEnabled = (packed & 2) !== 0

        this.#ensureRenderTextures(sceneWidth, sceneHeight)

        const viewTransform = new Float32Array(buffer, slotBase + L.O_VIEW_TRANSFORM, 16)
        const cameraPosition: [number, number, number] = [
            f32[b4 + L.O_CAMERA_POSITION / 4],
            f32[b4 + L.O_CAMERA_POSITION / 4 + 1],
            f32[b4 + L.O_CAMERA_POSITION / 4 + 2],
        ]
        const viewCenter: [number, number] = [f32[b4 + L.O_VIEW_CENTER / 4], f32[b4 + L.O_VIEW_CENTER / 4 + 1]]
        const psBase = b4 + L.O_PREVIEW_SHADING / 4
        const previewShading: PreviewShadingParams = {
            ambient: f32[psBase],
            diffuseWrap: f32[psBase + 1],
            keyWeight: f32[psBase + 2],
            fillWeight: f32[psBase + 3],
            rimWeight: f32[psBase + 4],
            backWeight: f32[psBase + 5],
            specIntensity: f32[psBase + 6],
            // psBase + 7 / psBase + 8 are dead slots — shader hard-codes
            // specular power 32 and Schlick Fresnel power 5.
            fresnelIntensity: f32[psBase + 9],
            aoStrength: f32[psBase + 10],
            aoRadius: f32[psBase + 11],
            aoSteps: f32[psBase + 12],
            aoBias: f32[psBase + 13],
        }
        this.#profileCtx.ao = previewShading.aoStrength
        this.#profileCtx.scale = resolutionScale
        this.#profileCtx.w = sceneWidth
        this.#profileCtx.h = sceneHeight
        this.#uploadCameraIfDirty(
            viewTransform,
            cameraPosition,
            sceneWidth,
            sceneHeight,
            f32[b4 + L.O_ZOOM / 4],
            viewCenter,
            previewShading,
            (packed & 128) !== 0,
        )

        this.#viewSettingsBuf[0] = packed & 1 ? 1 : 0
        this.#viewSettingsBuf[1] = this.#stepHeatmapEnabled ? 1 : 0 // debugHeatmap; see preview.wgsl ViewSettings
        this.#viewSettingsBuf[2] = beamEnabled ? 1 : 0
        this.#viewSettingsBuf[3] = this.#lastSelectionMode
        this.#viewSettingsBuf[4] = packed & 256 ? 1 : 0 // ghostMode (SAB bit 8)
        this.#viewSettingsBuf[5] = packed & 512 ? 1 : 0 // flatShading (SAB bit 9); see preview.wgsl ViewSettings
        this.#viewSettingsBuf[6] = packed & 1024 ? 1 : 0 // debugTessEdges (SAB bit 10); see preview.wgsl ViewSettings
        this.#writeBufferViewIfDirty(this.#uniformBuffers.viewSettings, this.#viewSettingsBuf, this.#viewSettingsCache)

        const rmBase = slotBase + L.O_RAY_MARCH_PARAMS
        // SAB carries only the *effective* values for this frame — the main
        // thread already substituted the *Moving variants when motion is
        // active. The Moving fields are zeroed here purely to satisfy the
        // `RayMarchParams` type; the worker doesn't read them.
        this.#uploadRayMarchParams({
            maxSteps: new Int32Array(buffer, rmBase, 1)[0],
            maxStepsMoving: 0,
            maxBeamSteps: new Int32Array(buffer, rmBase + 4, 1)[0],
            maxBeamStepsMoving: 0,
            hitRefineSteps: new Int32Array(buffer, rmBase + 8, 1)[0],
            hitRefineStepsMoving: 0,
            maxDist: new Float32Array(buffer, rmBase + 16, 1)[0],
            rayOriginDepth: new Float32Array(buffer, rmBase + 20, 1)[0],
        })

        // OutlineSettings upload removed — the outline shader is now a pure
        // blit and reads none of these fields. Selection rendering lives
        // inline in preview.wgsl (boundary outline via `fwidth(selFloat)` +
        // the existing object tint).

        const def = DEFAULT_SELECTION_STYLES
        const so = L.O_SELECTION_STYLES / 4
        this.#selectionStylesF32[0] = f32[b4 + so]
        this.#selectionStylesF32[4] = f32[b4 + so + 1]
        this.#selectionStylesF32[5] = f32[b4 + so + 2]
        this.#selectionStylesF32[6] = f32[b4 + so + 3]
        this.#selectionStylesF32[8] = f32[b4 + so + 4]
        this.#selectionStylesF32[9] = f32[b4 + so + 5]
        this.#selectionStylesF32[10] = f32[b4 + so + 6]
        this.#selectionStylesF32[12] = def.edge.selectedStrength
        this.#selectionStylesF32[13] = def.edge.hoverStrength
        this.#selectionStylesF32[14] = def.face.dotSpacing
        this.#selectionStylesF32[15] = def.face.dotRadius
        this.#selectionStylesF32[16] = def.face.dotDarken
        this.#selectionStylesF32[17] = resolutionScale
        this.#writeBufferViewIfDirty(this.#uniformBuffers.selectionStyles, this.#selectionStylesF32, this.#selectionStylesCache)

        this.#writeBufferFromSABIfDirty(
            this.#uniformBuffers.selectedObjectIds,
            buffer,
            slotBase + L.O_SELECTED_OBJECT_IDS,
            L.SELECTED_OBJECT_IDS_SIZE,
            this.#selectedIdsCache,
        )
        this.#writeBufferFromSABIfDirty(
            this.#uniformBuffers.selectedEdges,
            buffer,
            slotBase + L.O_SELECTED_EDGES_HEADER,
            L.SELECTED_EDGES_TOTAL,
            this.#selectedEdgesCache,
        )
        this.#writeBufferFromSABIfDirty(
            this.#uniformBuffers.hoveredEdge,
            buffer,
            slotBase + L.O_HOVERED_EDGES_HEADER,
            L.SELECTED_EDGES_TOTAL,
            this.#hoveredEdgesCache,
        )

        // Fast pick: uniforms are now current, so render just a few pixels
        // around the click into the offscreen `#colorTexture` to populate the
        // pick atomics, then bail — no full raymarch, no canvas, no post passes.
        // The shader reads `tStartTex` from the previous full frame (the camera
        // is static when picking), so the result matches a full render.
        if (pickClickUV) {
            const w = this.#renderTextureWidth
            const h = this.#renderTextureHeight
            const R = 3
            const cx = Math.round(pickClickUV[0] * w)
            const cy = Math.round((1 - pickClickUV[1]) * h)
            const x = Math.max(0, Math.min(w - 1, cx - R))
            const y = Math.max(0, Math.min(h - 1, cy - R))
            const sw = Math.min(2 * R + 1, w - x)
            const sh = Math.min(2 * R + 1, h - y)
            const enc = this.#device.createCommandEncoder({ label: "pick" })
            const pass = enc.beginRenderPass({
                label: "pick",
                colorAttachments: [{ view: this.#colorTextureView, loadOp: "clear", storeOp: "store" }],
            })
            pass.setPipeline(this.#pipeline)
            pass.setBindGroup(0, this.#bindGroup!)
            pass.setScissorRect(x, y, sw, sh)
            pass.draw(4)
            pass.end()
            this.#device.queue.submit([enc.finish()])
            return
        }

        // Canvas sizing:
        //  - FSR path: the canvas stays at full display resolution; the scene
        //    renders into the reduced-res `#colorTexture` and EASU (+FXAA)
        //    upscale it into the swapchain.
        //  - Legacy path: size the drawing buffer to the scene render size and
        //    render directly into the swapchain; the DOM canvas keeps its CSS
        //    size so the browser compositor bilinear-upscales it for free. (At
        //    scale 1.0 the scene size already equals the full size, so this is
        //    a no-op native-resolution render.)
        if (fullOutput) {
            this.#resizeCanvasIfNeeded(this.#fullWidth, this.#fullHeight)
        } else {
            this.#resizeCanvasIfNeeded(sceneWidth, sceneHeight)
        }
        // Full-res FXAA renders the scene into the sampleable full-res
        // intermediate (`#easuOutView`) so the FXAA pass can read it.
        if (fullResFxaa) this.#ensureUpscaleTextures(this.#fullWidth, this.#fullHeight, true)
        const canvasTexture = this.#context.getCurrentTexture()
        const canvasView = canvasTexture.createView()
        const commandEncoder = this.#device.createCommandEncoder()
        this.#beginFrameProfiling()

        if (beamEnabled && this.#beamPipeline) {
            if (this.#beamBindGroupInvalid) {
                this.#beamBindGroup = this.#device.createBindGroup({
                    label: "beamPrePass",
                    layout: this.#beamPipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 1, resource: { buffer: this.#uniformBuffers.camera } },
                        // viewSettings (binding 6): the beam shader force-references it (`_ = viewSettings.selectionMode`)
                        // so its auto bind-group layout keeps binding 6 even when the fast SDF doesn't read viewSettings.
                        { binding: 6, resource: { buffer: this.#uniformBuffers.viewSettings } },
                        { binding: 8, resource: this.#tStartTextureView },
                        { binding: 9, resource: { buffer: this.#uniformBuffers.polygonVertices } },
                        { binding: 19, resource: { buffer: this.#uniformBuffers.previewParamsF32 } },
                        { binding: 20, resource: { buffer: this.#uniformBuffers.previewParamsVec2 } },
                        { binding: 21, resource: { buffer: this.#uniformBuffers.previewParamsVec3 } },
                        { binding: 23, resource: { buffer: this.#uniformBuffers.previewParamsMat3 } },
                        { binding: 24, resource: { buffer: this.#uniformBuffers.previewCapParamDrag } },
                        { binding: 25, resource: { buffer: this.#uniformBuffers.rayMarchParams } },
                    ],
                })
                this.#beamBindGroupInvalid = false
            }
            const BEAM_TILE_SIZE = 8
            const tilesX = Math.ceil(sceneWidth / BEAM_TILE_SIZE)
            const tilesY = Math.ceil(sceneHeight / BEAM_TILE_SIZE)
            const beamPass = commandEncoder.beginComputePass({
                label: "Beam Pre-Pass",
                timestampWrites: this.#timestampWritesFor("beam"),
            })
            beamPass.setPipeline(this.#beamPipeline)
            beamPass.setBindGroup(0, this.#beamBindGroup!)
            beamPass.dispatchWorkgroups(Math.ceil(tilesX / 8), Math.ceil(tilesY / 8))
            beamPass.end()
        }

        // Scene target: the reduced-res `#colorTexture` when upscaling; the
        // full-res `#easuOutView` intermediate when applying full-res FXAA; else
        // the canvas swapchain directly. The r32uint object-ID texture is gone —
        // click picking uses the `clickedObjectId` atomic written in the shader.
        const sceneTarget = fsrEnabled ? this.#colorTextureView : fullResFxaa ? this.#easuOutView! : canvasView
        const deferred = this.#prepareDeferred((packed & 1) !== 0, sceneWidth, sceneHeight)
        // Phase 2: if only selection/hover changed since the last geometry pass
        // (same camera/resolution/shading + build generation), reuse the
        // retained G-buffer and run shade-only — the SDF march is skipped, so
        // the repaint cost is independent of scene depth. Picks never reach here
        // (they return early above). The geometry hash includes resolution, so a
        // res change forces a fresh geometry pass at the new size.
        let skipGeometry = false
        if (deferred) {
            const geomHash = this.#geometryHashFromSAB(buffer, slotBase)
            if (this.#gbuffer && this.#lastGeometryHash === geomHash && this.#lastGeometryBuildGen === this.#buildGeneration) {
                skipGeometry = true
            } else {
                this.#lastGeometryHash = geomHash
                this.#lastGeometryBuildGen = this.#buildGeneration
            }
        }
        this.#encodeScenePass(commandEncoder, sceneTarget, deferred, skipGeometry)

        if (fsrEnabled) {
            this.#encodeUpscale(commandEncoder, canvasView, sceneWidth, sceneHeight, this.#fullWidth, this.#fullHeight, fsrFxaa)
        } else if (fullResFxaa) {
            this.#encodeFxaaPass(commandEncoder, canvasView)
        }

        // Overlay draws on top with loadOp "load". At full output resolution
        // (upscaling or full-res FXAA) it renders crisp at display res; else at
        // the reduced scene/canvas resolution.
        const overlayW = fullOutput ? this.#fullWidth : sceneWidth
        const overlayH = fullOutput ? this.#fullHeight : sceneHeight
        this.#renderFeatureGraphOverlay(
            commandEncoder,
            canvasView,
            viewTransform,
            cameraPosition,
            overlayW,
            overlayH,
            f32[b4 + L.O_ZOOM / 4]!,
            viewCenter,
            sceneWidth,
            sceneHeight,
            deferred,
        )
        this.#renderGizmoOverlay(
            commandEncoder,
            canvasView,
            viewTransform,
            cameraPosition,
            overlayW,
            overlayH,
            f32[b4 + L.O_ZOOM / 4]!,
            viewCenter,
        )

        const filledSnap = this.#endFrameProfiling(commandEncoder)
        this.#device.queue.submit([commandEncoder.finish()])
        if (filledSnap.length > 0) void this.#drainTimestampReadback(filledSnap)
    }

    async #renderFrameAndWait(): Promise<void> {
        if (!this.#lastRenderMsg || !this.#pipeline) return
        this.render(this.#lastRenderMsg)
        await this.#device.queue.onSubmittedWorkDone()
    }

    async handleRenderMesh(
        body: string,
        requestId?: number,
        documentName?: string,
        simplifyOnExport = false,
        exporter: ExporterKind = "mdc",
        exporterTuning?: Partial<Record<ExporterKind, unknown>>,
        simplifyTuning?: SimplifyTuning,
        cancelBuffer?: SharedArrayBuffer,
    ): Promise<void> {
        // Supersede any still-running export: aborting its signal lets the
        // exporter bail out of GPU/CPU work instead of running to completion.
        this.#meshExportAbort?.abort()
        const abort = new AbortController()
        this.#meshExportAbort = abort
        try {
            if (!this.#scene || this.#builtBody !== body) {
                await this.build(body, undefined)
            }
            const bounds = await this.#computeSceneBoundsRefined()
            if (!bounds) {
                self.postMessage({
                    type: "renderMeshResult",
                    error: "Bounds compute found no inside samples; is the SDF empty or far from origin?",
                    requestId,
                    documentName,
                })
                return
            }
            const pad = 3.2
            const minX = bounds.min[0] - pad
            const minY = bounds.min[1] - pad
            const minZ = bounds.min[2] - pad
            const maxX = bounds.max[0] + pad
            const maxY = bounds.max[1] + pad
            const maxZ = bounds.max[2] + pad
            // Exact sampled bounds (pre-pad): exporter lattices derive from
            // these, so reproducing an export run outside the browser needs
            // them verbatim (GPU f32 sampling differs from analytic bounds).
            log("MeshExport").info("scene bounds (sampled, pre-pad)", {
                min: [bounds.min[0], bounds.min[1], bounds.min[2]],
                max: [bounds.max[0], bounds.max[1], bounds.max[2]],
            })

            const scene = this.#scene!
            const sceneAux = scene.compileAux()
            const sceneAuxFast = scene.compileAuxFast()
            const sceneAuxMid = scene.compileAuxMid()
            const sceneSDF = scene.compile()
            const sceneSDF_fast = scene.compileFast()
            const sceneSDF_mid = scene.compileMid()

            // Build the shared context handed to every exporter. The exporter
            // sizes its own grid (`computeUniformGrid`) or octree
            // (`worldBoundsCube`) from its own tuning's voxel/depth.
            const ctx: MeshExportContext = {
                device: this.#device,
                helper: this.#helper,
                uniformBuffers: {
                    polygonVertices: this.#uniformBuffers.polygonVertices,
                    faceSelection: this.#uniformBuffers.faceSelection,
                    mdcSceneParams: this.#uniformBuffers.mdcSceneParams,
                },
                scene,
                bounds: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
                worldBoundsCube: () => {
                    const cx = (minX + maxX) * 0.5
                    const cy = (minY + maxY) * 0.5
                    const cz = (minZ + maxZ) * 0.5
                    const half = Math.max(maxX - minX, maxY - minY, maxZ - minZ) * 0.5
                    return {
                        min: [cx - half, cy - half, cz - half],
                        max: [cx + half, cy + half, cz + half],
                    }
                },
                computeUniformGrid: (voxelSizeMm: number) => {
                    const sizeX = Math.max(voxelSizeMm, maxX - minX)
                    const sizeY = Math.max(voxelSizeMm, maxY - minY)
                    const sizeZ = Math.max(voxelSizeMm, maxZ - minZ)
                    return {
                        gridDimX: Math.max(2, Math.ceil(sizeX / voxelSizeMm) + 1),
                        gridDimY: Math.max(2, Math.ceil(sizeY / voxelSizeMm) + 1),
                        gridDimZ: Math.max(2, Math.ceil(sizeZ / voxelSizeMm) + 1),
                        gridOffsetX: minX,
                        gridOffsetY: minY,
                        gridOffsetZ: minZ,
                    }
                },
                buildFeatureGraph: (s, cellSize) => this.#buildFeatureGraph(s, cellSize),
                makeSceneCompiler: () =>
                    new ShaderCompiler(this.#device)
                        .replace("insert", "sceneAuxFast", sceneAuxFast)
                        .replace("insert", "sceneAux", sceneAux)
                        .replace("insert", "sceneAuxMid", sceneAuxMid)
                        .replace("insert", "sceneSDF_fast", sceneSDF_fast)
                        .replace("insert", "sceneSDF", sceneSDF)
                        .replace("insert", "sceneSDF_mid", sceneSDF_mid),
                signal: abort.signal,
                // Forward each live phase tick to the main thread. Cheap (one postMessage
                // per phase boundary, ~5/export) and only fires for exporters that emit.
                // The main thread uses it to drive the live export indicator.
                onProgress: (p) => {
                    if (abort.signal.aborted) return
                    self.postMessage({ type: "exportProgress", requestId, documentName, ...p })
                },
                // User-cancel flag (slot 0): the main thread writes 1 on the Cancel click.
                // A cancellable exporter (sfcc-rs) polls it and throws MeshExportCancelledError.
                cancelFlag: cancelBuffer ? new Int32Array(cancelBuffer) : undefined,
            }

            const exp = getExporter(exporter)
            const tuning = exp.normalizeTuning(exporterTuning?.[exporter])
            log("MeshExport").info(`handleRenderMesh: dispatching ${exporter}, tuning=${JSON.stringify(tuning)}`)
            let mesh
            const tConvert0 = performance.now()
            try {
                mesh = await exp.run(ctx, tuning)
            } catch (err) {
                // The user cancelled this export — report it as cancelled (empty result)
                // so the main thread keeps its previous mesh and clears the indicator.
                if (err instanceof MeshExportCancelledError) {
                    self.postMessage({ type: "renderMeshResult", requestId, documentName, cancelled: true })
                    return
                }
                // A newer export aborted this one — report it as superseded
                // (empty result) rather than surfacing an error to the user.
                if (abort.signal.aborted) {
                    self.postMessage({ type: "renderMeshResult", requestId, documentName })
                    return
                }
                throw err
            }
            // Always-on mesh conversion timing, tagged with the algorithm — emitted
            // for every exporter regardless of tuning/profile so each algorithm's
            // core conversion cost is comparable from the logs alone.
            log("MeshExport").info(
                `mesh conversion: algorithm=${exporter} (${exp.displayName}) ` +
                    `timeMs=${(performance.now() - tConvert0).toFixed(1)} tris=${mesh.tris.length / 3}`,
            )

            // Unified mesh post-passes for **both** MDC and SHREC: optional QEM
            // simplification (when enabled and targetRatio < 1), then optional
            // normal recompute — gated only by `simplifyTuning.renormalizeTriangles`
            // (Dev Tools checkbox), not by simplify enablement or target ratio.
            if (mesh.tris.length > 0) {
                const s = { ...DEFAULT_SIMPLIFY_TUNING, ...simplifyTuning }
                if (simplifyOnExport && s.targetRatio < 1) {
                    log("Simplify").info(
                        `Mesh simplification dispatched: exporter=${exporter} ` +
                            `targetRatio=${s.targetRatio} targetError=${s.targetError} ` +
                            `lockBorder=${s.lockBorder} sparse=${s.sparse} errorAbsolute=${s.errorAbsolute} ` +
                            `prune=${s.prune} regularize=${s.regularize} normalWeight=${s.normalWeight}`,
                    )
                    const { simplifyMesh } = await import("./export/simplify.mjs")
                    mesh = await simplifyMesh(mesh, s.targetRatio, s.targetError, {
                        lockBorder: s.lockBorder,
                        sparse: s.sparse,
                        errorAbsolute: s.errorAbsolute,
                        prune: s.prune,
                        regularize: s.regularize,
                        normalWeight: s.normalWeight > 0 ? s.normalWeight : undefined,
                        renormalizeTriangles: false,
                    })
                }
                if (s.renormalizeTriangles) {
                    // Flat face normals: these meshes are geometry-inspection
                    // artifacts — the normal view should show each facet's
                    // true orientation, not smoothing-group averages.
                    log("Simplify").info(`Mesh flat face normals: exporter=${exporter} renormalizeTriangles=true`)
                    const { flatFaceNormals } = await import("./export/crease-split.mjs")
                    const flat = flatFaceNormals(mesh.verts, mesh.tris)
                    mesh = { verts: flat.verts, tris: flat.tris, debug: mesh.debug }
                }
            }

            const transfer: Transferable[] = [mesh.verts.buffer, mesh.tris.buffer]
            if (mesh.debug?.mdc) {
                transfer.push(mesh.debug.mdc.samples.buffer)
            }
            self.postMessage({ type: "renderMeshResult", mesh, requestId, documentName }, { transfer })
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err)
            self.postMessage({ type: "renderMeshResult", error: errorMsg, requestId, documentName })
        }
    }

    async #computeSceneBounds(
        searchMin: [number, number, number],
        searchMax: [number, number, number],
        stepMm: number,
    ): Promise<{ min: readonly [number, number, number]; max: readonly [number, number, number] } | null> {
        const SCALE = 1000
        const dimsX = Math.max(1, Math.ceil((searchMax[0] - searchMin[0]) / stepMm) + 1)
        const dimsY = Math.max(1, Math.ceil((searchMax[1] - searchMin[1]) / stepMm) + 1)
        const dimsZ = Math.max(1, Math.ceil((searchMax[2] - searchMin[2]) / stepMm) + 1)
        const uniformsData = new ArrayBuffer(80)
        new Float32Array(uniformsData, 0, 4).set([searchMin[0], searchMin[1], searchMin[2], stepMm])
        new Float32Array(uniformsData, 16, 4).set([searchMax[0], searchMax[1], searchMax[2], 0.0])
        new Uint32Array(uniformsData, 32, 4).set([dimsX >>> 0, dimsY >>> 0, dimsZ >>> 0, 0])
        new Float32Array(uniformsData, 48, 1).set([SCALE])
        const uniformBuffer = this.#device.createBuffer({
            size: 80,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "BoundsUniforms",
        })
        this.#device.queue.writeBuffer(uniformBuffer, 0, uniformsData)
        const TILE_STRIDE_BYTES = 48
        const totalSamples = dimsX * dimsY * dimsZ
        const totalWorkgroups = Math.ceil(totalSamples / 256)
        const MAX_WG = 65535
        let dispatchX = Math.min(totalWorkgroups, MAX_WG)
        let dispatchY = Math.max(1, Math.ceil(totalWorkgroups / dispatchX))
        let dispatchZ = 1
        if (dispatchY > MAX_WG) {
            dispatchY = MAX_WG
            dispatchZ = Math.max(1, Math.ceil(totalWorkgroups / (dispatchX * dispatchY)))
        }
        if (dispatchZ > MAX_WG) {
            throw new Error(`Bounds grid too large for one GPU dispatch (${totalWorkgroups} workgroups)`)
        }
        const dispatchedWorkgroups = dispatchX * dispatchY * dispatchZ
        const outBuffer = this.#device.createBuffer({
            size: dispatchedWorkgroups * TILE_STRIDE_BYTES,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
            label: "BoundsOut",
        })
        const scene = this.#scene!
        const sceneAux = scene.compileAux()
        const sceneAuxFast = scene.compileAuxFast()
        const sceneSDF_fast = scene.compileFast()
        const shaderCompiler = new ShaderCompiler(this.#device)
            .replace("insert", "sceneAuxFast", sceneAuxFast)
            .replace("insert", "sceneAux", sceneAux)
            .replace("insert", "sceneSDF_fast", sceneSDF_fast)
        let boundsShaderModule: GPUShaderModule | undefined
        let boundsPipeline: GPUComputePipeline | undefined
        let bindGroup: GPUBindGroup | undefined
        try {
            boundsShaderModule = shaderCompiler.compile(boundsShader, "Bounds")
            boundsPipeline = this.#device.createComputePipeline({
                layout: "auto",
                compute: { module: boundsShaderModule, entryPoint: "computeBounds" },
            })
            const layout = boundsPipeline.getBindGroupLayout(0)
            bindGroup = this.#device.createBindGroup({
                layout,
                entries: [
                    { binding: 0, resource: { buffer: uniformBuffer } },
                    { binding: 1, resource: { buffer: outBuffer } },
                    { binding: 3, resource: { buffer: this.#uniformBuffers.polygonVertices } },
                    { binding: 4, resource: { buffer: this.#uniformBuffers.faceSelection } },
                    { binding: 6, resource: { buffer: this.#uniformBuffers.boundsSceneParams } },
                    { binding: 99, resource: { buffer: this.#uniformBuffers.selectedObjectIds } },
                ],
            })
            const encoder = this.#device.createCommandEncoder()
            const pass = encoder.beginComputePass()
            pass.setPipeline(boundsPipeline)
            pass.setBindGroup(0, bindGroup)
            pass.dispatchWorkgroups(dispatchX, dispatchY, dispatchZ)
            pass.end()
            this.#device.queue.submit([encoder.finish()])
            await this.#device.queue.onSubmittedWorkDone()
            const readback = await this.#helper.readBufferData(outBuffer, dispatchedWorkgroups * TILE_STRIDE_BYTES)
            const dv = new DataView(readback)
            let any = false
            let minXq = 2147483647
            let minYq = 2147483647
            let minZq = 2147483647
            let maxXq = -2147483648
            let maxYq = -2147483648
            let maxZq = -2147483648
            for (let t = 0; t < dispatchedWorkgroups; t++) {
                const base = t * TILE_STRIDE_BYTES
                const anyInside = dv.getUint32(base + 32, true)
                if (!anyInside) continue
                any = true
                const txMinX = dv.getInt32(base + 0, true)
                const txMinY = dv.getInt32(base + 4, true)
                const txMinZ = dv.getInt32(base + 8, true)
                const txMaxX = dv.getInt32(base + 16, true)
                const txMaxY = dv.getInt32(base + 20, true)
                const txMaxZ = dv.getInt32(base + 24, true)
                if (txMinX < minXq) minXq = txMinX
                if (txMinY < minYq) minYq = txMinY
                if (txMinZ < minZq) minZq = txMinZ
                if (txMaxX > maxXq) maxXq = txMaxX
                if (txMaxY > maxYq) maxYq = txMaxY
                if (txMaxZ > maxZq) maxZq = txMaxZ
            }
            if (!any) return null
            return {
                min: [minXq / SCALE, minYq / SCALE, minZq / SCALE] as const,
                max: [maxXq / SCALE, maxYq / SCALE, maxZq / SCALE] as const,
            }
        } finally {
            // Shader module, pipeline, bind group: no destroy(); locals go out of scope. Buffers we allocated:
            uniformBuffer.destroy()
            outBuffer.destroy()
        }
    }

    async #computeSceneBoundsRefined(): Promise<{ min: readonly [number, number, number]; max: readonly [number, number, number] } | null> {
        const COARSE_HALF = 250
        const coarse = await this.#computeSceneBounds(
            [-COARSE_HALF, -COARSE_HALF, -COARSE_HALF],
            [COARSE_HALF, COARSE_HALF, COARSE_HALF],
            2.0,
        )
        if (!coarse) return null
        const inflate = 4.0
        const min = [coarse.min[0] - inflate, coarse.min[1] - inflate, coarse.min[2] - inflate] as const
        const max = [coarse.max[0] + inflate, coarse.max[1] + inflate, coarse.max[2] + inflate] as const
        const refined = await this.#computeSceneBounds([min[0], min[1], min[2]], [max[0], max[1], max[2]], 0.5)
        return refined ?? coarse
    }

    async handleBenchmark(frameCount: number, waitForGPU: boolean, requestId?: number): Promise<void> {
        if (!this.#pipeline) {
            self.postMessage({
                type: "benchmarkResult",
                result: {
                    totalTime: 0,
                    averageFrameTime: 0,
                    minFrameTime: 0,
                    maxFrameTime: 0,
                    framesPerSecond: 0,
                    frameTimes: [],
                    error: "Cannot benchmark: renderer not initialized. Call build() first.",
                },
                requestId,
            })
            return
        }
        const frameTimes: number[] = []
        const startTime = performance.now()
        if (waitForGPU) {
            await this.#renderFrameAndWait()
        }
        for (let i = 0; i < frameCount; i++) {
            const frameStart = performance.now()
            if (waitForGPU) {
                await this.#renderFrameAndWait()
            } else {
                if (this.#lastRenderMsg) this.render(this.#lastRenderMsg)
            }
            frameTimes.push(performance.now() - frameStart)
        }
        const totalTime = performance.now() - startTime
        const n = frameTimes.length
        const averageFrameTime = n > 0 ? totalTime / n : 0
        const minFrameTime = n > 0 ? Math.min(...frameTimes) : 0
        const maxFrameTime = n > 0 ? Math.max(...frameTimes) : 0
        const framesPerSecond = totalTime > 0 ? (n / totalTime) * 1000 : 0
        self.postMessage({
            type: "benchmarkResult",
            result: { totalTime, averageFrameTime, minFrameTime, maxFrameTime, framesPerSecond, frameTimes },
            requestId,
        })
    }

    async handleThumbnail(body: string, width?: number, height?: number, requestId?: number, documentName?: string): Promise<void> {
        const thumbWidth = Math.max(1, Math.min(512, width ?? 256))
        const thumbHeight = Math.max(1, Math.min(512, height ?? 256))
        const previousBody = this.#builtBody
        let builtForThisThumb = false
        try {
            if (!this.#device) {
                self.postMessage({ type: "thumbnailResult", error: "WebGPU device unavailable", requestId, documentName })
                return
            }
            if (!this.#scene || this.#builtBody !== body) {
                await this.build(body, undefined)
                builtForThisThumb = true
            }
            if (!this.#pipeline) {
                self.postMessage({ type: "thumbnailResult", error: "Scene failed to build", requestId, documentName })
                return
            }
            const eye = vec3(30, 25, 30)
            const center = vec3(0, 0, 0)
            const up = vec3(0, 1, 0)
            const viewMatrix = lookAt(eye, center, up)
            const thumbMsg: Extract<MainToWorkerMessage, { type: "render" }> = {
                type: "render",
                cameraState: { rotation: [1, 0, 0, 0], dollyDistance: 50, translation: vec3(0, 0, 0) },
                viewTransform: viewMatrix.data,
                cameraPosition: [eye.x, eye.y, eye.z],
                cameraRes: [thumbWidth, thumbHeight],
                selectionState: {
                    selectedObjectIds: [],
                    selectedEdges: [],
                    hoveredObjectId: 0,
                    hoveredEdges: [],
                },
                viewSettings: {
                    xrayMode: false,
                    beamEnabled: false,
                    selectionMode: 0,
                    outlineMode: 0,
                    outlineThickness: 1,
                    outlineColor: [1, 1, 0],
                    selectionStyles: {
                        face: { darken: DEFAULT_SELECTION_STYLES.face.darken, tint: [...DEFAULT_SELECTION_STYLES.face.tint] },
                        edge: { color: [...DEFAULT_SELECTION_STYLES.edge.color] },
                    },
                    previewShading: DEFAULT_PREVIEW_SHADING,
                    previewNormalShading: false,
                },
                viewCenter: [0.5, 0.5],
                resolutionScale: 1.0,
                hidePivotCursor: true,
            }
            let thumbOutputTexture: GPUTexture | undefined
            let readbackBuffer: GPUBuffer | undefined
            let readbackMapped = false
            try {
                thumbOutputTexture = this.#device.createTexture({
                    label: "ThumbnailOutput",
                    size: [thumbWidth, thumbHeight],
                    format: this.#format,
                    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
                })
                this.render(thumbMsg, thumbOutputTexture.createView())
                await this.#device.queue.onSubmittedWorkDone()
                const bytesPerRow = Math.ceil((thumbWidth * 4) / 256) * 256
                const bufferSize = bytesPerRow * thumbHeight
                readbackBuffer = this.#device.createBuffer({
                    label: "ThumbnailReadback",
                    size: bufferSize,
                    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
                })
                const encoder = this.#device.createCommandEncoder()
                encoder.copyTextureToBuffer(
                    { texture: thumbOutputTexture },
                    { buffer: readbackBuffer, bytesPerRow, rowsPerImage: thumbHeight },
                    [thumbWidth, thumbHeight, 1],
                )
                this.#device.queue.submit([encoder.finish()])
                await readbackBuffer.mapAsync(GPUMapMode.READ)
                readbackMapped = true
                const mapped = new Uint8Array(readbackBuffer.getMappedRange())
                const imageData = new ImageData(thumbWidth, thumbHeight)
                const isBgra = this.#format.includes("bgra")
                for (let y = 0; y < thumbHeight; y++) {
                    const srcRow = y * bytesPerRow
                    const dstRow = y * thumbWidth * 4
                    for (let x = 0; x < thumbWidth; x++) {
                        const srcOff = srcRow + x * 4
                        const dstOff = dstRow + x * 4
                        if (isBgra) {
                            imageData.data[dstOff + 0] = mapped[srcOff + 2]
                            imageData.data[dstOff + 1] = mapped[srcOff + 1]
                            imageData.data[dstOff + 2] = mapped[srcOff + 0]
                            imageData.data[dstOff + 3] = mapped[srcOff + 3]
                        } else {
                            imageData.data[dstOff + 0] = mapped[srcOff + 0]
                            imageData.data[dstOff + 1] = mapped[srcOff + 1]
                            imageData.data[dstOff + 2] = mapped[srcOff + 2]
                            imageData.data[dstOff + 3] = mapped[srcOff + 3]
                        }
                    }
                }
                self.postMessage({ type: "thumbnailResult", imageData, requestId, documentName }, { transfer: [imageData.data.buffer] })
            } finally {
                if (readbackMapped) {
                    try {
                        readbackBuffer?.unmap()
                    } catch {
                        /* ignore */
                    }
                }
                readbackBuffer?.destroy()
                thumbOutputTexture?.destroy()
            }
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err)
            self.postMessage({ type: "thumbnailResult", error: errorMsg, requestId, documentName })
        } finally {
            // Thumbnails call build() directly (not the render worker queue). If the user opens a document
            // while welcome thumbnails are still loading, a later thumb can overwrite the preview pipeline.
            // Restore whatever scene was current before this thumbnail when we actually switched bodies.
            if (builtForThisThumb && previousBody !== null && previousBody !== body && this.#builtBody === body) {
                try {
                    await this.build(previousBody, undefined)
                } catch {
                    // Ignore: preview may rebuild on next main-thread build()
                }
            }
        }
    }

    /** Off-screen SDF capture for agents: parameterized camera, normal-vector shading, larger max resolution than welcome thumbnails. */
    async handleAgentPreview(msg: Extract<MainToWorkerMessage, { type: "agentPreview" }>): Promise<void> {
        const AGENT_PREVIEW_MAX = 8192
        const tw = Math.max(1, Math.min(AGENT_PREVIEW_MAX, Math.floor(msg.width)))
        const th = Math.max(1, Math.min(AGENT_PREVIEW_MAX, Math.floor(msg.height)))
        const body = msg.body
        const requestId = msg.requestId
        const documentName = msg.documentName
        const previousBody = this.#builtBody
        // Isolation is now a build-time root choice; apply it before building and
        // restore it after, so this side-channel preview can't leak isolation into
        // the live session's scene.
        const previousIso = this.#isolatedIds
        const wantIso = msg.isolatedIds ?? []
        // A/B verification hook: force deferred shading on/off for this headless
        // render, restored in the finally below so it can't leak into the live
        // session's flag.
        const previousDeferred = this.#deferredShading
        if (msg.deferredShading !== undefined) this.#deferredShading = msg.deferredShading
        let builtForThis = false
        try {
            if (!this.#device) {
                self.postMessage({ type: "thumbnailResult", error: "WebGPU device unavailable", requestId, documentName })
                return
            }
            this.setIsolatedIds(wantIso)
            if (!this.#scene || this.#builtBody !== body || !sameIdList(this.#builtIsolatedIds, wantIso)) {
                await this.build(body, undefined)
                builtForThis = true
            }
            if (!this.#pipeline) {
                self.postMessage({ type: "thumbnailResult", error: "Scene failed to build", requestId, documentName })
                return
            }
            // Deferred A/B: build the geometry/shade pipelines synchronously here
            // (they're lazy, so a fresh build won't have them yet) before the
            // one-shot render so this frame actually exercises the deferred path.
            if (this.#deferredShading) await this.#ensureDeferredPipelines()
            const vt = new Float32Array(msg.viewTransform)
            const thumbMsg: Extract<MainToWorkerMessage, { type: "render" }> = {
                type: "render",
                cameraState: msg.cameraState,
                viewTransform: vt,
                cameraPosition: msg.cameraPosition,
                cameraRes: [tw, th],
                selectionState: {
                    selectedObjectIds: msg.selectedObjectIds ?? [],
                    selectedEdges: [],
                    hoveredObjectId: 0,
                    hoveredEdges: [],
                },
                viewSettings: {
                    xrayMode: false,
                    beamEnabled: false,
                    selectionMode: 0,
                    outlineMode: 0,
                    outlineThickness: 1,
                    outlineColor: [1, 1, 0],
                    selectionStyles: {
                        face: { darken: DEFAULT_SELECTION_STYLES.face.darken, tint: [...DEFAULT_SELECTION_STYLES.face.tint] },
                        edge: { color: [...DEFAULT_SELECTION_STYLES.edge.color] },
                    },
                    previewShading: DEFAULT_PREVIEW_SHADING,
                    previewNormalShading: true,
                    // Agent SDF captures always render flat so they match the faceted
                    // mesh (path2d curves shade smooth in the live preview by default).
                    flatShading: true,
                    rayMarchParams: { ...DEFAULT_RAY_MARCH_PARAMS, maxSteps: 600, hitRefineSteps: 24 },
                },
                viewCenter: [msg.viewCenter[0], msg.viewCenter[1]],
                resolutionScale: 1.0,
                hidePivotCursor: true,
            }
            let thumbOutputTexture: GPUTexture | undefined
            let readbackBuffer: GPUBuffer | undefined
            let readbackMapped = false
            try {
                thumbOutputTexture = this.#device.createTexture({
                    label: "AgentPreviewOutput",
                    size: [tw, th],
                    format: this.#format,
                    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
                })
                this.render(thumbMsg, thumbOutputTexture.createView())
                await this.#device.queue.onSubmittedWorkDone()
                const bytesPerRow = Math.ceil((tw * 4) / 256) * 256
                const bufferSize = bytesPerRow * th
                readbackBuffer = this.#device.createBuffer({
                    label: "AgentPreviewReadback",
                    size: bufferSize,
                    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
                })
                const encoder = this.#device.createCommandEncoder()
                encoder.copyTextureToBuffer({ texture: thumbOutputTexture }, { buffer: readbackBuffer, bytesPerRow, rowsPerImage: th }, [
                    tw,
                    th,
                    1,
                ])
                this.#device.queue.submit([encoder.finish()])
                await readbackBuffer.mapAsync(GPUMapMode.READ)
                readbackMapped = true
                const mapped = new Uint8Array(readbackBuffer.getMappedRange())
                const imageData = new ImageData(tw, th)
                const isBgra = this.#format.includes("bgra")
                for (let y = 0; y < th; y++) {
                    const srcRow = y * bytesPerRow
                    const dstRow = y * tw * 4
                    for (let x = 0; x < tw; x++) {
                        const srcOff = srcRow + x * 4
                        const dstOff = dstRow + x * 4
                        if (isBgra) {
                            imageData.data[dstOff + 0] = mapped[srcOff + 2]
                            imageData.data[dstOff + 1] = mapped[srcOff + 1]
                            imageData.data[dstOff + 2] = mapped[srcOff + 0]
                            imageData.data[dstOff + 3] = mapped[srcOff + 3]
                        } else {
                            imageData.data[dstOff + 0] = mapped[srcOff + 0]
                            imageData.data[dstOff + 1] = mapped[srcOff + 1]
                            imageData.data[dstOff + 2] = mapped[srcOff + 2]
                            imageData.data[dstOff + 3] = mapped[srcOff + 3]
                        }
                    }
                }
                self.postMessage({ type: "thumbnailResult", imageData, requestId, documentName }, { transfer: [imageData.data.buffer] })
            } finally {
                if (readbackMapped) {
                    try {
                        readbackBuffer?.unmap()
                    } catch {
                        /* ignore */
                    }
                }
                readbackBuffer?.destroy()
                thumbOutputTexture?.destroy()
            }
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err)
            self.postMessage({ type: "thumbnailResult", error: errorMsg, requestId, documentName })
        } finally {
            this.#isolatedIds = previousIso
            this.#deferredShading = previousDeferred
            const bodyChanged = previousBody !== null && previousBody !== body
            const isoChanged = !sameIdList(this.#builtIsolatedIds, previousIso)
            if (builtForThis && previousBody !== null && (bodyChanged || isoChanged) && this.#builtBody === body) {
                try {
                    await this.build(previousBody, undefined)
                } catch {
                    /* ignore */
                }
            }
        }
    }

    /**
     * Screenshot the *current* live SDF preview: render the supplied payload (the main thread's current
     * camera/view of the already-built scene, forced to full resolution) into an offscreen texture and
     * read it back. No rebuild from source — the pixels match what's on screen. Result is posted as
     * `thumbnailResult` (reuses the main thread's `#pendingThumbnail` plumbing).
     *
     * The texture is sized to `cameraRes × resolutionScale`; the main thread passes full resolution, so
     * the capture is a crisp full-size frame of the on-screen view (CSS upscales the live half-res buffer).
     */
    async handleCapturePreviewFrame(msg: Extract<MainToWorkerMessage, { type: "capturePreviewFrame" }>): Promise<void> {
        const requestId = msg.requestId
        try {
            if (!this.#device) {
                self.postMessage({ type: "thumbnailResult", error: "WebGPU device unavailable", requestId })
                return
            }
            if (!this.#pipeline) {
                self.postMessage({ type: "thumbnailResult", error: "no preview frame to capture (scene not built yet)", requestId })
                return
            }
            const render = msg.payload
            const w = Math.max(1, Math.round(render.cameraRes[0] * render.resolutionScale))
            const h = Math.max(1, Math.round(render.cameraRes[1] * render.resolutionScale))
            let captureTexture: GPUTexture | undefined
            let readbackBuffer: GPUBuffer | undefined
            let readbackMapped = false
            try {
                captureTexture = this.#device.createTexture({
                    label: "PreviewCaptureOutput",
                    size: [w, h],
                    format: this.#format,
                    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
                })
                this.render(render, captureTexture.createView())
                await this.#device.queue.onSubmittedWorkDone()
                const bytesPerRow = Math.ceil((w * 4) / 256) * 256
                readbackBuffer = this.#device.createBuffer({
                    label: "PreviewCaptureReadback",
                    size: bytesPerRow * h,
                    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
                })
                const encoder = this.#device.createCommandEncoder()
                encoder.copyTextureToBuffer({ texture: captureTexture }, { buffer: readbackBuffer, bytesPerRow, rowsPerImage: h }, [w, h, 1])
                this.#device.queue.submit([encoder.finish()])
                await readbackBuffer.mapAsync(GPUMapMode.READ)
                readbackMapped = true
                const mapped = new Uint8Array(readbackBuffer.getMappedRange())
                const imageData = new ImageData(w, h)
                const isBgra = this.#format.includes("bgra")
                for (let y = 0; y < h; y++) {
                    const srcRow = y * bytesPerRow
                    const dstRow = y * w * 4
                    for (let x = 0; x < w; x++) {
                        const srcOff = srcRow + x * 4
                        const dstOff = dstRow + x * 4
                        if (isBgra) {
                            imageData.data[dstOff + 0] = mapped[srcOff + 2]
                            imageData.data[dstOff + 1] = mapped[srcOff + 1]
                            imageData.data[dstOff + 2] = mapped[srcOff + 0]
                            imageData.data[dstOff + 3] = mapped[srcOff + 3]
                        } else {
                            imageData.data[dstOff + 0] = mapped[srcOff + 0]
                            imageData.data[dstOff + 1] = mapped[srcOff + 1]
                            imageData.data[dstOff + 2] = mapped[srcOff + 2]
                            imageData.data[dstOff + 3] = mapped[srcOff + 3]
                        }
                    }
                }
                self.postMessage({ type: "thumbnailResult", imageData, requestId }, { transfer: [imageData.data.buffer] })
            } finally {
                if (readbackMapped) {
                    try {
                        readbackBuffer?.unmap()
                    } catch {
                        /* ignore */
                    }
                }
                readbackBuffer?.destroy()
                captureTexture?.destroy()
            }
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err)
            self.postMessage({ type: "thumbnailResult", error: errorMsg, requestId })
        }
    }

    #ensureRenderTextures(width: number, height: number): void {
        const w = Math.max(1, width)
        const h = Math.max(1, height)
        const dimensionsChanged = w !== this.#renderTextureWidth || h !== this.#renderTextureHeight
        if (!dimensionsChanged && !this.#sceneBindGroupInvalid) return

        if (dimensionsChanged) {
            // Bind groups: no destroy(); clear refs before attaching new textures.
            this.#outlineBindGroup = undefined
            this.#beamBindGroup = undefined
            // EASU samples `#colorTextureView`, which is recreated below.
            this.#easuBindGroup = undefined

            if (this.#colorTexture) this.#colorTexture.destroy()
            if (this.#tStartTexture) this.#tStartTexture.destroy()

            // Kept only for the outputTextureView render path (thumbnails /
            // agent capture). The canvas render path writes scene fragments
            // straight to the swapchain and does not touch this texture.
            this.#colorTexture = this.#device.createTexture({
                label: "Preview Color (outputTextureView only)",
                size: [w, h],
                format: this.#format,
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            })
            this.#colorTextureView = this.#colorTexture.createView()

            const BEAM_TILE_SIZE = 8
            const tilesX = Math.ceil(w / BEAM_TILE_SIZE)
            const tilesY = Math.ceil(h / BEAM_TILE_SIZE)
            this.#tStartTexture = this.#device.createTexture({
                label: "Beam t_start",
                size: [tilesX, tilesY],
                format: "r32float",
                usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
            })
            this.#tStartTextureView = this.#tStartTexture.createView()

            this.#outlineBindGroup = this.#device.createBindGroup({
                label: "outlinePostProcess",
                layout: this.#outlinePipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: this.#colorTextureView },
                    // outline.wgsl is now a pure passthrough — no idTex /
                    // selectedObjectIds / outlineSettings bindings; sampler
                    // moved to binding 1 (was 4).
                    { binding: 1, resource: this.#colorSampler },
                ],
            })

            if (this.#beamPipeline) {
                this.#beamBindGroup = this.#device.createBindGroup({
                    label: "beamPrePass",
                    layout: this.#beamPipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 1, resource: { buffer: this.#uniformBuffers.camera } },
                        // viewSettings (binding 6): the beam shader force-references it (`_ = viewSettings.selectionMode`)
                        // so its auto bind-group layout keeps binding 6 even when the fast SDF doesn't read viewSettings.
                        { binding: 6, resource: { buffer: this.#uniformBuffers.viewSettings } },
                        { binding: 8, resource: this.#tStartTextureView },
                        { binding: 9, resource: { buffer: this.#uniformBuffers.polygonVertices } },
                        { binding: 19, resource: { buffer: this.#uniformBuffers.previewParamsF32 } },
                        { binding: 20, resource: { buffer: this.#uniformBuffers.previewParamsVec2 } },
                        { binding: 21, resource: { buffer: this.#uniformBuffers.previewParamsVec3 } },
                        { binding: 23, resource: { buffer: this.#uniformBuffers.previewParamsMat3 } },
                        { binding: 24, resource: { buffer: this.#uniformBuffers.previewCapParamDrag } },
                        { binding: 25, resource: { buffer: this.#uniformBuffers.rayMarchParams } },
                    ],
                })
                this.#beamBindGroupInvalid = false
            }

            this.#renderTextureWidth = w
            this.#renderTextureHeight = h
        }

        if (dimensionsChanged || this.#sceneBindGroupInvalid) {
            // Previous #bindGroup is dropped here (no destroy() on GPUBindGroup).
            this.#bindGroup = this.#device.createBindGroup({
                label: "scenePreview",
                layout: this.#pipeline!.getBindGroupLayout(0),
                entries: this.#sceneBindGroupEntries(),
            })
            // The depth pipeline shares this binding set; rebuild its bind group
            // too (binding 7 = tStartTextureView is recreated on resize, and the
            // uniform buffers may have changed on a rebuild). The deferred
            // geometry/shade bind groups share it as well.
            this.#depthBindGroup = null
            this.#geometryBindGroup = null
            this.#shadeBindGroup = null
            this.#sceneBindGroupInvalid = false
        }
    }

    /**
     * Scene bind-group entries (group 0), shared by the preview pipeline and the
     * depth pipeline — both reference an identical binding set, so a single entry
     * list binds to either's auto layout. Kept as one source of truth so the two
     * can't drift (drift would make the depth pipeline's bind group invalid).
     */
    #sceneBindGroupEntries(): GPUBindGroupEntry[] {
        return [
            { binding: 1, resource: { buffer: this.#uniformBuffers.camera } },
            { binding: 2, resource: { buffer: this.#uniformBuffers.clickState } },
            { binding: 3, resource: { buffer: this.#uniformBuffers.clickedObjectId } },
            { binding: 4, resource: { buffer: this.#uniformBuffers.selectedObjectIds } },
            { binding: 5, resource: { buffer: this.#uniformBuffers.colorPalette } },
            { binding: 6, resource: { buffer: this.#uniformBuffers.viewSettings } },
            { binding: 7, resource: this.#tStartTextureView },
            { binding: 9, resource: { buffer: this.#uniformBuffers.polygonVertices } },
            { binding: 10, resource: { buffer: this.#uniformBuffers.clickedHitPos } },
            { binding: 11, resource: { buffer: this.#uniformBuffers.faceSelection } },
            { binding: 13, resource: { buffer: this.#uniformBuffers.edgeHit } },
            { binding: 14, resource: { buffer: this.#uniformBuffers.selectedEdges } },
            { binding: 15, resource: { buffer: this.#uniformBuffers.hoverEdgeHit } },
            { binding: 16, resource: { buffer: this.#uniformBuffers.hoveredEdge } },
            { binding: 17, resource: { buffer: this.#uniformBuffers.clickedNormal } },
            { binding: 18, resource: { buffer: this.#uniformBuffers.selectionStyles } },
            { binding: 19, resource: { buffer: this.#uniformBuffers.previewParamsF32 } },
            { binding: 20, resource: { buffer: this.#uniformBuffers.previewParamsVec2 } },
            { binding: 21, resource: { buffer: this.#uniformBuffers.previewParamsVec3 } },
            { binding: 23, resource: { buffer: this.#uniformBuffers.previewParamsMat3 } },
            { binding: 24, resource: { buffer: this.#uniformBuffers.previewCapParamDrag } },
            { binding: 25, resource: { buffer: this.#uniformBuffers.rayMarchParams } },
        ]
    }

    /** Drop the deferred pipelines + bind groups and bump the build generation
     * (so any in-flight async compile for the old shader is discarded). Called
     * on every scene rebuild; the build re-kicks the compile if the knob is on. */
    #invalidateDeferredPipelines(): void {
        this.#geometryPipeline = null
        this.#shadePipeline = null
        this.#occlusionGbufferPipeline = null
        this.#geometryBindGroup = null
        this.#shadeBindGroup = null
        this.#occlusionGbufferBindGroup = null
        this.#deferredPipelineGen++
    }

    /**
     * Lazily compile the deferred geometry+shade pipelines from the current
     * scene shader. Built only when deferred shading is enabled, so the
     * default-off path pays nothing (compiling the deep-scene shader for two
     * extra entry points is not free). Best-effort: a failure leaves them null
     * and renders fall back to the single pass. A scene rebuild bumps the
     * generation, discarding an in-flight compile for a stale shader.
     */
    async #ensureDeferredPipelines(): Promise<void> {
        if (this.#geometryPipeline && this.#shadePipeline && this.#occlusionGbufferPipeline) return
        const shader = this.#sceneShader
        if (!shader) return
        const gen = this.#deferredPipelineGen
        try {
            const [geo, shade, occ] = await Promise.all([
                this.#device.createRenderPipelineAsync({
                    label: "Deferred Geometry Pipeline",
                    layout: "auto",
                    vertex: { module: shader, entryPoint: "vertexMain" },
                    fragment: { module: shader, entryPoint: "geometryMain", targets: [{ format: this.#format }] },
                    primitive: { topology: "triangle-strip", stripIndexFormat: "uint32" },
                }),
                this.#device.createRenderPipelineAsync({
                    label: "Deferred Shade Pipeline",
                    layout: "auto",
                    vertex: { module: shader, entryPoint: "vertexMain" },
                    fragment: { module: shader, entryPoint: "shadeMain", targets: [{ format: this.#format }] },
                    primitive: { topology: "triangle-strip", stripIndexFormat: "uint32" },
                }),
                this.#device.createRenderPipelineAsync({
                    label: "Deferred Occlusion-from-GBuffer Pipeline",
                    layout: "auto",
                    vertex: { module: shader, entryPoint: "vertexMain" },
                    fragment: { module: shader, entryPoint: "occlusionFromGBufferMain", targets: [{ format: "rgba32float" }] },
                    primitive: { topology: "triangle-strip", stripIndexFormat: "uint32" },
                }),
            ])
            if (gen !== this.#deferredPipelineGen) return // stale: scene rebuilt mid-compile
            this.#geometryPipeline = geo
            this.#shadePipeline = shade
            this.#occlusionGbufferPipeline = occ
            this.#geometryBindGroup = null
            this.#shadeBindGroup = null
            this.#occlusionGbufferBindGroup = null
            this.#forceNextRender = true
        } catch (err) {
            const text = err instanceof Error ? (err.stack ?? err.message) : String(err)
            logWgsl("warn", `Deferred shading pipelines failed (deferred disabled, single-pass unaffected): ${text}`)
        }
    }

    /**
     * Prepare the deferred-shading resources for a w×h scene render and report
     * whether the deferred two-pass path can run this frame. Returns false (→
     * single-pass fallback) when deferred is off, in x-ray mode, the pipelines
     * didn't build, or the G-buffer would exceed the storage-buffer limit.
     * Allocates/resizes the G-buffer and (re)builds the geometry+shade bind
     * groups as needed. `geometryMain`/`shadeMain` force-reference the full
     * scene binding set (+ binding 26), so both reuse `#sceneBindGroupEntries`.
     */
    #prepareDeferred(xray: boolean, w: number, h: number): boolean {
        if (!this.#deferredShading || xray) return false
        if (!this.#geometryPipeline || !this.#shadePipeline) return false

        const px = w * h
        const needed = px * GBUFFER_STRIDE_BYTES
        if (needed > this.#device.limits.maxStorageBufferBindingSize) {
            // Too big for one binding — silently fall back so huge viewports
            // still render (just without the fast selection path).
            return false
        }
        if (!this.#gbuffer || px > this.#gbufferCapacityPx) {
            this.#gbuffer?.destroy()
            this.#gbuffer = this.#device.createBuffer({
                label: "deferred-gbuffer",
                size: needed,
                usage: GPUBufferUsage.STORAGE,
            })
            this.#gbufferCapacityPx = px
            this.#geometryBindGroup = null
            this.#shadeBindGroup = null
            this.#occlusionGbufferBindGroup = null
            // Fresh (zeroed) buffer — the retained geometry is gone, so force the
            // next frame to run a full geometry pass before any shade-only reuse.
            this.#lastGeometryHash = -1
        }

        if (!this.#geometryBindGroup || !this.#shadeBindGroup) {
            const entries: GPUBindGroupEntry[] = [
                ...this.#sceneBindGroupEntries(),
                { binding: 26, resource: { buffer: this.#gbuffer } },
            ]
            this.#geometryBindGroup = this.#device.createBindGroup({
                label: "deferred-geometry",
                layout: this.#geometryPipeline.getBindGroupLayout(0),
                entries,
            })
            this.#shadeBindGroup = this.#device.createBindGroup({
                label: "deferred-shade",
                layout: this.#shadePipeline.getBindGroupLayout(0),
                entries,
            })
            this.#occlusionGbufferBindGroup = null
        }
        // Occlusion-from-G-buffer bind group: built on demand (occlusion is
        // usually off). `occlusionFromGBufferMain` force-references the same
        // binding set, so it reuses the scene entries + gbuffer.
        if (this.#occlusionGbufferPipeline && !this.#occlusionGbufferBindGroup) {
            this.#occlusionGbufferBindGroup = this.#device.createBindGroup({
                label: "deferred-occlusion-gbuffer",
                layout: this.#occlusionGbufferPipeline.getBindGroupLayout(0),
                entries: [...this.#sceneBindGroupEntries(), { binding: 26, resource: { buffer: this.#gbuffer } }],
            })
        }
        return true
    }

    /** FNV-1a over the geometry-relevant SAB slot fields — everything the
     * G-buffer depends on (camera, resolution, view settings, preview shading,
     * ray-march params), EXCLUDING the selection regions (styles [172,200),
     * selected ids / edges [256,6948)). Two frames with the same hash differ
     * only in selection state, so the retained G-buffer is still valid. */
    #geometryHashFromSAB(buffer: SharedArrayBuffer, slotBase: number): number {
        const u32 = new Uint32Array(buffer)
        const b4 = slotBase / 4
        let h = 2166136261
        // [0,172): version/flags, resolution scale, view transform, camera pos,
        // camera res, zoom, view center, view settings.
        for (let i = 0; i < 43; i++) h = Math.imul(h ^ u32[b4 + i]!, 16777619)
        // [200,256): preview shading params (skips selection styles at [172,200)).
        for (let i = 50; i < 64; i++) h = Math.imul(h ^ u32[b4 + i]!, 16777619)
        // Ray-march params [6948,6980): 8 words.
        for (let i = 1737; i < 1745; i++) h = Math.imul(h ^ u32[b4 + i]!, 16777619)
        return h >>> 0
    }

    /**
     * Encode the scene-color pass into `sceneColorView`. When `deferred` is
     * true, runs geometryMain (SDF march → G-buffer, throwaway colour into
     * `#colorTexture`) then shadeMain (G-buffer → selection-tinted frame);
     * otherwise the single fragmentMain pass. When `skipGeometry` is also true
     * (selection-only repaint — Phase 2), the geometry pass is omitted and the
     * retained G-buffer drives shadeMain directly. Shared by `render()` and
     * `#renderFromSAB` so the two paths can't drift.
     */
    #encodeScenePass(enc: GPUCommandEncoder, sceneColorView: GPUTextureView, deferred: boolean, skipGeometry = false): void {
        if (deferred) {
            if (!skipGeometry) {
                // Geometry: marches the SDF and writes the G-buffer. Its colour
                // attachment is a throwaway (#colorTexture is scene-sized and always
                // allocated); the visible frame is produced by the shade pass. When
                // sceneColorView IS #colorTextureView (FSR/offscreen), the shade pass
                // below overwrites it — geometry's colour is simply discarded.
                const geoPass = enc.beginRenderPass({
                    label: "deferred-geometry",
                    colorAttachments: [{ view: this.#colorTextureView, loadOp: "clear", storeOp: "store" }],
                    timestampWrites: this.#timestampWritesFor("scene"),
                })
                geoPass.setPipeline(this.#geometryPipeline!)
                geoPass.setBindGroup(0, this.#geometryBindGroup!)
                geoPass.draw(4)
                geoPass.end()
            }

            const shadePass = enc.beginRenderPass({
                label: "deferred-shade",
                colorAttachments: [{ view: sceneColorView, loadOp: "clear", storeOp: "store" }],
                timestampWrites: this.#timestampWritesFor("shade"),
            })
            shadePass.setPipeline(this.#shadePipeline!)
            shadePass.setBindGroup(0, this.#shadeBindGroup!)
            shadePass.draw(4)
            shadePass.end()
            return
        }

        const scenePass = enc.beginRenderPass({
            colorAttachments: [{ view: sceneColorView, loadOp: "clear", storeOp: "store" }],
            timestampWrites: this.#timestampWritesFor("scene"),
        })
        scenePass.setPipeline(this.#pipeline!)
        scenePass.setBindGroup(0, this.#bindGroup!)
        scenePass.draw(4)
        scenePass.end()
    }

    /**
     * Ensure the FSR1 upscale resources exist for the current sizes:
     *  - the full-res intermediate texture (when FXAA follows EASU; without it,
     *    EASU writes straight to the final target),
     *  - the EASU bind group (source = the reduced-res `#colorTextureView`),
     *  - the FXAA bind group (source = the full-res EASU output).
     * The EASU bind group is nulled by `#ensureRenderTextures` when the scene
     * texture is recreated; the FXAA bind group is nulled here when the full-res
     * intermediate is reallocated.
     */
    #ensureUpscaleTextures(fullW: number, fullH: number, needFxaa: boolean): void {
        if (needFxaa && (!this.#easuOutTexture || fullW !== this.#easuOutWidth || fullH !== this.#easuOutHeight)) {
            this.#easuOutTexture?.destroy()
            this.#easuOutTexture = this.#device.createTexture({
                label: "EASU Output (full-res)",
                size: [Math.max(1, fullW), Math.max(1, fullH)],
                format: this.#format,
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            })
            this.#easuOutView = this.#easuOutTexture.createView()
            this.#easuOutWidth = fullW
            this.#easuOutHeight = fullH
            this.#fxaaBindGroup = undefined
        }

        if (!this.#easuBindGroup) {
            this.#easuBindGroup = this.#device.createBindGroup({
                label: "easuUpscale",
                layout: this.#easuPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: this.#colorTextureView },
                    { binding: 1, resource: this.#colorSampler },
                    { binding: 2, resource: { buffer: this.#uniformBuffers.easuConst } },
                ],
            })
        }

        if (needFxaa && !this.#fxaaBindGroup) {
            this.#fxaaBindGroup = this.#device.createBindGroup({
                label: "fxaa",
                layout: this.#fxaaPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: this.#easuOutView! },
                    { binding: 1, resource: this.#colorSampler },
                ],
            })
        }
    }

    /**
     * Compute the EASU con0..con3 constants (port of `ffxFsrPopulateEasuConstants`)
     * for the given reduced-res input and full-res output, and upload them. The
     * shader reads each vec4 as `bitcast<vec4f>(vec4<u32>)`, so writing the raw
     * f32 bit patterns here is exactly equivalent to the reference's
     * `ffxAsUInt32(float)`. Skips the upload when sizes are unchanged.
     */
    #updateEasuConstants(inW: number, inH: number, outW: number, outH: number): void {
        const key = `${inW},${inH},${outW},${outH}`
        if (key === this.#lastEasuKey) return
        this.#lastEasuKey = key
        const f = this.#easuConstF32
        const rOutX = 1 / outW
        const rOutY = 1 / outH
        const rInX = 1 / inW
        const rInY = 1 / inH
        // con0: output integer position -> input pixel position.
        f[0] = inW * rOutX
        f[1] = inH * rOutY
        f[2] = 0.5 * inW * rOutX - 0.5
        f[3] = 0.5 * inH * rOutY - 0.5
        // con1: viewport pixel -> normalized, plus first gather offset.
        f[4] = rInX
        f[5] = rInY
        f[6] = rInX
        f[7] = -rInY
        // con2 / con3: remaining gather-center offsets.
        f[8] = -rInX
        f[9] = 2 * rInY
        f[10] = rInX
        f[11] = 2 * rInY
        f[12] = 0
        f[13] = 4 * rInY
        f[14] = 0
        f[15] = 0
        this.#device.queue.writeBuffer(this.#uniformBuffers.easuConst, 0, this.#easuConstBuf)
    }

    /**
     * Encode the FSR1 upscale chain. The scene must already be rendered into the
     * reduced-res `#colorTextureView`. EASU resolves it to full resolution; when
     * `needFxaa`, EASU writes the full-res intermediate that FXAA then smooths
     * into `finalTarget`, otherwise EASU writes `finalTarget` directly.
     */
    #encodeUpscale(
        encoder: GPUCommandEncoder,
        finalTarget: GPUTextureView,
        sceneW: number,
        sceneH: number,
        fullW: number,
        fullH: number,
        needFxaa: boolean,
    ): void {
        this.#ensureUpscaleTextures(fullW, fullH, needFxaa)
        this.#updateEasuConstants(sceneW, sceneH, fullW, fullH)

        const easuTarget = needFxaa ? this.#easuOutView! : finalTarget
        const easuPass = encoder.beginRenderPass({
            label: "EASU Upscale",
            colorAttachments: [{ view: easuTarget, loadOp: "clear", storeOp: "store" }],
            timestampWrites: this.#timestampWritesFor("easu"),
        })
        easuPass.setPipeline(this.#easuPipeline)
        easuPass.setBindGroup(0, this.#easuBindGroup!)
        easuPass.draw(4)
        easuPass.end()

        if (needFxaa) {
            this.#encodeFxaaPass(encoder, finalTarget)
        }
    }

    /**
     * FXAA post-process pass: reads `#easuOutView` (the full-res color written by
     * EASU during motion, or by the scene directly for a full-res frame) and
     * writes `dst`. Callers must have ensured the FXAA resources via
     * `#ensureUpscaleTextures(..., needFxaa = true)` and rendered into
     * `#easuOutView` first.
     */
    #encodeFxaaPass(encoder: GPUCommandEncoder, dst: GPUTextureView): void {
        const pass = encoder.beginRenderPass({
            label: "FXAA",
            colorAttachments: [{ view: dst, loadOp: "clear", storeOp: "store" }],
            timestampWrites: this.#timestampWritesFor("fxaa"),
        })
        pass.setPipeline(this.#fxaaPipeline)
        pass.setBindGroup(0, this.#fxaaBindGroup!)
        pass.draw(4)
        pass.end()
    }

    #createBuffers(): void {
        const ub = this.#uniformBuffers
        ub.scene = this.#device.createBuffer({
            size: 16384,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
            label: "scene",
        })

        this.#exportBuffers.scene = this.#device.createBuffer({
            size: 16384,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "scene",
        })

        ub.camera = this.#device.createBuffer({
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "camera",
        })

        ub.clickState = this.#device.createBuffer({
            size: 32,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "clickState",
        })

        ub.clickedObjectId = this.#device.createBuffer({
            size: 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            label: "clickedObjectId",
        })

        ub.selectedObjectIds = this.#device.createBuffer({
            size: 4096,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: "selectedObjectIds",
        })

        ub.colorPalette = this.#device.createBuffer({
            size: PALETTE_SIZE * 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "colorPalette",
        })

        const paletteData = paletteToFloat32Array(DEFAULT_PALETTE)
        const alignedData = new Float32Array(PALETTE_SIZE * 4)
        for (let i = 0; i < PALETTE_SIZE; i++) {
            alignedData[i * 4] = paletteData[i * 3]
            alignedData[i * 4 + 1] = paletteData[i * 3 + 1]
            alignedData[i * 4 + 2] = paletteData[i * 3 + 2]
            alignedData[i * 4 + 3] = 0.0
        }
        this.#device.queue.writeBuffer(ub.colorPalette, 0, alignedData)

        ub.viewSettings = this.#device.createBuffer({
            size: 32, // 7 u32 (xray, heatmap, beam, selMode, ghost, flatShading, debugTessEdges) + pad to 16-byte align
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "viewSettings",
        })

        ub.easuConst = this.#device.createBuffer({
            size: 64,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "easuConst",
        })

        // OutlineSettings GPU buffer dropped — no shader binding reads it.

        ub.selectionStyles = this.#device.createBuffer({
            size: 80,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "selectionStyles",
        })

        ub.polygonVertices = this.#device.createBuffer({
            size: POLYGON_VERTEX_BUFFER_SIZE,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: "polygonVertices",
        })

        ub.clickedHitPos = this.#device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            label: "clickedHitPos",
        })

        ub.clickedNormal = this.#device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            label: "clickedNormal",
        })

        ub.faceSelection = this.#device.createBuffer({
            // 7 scalars (nodeId, faceIndex, mode, extrudeOffset, pushPullActive,
            // segStart, segEnd) = 28 bytes; rounded to 32. Shaders that read only
            // the first 5 fields bind the same buffer with a smaller struct view.
            size: 32,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "faceSelection",
        })

        // One buffer, two field aliases — bound at @binding(6) by bounds.wgsl
        // and @binding(30) by mdc.wgsl / sample_grid.wgsl / iso_sample_batch.wgsl
        // through their own bind groups, but the underlying GPU resource and
        // its contents are identical.
        const sceneParamsBuffer = this.#device.createBuffer({
            size: SCENE_PARAMS_BYTE_SIZE,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: "sceneParams",
        })
        ub.boundsSceneParams = sceneParamsBuffer
        ub.mdcSceneParams = sceneParamsBuffer
        ub.previewParamsF32 = this.#device.createBuffer({
            size: PREVIEW_PARAMS_F32_BYTE_SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "previewParamsF32",
        })
        ub.previewParamsVec2 = this.#device.createBuffer({
            size: PREVIEW_PARAMS_VEC2_BYTE_SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "previewParamsVec2",
        })
        ub.previewParamsVec3 = this.#device.createBuffer({
            size: PREVIEW_PARAMS_VEC3_BYTE_SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "previewParamsVec3",
        })
        ub.previewParamsMat3 = this.#device.createBuffer({
            size: PREVIEW_PARAMS_MAT3_BYTE_SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "previewParamsMat3",
        })
        ub.previewCapParamDrag = this.#device.createBuffer({
            size: PREVIEW_PARAMS_F32_BYTE_SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "previewCapParamDrag",
        })
        ub.rayMarchParams = this.#device.createBuffer({
            size: 32,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "rayMarchParams",
        })
        this.#uploadRayMarchParams(DEFAULT_RAY_MARCH_PARAMS)

        this.#previewF32Shadow = new Float32Array(PREVIEW_UNIFORM_F32_COUNT)
        this.#previewVec2Shadow = new Float32Array(PREVIEW_UNIFORM_VEC2_COUNT * 2)
        this.#previewVec3Shadow = new Float32Array(PREVIEW_UNIFORM_VEC3_COUNT * 4)
        this.#previewMat3Shadow = new Float32Array(PREVIEW_UNIFORM_MAT3_COUNT * PREVIEW_MAT3_PACK_FLOATS)
        this.#previewPackTarget = {
            f32: this.#previewF32Shadow,
            vec2: this.#previewVec2Shadow,
            vec3: this.#previewVec3Shadow,
            mat3: this.#previewMat3Shadow,
        }

        ub.edgeHit = this.#device.createBuffer({
            size: EDGE_HITS_SIZE,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            label: "edgeHit",
        })
        ub.selectedEdges = this.#device.createBuffer({
            size: SELECTED_EDGES_TOTAL,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: "selectedEdges",
        })
        ub.hoverEdgeHit = this.#device.createBuffer({
            size: EDGE_HITS_SIZE,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            label: "hoverEdgeHit",
        })
        ub.hoveredEdge = this.#device.createBuffer({
            size: SELECTED_EDGES_TOTAL,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: "hoveredEdge",
        })

        this.#clickIdReadback = this.#device.createBuffer({
            size: 4,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            label: "clickIdReadback",
        })
        this.#edgeHitReadback = this.#device.createBuffer({
            size: EDGE_HITS_SIZE,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            label: "edgeHitReadback",
        })
        this.#hitPosReadback = this.#device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            label: "hitPosReadback",
        })
        this.#clickNormalReadback = this.#device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            label: "clickNormalReadback",
        })
        this.#hoverEdgeHitReadback = this.#device.createBuffer({
            size: EDGE_HITS_SIZE,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            label: "hoverEdgeHitReadback",
        })
    }

    #writeClickState(clickUV: [number, number], enableClick: boolean, enableHover: boolean, hoverUV?: [number, number]): void {
        const clickData = new ArrayBuffer(32)
        const clickF32 = new Float32Array(clickData)
        const clickU32 = new Uint32Array(clickData)
        clickF32[0] = clickUV[0]
        clickF32[1] = clickUV[1]
        clickU32[2] = enableClick ? 1 : 0
        clickU32[3] = enableHover ? 1 : 0
        clickF32[4] = hoverUV?.[0] ?? 0
        clickF32[5] = hoverUV?.[1] ?? 0
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickState, 0, clickData)
        // clickState lives in a uniform buffer the shader reads every
        // frame; without forcing here, the SAB-hash idle skip would
        // silently drop the pick/hover render that the caller is about
        // to issue, breaking click detection.
        this.#forceNextRender = true
    }

    /** Read from a GPU buffer using the persistent readback buffer when available, else fresh allocation. */
    #readGPU(source: GPUBuffer, readback: GPUBuffer, size: number, reuse: boolean): Promise<ArrayBuffer> {
        return reuse ? this.#helper.readBufferDataReuse(source, readback, size) : this.#helper.readBufferData(source, size)
    }

    async #readClickResult(): Promise<{
        clickedId: number
        edgeHits: import("./render-worker-protocol.mjs").EdgeHitData[]
        hitPos: [number, number, number, number]
        clickedNormal: [number, number, number]
    }> {
        const reuse = !this.#clickReadbackBusy
        if (reuse) this.#clickReadbackBusy = true
        const [idBuf, edgeBuf, hitBuf, normalBuf] = await Promise.all([
            this.#readGPU(this.#uniformBuffers.clickedObjectId, this.#clickIdReadback, 4, reuse),
            this.#readGPU(this.#uniformBuffers.edgeHit, this.#edgeHitReadback, EDGE_HITS_SIZE, reuse),
            this.#readGPU(this.#uniformBuffers.clickedHitPos, this.#hitPosReadback, 16, reuse),
            this.#readGPU(this.#uniformBuffers.clickedNormal, this.#clickNormalReadback, 16, reuse),
        ])
        if (reuse) this.#clickReadbackBusy = false
        const clickedId = new Uint32Array(idBuf)[0] ?? 0
        const u32 = new Uint32Array(edgeBuf)
        const f32 = new Float32Array(edgeBuf)
        const edgeHits: import("./render-worker-protocol.mjs").EdgeHitData[] = []
        const STRIDE = 20
        for (let slot = 0; slot < 4; slot++) {
            const o = slot * STRIDE
            const kind = u32[o]
            if (kind === EdgeKind.None) continue
            edgeHits.push({
                kind,
                primaryId: u32[o + 1],
                secondaryId: u32[o + 2],
                featureA: u32[o + 3],
                opType: u32[o + 4],
                objectId: u32[o + 5],
                seedPoint: [f32[o + 8], f32[o + 9], f32[o + 10]],
                seedTangent: [f32[o + 12], f32[o + 13], f32[o + 14]],
                seedNormal: [f32[o + 16], f32[o + 17], f32[o + 18]],
            })
        }
        const hitF32 = new Float32Array(hitBuf)
        const hitPos: [number, number, number, number] = [hitF32[0], hitF32[1], hitF32[2], hitF32[3]]
        const normF32 = new Float32Array(normalBuf)
        const clickedNormal: [number, number, number] = [normF32[0], normF32[1], normF32[2]]
        return { clickedId, edgeHits, hitPos, clickedNormal }
    }

    async #readHoverResult(): Promise<{
        hoveredObjectId: number
        hoveredEdges: SelectedEdgePayload[]
        hoverHitPos: [number, number, number] | null
    }> {
        const reuse = !this.#hoverReadbackBusy
        if (reuse) this.#hoverReadbackBusy = true
        const readback = await this.#readGPU(this.#uniformBuffers.hoverEdgeHit, this.#hoverEdgeHitReadback, EDGE_HITS_SIZE, reuse)
        if (reuse) this.#hoverReadbackBusy = false
        const u32 = new Uint32Array(readback)
        const f32 = new Float32Array(readback)
        const edges: SelectedEdgePayload[] = []
        let hoveredObjectId = 0
        const STRIDE = 20
        // Front slot (0) carries the hover hit's world position in `seedPoint`,
        // set unconditionally by `classifyEdgeAtHit` even on a flat (edge-less)
        // face — so face-hover preview can resolve the side/cap without a
        // separate pick readback.
        const hoverHitPos: [number, number, number] | null =
            u32[5] !== 0 ? [f32[8], f32[9], f32[10]] : null
        for (let slot = 0; slot < 4; slot++) {
            const o = slot * STRIDE
            const kind = u32[o]
            const objectId = u32[o + 5]
            if (kind === EdgeKind.None && objectId === 0) continue
            hoveredObjectId = objectId
            if (kind !== EdgeKind.None) {
                edges.push({
                    kind,
                    primaryId: u32[o + 1],
                    secondaryId: u32[o + 2],
                    featureA: u32[o + 3],
                    opType: u32[o + 4],
                    lineWidthPx: 6.0,
                    epsilon: 0.02,
                    seedPoint: [f32[o + 8], f32[o + 9], f32[o + 10]],
                    seedTangent: [f32[o + 12], f32[o + 13], f32[o + 14]],
                    seedNormal: [f32[o + 16], f32[o + 17], f32[o + 18]],
                })
            }
        }
        return { hoveredObjectId, hoveredEdges: edges, hoverHitPos }
    }

    /** Read the published selection mode (SAB if present, else the cached value). */
    #readSelectionMode(sab?: SharedArrayBuffer): number {
        if (!sab) return this.#lastSelectionMode
        const off = (getSlotByteOffset(getPublishedRenderSlot(sab)) + SAB_LAYOUT.O_VIEW_SETTINGS) / 4
        return (new Uint32Array(sab)[off]! >> 2) & 7
    }

    /** Pixel slop for FG CORNER picking — generous, since points are small targets. */
    #fgPickThresholdPx(): number {
        return this.#featureGraphLineWidth + 10
    }

    /** Pixel slop for FG EDGE-CHAIN (polyline) picking — tighter than corners so
     *  hover/select tracks the visible line (~3px beyond its edge) instead of
     *  triggering far from it. Scales with the line-width dev-tools knob. */
    #fgEdgePickThresholdPx(): number {
        return this.#featureGraphLineWidth / 2 + 3
    }

    /** Whether FG picking should depth-occlude features — true only in the
     *  "hide behind" (hard) occlusion mode, matching what the overlay hides, so
     *  you can't hover/select a feature the surface is drawn over. */
    #fgDepthOcclusionActive(): boolean {
        return this.#featureGraphOcclusionMode === occlusionModeToInt("hard")
    }

    /**
     * Surface view-space depth (`viewZ`) at the cursor, read from the overlay's
     * scene-depth texture (world-position rgba32float). Used to depth-occlude FG
     * features in hide-behind mode. Returns undefined when occlusion is off, the
     * depth texture isn't ready yet, or the cursor is over empty space (nothing
     * to occlude behind). The texture is from the last overlay render — fine
     * since the camera is static while hovering. Matches viewZ in
     * feature_graph_overlay.wgsl (and feature-graph-hit-test's viewZOf).
     */
    async #cursorSurfaceViewZ(clickUV: [number, number], sab?: SharedArrayBuffer): Promise<number | undefined> {
        if (!this.#fgDepthOcclusionActive()) return undefined
        const tex = this.#sceneDepthTexture
        if (!tex) return undefined
        const w = this.#sceneDepthW
        const h = this.#sceneDepthH
        const px = Math.max(0, Math.min(w - 1, Math.round(clickUV[0] * w)))
        const py = Math.max(0, Math.min(h - 1, Math.round((1 - clickUV[1]) * h)))
        if (this.#occlusionReadbackBusy) return undefined // a prior hover's readback is still mapping
        if (!this.#occlusionReadback) {
            this.#occlusionReadback = this.#device.createBuffer({
                label: "fgOcclusionReadback",
                size: 256,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            })
        }
        this.#occlusionReadbackBusy = true
        const enc = this.#device.createCommandEncoder({ label: "fgOcclusionDepth" })
        enc.copyTextureToBuffer({ texture: tex, origin: { x: px, y: py } }, { buffer: this.#occlusionReadback, bytesPerRow: 256 }, { width: 1, height: 1 })
        this.#device.queue.submit([enc.finish()])
        try {
            await this.#occlusionReadback.mapAsync(GPUMapMode.READ, 0, 16)
        } catch {
            this.#occlusionReadbackBusy = false
            return undefined
        }
        const f = new Float32Array(this.#occlusionReadback.getMappedRange(0, 16).slice(0))
        this.#occlusionReadback.unmap()
        this.#occlusionReadbackBusy = false
        if ((f[3] ?? 0) <= 0.5) return undefined // miss: no surface at the cursor
        const cam = this.#buildFgCameraParams(sab)
        if (!cam) return undefined
        const m = cam.viewTransformInv
        return m[2]! * f[0]! + m[6]! * f[1]! + m[10]! * f[2]! + m[14]! - cam.origin[2]
    }

    /**
     * Build the projection parameters the CPU hit-tester needs, mirroring the
     * overlay's `uploadCamera`: inverse view transform + ray-origin-pushed
     * camera origin, at full display resolution (so thresholds are display px).
     */
    #buildFgCameraParams(sab?: SharedArrayBuffer): FgCameraParams | null {
        if (this.#fullWidth <= 0 || this.#fullHeight <= 0) return null
        let viewTransform: Float32Array
        let cameraPosition: [number, number, number]
        let viewCenter: [number, number]
        let zoom: number
        if (sab) {
            const L = SAB_LAYOUT
            const slotBase = getSlotByteOffset(getPublishedRenderSlot(sab))
            const b4 = slotBase / 4
            const f32 = new Float32Array(sab)
            viewTransform = new Float32Array(sab, slotBase + L.O_VIEW_TRANSFORM, 16)
            cameraPosition = [
                f32[b4 + L.O_CAMERA_POSITION / 4]!,
                f32[b4 + L.O_CAMERA_POSITION / 4 + 1]!,
                f32[b4 + L.O_CAMERA_POSITION / 4 + 2]!,
            ]
            viewCenter = [f32[b4 + L.O_VIEW_CENTER / 4]!, f32[b4 + L.O_VIEW_CENTER / 4 + 1]!]
            zoom = f32[b4 + L.O_ZOOM / 4]!
        } else if (this.#lastRenderMsg) {
            const msg = this.#lastRenderMsg
            viewTransform =
                msg.viewTransform instanceof Float32Array ? msg.viewTransform : new Float32Array(msg.viewTransform)
            cameraPosition = [msg.cameraPosition[0], msg.cameraPosition[1], msg.cameraPosition[2]]
            viewCenter = [msg.viewCenter[0], msg.viewCenter[1]]
            zoom = orthoHalfFromDolly(msg.cameraState.dollyDistance)
        } else {
            return null
        }
        const inv = new Mat4x4f(new Float32Array(viewTransform)).inverse()
        return {
            viewTransformInv: inv.data,
            origin: [cameraPosition[0], cameraPosition[1], cameraPosition[2] + FG_PICK_RAY_ORIGIN_DEPTH],
            resX: this.#fullWidth,
            resY: this.#fullHeight,
            zoom,
            viewCenter,
        }
    }

    /** Recompute per-instance overlay highlight state from the FG selection + hover. */
    #applyFgHighlights(): void {
        const ht = this.#fgHitTester
        const chains = this.#fgChains
        const overlay = this.#featureGraphOverlay
        if (!ht || !chains || !overlay) return
        const edgeStates = new Uint32Array(ht.edgeInstanceCount)
        for (const chainId of this.#fgSelectedChains) {
            const c = chains.chains[chainId]
            if (c) for (const s of c.edgeInstanceIndices) edgeStates[s] = 2
        }
        if (this.#fgHoverChain >= 0) {
            const c = chains.chains[this.#fgHoverChain]
            if (c) for (const s of c.edgeInstanceIndices) if (edgeStates[s] !== 2) edgeStates[s] = 1
        }
        const cornerStates = new Uint32Array(ht.cornerInstanceCount)
        for (const v of this.#fgSelectedCorners) {
            const ci = ht.cornerInstanceIndex(v)
            if (ci >= 0) cornerStates[ci] = 2
        }
        if (this.#fgHoverCorner >= 0) {
            const ci = ht.cornerInstanceIndex(this.#fgHoverCorner)
            if (ci >= 0 && cornerStates[ci] !== 2) cornerStates[ci] = 1
        }
        overlay.setHighlights(edgeStates, cornerStates)
    }

    /** Build the `.sel-info` payload describing the current FG hover + selection. */
    #fgBuildSelectionInfo(): SelectionInfo {
        let polylines = 0
        let rings = 0
        if (this.#fgChains) {
            for (const id of this.#fgSelectedChains) {
                const c = this.#fgChains.chains[id]
                if (!c) continue
                if (c.kind === FgChainKind.Ring) rings++
                else polylines++
            }
        }
        let hoverKind: "polyline" | "ring" | "corner" | null = null
        let hoverId: number | undefined
        if (this.#fgHoverCorner >= 0) {
            hoverKind = "corner"
            hoverId = this.#fgHoverCorner
        } else if (this.#fgHoverChain >= 0 && this.#fgChains) {
            const c = this.#fgChains.chains[this.#fgHoverChain]
            if (c) {
                hoverKind = c.kind === FgChainKind.Ring ? "ring" : "polyline"
                hoverId = this.#fgHoverChain
            }
        }
        return {
            objects: [],
            objectNames: {},
            edges: [],
            face: null,
            hover: null,
            fgFeatures: { polylines, rings, corners: this.#fgSelectedCorners.size, hoverKind, hoverId },
        }
    }

    /** Re-render so highlight/hover recolors show, then publish the FG selection info. */
    #fgRenderAndReport(sab: SharedArrayBuffer | undefined, clickUV: [number, number], documentName?: string, hoverRequestId?: number): void {
        this.#forceNextRender = true
        if (sab) this.#renderFromSAB(sab, clickUV)
        else if (this.#lastRenderMsg) this.render(this.#lastRenderMsg)
        self.postMessage({ type: "selectionInfo", info: this.#fgBuildSelectionInfo(), documentName, hoverRequestId })
    }

    /** Clear all interactive FeatureGraph selection + hover and drop the overlay highlights. */
    clearFgSelection(): void {
        this.#fgSelectedChains.clear()
        this.#fgSelectedCorners.clear()
        this.#fgAutoLockedType = null
        this.#fgHoverChain = -1
        this.#fgHoverCorner = -1
        this.#fgLastHoverKey = ""
        this.#fgHoverFadeStartMs = -1
        if (this.#fgFadeTimer !== null) {
            clearTimeout(this.#fgFadeTimer)
            this.#fgFadeTimer = null
        }
        this.#applyFgHighlights()
        this.#forceNextRender = true
    }

    /** CPU feature pick for a click in edge/corner/auto mode. */
    // NOTE(deferred-shading work): added to unblock a pre-existing build break —
    // `#fgClickHasFeature` was referenced by the AUTO-mode arbitration below but
    // never defined. Minimal faithful impl (mirrors the pickAny path in
    // #handleFgClick): is any FeatureGraph feature under the cursor? Confirm or
    // replace with your intended version.
    #fgClickHasFeature(clickUV: [number, number], sab?: SharedArrayBuffer, occluderViewZ?: number): boolean {
        const cam = this.#buildFgCameraParams(sab)
        const ht = this.#fgHitTester
        if (!cam || !ht) return false
        return ht.pickAny(clickUV, cam, this.#fgPickThresholdPx(), this.#fgEdgePickThresholdPx(), occluderViewZ) !== null
    }

    #handleFgClick(clickUV: [number, number], mode: number, shiftKey: boolean, sab?: SharedArrayBuffer, documentName?: string, occluderViewZ?: number): void {
        const cam = this.#buildFgCameraParams(sab)
        const ht = this.#fgHitTester
        if (cam && ht) {
            const thr = this.#fgPickThresholdPx()
            const edgeThr = this.#fgEdgePickThresholdPx()
            let kind: "edge" | "corner" | null = null
            let id = -1
            if (mode === SEL_MODE_CORNER || (mode === SEL_MODE_AUTO && this.#fgAutoLockedType === "corner")) {
                const h = ht.pickCorner(clickUV, cam, thr, occluderViewZ)
                if (h) {
                    kind = "corner"
                    id = h.cornerVertexIndex
                }
            } else if (mode === SEL_MODE_EDGE || (mode === SEL_MODE_AUTO && this.#fgAutoLockedType === "edge")) {
                const h = ht.pickEdgeChain(clickUV, cam, edgeThr, occluderViewZ)
                if (h) {
                    kind = "edge"
                    id = h.chainId
                }
            } else {
                // Auto, no lock yet — nearest feature of any type.
                const h = ht.pickAny(clickUV, cam, thr, edgeThr, occluderViewZ)
                if (h) {
                    kind = h.kind
                    id = h.id
                }
            }

            if (kind === null) {
                // Click on empty space clears (non-shift); shift keeps the set.
                if (!shiftKey) {
                    this.#fgSelectedChains.clear()
                    this.#fgSelectedCorners.clear()
                    this.#fgAutoLockedType = null
                }
            } else if (!shiftKey) {
                this.#fgSelectedChains.clear()
                this.#fgSelectedCorners.clear()
                if (kind === "edge") this.#fgSelectedChains.add(id)
                else this.#fgSelectedCorners.add(id)
                if (mode === SEL_MODE_AUTO) this.#fgAutoLockedType = kind
            } else {
                const set = kind === "edge" ? this.#fgSelectedChains : this.#fgSelectedCorners
                if (set.has(id)) set.delete(id)
                else set.add(id)
                if (mode === SEL_MODE_AUTO) {
                    // First shift-pick after a clear locks the type; an emptied
                    // selection re-arms auto-detection.
                    this.#fgAutoLockedType =
                        this.#fgSelectedChains.size === 0 && this.#fgSelectedCorners.size === 0 ? null : kind
                }
            }
            this.#applyFgHighlights()
        }
        this.#fgRenderAndReport(sab, clickUV, documentName)
    }

    /** CPU feature pick for a hover in edge/corner/auto mode. */
    #handleFgHover(clickUV: [number, number], mode: number, sab?: SharedArrayBuffer, documentName?: string, hoverRequestId?: number, occluderViewZ?: number): void {
        this.#fgHoverChain = -1
        this.#fgHoverCorner = -1
        const cam = this.#buildFgCameraParams(sab)
        const ht = this.#fgHitTester
        if (cam && ht) {
            const thr = this.#fgPickThresholdPx()
            const edgeThr = this.#fgEdgePickThresholdPx()
            if (mode === SEL_MODE_CORNER || (mode === SEL_MODE_AUTO && this.#fgAutoLockedType === "corner")) {
                const h = ht.pickCorner(clickUV, cam, thr, occluderViewZ)
                if (h) this.#fgHoverCorner = h.cornerVertexIndex
            } else if (mode === SEL_MODE_EDGE || (mode === SEL_MODE_AUTO && this.#fgAutoLockedType === "edge")) {
                const h = ht.pickEdgeChain(clickUV, cam, edgeThr, occluderViewZ)
                if (h) this.#fgHoverChain = h.chainId
            } else {
                const h = ht.pickAny(clickUV, cam, thr, edgeThr, occluderViewZ)
                if (h) {
                    if (h.kind === "corner") this.#fgHoverCorner = h.id
                    else this.#fgHoverChain = h.id
                }
            }
            this.#applyFgHighlights()
        }
        // Auto mode fades the hovered feature in. Restart the fade only when the
        // hovered feature actually CHANGES (not on every same-feature hover), and
        // drive the short animation with self-scheduled re-renders.
        if (mode === SEL_MODE_AUTO) {
            const hoverKey =
                this.#fgHoverChain >= 0 ? `e${this.#fgHoverChain}`
                : this.#fgHoverCorner >= 0 ? `c${this.#fgHoverCorner}`
                : ""
            if (hoverKey !== "" && hoverKey !== this.#fgLastHoverKey) {
                this.#fgHoverFadeStartMs = performance.now()
                this.#scheduleFgFade(sab)
            }
            this.#fgLastHoverKey = hoverKey
        }
        this.#fgRenderAndReport(sab, clickUV, documentName, hoverRequestId)
    }

    /**
     * Drive the auto-mode hover fade-in: re-render the last frame every ~16 ms
     * until {@link FG_HOVER_FADE_MS} elapses, so the hovered feature smoothly
     * appears even when the cursor is held still (no new hover events). Self-
     * contained in the worker; a single timer, restarted by the caller resetting
     * #fgHoverFadeStartMs.
     */
    #scheduleFgFade(sab?: SharedArrayBuffer): void {
        if (this.#fgFadeTimer !== null) return
        const buf = sab ?? this.#lastSharedBuffer
        if (!buf) return
        const step = () => {
            this.#fgFadeTimer = null
            this.#forceNextRender = true
            this.#renderFromSAB(buf)
            if (performance.now() - this.#fgHoverFadeStartMs < FG_HOVER_FADE_MS) {
                this.#fgFadeTimer = setTimeout(step, 16)
            }
        }
        this.#fgFadeTimer = setTimeout(step, 16)
    }

    async handleClick(
        clickUV: [number, number],
        shiftKey: boolean,
        altKey: boolean,
        documentName?: string,
        sab?: SharedArrayBuffer,
    ): Promise<void> {
        if (!this.#pipeline) return
        if (!sab && !this.#lastRenderMsg) return
        // Edge/corner modes pick FeatureGraph features on the CPU instead of the
        // GPU object/edge atomics — object selection never runs there.
        const mode = this.#readSelectionMode(sab)
        if (mode === SEL_MODE_EDGE || mode === SEL_MODE_CORNER || mode === SEL_MODE_AUTO) {
            // Hide-behind: occlude features behind the surface at the cursor.
            const occZ = await this.#cursorSurfaceViewZ(clickUV, sab)
            if (mode === SEL_MODE_EDGE || mode === SEL_MODE_CORNER) {
                this.#handleFgClick(clickUV, mode, shiftKey, sab, documentName, occZ)
                return
            }
            // Auto picks the nearest FeatureGraph feature when one is under the
            // cursor; otherwise it falls through to the GPU pick so the main thread
            // can select the face/surface (auto = "select any feature", incl. caps).
            if (this.#fgClickHasFeature(clickUV, sab, occZ)) {
                this.#handleFgClick(clickUV, mode, shiftKey, sab, documentName, occZ)
                return
            }
            if (!shiftKey) this.clearFgSelection()
        }
        this.#writeClickState(clickUV, true, false)
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickedObjectId, 0, ZERO_U32)
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickedHitPos, 0, ZERO_VEC4)
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickedNormal, 0, ZERO_VEC4)
        this.#device.queue.writeBuffer(this.#uniformBuffers.edgeHit, 0, ZERO_EDGE_HITS)

        if (sab) this.#renderFromSAB(sab, clickUV)
        else this.render(this.#lastRenderMsg!)
        const result = await this.#readClickResult()
        self.postMessage({
            type: "clickResult",
            clickedId: result.clickedId,
            edgeHits: result.edgeHits,
            hitPos: result.hitPos,
            clickedNormal: result.clickedNormal,
            shiftKey,
            altKey,
            documentName,
        })
    }

    async handleHover(
        clickUV: [number, number],
        altKey: boolean,
        documentName?: string,
        hoverRequestId?: number,
        sab?: SharedArrayBuffer,
    ): Promise<void> {
        if (!this.#pipeline) return
        if (!sab && !this.#lastRenderMsg) return
        // Edge/corner modes hover-test FeatureGraph features on the CPU only.
        // Auto mirrors the click arbitration (handleClick): hover an FG edge/corner
        // when one is under the cursor, otherwise fall through to the GPU
        // face/surface hover below — so face-hover highlight works in Auto, not
        // just Face mode.
        const fgMode = this.#readSelectionMode(sab)
        if (fgMode === SEL_MODE_EDGE || fgMode === SEL_MODE_CORNER || fgMode === SEL_MODE_AUTO) {
            // In hide-behind mode, surface depth at the cursor occludes features
            // drawn behind it (read once, threaded into the hit-test).
            const occZ = await this.#cursorSurfaceViewZ(clickUV, sab)
            if (fgMode === SEL_MODE_EDGE || fgMode === SEL_MODE_CORNER) {
                this.#handleFgHover(clickUV, fgMode, sab, documentName, hoverRequestId, occZ)
                return
            }
            if (this.#fgClickHasFeature(clickUV, sab, occZ)) {
                this.#handleFgHover(clickUV, fgMode, sab, documentName, hoverRequestId, occZ)
                return
            }
            // No FG feature near — drop any stale FG hover highlight, then let the
            // GPU face hover run so the face/surface under the cursor previews.
            this.#fgLastHoverKey = "" // re-arm the fade for the next hovered feature
            if (this.#fgHoverChain >= 0 || this.#fgHoverCorner >= 0) {
                this.#fgHoverChain = -1
                this.#fgHoverCorner = -1
                this.#applyFgHighlights()
            }
        }
        this.#writeClickState(clickUV, false, true, clickUV)
        this.#device.queue.writeBuffer(this.#uniformBuffers.hoverEdgeHit, 0, ZERO_EDGE_HITS)

        // Hover renders share the canvas target with the normal preview
        // path — so whatever quality this render uses is what the user
        // sees on screen until the next main-thread-initiated render. An
        // earlier attempt to drop ray-march quality here (to reduce the
        // "stuck at drag-start" delay on heavy scenes) caused visible
        // degradation while hovering, because the canvas was constantly
        // being repainted at hover-quality between user actions.
        //
        // Fast pick: scissored offscreen render of a few pixels around the
        // hover point — no full raymarch, no canvas repaint. The hover
        // highlight itself is drawn by the next main-thread-initiated render
        // (the hovered id rides the SAB), so there's at most a ~1-frame lag,
        // and the readback no longer stalls behind a full-frame raymarch (which
        // is what made hover-flood selection feel slow).
        if (sab) {
            this.#renderFromSAB(sab, clickUV)
        } else {
            this.render(this.#lastRenderMsg!)
        }
        const selectionMode =
            sab ?
                (new Uint32Array(sab)[(getSlotByteOffset(getPublishedRenderSlot(sab)) + SAB_LAYOUT.O_VIEW_SETTINGS) / 4] >> 2) & 7
            :   this.#lastSelectionMode
        const effectiveMode = altKey && selectionMode === 0 ? 1 : selectionMode

        const { hoveredObjectId, hoveredEdges, hoverHitPos } = await this.#readHoverResult()
        let edges: SelectedEdgePayload[] = []
        if (effectiveMode === 1) {
            edges = hoveredEdges.filter(h => h.kind === EdgeKind.Seam)
        } else if (effectiveMode === 2) {
            edges = hoveredEdges.filter(h => h.kind === EdgeKind.Primitive || h.kind === EdgeKind.SeamSegment)
        }

        const selectionState = sab ? readSelectionStateFromSAB(sab) : this.#lastRenderMsg!.selectionState
        const objects = selectionState.selectedObjectIds
        const objectNames: Record<number, string> = {}
        if (this.#scene) {
            const ids = new Set([...objects, hoveredObjectId].filter(id => id > 0))
            for (const id of ids) {
                const node = this.#scene.get(id)
                objectNames[id] = node?.getShapeType?.() ?? "?"
            }
        }
        const info: SelectionInfo = {
            objects,
            objectNames,
            edges: selectionState.selectedEdges.map(e => ({
                kind: e.kind,
                primaryId: e.primaryId,
                secondaryId: e.secondaryId,
                featureA: e.featureA,
                opType: e.opType,
            })),
            face: null,
            hover:
                hoveredObjectId > 0 ?
                    {
                        objectId: hoveredObjectId,
                        hitPos: hoverHitPos ?? undefined,
                        edges: edges.map(e => ({
                            kind: e.kind,
                            primaryId: e.primaryId,
                            secondaryId: e.secondaryId,
                            featureA: e.featureA,
                            opType: e.opType,
                            seedPoint: e.seedPoint,
                            seedTangent: e.seedTangent,
                            seedNormal: e.seedNormal,
                        })),
                    }
                :   null,
        }
        self.postMessage({ type: "selectionInfo", info, documentName, hoverRequestId })
    }

    async handlePickObject(clickUV: [number, number], requestId: number, sab?: SharedArrayBuffer): Promise<void> {
        if (!this.#pipeline) {
            self.postMessage({ type: "pickObjectResult", objectId: 0, requestId })
            return
        }
        if (!sab && !this.#lastRenderMsg) {
            self.postMessage({ type: "pickObjectResult", objectId: 0, requestId })
            return
        }
        this.#writeClickState(clickUV, false, true, clickUV)
        this.#device.queue.writeBuffer(this.#uniformBuffers.hoverEdgeHit, 0, ZERO_EDGE_HITS)
        if (sab) this.#renderFromSAB(sab, clickUV)
        else this.render(this.#lastRenderMsg!)
        const { hoveredObjectId } = await this.#readHoverResult()
        self.postMessage({ type: "pickObjectResult", objectId: hoveredObjectId, requestId })
    }

    async handleDoubleClick(clickUV: [number, number], documentName?: string, sab?: SharedArrayBuffer): Promise<void> {
        if (!this.#pipeline) return
        if (!sab && !this.#lastRenderMsg) return
        this.#writeClickState(clickUV, true, false)
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickedObjectId, 0, ZERO_U32)
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickedHitPos, 0, ZERO_VEC4)
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickedNormal, 0, ZERO_VEC4)
        this.#device.queue.writeBuffer(this.#uniformBuffers.edgeHit, 0, ZERO_EDGE_HITS)

        if (sab) this.#renderFromSAB(sab, clickUV)
        else this.render(this.#lastRenderMsg!)
        const result = await this.#readClickResult()
        if (result.clickedId !== 0) {
            self.postMessage({
                type: "objectDoubleClick",
                nodeId: result.clickedId,
                hitPos: [result.hitPos[0], result.hitPos[1], result.hitPos[2]],
                documentName,
            })
        }
    }

    async handlePickPos(clickUV: [number, number], requestId: number, sab?: SharedArrayBuffer): Promise<void> {
        if (!this.#pipeline) {
            self.postMessage({ type: "pickPosResult", hitPos: null, requestId })
            return
        }
        if (!sab && !this.#lastRenderMsg) {
            self.postMessage({ type: "pickPosResult", hitPos: null, requestId })
            return
        }
        this.#writeClickState(clickUV, true, false)
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickedObjectId, 0, ZERO_U32)
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickedHitPos, 0, ZERO_VEC4)
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickedNormal, 0, ZERO_VEC4)
        this.#device.queue.writeBuffer(this.#uniformBuffers.edgeHit, 0, ZERO_EDGE_HITS)
        if (sab) this.#renderFromSAB(sab, clickUV)
        else this.render(this.#lastRenderMsg!)
        const result = await this.#readClickResult()
        // hitPos[3] is the ray travel distance t; 0 means no hit
        const hasHit = result.hitPos[3] > 0
        self.postMessage({
            type: "pickPosResult",
            hitPos: hasHit ? [result.hitPos[0], result.hitPos[1], result.hitPos[2]] : null,
            requestId,
        })
    }

    writeBuffers(msg: Extract<MainToWorkerMessage, { type: "writeBuffers" }>): void {
        if (msg.faceSelection) {
            this.#device.queue.writeBuffer(this.#uniformBuffers.faceSelection, 0, msg.faceSelection)
        }
        if (msg.polygonVertices) {
            this.#device.queue.writeBuffer(this.#uniformBuffers.polygonVertices, msg.polygonVertices.offset, msg.polygonVertices.data)
            // This patches the buffer out-of-band, so the dedup cache no longer mirrors the
            // GPU. Invalidate it so the next build always re-uploads — otherwise an undo that
            // repacks identical vertices would dedup-skip and leave the live side-face drag on
            // screen (preview doesn't revert on cmd-z).
            this.#lastPolygonVertexLen = -1
            // The geometry changed out-of-band, but the deferred-shading geometry
            // hash only reflects the SAB. Invalidate it so the next frame runs a
            // full SDF march instead of a shade-only repaint (which would freeze
            // the live push/pull on screen).
            this.#lastGeometryHash = -1
        }
        if (msg.previewParamsF32Patch) {
            const patch = new Float32Array(msg.previewParamsF32Patch.data)
            const byteOffset = msg.previewParamsF32Patch.byteOffset
            const f32Off = byteOffset >> 2
            this.#previewF32Shadow[f32Off] = patch[0]!
            this.#previewF32Shadow[f32Off + 1] = patch[1]!
            // Only upload the two patched floats; `queue.writeBuffer` offset is 4-byte aligned (f32 slot indices).
            const dataByteOffset = this.#previewF32Shadow.byteOffset + byteOffset
            this.#device.queue.writeBuffer(
                this.#uniformBuffers.previewCapParamDrag,
                byteOffset,
                this.#previewF32Shadow.buffer,
                dataByteOffset,
                8,
            )
            // previewCapParamDrag was patched out-of-band, so the dedup cache no longer
            // mirrors the GPU. Invalidate it so the next build re-uploads both preview banks —
            // otherwise an undo whose repacked params equal the cache would dedup-skip and
            // leave the dragged cap height/shift on screen (preview doesn't revert on cmd-z).
            this.#lastPreviewF32Len = -1
            // Cap h/posY is geometry. The deferred-shading geometry hash only
            // reflects the SAB, so a live cap drag (patched here, not in the SAB)
            // would otherwise hit the shade-only fast path and freeze on screen
            // until release. Force a full SDF march next frame.
            this.#lastGeometryHash = -1
        }
        if (msg.selectedObjectIds) {
            if (msg.selectedObjectIds instanceof ArrayBuffer) {
                this.#device.queue.writeBuffer(this.#uniformBuffers.selectedObjectIds, 0, msg.selectedObjectIds)
                new Uint8Array(this.#selectedIdsCache).set(new Uint8Array(msg.selectedObjectIds))
            } else {
                this.#device.queue.writeBuffer(
                    this.#uniformBuffers.selectedObjectIds,
                    msg.selectedObjectIds.offset,
                    msg.selectedObjectIds.data,
                )
                new Uint8Array(this.#selectedIdsCache, msg.selectedObjectIds.offset, msg.selectedObjectIds.data.byteLength).set(
                    new Uint8Array(msg.selectedObjectIds.data),
                )
            }
        }
        if (msg.colorPalette) {
            this.#device.queue.writeBuffer(this.#uniformBuffers.colorPalette, 0, msg.colorPalette)
        }
        // Any of these writes (face highlight, polygon vertex patch, cap
        // drag, selectedObjectIds, color palette) changes what the next
        // render would produce even without a SAB version bump. Defeat
        // the idle-skip hash gate so the caller's subsequent
        // `requestRender()` actually goes through.
        this.#forceNextRender = true
    }

    /** Build full 256-byte camera uniform and upload if dirty. */
    #uploadCameraIfDirty(
        viewTransform: Float32Array | ArrayBuffer,
        cameraPosition: [number, number, number],
        sceneWidth: number,
        sceneHeight: number,
        zoom: number,
        viewCenter: [number, number],
        previewShading: PreviewShadingParams,
        previewNormalShading: boolean,
    ): void {
        const vt = viewTransform instanceof Float32Array ? viewTransform : new Float32Array(viewTransform)
        // Input-equality short-circuit. Inputs are cheap to compare; the work
        // we skip on a match (matrix inverse + 4 light-dir transforms +
        // 256-byte staging build + memcmp + GPU upload) is not. Steady-state
        // idle frames reach this path and exit before doing any real work.
        const cache = this.#cameraInputCache
        const ps = previewShading
        const normShade = previewNormalShading ? 1 : 0
        if (this.#cameraInputValid) {
            let same = true
            for (let i = 0; i < 16; i++) {
                if (cache[i] !== vt[i]) { same = false; break }
            }
            if (
                same &&
                cache[16] === cameraPosition[0] &&
                cache[17] === cameraPosition[1] &&
                cache[18] === cameraPosition[2] &&
                cache[19] === sceneWidth &&
                cache[20] === sceneHeight &&
                cache[21] === zoom &&
                cache[22] === viewCenter[0] &&
                cache[23] === viewCenter[1] &&
                cache[24] === ps.ambient &&
                cache[25] === ps.diffuseWrap &&
                cache[26] === ps.keyWeight &&
                cache[27] === ps.fillWeight &&
                cache[28] === ps.rimWeight &&
                cache[29] === ps.backWeight &&
                cache[30] === ps.specIntensity &&
                // cache[31] / cache[32] are dead slots (formerly specShininess /
                // fresnelPower) — kept in the layout so downstream slot indices
                // don't shift; never read, never compared.
                cache[33] === ps.fresnelIntensity &&
                cache[34] === ps.aoStrength &&
                cache[35] === ps.aoRadius &&
                cache[36] === ps.aoSteps &&
                cache[37] === ps.aoBias &&
                cache[38] === normShade
            ) return
        }
        for (let i = 0; i < 16; i++) cache[i] = vt[i]!
        cache[16] = cameraPosition[0]
        cache[17] = cameraPosition[1]
        cache[18] = cameraPosition[2]
        cache[19] = sceneWidth
        cache[20] = sceneHeight
        cache[21] = zoom
        cache[22] = viewCenter[0]
        cache[23] = viewCenter[1]
        cache[24] = ps.ambient
        cache[25] = ps.diffuseWrap
        cache[26] = ps.keyWeight
        cache[27] = ps.fillWeight
        cache[28] = ps.rimWeight
        cache[29] = ps.backWeight
        cache[30] = ps.specIntensity
        // cache[31] / cache[32] left as 0 — see comparison block above.
        cache[33] = ps.fresnelIntensity
        cache[34] = ps.aoStrength
        cache[35] = ps.aoRadius
        cache[36] = ps.aoSteps
        cache[37] = ps.aoBias
        cache[38] = normShade
        this.#cameraInputValid = true

        this.#camTransform.data.set(vt)
        const v1 = this.#camTransform.transformVector(vec3(0.5, 0.6, 1.0).normalize())
        const v2 = this.#camTransform.transformVector(vec3(-0.6, 0.3, 0.8).normalize())
        const v3 = this.#camTransform.transformVector(vec3(0.1, -0.5, 0.9).normalize())
        const v4 = this.#camTransform.transformVector(vec3(-0.2, 0.2, 1.0).normalize())
        const ld = this.#lightDirBuf
        ld[0] = v1.x
        ld[1] = v1.y
        ld[2] = v1.z
        ld[3] = 0
        ld[4] = v2.x
        ld[5] = v2.y
        ld[6] = v2.z
        ld[7] = 0
        ld[8] = v3.x
        ld[9] = v3.y
        ld[10] = v3.z
        ld[11] = 0
        const staging = new Uint8Array(this.#cameraStagingBuf)
        const f32 = new Float32Array(this.#cameraStagingBuf)
        staging.set(new Uint8Array(vt.buffer, vt.byteOffset, 64), 0)
        f32[16] = cameraPosition[0]
        f32[17] = cameraPosition[1]
        f32[18] = cameraPosition[2]
        f32[19] = 0
        f32[20] = sceneWidth
        f32[21] = sceneHeight
        f32[22] = zoom
        f32[23] = 0
        f32[24] = ld[0]
        f32[25] = ld[1]
        f32[26] = ld[2]
        f32[27] = 0
        f32[28] = ld[4]
        f32[29] = ld[5]
        f32[30] = ld[6]
        f32[31] = 0
        f32[32] = ld[8]
        f32[33] = ld[9]
        f32[34] = ld[10]
        f32[35] = 0
        f32[36] = viewCenter[0]
        f32[37] = viewCenter[1]
        f32[38] = 0
        f32[39] = 0
        f32[40] = v4.x
        f32[41] = v4.y
        f32[42] = v4.z
        f32[43] = 0
        f32[44] = ps.ambient
        f32[45] = ps.diffuseWrap
        f32[46] = ps.keyWeight
        f32[47] = ps.fillWeight
        f32[48] = ps.rimWeight
        f32[49] = ps.backWeight
        f32[50] = ps.specIntensity
        // f32[51] / f32[52] map to `camera.previewShade1.w` /
        // `camera.previewShade2.x` — formerly specShininess / fresnelPower.
        // Shader hard-codes power 32 / Schlick power 5 in
        // `specularAndFresnelRim` now; leave the slots at zero so the
        // 256-byte Camera buffer layout stays stable.
        f32[51] = 0
        f32[52] = 0
        f32[53] = ps.fresnelIntensity
        f32[54] = previewNormalShading ? 1.0 : 0.0
        f32[55] = 0.0
        f32[56] = ps.aoStrength
        f32[57] = ps.aoRadius
        f32[58] = ps.aoSteps
        f32[59] = ps.aoBias
        // Slots 60-63 (formerly pivotPx + pivotCursorFlags) now carry the
        // CPU-baked Blinn-Phong half-vector for the key light. Both
        // `lightDir1` and the camera +Z column (viewDir in scene space)
        // are uniform per frame, so computing
        // `normalize(lightDir1 + viewDir)` here once replaces a per-pixel
        // vec3 add + normalize in the fragment shader's
        // `specularAndFresnelRim`.
        const vdx = this.#camTransform.data[8]!
        const vdy = this.#camTransform.data[9]!
        const vdz = this.#camTransform.data[10]!
        const hxRaw = v1.x + vdx
        const hyRaw = v1.y + vdy
        const hzRaw = v1.z + vdz
        const hLenSq = hxRaw * hxRaw + hyRaw * hyRaw + hzRaw * hzRaw
        const invH = hLenSq > 1e-20 ? 1 / Math.sqrt(hLenSq) : 0
        f32[60] = hxRaw * invH
        f32[61] = hyRaw * invH
        f32[62] = hzRaw * invH
        f32[63] = 0
        this.#writeBufferIfDirty(this.#uniformBuffers.camera, this.#cameraStagingBuf, 0, 256, this.#cameraCache)
    }

    /** Compare src[offset:offset+byteLength] with cache; if different, write to GPU and update cache. Returns true if wrote. */
    #writeBufferIfDirty(
        gpuBuffer: GPUBuffer,
        src: ArrayBuffer | SharedArrayBuffer,
        srcOffset: number,
        byteLength: number,
        cache: ArrayBuffer,
    ): boolean {
        const srcU8 = new Uint8Array(src, srcOffset, byteLength)
        const cacheU8 = new Uint8Array(cache)
        for (let i = 0; i < byteLength; i++) {
            if (srcU8[i] !== cacheU8[i]) {
                this.#device.queue.writeBuffer(gpuBuffer, 0, src, srcOffset, byteLength)
                cacheU8.set(srcU8)
                return true
            }
        }
        return false
    }

    /**
     * SAB variant: snapshot byte range into worker-owned staging, then compare/write/update
     * from that snapshot. Ensures GPU upload and cache state stay consistent when the main
     * thread may be modifying the SAB concurrently.
     */
    #writeBufferFromSABIfDirty(
        gpuBuffer: GPUBuffer,
        sab: SharedArrayBuffer,
        sabOffset: number,
        byteLength: number,
        cache: ArrayBuffer,
    ): boolean {
        const staging = new Uint8Array(this.#sabStagingBuf, 0, byteLength)
        staging.set(new Uint8Array(sab, sabOffset, byteLength))
        return this.#writeBufferIfDirty(gpuBuffer, this.#sabStagingBuf, 0, byteLength, cache)
    }

    /**
     * Resize the OffscreenCanvas drawing buffer to the current scene render
     * resolution. The DOM canvas keeps its CSS size; the browser bilinear-
     * scales the drawing buffer into that CSS box at composite time, which
     * is the same upsample the outline blit pass used to do — but free,
     * because it lives outside the GPU command queue.
     *
     * Only triggers an actual size change when the requested dimensions
     * differ from the canvas's current drawing buffer, so steady-state
     * frames pay zero overhead.
     */
    #resizeCanvasIfNeeded(targetWidth: number, targetHeight: number): void {
        if (this.#canvas.width !== targetWidth) this.#canvas.width = Math.max(1, targetWidth)
        if (this.#canvas.height !== targetHeight) this.#canvas.height = Math.max(1, targetHeight)
    }

    /** Compare src view with cache; if different, write to GPU and update cache. Returns true if wrote. */
    #uploadRayMarchParams(params: RayMarchParams): void {
        this.#rayMarchParamsI32[0] = params.maxSteps
        this.#rayMarchParamsI32[1] = params.maxBeamSteps
        this.#rayMarchParamsI32[2] = params.hitRefineSteps
        this.#rayMarchParamsI32[3] = 0
        this.#rayMarchParamsF32[4] = params.maxDist
        this.#rayMarchParamsF32[5] = params.rayOriginDepth
        this.#writeBufferViewIfDirty(
            this.#uniformBuffers.rayMarchParams,
            new Uint8Array(this.#rayMarchParamsBuf),
            this.#rayMarchParamsCache,
        )
    }

    #writeBufferViewIfDirty(gpuBuffer: GPUBuffer, src: ArrayBufferView, cache: ArrayBuffer): boolean {
        const byteLength = src.byteLength
        const srcU8 = new Uint8Array(src.buffer, src.byteOffset, byteLength)
        const cacheU8 = new Uint8Array(cache)
        for (let i = 0; i < byteLength; i++) {
            if (srcU8[i] !== cacheU8[i]) {
                this.#device.queue.writeBuffer(gpuBuffer, 0, src as BufferSource)
                cacheU8.set(srcU8)
                return true
            }
        }
        return false
    }

    /** Build edges into staging, upload to GPU if dirty. */
    #writeEdgesToBufferIfDirty(
        gpuBuffer: GPUBuffer,
        edges: (
            | SelectedEdgePayload
            | {
                  kind: number
                  primaryId: number
                  secondaryId: number
                  featureA: number
                  opType: number
                  lineWidthPx?: number
                  epsilon?: number
                  seedPoint?: [number, number, number]
                  seedTangent?: [number, number, number]
                  seedNormal?: [number, number, number]
              }
        )[],
        lineWidthPx: number,
        epsilon: number,
        cache: ArrayBuffer,
    ): void {
        const u32 = new Uint32Array(this.#edgesStagingBuf)
        const f32 = new Float32Array(this.#edgesStagingBuf)
        const count = Math.min(edges.length, SELECTED_EDGES_COUNT)
        u32[0] = count
        for (let i = 1; i < SELECTED_EDGES_HEADER / 4; i++) u32[i] = 0
        for (let i = 0; i < count; i++) {
            const e = edges[i]
            const base = SELECTED_EDGES_HEADER / 4 + i * (SELECTED_EDGE_SIZE / 4)
            u32[base] = e.kind
            u32[base + 1] = e.primaryId
            u32[base + 2] = e.secondaryId
            u32[base + 3] = e.featureA
            u32[base + 4] = e.opType
            f32[base + 5] = e.lineWidthPx ?? lineWidthPx
            f32[base + 6] = e.epsilon ?? epsilon
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
        new Uint8Array(this.#edgesStagingBuf).fill(0, SELECTED_EDGES_HEADER + count * SELECTED_EDGE_SIZE, SELECTED_EDGES_TOTAL)
        this.#writeBufferIfDirty(gpuBuffer, this.#edgesStagingBuf, 0, SELECTED_EDGES_TOTAL, cache)
    }

    #writeEdgesToBuffer(
        buffer: GPUBuffer,
        edges: (
            | SelectedEdgePayload
            | {
                  kind: number
                  primaryId: number
                  secondaryId: number
                  featureA: number
                  opType: number
                  lineWidthPx?: number
                  epsilon?: number
                  seedPoint?: [number, number, number]
                  seedTangent?: [number, number, number]
                  seedNormal?: [number, number, number]
              }
        )[],
        lineWidthPx: number,
        epsilon: number,
    ): void {
        this.#edgeHeaderU32[0] = Math.min(edges.length, SELECTED_EDGES_COUNT)
        this.#device.queue.writeBuffer(buffer, 0, this.#edgeHeaderBuf)
        const u32 = this.#edgeStrideU32
        const f32 = this.#edgeStrideF32
        for (let i = 0; i < Math.min(edges.length, SELECTED_EDGES_COUNT); i++) {
            const e = edges[i]
            u32[0] = e.kind
            u32[1] = e.primaryId
            u32[2] = e.secondaryId
            u32[3] = e.featureA
            u32[4] = e.opType
            f32[5] = e.lineWidthPx ?? lineWidthPx
            f32[6] = e.epsilon ?? epsilon
            const sp = e.seedPoint ?? [0, 0, 0]
            f32[8] = sp[0]
            f32[9] = sp[1]
            f32[10] = sp[2]
            const st = e.seedTangent ?? [0, 0, 0]
            f32[12] = st[0]
            f32[13] = st[1]
            f32[14] = st[2]
            const sn = e.seedNormal ?? [0, 0, 0]
            f32[16] = sn[0]
            f32[17] = sn[1]
            f32[18] = sn[2]
            this.#device.queue.writeBuffer(buffer, SELECTED_EDGES_HEADER + i * SELECTED_EDGE_SIZE, this.#edgeStrideBuf)
        }
    }
}
