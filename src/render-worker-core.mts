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
    type ExporterKind,
    type MeshExportContext,
} from "./export/mesh-exporter.mjs"
import { IsoSampleBatch } from "./export/iso-simplicial/index.mjs"
import { FeatureGraphBuilder } from "./scene/feature-graph-buffer.mjs"
import {
    FeatureGraphGpu,
    type FeatureGraphBuildResult,
} from "./feature-graph/feature-graph-gpu.mjs"
import { featureGraphToContours } from "./feature-graph/feature-graph-to-contours.mjs"
import { FeatureGraphOverlay } from "./feature-graph/feature-graph-overlay.mjs"
import { SceneInfo } from "./scene/scene.mjs"
import { Extrude, Loft, ThreadedRod } from "./scene/scene.mjs"
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
    type PreviewParamsOut,
} from "./scene/scene-params.mjs"
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
const POLYGON_VERTEX_BUFFER_SIZE = MAX_POLYGON_VERTICES * 8
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
type ProfiledPassName = "beam" | "scene" | "easu" | "fxaa" | "outline" | "overlay"
/** Max pass-time pairs per frame — sized to {@link ProfiledPassName}. */
const TIMESTAMP_MAX_PAIRS = 6
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
    /** Toggle for the debug overlay; default ON, updated by view settings. */
    #featureGraphOverlayEnabled = true
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
    #viewSettingsBuf = new Uint32Array(5)
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
    #viewSettingsCache = new ArrayBuffer(20)
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
        easu: new AveragedBuffer(30),
        fxaa: new AveragedBuffer(30),
        outline: new AveragedBuffer(30),
        overlay: new AveragedBuffer(30),
    }
    /** Frames since last profiling log. Reported every ~60 frames to avoid console spam. */
    #passTimeLogFrames = 0
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

        this.#outlineShaderModule = this.#device.createShaderModule({
            label: "Outline Post-Process",
            code: outlineShader,
        })
        scheduleShaderModuleCompilationLogging(this.#outlineShaderModule, "Outline Post-Process", outlineShader)
        try {
            this.#outlinePipeline = this.#device.createRenderPipeline({
                label: "Outline Pipeline",
                layout: "auto",
                vertex: {
                    module: this.#outlineShaderModule,
                    entryPoint: "vertexMain",
                },
                fragment: {
                    module: this.#outlineShaderModule,
                    entryPoint: "fragmentMain",
                    targets: [{ format: this.#format }],
                },
                primitive: {
                    topology: "triangle-strip",
                    stripIndexFormat: "uint32",
                },
            })
        } catch (err) {
            const text = err instanceof Error ? (err.stack ?? err.message) : String(err)
            logWgsl("error", `Outline post-process pipeline creation failed: ${text}`)
            throw err
        }

        // FSR1 EASU upscale pipeline — a full-screen fragment pass writing the
        // canvas `#format`, mirroring the outline blit. Bind groups are created
        // lazily in `#ensureUpscaleTextures` once the scene/display sizes are known.
        this.#easuShaderModule = this.#device.createShaderModule({ label: "FSR1 EASU", code: easuShader })
        scheduleShaderModuleCompilationLogging(this.#easuShaderModule, "FSR1 EASU", easuShader)
        try {
            this.#easuPipeline = this.#device.createRenderPipeline({
                label: "FSR1 EASU Pipeline",
                layout: "auto",
                vertex: { module: this.#easuShaderModule, entryPoint: "vertexMain" },
                fragment: { module: this.#easuShaderModule, entryPoint: "fragmentMain", targets: [{ format: this.#format }] },
                primitive: { topology: "triangle-strip", stripIndexFormat: "uint32" },
            })
        } catch (err) {
            const text = err instanceof Error ? (err.stack ?? err.message) : String(err)
            logWgsl("error", `FSR1 upscale pipeline creation failed: ${text}`)
            throw err
        }

        // FXAA post-process (luma-driven edge smoothing), optional final pass
        // after EASU / on full-res frames. Same full-screen fragment shape.
        this.#fxaaShaderModule = this.#device.createShaderModule({ label: "FXAA", code: fxaaShader })
        scheduleShaderModuleCompilationLogging(this.#fxaaShaderModule, "FXAA", fxaaShader)
        try {
            this.#fxaaPipeline = this.#device.createRenderPipeline({
                label: "FXAA Pipeline",
                layout: "auto",
                vertex: { module: this.#fxaaShaderModule, entryPoint: "vertexMain" },
                fragment: { module: this.#fxaaShaderModule, entryPoint: "fragmentMain", targets: [{ format: this.#format }] },
                primitive: { topology: "triangle-strip", stripIndexFormat: "uint32" },
            })
        } catch (err) {
            const text = err instanceof Error ? (err.stack ?? err.message) : String(err)
            logWgsl("error", `FXAA pipeline creation failed: ${text}`)
            throw err
        }

        // Outline bind group created in ensureRenderTextures when we have color/id textures

        // Init click/selection/face buffers
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickState, 0, new ArrayBuffer(32))
        this.#device.queue.writeBuffer(this.#uniformBuffers.selectedObjectIds, 0, new Uint32Array(1024))
        this.#device.queue.writeBuffer(this.#uniformBuffers.faceSelection, 0, new ArrayBuffer(20))

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
            return await this.#doBuild(body)
        } finally {
            release()
        }
    }

    setBvhEnabled(enabled: boolean): void {
        this.#bvhEnabled = enabled
    }

    /**
     * Toggle the per-pixel `sceneSDF_fast` step-count heatmap in the preview
     * shader. Picked up on the next render frame; no immediate re-render is
     * triggered (the user typically toggles and then interacts, which kicks
     * a render naturally — matching the {@link setFeatureGraphOverlayEnabled}
     * convention).
     */
    setStepHeatmapEnabled(enabled: boolean): void {
        if (this.#stepHeatmapEnabled === enabled) return
        this.#stepHeatmapEnabled = enabled
        // Worker-internal state change — SAB hasn't moved, but the rendered
        // output would differ, so the SAB-hash idle skip needs a one-shot
        // override to actually pick this up on the next render kick.
        this.#forceNextRender = true
    }

    /** Toggle the FeatureGraph debug overlay. Renders alive crease/corner edges over the scene. */
    setFeatureGraphOverlayEnabled(enabled: boolean): void {
        const wasEnabled = this.#featureGraphOverlayEnabled
        if (wasEnabled === enabled) return
        this.#featureGraphOverlayEnabled = enabled
        this.#forceNextRender = true
        // Enabling mid-session: lazily kick a build against the current scene
        // so the overlay populates without waiting for the next source edit.
        if (!wasEnabled && enabled && this.#scene && this.#builtStructuralFingerprint) {
            this.#kickFeatureGraphBuild(this.#scene, this.#builtStructuralFingerprint)
        }
    }

    cancelBuilds(): void {
        this.#buildGeneration++
        // Supersede any in-flight background FG build too — its upload is
        // gated on `#fgGeneration` matching, so newer kicks always win.
        this.#fgGeneration++
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
            this.#sceneShader !== null

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

        const tWgsl0 = performance.now()
        const sceneAux = scene.compileAuxPreview()
        const tAux = performance.now()
        const sceneAuxFast = scene.compileAuxFastPreview()
        const tAuxFast = performance.now()
        const sceneAuxMid = scene.compileAuxMidPreview()
        const tAuxMid = performance.now()
        const sceneSDF = scene.compileForPreview()
        const tSdf = performance.now()
        const sceneSDF_fast = scene.compileFastForPreview()
        const tSdfFast = performance.now()
        const sceneSDF_mid = scene.compileMidForPreview()
        const tSdfMid = performance.now()
        const sceneEdgeHelpers = scene.compileEdgeHelpers()
        const sceneLatheEdgeHitCases = scene.compileLathePrimitiveEdgeHitCases()
        const sceneLatheRingDistanceCases = scene.compileLathePrimitiveRingDistanceCases()
        const tWgsl1 = performance.now()

        const shaderCompiler = new ShaderCompiler(this.#device)
            .replace("insert", "sceneAuxFast", sceneAuxFast)
            .replace("insert", "sceneAux", sceneAux)
            .replace("insert", "sceneAuxMid", sceneAuxMid)
            .replace("insert", "sceneSDF_fast", sceneSDF_fast)
            .replace("insert", "sceneSDF", sceneSDF)
            .replace("insert", "sceneSDF_mid", sceneSDF_mid)
            .replace("insert", "sceneEdgeHelpers", sceneEdgeHelpers)
            .replace("insert", "sceneLatheEdgeHitCases", sceneLatheEdgeHitCases)
            .replace("insert", "sceneLatheRingDistanceCases", sceneLatheRingDistanceCases)

        const tShaderMod0 = performance.now()
        const nextShader = shaderCompiler.compile(previewShader, "Preview + Beam")
        const tShaderMod1 = performance.now()

        // Iso_sample_batch module compile is deferred — `#ensureFeatureGraphIsoModule`
        // produces it on demand from the FG kick or from `handleRenderMesh`. It
        // duplicates `scene.compileAux*()` / `compile()` / `compileMid()` against
        // the export bind set, so building it inline doubled the WGSL codegen
        // cost of every structural rebuild even when the overlay was off.
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
                        // Single target: the canvas swapchain. The previous
                        // r32uint object-ID attachment fed the old outline
                        // post-process pass which is gone; click picking
                        // uses the `clickedObjectId` atomic written from
                        // inside the fragment shader.
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
            return { superseded: true } as { superseded: true }
        }

        log("RenderWorker").debug("scene build full (ms)", {
            sceneConstruct: roundMs(tSceneConstruct - t0),
            fingerprint: roundMs(tFingerprint - tFp0),
            packScene: roundMs(tPackScene1 - tPackScene0),
            packPreview: roundMs(tPackPreview - tPackPrev0),
            wgslScene: roundMs(tWgsl1 - tWgsl0),
            shaderModules: roundMs(tShaderMod1 - tShaderMod0),
            pipelines: roundMs(tPipeline1 - tPipeline0),
            total: roundMs(tPipeline1 - t0),
        })

        // WebGPU: only buffers, textures, and query sets have destroy(). Pipelines, shader modules,
        // and bind groups do not — replace fields so previous objects can be GC'd.
        this.#pipeline = pipeline
        this.#beamPipeline = beamPipeline
        this.#sceneShader = nextShader
        this.#builtStructuralFingerprint = fingerprint
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
            wgslSceneMs: roundMs(tWgsl1 - tWgsl0),
            compileAuxPreviewMs: roundMs(tAux - tWgsl0),
            compileAuxFastPreviewMs: roundMs(tAuxFast - tAux),
            compileAuxMidPreviewMs: roundMs(tAuxMid - tAuxFast),
            compileForPreviewMs: roundMs(tSdf - tAuxMid),
            compileFastForPreviewMs: roundMs(tSdfFast - tSdf),
            compileMidForPreviewMs: roundMs(tSdfMid - tSdfFast),
            compileEdgeHelpersMs: roundMs(tWgsl1 - tSdfMid),
            shaderModulesMs: roundMs(tShaderMod1 - tShaderMod0),
            pipelinesMs: roundMs(tPipeline1 - tPipeline0),
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
    ): void {
        if (!this.#featureGraphOverlayEnabled) return
        const overlay = this.#featureGraphOverlay
        if (!overlay || !overlay.hasAliveFeatures) return
        overlay.uploadCamera(viewTransform, cameraPosition, width, height, zoom, viewCenter)
        const pass = commandEncoder.beginRenderPass({
            label: "FeatureGraph Overlay",
            colorAttachments: [{ view: target, loadOp: "load", storeOp: "store" }],
            timestampWrites: this.#timestampWritesFor("overlay"),
        })
        overlay.render(pass)
        pass.end()
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
            log("RenderWorker").debug("gpu pass times (avg ms, 30-frame window)", {
                beam: roundMs2(avg.beam.average),
                scene: roundMs2(avg.scene.average),
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
        if (!this.#featureGraphOverlayEnabled) return
        this.#fgGeneration++
        const gen = this.#fgGeneration
        const prev = this.#fgBuildLock
        this.#fgBuildLock = (async () => {
            await prev
            // Skip stale kicks queued behind a newer one — only the latest
            // kick should pay for the GPU compute + readback round-trip.
            if (gen !== this.#fgGeneration) return
            if (!this.#featureGraphOverlayEnabled) return
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
            if (!dedup || this.#lastPreviewF32Len !== f32Len || !float32SubarrayEqual(this.#lastPreviewF32Upload, p.f32, f32Len)) {
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
        this.#viewSettingsBuf[4] = viewSettings.isolateId
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
                        // viewSettings (binding 6): the fast SDF now reads viewSettings.isolateId for
                        // isolate-view pass-through, so the beam pre-pass shader statically references it.
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
        const scenePass = commandEncoder.beginRenderPass({
            colorAttachments: [{ view: sceneColorView, loadOp: "clear", storeOp: "store" }],
            timestampWrites: this.#timestampWritesFor("scene"),
        })
        scenePass.setPipeline(this.#pipeline)
        scenePass.setBindGroup(0, this.#bindGroup!)
        scenePass.draw(4)
        scenePass.end()

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

    #renderFromSAB(buffer: SharedArrayBuffer): void {
        const slot = getPublishedRenderSlot(buffer)
        const slotBase = getSlotByteOffset(slot)

        // Idle short-circuit: hash the active slot bytes and bail out when
        // the result matches what we last rendered (and nothing forced a
        // refresh). Catches the case where the SAB version was bumped but
        // no render-relevant state actually changed. FNV-1a on u32 words —
        // SLOT_SIZE / 4 ≈ 1745 iterations, well under 100 µs on typical
        // hardware vs the 35 ms+ frame we're skipping.
        const slotU32View = new Uint32Array(buffer, slotBase, SLOT_SIZE / 4)
        let hash = 2166136261
        for (let i = 0; i < slotU32View.length; i++) {
            hash = Math.imul(hash ^ slotU32View[i]!, 16777619)
        }
        if (hash === this.#lastRenderedSabHash && !this.#forceNextRender) {
            // Identical to last rendered frame — skip GPU work entirely.
            // The swapchain texture still holds the previous frame's
            // pixels, which is exactly what the user should see.
            return
        }
        this.#lastRenderedSabHash = hash
        this.#forceNextRender = false

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
        this.#viewSettingsBuf[4] = u32[b4 + L.O_ISOLATE_ID / 4]
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
                        // viewSettings (binding 6): the fast SDF now reads viewSettings.isolateId for
                        // isolate-view pass-through, so the beam pre-pass shader statically references it.
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
        const scenePass = commandEncoder.beginRenderPass({
            colorAttachments: [{ view: sceneTarget, loadOp: "clear", storeOp: "store" }],
            timestampWrites: this.#timestampWritesFor("scene"),
        })
        scenePass.setPipeline(this.#pipeline)
        scenePass.setBindGroup(0, this.#bindGroup!)
        scenePass.draw(4)
        scenePass.end()

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
            }

            const exp = getExporter(exporter)
            const tuning = exp.normalizeTuning(exporterTuning?.[exporter])
            log("MeshExport").info(`handleRenderMesh: dispatching ${exporter}, tuning=${JSON.stringify(tuning)}`)
            let mesh
            try {
                mesh = await exp.run(ctx, tuning)
            } catch (err) {
                // A newer export aborted this one — report it as superseded
                // (empty result) rather than surfacing an error to the user.
                if (abort.signal.aborted) {
                    self.postMessage({ type: "renderMeshResult", requestId, documentName })
                    return
                }
                throw err
            }

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
                    isolateId: 0,
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
        let builtForThis = false
        try {
            if (!this.#device) {
                self.postMessage({ type: "thumbnailResult", error: "WebGPU device unavailable", requestId, documentName })
                return
            }
            if (!this.#scene || this.#builtBody !== body) {
                await this.build(body, undefined)
                builtForThis = true
            }
            if (!this.#pipeline) {
                self.postMessage({ type: "thumbnailResult", error: "Scene failed to build", requestId, documentName })
                return
            }
            const vt = new Float32Array(msg.viewTransform)
            const thumbMsg: Extract<MainToWorkerMessage, { type: "render" }> = {
                type: "render",
                cameraState: msg.cameraState,
                viewTransform: vt,
                cameraPosition: msg.cameraPosition,
                cameraRes: [tw, th],
                selectionState: {
                    selectedObjectIds: [],
                    selectedEdges: [],
                    hoveredObjectId: 0,
                    hoveredEdges: [],
                },
                viewSettings: {
                    xrayMode: false,
                    beamEnabled: false,
                    isolateId: msg.isolateId ?? 0,
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
            if (builtForThis && previousBody !== null && previousBody !== body && this.#builtBody === body) {
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
                        // viewSettings (binding 6): the fast SDF now reads viewSettings.isolateId for
                        // isolate-view pass-through, so the beam pre-pass shader statically references it.
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
                entries: [
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
                ],
            })
            this.#sceneBindGroupInvalid = false
        }
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
            size: 32, // 5 u32 (20 B) rounded up to 16-byte alignment
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
            size: 20,
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

    async #readHoverResult(): Promise<{ hoveredObjectId: number; hoveredEdges: SelectedEdgePayload[] }> {
        const reuse = !this.#hoverReadbackBusy
        if (reuse) this.#hoverReadbackBusy = true
        const readback = await this.#readGPU(this.#uniformBuffers.hoverEdgeHit, this.#hoverEdgeHitReadback, EDGE_HITS_SIZE, reuse)
        if (reuse) this.#hoverReadbackBusy = false
        const u32 = new Uint32Array(readback)
        const f32 = new Float32Array(readback)
        const edges: SelectedEdgePayload[] = []
        let hoveredObjectId = 0
        const STRIDE = 20
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
        return { hoveredObjectId, hoveredEdges: edges }
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
        this.#writeClickState(clickUV, true, false)
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickedObjectId, 0, ZERO_U32)
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickedHitPos, 0, ZERO_VEC4)
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickedNormal, 0, ZERO_VEC4)
        this.#device.queue.writeBuffer(this.#uniformBuffers.edgeHit, 0, ZERO_EDGE_HITS)

        if (sab) this.#renderFromSAB(sab)
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
        // The right fix is a tiny compute-shader pick that doesn't write
        // to the canvas. Until that lands, use the same quality the SAB
        // carries for this frame — visible quality matches user settings.
        if (sab) {
            this.#renderFromSAB(sab)
        } else {
            this.render(this.#lastRenderMsg!)
        }
        const selectionMode =
            sab ?
                (new Uint32Array(sab)[(getSlotByteOffset(getPublishedRenderSlot(sab)) + SAB_LAYOUT.O_VIEW_SETTINGS) / 4] >> 2) & 7
            :   this.#lastSelectionMode
        const effectiveMode = altKey && selectionMode === 0 ? 1 : selectionMode

        const { hoveredObjectId, hoveredEdges } = await this.#readHoverResult()
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
        if (sab) this.#renderFromSAB(sab)
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

        if (sab) this.#renderFromSAB(sab)
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
        if (sab) this.#renderFromSAB(sab)
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
