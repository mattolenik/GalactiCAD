/**
 * SDFRenderer - Main-thread proxy that delegates to the render worker.
 * Keeps DOM-dependent components (CameraController, PushPullController); worker owns GPU.
 */

import { Subject } from "rxjs"
import { fromEvent } from "rxjs"
import { throttleTime } from "rxjs"
import type { Subscription } from "rxjs"
import { SettingsManager, type CameraSettings } from "./storage/settings.mjs"
import { PreviewWindow, type HoverInfo } from "./components/preview-window.mjs"
import { CameraController, DOLLY_REF } from "./controls/camera-controller.mjs"
import type { CameraState } from "./controls/camera-controller.mjs"
import type { Vec2f, Vec3f } from "./vecmat/vector.mjs"
import { vec2, vec3 } from "./vecmat/vector.mjs"
import { Mat4x4f } from "./vecmat/matrix.mjs"
import { PushPullController } from "./interaction/push-pull.mjs"
import type { MeshData } from "./export/export.mjs"
import {
    DEFAULT_PREVIEW_SHADING,
    DEFAULT_RAY_MARCH_PARAMS,
    DEFAULT_UPSCALE_PARAMS,
    type BuildTimingBreakdownMs,
    type FeatureGraphOcclusionMode,
    type MainToWorkerMessage,
    type PreviewShadingParams,
    type RayMarchParams,
    type SceneBuildPipelineMs,
    type UpscaleParams,
    type WorkerToMainMessage,
} from "./render-worker-protocol.mjs"
import type { ExporterKind } from "./export/mesh-exporter.mjs"
import type {
    EdgeHitData,
    SelectedEdgePayload,
    SimplifyTuning,
} from "./render-worker-protocol.mjs"
import { PALETTE_SIZE, paletteToFloat32Array } from "./colorPalette.mjs"
import { sha1Hash } from "./math.mjs"
import { DEFAULT_SELECTION_STYLES, type SelectionStyles } from "./selectionStyles.mjs"
import type { RenderSelectionStyles } from "./render-worker-protocol.mjs"
import { EdgeKind } from "./edge-kind.mjs"
import {
    isSharedMemoryAvailable,
    writeRenderPayloadSlot,
    publishRenderSlot,
    getPublishedRenderSlot,
    readFps,
    SHARED_RENDER_BUFFER_SIZE,
    initSharedRenderBuffer,
} from "./shared-render-buffer.mjs"
import type { TranspileKind, TranspileToMainMessage } from "./transpile-worker-protocol.mjs"
import { appendDevLogLine, log, snapshotDebugLogModules } from "./logging/debug-log.mjs"
import { DEFAULT_APP_DEVTOOLS_STATE, DEVTOOLS_SECTION_APP } from "./components/dev-tools-protocol.mjs"
import { computeAgentPreviewCameraParams } from "./agent-autotest/agent-preview-camera.mjs"
import { captureAgentMeshImageData, captureMeshThumbnailImageData } from "./agent-autotest/agent-mesh-capture.mjs"
import type { AgentMeshOverlay } from "./agent-autotest/agent-testcase.mjs"

export type SelectionMode = "object" | "seam" | "edge" | "corner" | "face" | "auto"
export type OutlineMode = "none" | "solid" | "dashed" | "dotted"
export { EdgeKind } from "./edge-kind.mjs"

export type {
    SerializedNode,
    BuildTimingBreakdownMs,
    SceneBuildPipelineMs,
    SimplifyTuning,
} from "./render-worker-protocol.mjs"
export type { ExporterKind } from "./export/mesh-exporter.mjs"

function roundScenePerfMs(x: number): number {
    return Math.round(x * 100) / 100
}

/** Default max frames per second for the preview. Main thread throttles render messages to the worker. */
const DEFAULT_TARGET_FPS = 120

/** Lightweight node stub for main-thread selection logic. Reconstructed from SerializedNode. */
export interface NodeStub {
    id: number
    shapeType: string
    getShapeType(): string
    getIndicatorSvg?(): string
    getAllDescendantIds?(): number[]
    pos?: { x: number; y: number; z: number }
    size?: { x: number; y: number; z: number }
    r?: number
    h?: number
    sr?: number
    lr?: number
    c?: number
    normal?: { x: number; y: number; z: number }
    planeOffset?: number
    vertices?: [number, number][]
    twistDegrees?: number
    turnPitch?: number
    threadAmp?: number
    threadFlankAngleDeg?: number
    threadProfile?: "fdm" | "iso" | "acme"
    handedness?: number
    filletTop?: number
    filletBottom?: number
    chamferTop?: number
    chamferBottom?: number
    femalePlay?: number
}

export class SDFRenderer {
    #preview: PreviewWindow
    #controls: CameraController
    #worker: Worker
    #transpileWorker: Worker
    #readyResolve!: () => void
    #readyReject!: (err: unknown) => void
    #readyPromise: Promise<void>
    #sceneNodeCache: NodeStub[] = []
    #selectedObjectIds: boolean[] = new Array(1024).fill(false)
    #cachedSelectedIds: number[] = []
    #selectionDirty = true
    #selectedEdges: SelectedEdgePayload[] = []
    #hoveredObjectId = 0
    #hoveredEdges: SelectedEdgePayload[] = []
    /** A transient face-hover preview highlight is currently shown (face/auto mode). */
    #faceHoverActive = false
    /** Node id whose face the hover preview is currently highlighting (0 = none).
     *  Used to resolve the FACE_HIGHLIGHT sentinel (1022/1023) the GPU reports
     *  when the cursor sits on the already-highlighted face — see #resolveFaceSentinel. */
    #faceHoverNodeId = 0
    /** A face was committed by a click (so hover-out restores it instead of clearing). */
    #faceClickCommitted = false
    /** Last hover screen position and altKey, cached for replay when camera movement stops. */
    #lastHoverScreenPos: { x: number; y: number } | null = null
    #lastHoverAltKey = false
    /** Tracks previous frame's isActivelyMoving for motion transition detection. */
    #wasActivelyMoving = false
    /** Defer hover replay until after the settled frame is published (avoids stale first-hover). */
    #shouldReplayHoverAfterRender = false
    /** Monotonic hover request ID; -1 means ignore all in-flight hover results (e.g. during movement). */
    #hoverRequestId = 0
    #latestHoverRequestId = -1
    #compiledPosY = new Map<number, number>()
    #getInteractionRect: (() => DOMRect) | null = null
    #pushPullNodes: Map<number, { type: "extrude"; id: number; pos: { x: number; y: number; z: number }; h: number; child: { vertices: [number, number][]; bufferOffset: number }; twistDegrees?: number; capTopId?: number; capBottomId?: number; sceneCapParamsByteOffset: number } | { type: "loft"; id: number; pos: { x: number; y: number; z: number }; h: number; profiles: { vertices: [number, number][]; bufferOffset: number }[]; sceneCapParamsByteOffset: number } | { type: "threaded_rod"; id: number; pos: { x: number; y: number; z: number }; h: number; sceneCapParamsByteOffset: number } | { type: "polygon2d"; id: number; vertices: [number, number][]; bufferOffset: number } | { type: "virtualCap"; id: number; parentId: number; isTop: boolean }> = new Map()
    #childrenByParent = new Map<number, number[]>()
    #parentById = new Map<number, number>()
    #needsRender = true
    #started = false
    #xrayMode = false
    #isolatedIds: number[] = []
    #beamEnabled = false
    #previewShading: PreviewShadingParams = { ...DEFAULT_PREVIEW_SHADING }
    #rayMarchParams: RayMarchParams = { ...DEFAULT_RAY_MARCH_PARAMS }
    #upscaleParams: UpscaleParams = { ...DEFAULT_UPSCALE_PARAMS }
    #previewNormalShading = false
    #bvhEnabled = true
    #featureGraphOcclusion: FeatureGraphOcclusionMode = "hard"
    #featureGraphLineWidth = 2
    #featureGraphDifferentiateSegments = false
    #stepHeatmapEnabled = false
    #deferredShadingEnabled = false
    #selectionMode: SelectionMode = "object"
    #cameraOptimization = true
    #viewCenter = vec2(0.5, 0.5)
    #controlSubs: Subscription[] = []
    #pushPullController: PushPullController | null = null
    /** Hit position from the most recent click, keyed by clicked object ID. Used for shift-to-push/pull. */
    #lastClickHitPos: [number, number, number] | null = null
    #lastClickedId = 0
    #tabsElement: EventTarget | null = null
    #getActiveDocument: (() => string | undefined) | null = null
    #tabChangeSub: Subscription | null = null
    #resizeObserver: ResizeObserver | null = null
    #settings = SettingsManager.instance
    #lastRenderEndTime = 0
    #lastRenderedResolutionScale = 1.0
    #targetFPS = DEFAULT_TARGET_FPS
    #fullWidth = 0
    #fullHeight = 0
    #devicePixelRatio = 1
    #outlineMode: OutlineMode = DEFAULT_SELECTION_STYLES.outline.mode
    #outlineThickness: number = DEFAULT_SELECTION_STYLES.outline.thickness
    #outlineColor: [number, number, number] = [...DEFAULT_SELECTION_STYLES.outline.color]
    #selectionStyles: RenderSelectionStyles = {
        face: { darken: DEFAULT_SELECTION_STYLES.face.darken, tint: [...DEFAULT_SELECTION_STYLES.face.tint] },
        edge: { color: [...DEFAULT_SELECTION_STYLES.edge.color] },
    }
    #requestIdCounter = 0
    #latestBuildRequestId = 0
    #latestRenderMeshRequestId = 0
    #latestThumbnailRequestId = 0
    #latestAgentPreviewRequestId = 0
    #pendingTranspile = new Map<
        number,
        {
            kind: TranspileKind
            documentName?: string
            width?: number
            height?: number
            simplifyOnExport?: boolean
            exporter?: ExporterKind
            exporterTuning?: Partial<Record<ExporterKind, unknown>>
            simplifyTuning?: SimplifyTuning
            cameraState?: CameraState
            viewTransform?: Float32Array
            cameraPosition?: [number, number, number]
            viewCenter?: [number, number]
            isolatedIds?: number[]
            selectedObjectIds?: number[]
            deferredShading?: boolean
        }
    >()
    #pendingBuild = new Map<number, { resolve: (applied: boolean) => void; reject: (err: unknown) => void }>()
    /** Wall-time anchors for `build()` request ids (transpile → worker round-trip). */
    #buildChronicleByRequestId = new Map<
        number,
        { startWall: number; transpileCpuMs?: number; transpileEndWall?: number; workerPostWall?: number }
    >()
    /** Last successful worker `#doBuild` breakdown (when `buildComplete` included `timingMs`). */
    #lastBuildTimingMs: BuildTimingBreakdownMs | null = null
    /** Last successful end-to-end pipeline (transpile wall + worker round-trip + worker breakdown). */
    #lastSceneBuildPipelineMs: SceneBuildPipelineMs | null = null
    #pendingRenderMesh = new Map<
        number,
        { resolve: (v: MeshData) => void; reject: (err: unknown) => void; skipDocumentGuard?: boolean }
    >()
    #pendingBenchmark = new Map<number, { resolve: (v: { totalTime: number; averageFrameTime: number; minFrameTime: number; maxFrameTime: number; framesPerSecond: number; frameTimes: number[] }) => void }>()
    #pendingThumbnail = new Map<
        number,
        { resolve: (v: ImageData) => void; reject: (err: unknown) => void; skipDocumentGuard?: boolean }
    >()
    #pendingPickPos = new Map<number, { resolve: (v: [number, number, number] | null) => void }>()
    #pendingPickObject = new Map<number, { clientX: number; clientY: number }>()
    #pickObjectRequestId = 0
    #sharedBuffer: SharedArrayBuffer | null = null
    #renderVersion = 0
    #useSharedMemory = false
    #renderPayload: Extract<MainToWorkerMessage, { type: "render" }> = this.#createRenderPayloadCache()
    #createRenderPayloadCache(): Extract<MainToWorkerMessage, { type: "render" }> {
        return {
            type: "render",
            cameraState: {} as Extract<MainToWorkerMessage, { type: "render" }>["cameraState"],
            viewTransform: new Float32Array(16),
            cameraPosition: [0, 0, 0],
            cameraRes: [1, 1],
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
                outlineColor: [0, 0, 0],
                selectionStyles: {
                    face: { darken: 0.9, tint: [0.15, 0.15, 0.15] },
                    edge: { color: [1, 1, 0] },
                },
                previewShading: { ...DEFAULT_PREVIEW_SHADING },
                previewNormalShading: false,
            },
            viewCenter: [0.5, 0.5],
            resolutionScale: 1.0,
        }
    }

    readonly selectionChange$ = new Subject<number[]>()
    readonly objectDoubleClick$ = new Subject<number>()
    /** Emits when hover changes: objectId and screen position. objectId 0 means no hover. */
    readonly hoverInfo$ = new Subject<{ objectId: number; screenPos: { x: number; y: number } }>()
    /** Emits when right-clicking on the preview: objectId and client position. */
    readonly contextMenu$ = new Subject<{ objectId: number; clientX: number; clientY: number }>()
    readonly pushPullComplete$ = new Subject<{ nodeId: number; vertices: [number, number][] }>()
    readonly capPullComplete$ = new Subject<{ nodeId: number; newH: number; newPosY: number }>()
    readonly pushPullExit$ = new Subject<void>()
    readonly previewSettingsLoaded$ = new Subject<void>()

    constructor(preview: PreviewWindow, tabsElement?: EventTarget | null, getInteractionRect?: () => DOMRect, getActiveDocument?: () => string | undefined) {
        this.#preview = preview
        this.#controls = new CameraController(preview, vec3(0, 0, 0), DOLLY_REF, 0, Math.PI / 2, tabsElement ?? null, getInteractionRect ?? undefined)
        this.#tabsElement = tabsElement ?? null
        this.#getInteractionRect = getInteractionRect ?? null
        this.#getActiveDocument = getActiveDocument ?? null

        this.#readyPromise = new Promise<void>((resolve, reject) => {
            this.#readyResolve = resolve
            this.#readyReject = reject
        })

        const workerUrl = new URL("./render-worker.js", import.meta.url)
        this.#worker = new Worker(workerUrl, { type: "module" })
        this.#worker.onmessage = (e: MessageEvent<WorkerToMainMessage>) => this.#handleWorkerMessage(e.data)

        const transpileWorkerUrl = new URL("./transpile-worker.js", import.meta.url)
        this.#transpileWorker = new Worker(transpileWorkerUrl, { type: "module" })
        this.#transpileWorker.onmessage = (e: MessageEvent<TranspileToMainMessage>) => this.#handleTranspileMessage(e.data)

        this.#controlSubs.push(
            this.#controls.select$.subscribe(({ screenPos, shiftKey, altKey }) => {
                const uv = this.#screenToClickUV(screenPos.x, screenPos.y)
                if (uv) this.#worker.postMessage({ type: "click", clickUV: uv, shiftKey, altKey, documentName: this.#getActiveDocument?.() ?? undefined })
            }),
            this.#controls.doubleClick$.subscribe(({ screenPos, metaKey, ctrlKey }) => {
                if (metaKey || ctrlKey) {
                    // Cmd/Ctrl+double-click: set orbit pivot to pick hit (world xyz)
                    this.pickPosAtScreen(screenPos.x, screenPos.y).then(pos => {
                        if (pos) this.#controls.setPivotToWorldHit(vec3(pos[0], pos[1], pos[2]))
                    })
                    return
                }
                // Double-click selects the whole object + focuses it in the editor —
                // only meaningful for object/auto selection. In face/edge/corner/seam
                // modes a double-click shouldn't hijack the editor or swap the object
                // selection out from under the active feature mode.
                if (this.#selectionMode !== "object" && this.#selectionMode !== "auto") return
                const uv = this.#screenToClickUV(screenPos.x, screenPos.y)
                if (uv) this.#worker.postMessage({ type: "doubleClick", clickUV: uv, documentName: this.#getActiveDocument?.() ?? undefined })
            }),
            this.#controls.hover$.pipe(throttleTime(80)).subscribe(({ screenPos, altKey }) => {
                this.#lastHoverScreenPos = { x: screenPos.x, y: screenPos.y }
                this.#lastHoverAltKey = altKey
                if (this.#controls.isActivelyMoving) return
                const uv = this.#screenToClickUV(screenPos.x, screenPos.y)
                if (uv) {
                    const id = ++this.#hoverRequestId
                    this.#latestHoverRequestId = id
                    this.#worker.postMessage({ type: "hover", clickUV: uv, altKey, documentName: this.#getActiveDocument?.() ?? undefined, hoverRequestId: id })
                }
            }),
            this.#controls.change$.subscribe(() => {
                this.#needsRender = true
                this.#updatePivotCursor()
            })
        )

        this.#resizeObserver = new ResizeObserver(entries => {
            requestAnimationFrame(() => {
                for (const entry of entries) {
                    const w = Math.max(1,
                        entry.devicePixelContentBoxSize?.[0].inlineSize ??
                        Math.round(entry.contentRect.width * devicePixelRatio))
                    const h = Math.max(1,
                        entry.devicePixelContentBoxSize?.[0].blockSize ??
                        Math.round(entry.contentRect.height * devicePixelRatio))
                    this.#fullWidth = w
                    this.#fullHeight = h
                    this.#devicePixelRatio = devicePixelRatio
                    this.#worker.postMessage({ type: "resize", fullWidth: w, fullHeight: h, devicePixelRatio })
                    this.#needsRender = true
                    this.#updatePivotCursor()
                }
            })
        })
        try {
            this.#resizeObserver.observe(preview, { box: "device-pixel-content-box" })
        } catch {
            this.#resizeObserver.observe(preview, { box: "content-box" })
        }

        if (this.#tabsElement) {
            this.#tabChangeSub = fromEvent(this.#tabsElement, "activeTabChanged").subscribe(() => {
                this.#loadPreviewSettings()
            })
        }

        preview.canvas.addEventListener("contextmenu", (e: MouseEvent) => {
            e.preventDefault()
            const uv = this.#screenToClickUV(e.clientX, e.clientY)
            if (!uv) return
            const requestId = ++this.#pickObjectRequestId
            this.#worker.postMessage({ type: "pickObject", clickUV: uv, requestId })
            this.#pendingPickObject.set(requestId, { clientX: e.clientX, clientY: e.clientY })
        })

        this.#loadPreviewSettings()
    }

    #screenToClickUV(clientX: number, clientY: number): [number, number] | null {
        const rect = this.#preview.canvas.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return null
        if (this.#getInteractionRect) {
            const ir = this.#getInteractionRect()
            if (clientX < ir.left || clientX > ir.right || clientY < ir.top || clientY > ir.bottom) return null
        }
        const u = (clientX - rect.left) / rect.width
        const v = 1 - (clientY - rect.top) / rect.height
        return [u, v]
    }

    /** Query the 3D world-space position under the given screen coordinate. Returns null if no surface is hit. */
    pickPosAtScreen(clientX: number, clientY: number): Promise<[number, number, number] | null> {
        this.#syncCameraToWorkerForPick()
        const uv = this.#screenToClickUV(clientX, clientY)
        if (!uv) return Promise.resolve(null)
        const requestId = ++this.#requestIdCounter
        return new Promise(resolve => {
            this.#pendingPickPos.set(requestId, { resolve })
            this.#worker.postMessage({ type: "pickPos", clickUV: uv, requestId })
        })
    }

    #loadPreviewSettings(): void {
        const prev = this.#settings.getPreview()
        const global = this.#settings.getGlobal()
        this.#xrayMode = prev.xrayMode
        this.#previewNormalShading = prev.previewNormalShading
        this.#cameraOptimization = prev.cameraOptimization
        this.#beamEnabled = prev.beamOptimization
        this.#bvhEnabled = prev.bvhOptimization
        this.#featureGraphOcclusion = prev.featureGraphOcclusion
        this.#featureGraphLineWidth = prev.featureGraphLineWidth
        this.#featureGraphDifferentiateSegments = prev.featureGraphDifferentiateSegments
        this.#selectionMode = global.preview.selectionMode
        this.previewSettingsLoaded$.next()
        this.#needsRender = true
    }

    #handleWorkerMessage(msg: WorkerToMainMessage): void {
        switch (msg.type) {
            case "devLogLine":
                appendDevLogLine(msg.line, msg.module)
                break
            case "ready":
                this.#worker.postMessage({ type: "setBvhEnabled", enabled: this.#bvhEnabled })
                this.#worker.postMessage({
                    type: "setFeatureGraphOcclusionMode",
                    mode: this.#featureGraphOcclusion,
                })
                this.#worker.postMessage({
                    type: "setFeatureGraphLineWidth",
                    px: this.#featureGraphLineWidth,
                })
                this.#worker.postMessage({
                    type: "setFeatureGraphDifferentiateSegments",
                    on: this.#featureGraphDifferentiateSegments,
                })
                this.syncDebugLogModulesToWorker()
                this.#readyResolve()
                break
            case "initError":
                this.#readyReject(new Error(msg.error))
                break
            case "buildComplete": {
                const pending = msg.requestId != null ? this.#pendingBuild.get(msg.requestId) : null
                const rid = msg.requestId
                if (rid != null) {
                    if (msg.error) {
                        this.#buildChronicleByRequestId.delete(rid)
                    } else if (msg.timingMs) {
                        const ch = this.#buildChronicleByRequestId.get(rid)
                        this.#buildChronicleByRequestId.delete(rid)
                        const active = this.#getActiveDocument?.()
                        const stillActive = msg.documentName === undefined || msg.documentName === active
                        if (stillActive && ch?.workerPostWall != null) {
                            const transpileWallMs = roundScenePerfMs((ch.transpileEndWall ?? ch.workerPostWall) - ch.startWall)
                            const transpileCpuMs = roundScenePerfMs(ch.transpileCpuMs ?? 0)
                            const workerRoundTripMs = roundScenePerfMs(performance.now() - ch.workerPostWall)
                            this.#lastSceneBuildPipelineMs = {
                                transpileWallMs,
                                transpileCpuMs,
                                workerRoundTripMs,
                                worker: msg.timingMs,
                            }
                        }
                    } else {
                        this.#buildChronicleByRequestId.delete(rid)
                    }
                }
                if (msg.error) {
                    pending?.reject(new Error(msg.error))
                } else if (pending) {
                    if (!msg.superseded) {
                        const active = this.#getActiveDocument?.()
                        const stillActive = msg.documentName === undefined || msg.documentName === active
                        if (stillActive) {
                            this.#sceneNodeCache = this.#reconstructNodes(msg.sceneNodes)
                            this.#buildPushPullNodes(msg.sceneNodes)
                            this.#compiledPosY = new Map(msg.compiledPosY ?? [])
                            this.#controls.loadCameraFromSettings()
                            this.#needsRender = true
                            this.#lastBuildTimingMs = msg.timingMs ?? null
                        }
                    }
                    pending.resolve(!msg.superseded)
                }
                if (msg.requestId != null) this.#pendingBuild.delete(msg.requestId)
                break
            }
            case "clickResult": {
                if (msg.documentName !== undefined && msg.documentName !== this.#getActiveDocument?.()) return
                // Clicking a face that's currently highlighted (the normal
                // hover-then-click) reads back the FACE_HIGHLIGHT sentinel
                // (1023/1022), not the real node — resolve it like the hover path,
                // or the face-commit silently fails and the selection drops on the
                // next hover. Non-sentinel ids pass through unchanged.
                const clickedId = this.#resolveFaceSentinel(msg.clickedId)
                this.#lastClickHitPos = msg.hitPos ? [msg.hitPos[0], msg.hitPos[1], msg.hitPos[2]] : null
                this.#lastClickedId = clickedId
                this.#handleClickResult(clickedId, msg.edgeHits, msg.shiftKey, msg.altKey)
                break
            }
            case "selectionInfo":
                if (msg.documentName !== undefined && msg.documentName !== this.#getActiveDocument?.()) return
                if (msg.hoverRequestId !== undefined && msg.hoverRequestId !== this.#latestHoverRequestId) return
                // The GPU reports FACE_HIGHLIGHT_ID (1023/1022) for pixels on an
                // already-highlighted face. Left as-is it makes hover fight its own
                // highlight — the readback flips 6↔1023 every frame, tearing the
                // highlight down and back up (flicker) and flashing "Object 1023 (?)".
                // Resolve the sentinel back to the highlight's real owner.
                if (msg.info.hover) {
                    const raw = msg.info.hover.objectId
                    const resolved = this.#resolveFaceSentinel(raw)
                    if (resolved !== raw) {
                        if (resolved > 0) {
                            msg.info.hover.objectId = resolved
                            if (msg.info.objectNames[resolved] === undefined) {
                                msg.info.objectNames[resolved] = this.#getNode(resolved)?.getShapeType?.() ?? "?"
                            }
                        } else {
                            msg.info.hover = null
                        }
                    }
                }
                this.#hoveredObjectId = msg.info.hover?.objectId ?? 0
                this.#hoveredEdges = msg.info.hover?.edges?.map(e => ({
                    kind: e.kind,
                    primaryId: e.primaryId,
                    secondaryId: e.secondaryId,
                    featureA: e.featureA ?? 0,
                    opType: e.opType ?? 0,
                    lineWidthPx: 6.0,
                    epsilon: 0.02,
                    seedPoint: e.seedPoint,
                    seedTangent: e.seedTangent,
                    seedNormal: e.seedNormal,
                })) ?? []
                this.#preview.updateSelectionInfo(msg.info)
                this.#updateFaceHover(msg.info.hover ?? null)
                if (this.#lastHoverScreenPos) {
                    this.hoverInfo$.next({ objectId: this.#hoveredObjectId, screenPos: this.#lastHoverScreenPos })
                }
                this.#needsRender = true
                break
            case "objectDoubleClick":
                if (msg.documentName !== undefined && msg.documentName !== this.#getActiveDocument?.()) return
                this.objectDoubleClick$.next(msg.nodeId)
                break
            case "renderMeshResult": {
                const pending = msg.requestId != null ? this.#pendingRenderMesh.get(msg.requestId) : null
                if (pending) {
                    const active = this.#getActiveDocument?.()
                    const stillActive =
                        pending.skipDocumentGuard === true ||
                        msg.documentName === undefined ||
                        msg.documentName === active
                    if (!stillActive) {
                        pending.reject(new Error("Document changed"))
                    } else if (msg.mesh) {
                        pending.resolve(msg.mesh)
                    } else {
                        pending.reject(new Error(msg.error ?? "Unknown error"))
                    }
                }
                if (msg.requestId != null) this.#pendingRenderMesh.delete(msg.requestId)
                break
            }
            case "benchmarkResult": {
                const pending = msg.requestId != null ? this.#pendingBenchmark.get(msg.requestId) : null
                pending?.resolve(msg.result)
                if (msg.requestId != null) this.#pendingBenchmark.delete(msg.requestId)
                break
            }
            case "thumbnailResult": {
                const pending = msg.requestId != null ? this.#pendingThumbnail.get(msg.requestId) : null
                if (pending) {
                    const active = this.#getActiveDocument?.()
                    const stillActive =
                        pending.skipDocumentGuard === true ||
                        msg.documentName === undefined ||
                        msg.documentName === active
                    if (!stillActive) {
                        pending.reject(new Error("Document changed"))
                    } else if (msg.imageData) {
                        pending.resolve(msg.imageData)
                    } else {
                        pending.reject(new Error(msg.error ?? "Unknown error"))
                    }
                }
                if (msg.requestId != null) this.#pendingThumbnail.delete(msg.requestId)
                break
            }
            case "fps":
                if (!this.#useSharedMemory) this.#preview.updateFPS(msg.fps)
                break
            case "pickPosResult": {
                const pending = this.#pendingPickPos.get(msg.requestId)
                if (pending) {
                    pending.resolve(msg.hitPos)
                    this.#pendingPickPos.delete(msg.requestId)
                }
                break
            }
            case "pickObjectResult": {
                const pending = this.#pendingPickObject.get(msg.requestId)
                if (pending) {
                    this.contextMenu$.next({ objectId: msg.objectId, clientX: pending.clientX, clientY: pending.clientY })
                    this.#pendingPickObject.delete(msg.requestId)
                }
                break
            }
        }
    }

    #handleTranspileMessage(msg: TranspileToMainMessage): void {
        if (msg.type === "devLogLine") {
            appendDevLogLine(msg.line, msg.module)
            return
        }
        if (msg.type !== "transpileComplete") return
        const { body, error, requestId, transpileMs } = msg
        const pending = this.#pendingTranspile.get(requestId)
        this.#pendingTranspile.delete(requestId)
        if (!pending) return

        if (error) {
            if (pending.kind === "build") {
                this.#buildChronicleByRequestId.delete(requestId)
                this.#pendingBuild.get(requestId)?.reject(new Error(error))
                this.#pendingBuild.delete(requestId)
            } else if (pending.kind === "renderMesh") {
                this.#pendingRenderMesh.get(requestId)?.reject(new Error(error))
                this.#pendingRenderMesh.delete(requestId)
            } else if (pending.kind === "thumbnail") {
                this.#pendingThumbnail.get(requestId)?.reject(new Error(error))
                this.#pendingThumbnail.delete(requestId)
            } else if (pending.kind === "agentPreview") {
                this.#pendingThumbnail.get(requestId)?.reject(new Error(error))
                this.#pendingThumbnail.delete(requestId)
            }
            return
        }

        if (!body) {
            if (pending.kind === "build") this.#buildChronicleByRequestId.delete(requestId)
            return
        }

        if (pending.kind === "build") {
            if (requestId !== this.#latestBuildRequestId) {
                this.#buildChronicleByRequestId.delete(requestId)
                this.#pendingBuild.get(requestId)?.resolve(false)
                this.#pendingBuild.delete(requestId)
                return
            }
            const ch = this.#buildChronicleByRequestId.get(requestId)
            if (ch) {
                ch.transpileCpuMs = transpileMs ?? 0
                ch.transpileEndWall = performance.now()
            }
            this.#worker.postMessage({ type: "build", body, documentName: pending.documentName ?? undefined, requestId })
            const chPost = this.#buildChronicleByRequestId.get(requestId)
            if (chPost) chPost.workerPostWall = performance.now()
        } else if (pending.kind === "renderMesh") {
            if (requestId !== this.#latestRenderMeshRequestId) {
                this.#pendingRenderMesh.get(requestId)?.reject(new Error("Superseded"))
                this.#pendingRenderMesh.delete(requestId)
                return
            }
            this.#worker.postMessage({
                type: "renderMesh",
                body,
                requestId,
                documentName: pending.documentName,
                simplifyOnExport: pending.simplifyOnExport,
                exporter: pending.exporter,
                exporterTuning: pending.exporterTuning,
                simplifyTuning: pending.simplifyTuning,
            })
        } else if (pending.kind === "thumbnail") {
            if (requestId !== this.#latestThumbnailRequestId) {
                this.#pendingThumbnail.get(requestId)?.reject(new Error("Superseded"))
                this.#pendingThumbnail.delete(requestId)
                return
            }
            this.#worker.postMessage({ type: "thumbnail", body, width: pending.width, height: pending.height, requestId, documentName: pending.documentName })
        } else if (pending.kind === "agentPreview") {
            if (requestId !== this.#latestAgentPreviewRequestId) {
                this.#pendingThumbnail.get(requestId)?.reject(new Error("Superseded"))
                this.#pendingThumbnail.delete(requestId)
                return
            }
            const camState = pending.cameraState
            const vt = pending.viewTransform
            const cp = pending.cameraPosition
            const vc = pending.viewCenter
            const w = pending.width
            const h = pending.height
            if (!camState || !vt || !cp || !vc || w === undefined || h === undefined) {
                this.#pendingThumbnail.get(requestId)?.reject(new Error("Incomplete agent preview params"))
                this.#pendingThumbnail.delete(requestId)
                return
            }
            this.#worker.postMessage({
                type: "agentPreview",
                body,
                width: w,
                height: h,
                requestId,
                documentName: pending.documentName,
                cameraState: camState,
                viewTransform: vt,
                cameraPosition: cp,
                viewCenter: vc,
                isolatedIds: pending.isolatedIds ?? [],
                selectedObjectIds: pending.selectedObjectIds ?? [],
                deferredShading: pending.deferredShading,
            })
        }
    }

    #getNode(id: number): NodeStub | undefined {
        return this.#sceneNodeCache.find(n => n.id === id)
    }

    #getEffectiveMode(altKey: boolean): SelectionMode {
        if (altKey && this.#selectionMode === "object") return "seam"
        return this.#selectionMode
    }

    #edgeKey(h: { kind: number; primaryId: number; secondaryId: number; featureA: number; opType: number; seedPoint?: [number, number, number]; seedTangent?: [number, number, number] }): string {
        const seedKey = h.seedPoint ? `:${h.seedPoint[0].toFixed(3)},${h.seedPoint[1].toFixed(3)},${h.seedPoint[2].toFixed(3)}` : ""
        const tanKey = h.seedTangent ? `:t${h.seedTangent[0].toFixed(3)},${h.seedTangent[1].toFixed(3)},${h.seedTangent[2].toFixed(3)}` : ""
        return `${h.kind}:${h.primaryId}:${h.secondaryId}:${h.featureA}:${h.opType}${seedKey}${tanKey}`
    }

    #edgeFromHit(hit: EdgeHitData): SelectedEdgePayload {
        return {
            kind: hit.kind,
            primaryId: hit.primaryId,
            secondaryId: hit.secondaryId,
            featureA: hit.featureA,
            opType: hit.opType,
            lineWidthPx: DEFAULT_SELECTION_STYLES.edge.lineWidthPx,
            epsilon: DEFAULT_SELECTION_STYLES.edge.epsilon,
            seedPoint: hit.seedPoint,
            seedTangent: hit.seedTangent,
            seedNormal: hit.seedNormal,
        }
    }

    #handleClickResult(clickedId: number, edgeHits: EdgeHitData[], shiftKey: boolean, altKey: boolean): void {
        const effectiveMode = this.#getEffectiveMode(altKey)
        // Face mode = pure surface selection of an extrude SIDE or CAP, painted
        // with the selection cross-hatch (NOT push/pull dots, WITHOUT activating
        // push/pull). Edge/corner are handled in the worker via the FeatureGraph
        // hit-tester and never produce a `clickResult`. Auto also reaches here
        // only when the worker found NO edge/corner feature near the cursor — so
        // an auto `clickResult` means "select the face/surface under the cursor".
        if (effectiveMode === "face" || effectiveMode === "auto") {
            // A click supersedes the hover preview and commits (or clears) the face.
            this.#faceHoverActive = false
            if (clickedId !== 0 && this.#lastClickHitPos) {
                this.#faceClickCommitted = this.#tryHighlightPushPullFromSelection(true)
            } else {
                this.#faceClickCommitted = false
                this.#pushPullController?.deselect()
                this.#pushSelectionInfo()
            }
            this.#needsRender = true
            return
        }
        if (effectiveMode === "seam") {
            const edgeFilter = (h: EdgeHitData) => h.kind === EdgeKind.Seam
            const filtered = edgeHits.filter(edgeFilter)
            if (filtered.length > 0) {
                if (shiftKey) {
                    for (const hit of filtered) this.#addSelectedEdgeFromHit(hit)
                } else {
                    this.#setSelectedEdgesFromHits(filtered)
                }
                this.#selectedObjectIds.fill(false)
                this.#selectionDirty = true
                this.selectionChange$.next([])
                this.#pushSelectionInfo()
                this.#needsRender = true
                return
            }
        }

        this.#selectedEdges = []
        if (clickedId !== 0) {
            this.#updateSelection(clickedId, shiftKey)
        } else {
            this.#selectedObjectIds.fill(false)
            this.#lastClickedId = 0
            this.#lastClickHitPos = null
            this.#selectionDirty = true
            this.selectionChange$.next([])
        }
        this.#pushSelectionInfo()
        this.#needsRender = true
    }

    #setSelectedEdgesFromHits(hits: EdgeHitData[]): void {
        const seen = new Set<string>()
        this.#selectedEdges = []
        for (const hit of hits) {
            const key = this.#edgeKey(hit)
            if (seen.has(key)) continue
            seen.add(key)
            this.#selectedEdges.push(this.#edgeFromHit(hit))
        }
        if (this.#selectedEdges.length > 16) this.#selectedEdges = this.#selectedEdges.slice(0, 16)
        this.#needsRender = true
    }

    #addSelectedEdgeFromHit(hit: EdgeHitData): void {
        const key = this.#edgeKey(hit)
        if (this.#selectedEdges.some(e => this.#edgeKey(e) === key)) return
        this.#selectedEdges.push(this.#edgeFromHit(hit))
        if (this.#selectedEdges.length > 16) this.#selectedEdges = this.#selectedEdges.slice(-16)
        this.#needsRender = true
    }

    #updateSelection(clickedId: number, shiftKey: boolean): void {
        const wasSelected = this.#selectedObjectIds[clickedId] === true
        if (shiftKey) {
            this.#selectedObjectIds[clickedId] = !wasSelected
        } else {
            if (wasSelected && this.selectedObjectIds.length === 1) {
                this.#selectedObjectIds.fill(false)
            } else {
                this.#selectedObjectIds.fill(false)
                this.#selectedObjectIds[clickedId] = true
            }
        }
        this.#selectionDirty = true
        this.selectionChange$.next(this.selectedObjectIds)
    }

    #findCapParent(polygonId: number): { node: { id: number; pos: { x: number; y: number; z: number }; h: number; sceneCapParamsByteOffset: number }; isTop: boolean } | null {
        const vcap = this.#pushPullNodes.get(polygonId)
        if (vcap?.type === "virtualCap") {
            const node = this.#pushPullNodes.get(vcap.parentId)
            if (node && (node.type === "extrude" || node.type === "loft" || node.type === "threaded_rod")) return { node, isTop: vcap.isTop }
            return null
        }
        for (const [parentId, children] of this.#childrenByParent) {
            const idx = children.indexOf(polygonId)
            if (idx < 0) continue
            const node = this.#pushPullNodes.get(parentId)
            if (!node || (node.type !== "extrude" && node.type !== "loft")) continue
            if (node.type === "extrude") return { node, isTop: true }
            if (node.type === "loft") {
                if (idx === 0) return { node, isTop: true }
                if (idx === children.length - 1) return { node, isTop: false }
            }
        }
        return null
    }

    #handleObjectDoubleClick(nodeId: number, hitPos?: [number, number, number]): boolean {
        if (!this.#pushPullController || !hitPos) return false
        const node = this.#pushPullNodes.get(nodeId)
        if (!node) return false
        const hitVec = vec3(hitPos[0], hitPos[1], hitPos[2])
        if (node.type === "extrude") {
            // Twisted extrudes are supported: the controller un-twists the hit
            // into polygon (profile) space, so side-face selection + push/pull
            // work through the twist.
            this.#pushPullController.selectFace(node as unknown as Parameters<PushPullController["selectFace"]>[0], hitVec)
            this.#pushSelectionInfo()
            return true
        }
        if (node.type === "virtualCap" || node.type === "polygon2d") {
            const parent = this.#findCapParent(nodeId)
            if (parent) {
                const isTop = node.type === "virtualCap" ? node.isTop : (hitVec.y - parent.node.pos.y) >= 0
                this.#pushPullController.selectCapFace(parent.node as unknown as Parameters<PushPullController["selectCapFace"]>[0], isTop)
                this.#pushSelectionInfo()
                return true
            }
        }
        return false
    }

    /** Activate push/pull mode using the currently selected object + last click hit position. */
    #tryActivatePushPullFromSelection(): boolean {
        if (!this.#pushPullController || this.#pushPullController.isActive) return false
        const nodeId = this.#lastClickedId
        const hitPos = this.#lastClickHitPos
        if (!nodeId || !hitPos) return false
        return this.#handleObjectDoubleClick(nodeId, hitPos)
    }

    #cancelBuildsForPushPull(): void {
        this.#worker.postMessage({ type: "cancelBuilds" })
    }

    /**
     * Show face highlight (without activating drag) for the currently selected
     * object. Handles extrude SIDE faces and extrude/loft CAPS.
     *
     * `selectionOnly` = true marks it a pure surface selection (the "Face"
     * selection mode): the shader paints the selection cross-hatch instead of
     * the push/pull dot dither.
     */
    #tryHighlightPushPullFromSelection(selectionOnly = false): boolean {
        const ok = this.#highlightFaceAt(this.#lastClickedId, this.#lastClickHitPos, selectionOnly)
        if (ok) this.#pushSelectionInfo()
        return ok
    }

    /**
     * Highlight the extrude SIDE or extrude/loft CAP face under `hitPos` for the
     * given node, without activating push/pull. Pure uniform write + render (no
     * rebuild), so it's cheap enough to drive from hover. Returns false when the
     * node isn't a push/pull face host or push/pull is active. Shared by the
     * click-commit path ({@link #tryHighlightPushPullFromSelection}) and the
     * face-hover preview ({@link #updateFaceHover}).
     */
    #highlightFaceAt(nodeId: number, hitPos: [number, number, number] | null, selectionOnly: boolean): boolean {
        if (!this.#pushPullController || this.#pushPullController.isActive) return false
        if (!nodeId || !hitPos) return false
        const node = this.#pushPullNodes.get(nodeId)
        if (!node) return false
        const hitVec = vec3(hitPos[0], hitPos[1], hitPos[2])
        if (node.type === "extrude") {
            // Twisted extrudes supported — see #handleObjectDoubleClick.
            this.#pushPullController.highlightSideFace(node as unknown as Parameters<PushPullController["highlightSideFace"]>[0], hitVec, selectionOnly)
            return true
        }
        if (node.type === "virtualCap" || node.type === "polygon2d") {
            const parent = this.#findCapParent(nodeId)
            if (parent) {
                const isTop = node.type === "virtualCap" ? node.isTop : (hitVec.y - parent.node.pos.y) >= 0
                this.#pushPullController.highlightCapFace(parent.node as unknown as Parameters<PushPullController["highlightCapFace"]>[0], isTop, selectionOnly)
                return true
            }
        }
        return false
    }

    /**
     * Face-hover preview (Face / Auto modes): highlight the face under the cursor
     * as a transient preview that follows the pointer; on hover-out restore the
     * clicked face (if one is committed) or clear. No-op outside face/auto mode
     * or while push/pull is active. Reuses the same surface cross-hatch as the
     * committed selection.
     */
    /** Map the FACE_HIGHLIGHT sentinel (1023 side/top, 1022 bottom) — which the GPU
     *  returns for pixels on an already-highlighted face — back to the node that
     *  owns the current highlight (the hover preview's node, else the committed
     *  clicked node). Non-sentinel ids pass through unchanged. */
    #resolveFaceSentinel(rawId: number): number {
        if (rawId !== 1023 && rawId !== 1022) return rawId
        if (this.#faceHoverActive && this.#faceHoverNodeId > 0) return this.#faceHoverNodeId
        if (this.#faceClickCommitted && this.#lastClickedId > 0) return this.#lastClickedId
        return 0
    }

    #updateFaceHover(hover: HoverInfo | null): void {
        const mode = this.#getEffectiveMode(this.#lastHoverAltKey)
        const inFaceContext = (mode === "face" || mode === "auto") && !!this.#pushPullController && !this.#pushPullController.isActive
        if (!inFaceContext) {
            if (this.#faceHoverActive) {
                this.#faceHoverActive = false
                this.#faceHoverNodeId = 0
                this.#restoreCommittedFace()
                this.#needsRender = true
            }
            return
        }
        const objId = hover?.objectId ?? 0
        const hp = hover?.hitPos ?? null
        if (objId > 0 && hp && this.#highlightFaceAt(objId, hp, true)) {
            this.#faceHoverActive = true
            this.#faceHoverNodeId = objId
            this.#needsRender = true
        } else if (this.#faceHoverActive) {
            this.#faceHoverActive = false
            this.#faceHoverNodeId = 0
            this.#restoreCommittedFace()
            this.#needsRender = true
        }
    }

    /** Re-apply the clicked face highlight (if any) after a hover preview ends.
     *  Uses the quiet clear (not deselect()) so a transient hover-out doesn't
     *  fire pushPullExit$ (undo push / rebuild). */
    #restoreCommittedFace(): void {
        if (this.#faceClickCommitted && this.#highlightFaceAt(this.#lastClickedId, this.#lastClickHitPos, true)) {
            this.#pushSelectionInfo()
            return
        }
        this.#pushPullController?.clearFaceHighlight()
        this.#writeSelectionBuffer()
        this.#pushSelectionInfo()
    }

    #writeSelectionBuffer(): void {
        const selData = new Uint32Array(1024)
        selData.fill(0)
        for (const id of this.#getCompactSelectedIds()) {
            selData[id] = 1
        }
        this.#worker.postMessage({ type: "writeBuffers", selectedObjectIds: selData.buffer }, [selData.buffer])
    }

    /** Clear cached hover state and refresh UI when camera movement starts. */
    #clearHoverWhenMovingStarted(): void {
        this.#latestHoverRequestId = -1
        this.#hoveredObjectId = 0
        this.#hoveredEdges = []
        if (this.#lastHoverScreenPos) {
            this.hoverInfo$.next({ objectId: 0, screenPos: this.#lastHoverScreenPos })
        }
        this.#pushSelectionInfo()
        this.#needsRender = true
    }

    /**
     * Resolve a hovered object ID to the polygon2d node ID for source lookup.
     * Returns the polygon2d id when hovering over a polygon2d, extrude/loft cap, or extrude side; null otherwise.
     */
    resolvePolygon2dForHover(objectId: number): number | null {
        if (objectId <= 0) return null
        const node = this.#pushPullNodes.get(objectId)
        if (!node) return null
        if (node.type === "polygon2d") return objectId
        if (node.type === "virtualCap") {
            const parent = this.#pushPullNodes.get(node.parentId)
            if (parent?.type === "threaded_rod") return null
            const children = this.#childrenByParent.get(node.parentId)
            if (!children || children.length === 0) return null
            return children[0]
        }
        if (node.type === "extrude") {
            const children = this.#childrenByParent.get(objectId)
            if (!children || children.length === 0) return null
            return children[0]
        }
        return null
    }

    /**
     * IDs that count as "selected" for polygon context menu: the object itself, resolved polygon2d,
     * and parent extrude/loft (so right-click on cap works when extrude body was selected).
     */
    getPolygonContextMenuSelectionIds(objectId: number): number[] {
        const ids: number[] = []
        if (objectId <= 0) return ids
        ids.push(objectId)
        const polyId = this.resolvePolygon2dForHover(objectId)
        if (polyId != null) ids.push(polyId)
        const node = this.#pushPullNodes.get(objectId)
        if (node?.type === "virtualCap") ids.push(node.parentId)
        return ids
    }

    /** Issue one fresh hover query at the last cached position when camera movement stops. */
    #replayHoverWhenSettled(): void {
        const pos = this.#lastHoverScreenPos
        if (!pos) return
        const uv = this.#screenToClickUV(pos.x, pos.y)
        if (uv) {
            const id = ++this.#hoverRequestId
            this.#latestHoverRequestId = id
            this.#worker.postMessage({
                type: "hover",
                clickUV: uv,
                altKey: this.#lastHoverAltKey,
                documentName: this.#getActiveDocument?.() ?? undefined,
                hoverRequestId: id,
            })
        }
    }

    #pushSelectionInfo(): void {
        const rawObjects = this.selectedObjectIds
        const faceSel = this.#pushPullController?.getFaceSelection?.()
        const objects = faceSel
            ? rawObjects.filter(id => id !== 1023)
            : rawObjects
        const objectNames: Record<number, string> = {}
        for (const id of [...objects, this.#hoveredObjectId, faceSel?.nodeId].filter((id): id is number => id != null && id > 0)) {
            const node = this.#getNode(id)
            objectNames[id] = node?.getShapeType?.() ?? "?"
        }
        const edges = this.#selectedEdges.map(e => ({
            kind: e.kind,
            primaryId: e.primaryId,
            secondaryId: e.secondaryId,
            featureA: e.featureA,
            opType: e.opType,
        }))
        const face = faceSel ?? null
        const hover = this.#hoveredObjectId > 0
            ? { objectId: this.#hoveredObjectId, edges: this.#hoveredEdges.map(e => ({ kind: e.kind, primaryId: e.primaryId, secondaryId: e.secondaryId, featureA: e.featureA, opType: e.opType })) }
            : null
        this.#preview.updateSelectionInfo({ objects, objectNames, edges, face, hover })
    }

    #buildPushPullNodes(serialized: import("./render-worker-protocol.mjs").SerializedNode[]): void {
        this.#pushPullNodes.clear()
        this.#childrenByParent.clear()
        this.#parentById.clear()
        const polyById = new Map<number, { vertices: [number, number][]; bufferOffset: number }>()
        const byId = new Map(serialized.map(s => [s.id, s]))
        for (const s of serialized) {
            this.#childrenByParent.set(s.id, s.children)
            for (const cid of s.children) this.#parentById.set(cid, s.id)
            if (s.shapeType === "polygon2d" && s.vertices && s.bufferOffset !== undefined && s.bufferOffset >= 0) {
                const poly = {
                    vertices: s.vertices.map(v => [v[0], v[1]] as [number, number]),
                    bufferOffset: s.bufferOffset,
                }
                polyById.set(s.id, poly)
                this.#pushPullNodes.set(s.id, { type: "polygon2d", id: s.id, vertices: poly.vertices, bufferOffset: poly.bufferOffset })
            }
            if (s.isVirtualCap && s.capSide != null) {
                const parentId = s.parentId
                this.#pushPullNodes.set(s.id, { type: "virtualCap", id: s.id, parentId, isTop: s.capSide === "top" })
            }
        }
        for (const s of serialized) {
            if (s.shapeType === "extrude" && s.pos && s.children.length >= 1) {
                const polygonId = s.children[0]
                const poly = polyById.get(polygonId)
                if (poly) {
                    const child = { ...poly, id: polygonId }
                    let capTopId: number | undefined
                    let capBottomId: number | undefined
                    for (let i = 1; i < s.children.length; i++) {
                        const c = byId.get(s.children[i])
                        if (c?.isVirtualCap && c.capSide === "top") capTopId = s.children[i]
                        else if (c?.isVirtualCap && c.capSide === "bottom") capBottomId = s.children[i]
                    }
                    if (s.sceneCapParamsByteOffset === undefined) {
                        continue
                    }
                    this.#pushPullNodes.set(s.id, {
                        type: "extrude",
                        id: s.id,
                        pos: { x: s.pos[0], y: s.pos[1], z: s.pos[2] },
                        h: s.h ?? 1,
                        child,
                        twistDegrees: s.twistDegrees,
                        capTopId,
                        capBottomId,
                        sceneCapParamsByteOffset: s.sceneCapParamsByteOffset,
                    })
                }
            } else if (s.shapeType === "loft" && s.pos && s.children.length >= 2) {
                const profiles = s.children.map(cid => polyById.get(cid)).filter((p): p is { vertices: [number, number][]; bufferOffset: number } => p != null)
                if (profiles.length === s.children.length && s.sceneCapParamsByteOffset !== undefined) {
                    this.#pushPullNodes.set(s.id, {
                        type: "loft",
                        id: s.id,
                        pos: { x: s.pos[0], y: s.pos[1], z: s.pos[2] },
                        h: s.h ?? 1,
                        profiles,
                        sceneCapParamsByteOffset: s.sceneCapParamsByteOffset,
                    })
                }
            } else if (s.shapeType === "threaded_rod" && s.pos && s.h !== undefined && s.children.length >= 2) {
                let hasTop = false
                let hasBottom = false
                for (const cid of s.children) {
                    const c = byId.get(cid)
                    if (c?.isVirtualCap && c.capSide === "top") hasTop = true
                    if (c?.isVirtualCap && c.capSide === "bottom") hasBottom = true
                }
                if (hasTop && hasBottom && s.sceneCapParamsByteOffset !== undefined) {
                    this.#pushPullNodes.set(s.id, {
                        type: "threaded_rod",
                        id: s.id,
                        pos: { x: s.pos[0], y: s.pos[1], z: s.pos[2] },
                        h: s.h,
                        sceneCapParamsByteOffset: s.sceneCapParamsByteOffset,
                    })
                }
            }
        }
    }

    #reconstructNodes(serialized: import("./render-worker-protocol.mjs").SerializedNode[]): NodeStub[] {
        const byId = new Map<number, NodeStub>()
        const result: NodeStub[] = []
        for (const s of serialized) {
            const stub: NodeStub = {
                id: s.id,
                shapeType: s.shapeType,
                getShapeType: () => s.shapeType,
                getIndicatorSvg: s.indicatorSvg ? () => s.indicatorSvg! : undefined,
                pos: s.pos ? { x: s.pos[0], y: s.pos[1], z: s.pos[2] } : undefined,
                size: s.size ? { x: s.size[0], y: s.size[1], z: s.size[2] } : undefined,
                r: s.r,
                h: s.h,
                sr: s.sr,
                lr: s.lr,
                c: s.c,
                normal: s.normal ? { x: s.normal[0], y: s.normal[1], z: s.normal[2] } : undefined,
                planeOffset: s.planeOffset,
                vertices: s.vertices,
                twistDegrees: s.twistDegrees,
                turnPitch: s.turnPitch,
                threadAmp: s.threadAmp,
                threadFlankAngleDeg: s.threadFlankAngleDeg,
                threadProfile: s.threadProfile,
                handedness: s.handedness,
                filletTop: s.filletTop,
                filletBottom: s.filletBottom,
                chamferTop: s.chamferTop,
                chamferBottom: s.chamferBottom,
                femalePlay: s.femalePlay,
            }
            stub.getAllDescendantIds = () => [
                s.id,
                ...s.children.flatMap(cid => byId.get(cid)?.getAllDescendantIds?.() ?? [cid]),
            ]
            byId.set(s.id, stub)
            result.push(stub)
        }
        return result
    }

    async ready(): Promise<void> {
        const canvas = this.#preview.canvas
        if (this.#fullWidth <= 0 || this.#fullHeight <= 0) {
            const rect = this.#preview.getBoundingClientRect()
            const dpr = devicePixelRatio || 1
            this.#fullWidth = Math.max(1, Math.round(rect.width * dpr))
            this.#fullHeight = Math.max(1, Math.round(rect.height * dpr))
            canvas.width = this.#fullWidth
            canvas.height = this.#fullHeight
        } else {
            canvas.width = this.#fullWidth
            canvas.height = this.#fullHeight
        }
        const offscreen = canvas.transferControlToOffscreen()
        this.#useSharedMemory = isSharedMemoryAvailable()
        log("Sdf").info("useSharedMemory", this.#useSharedMemory)
        if (this.#useSharedMemory) {
            this.#sharedBuffer = new SharedArrayBuffer(SHARED_RENDER_BUFFER_SIZE)
            initSharedRenderBuffer(this.#sharedBuffer)
        }
        this.#worker.postMessage(
            { type: "init", canvas: offscreen, sharedBuffer: this.#sharedBuffer ?? undefined },
            [offscreen]
        )
        this.#worker.postMessage({ type: "resize", fullWidth: this.#fullWidth, fullHeight: this.#fullHeight, devicePixelRatio: this.#devicePixelRatio })
        await this.#readyPromise
        this.#initPushPull()
    }

    /** Push current debug-log flags to the render worker (call after settings change). */
    syncDebugLogModulesToWorker(): void {
        const mods = this.#settings.getDebugLogModules()
        this.#worker.postMessage({ type: "setDebugLogModules", modules: snapshotDebugLogModules(mods) })
    }

    #initPushPull(): void {
        const self = this
        this.#pushPullController = new PushPullController({
            writeBuffers(opts) {
                const transfer: ArrayBuffer[] = []
                if (opts.faceSelection) transfer.push(opts.faceSelection)
                if (opts.polygonVertices) transfer.push(opts.polygonVertices.data)
                if (opts.previewParamsF32Patch) transfer.push(opts.previewParamsF32Patch.data)
                if (opts.selectedObjectIds) {
                    transfer.push(opts.selectedObjectIds instanceof ArrayBuffer ? opts.selectedObjectIds : opts.selectedObjectIds.data)
                }
                self.#worker.postMessage({ type: "writeBuffers", ...opts }, transfer)
            },
            getCompiledPosY(nodeId: number) {
                return self.#compiledPosY.get(nodeId) ?? 0
            },
            hasCompiledPosY(nodeId: number) {
                return self.#compiledPosY.has(nodeId)
            },
            requestRender() {
                self.#needsRender = true
            },
            get canvas() {
                return self.#preview.canvas
            },
            get controls() {
                return self.#controls
            },
            get viewCenter() {
                return self.#viewCenter
            },
            get cameraRes() {
                return vec2(self.#fullWidth, self.#fullHeight)
            },
        })
        this.#pushPullController.onComplete = (nodeId, vertices) => {
            this.pushPullComplete$.next({ nodeId, vertices })
        }
        this.#pushPullController.onCapComplete = (nodeId, newH, newPosY) => {
            this.capPullComplete$.next({ nodeId, newH, newPosY })
        }
        this.#pushPullController.onDeselect = () => {
            self.#writeSelectionBuffer()
            self.#pushSelectionInfo()
            self.#needsRender = true
            self.pushPullExit$.next()
        }
        const canvas = this.#preview.canvas
        canvas.addEventListener("click", (e: MouseEvent) => {
            // Swallow the click during an active push/pull drag, or a shift+click
            // that promotes a selected face to push/pull — but let plain clicks
            // through so face/object selection works normally.
            if (
                this.#pushPullController?.isActive ||
                (e.shiftKey && this.#pushPullController?.getFaceSelection?.() != null)
            ) {
                e.stopImmediatePropagation()
            }
        }, { capture: true })
        canvas.addEventListener("pointerdown", (e: PointerEvent) => {
            // Push/pull is a FACE / AUTO-mode workflow (object mode never
            // push/pulls). Shift + drag a selected face → push/pull it.
            const ppMode = this.#selectionMode === "face" || this.#selectionMode === "auto"
            if (e.shiftKey && ppMode && this.#pushPullController && !this.#pushPullController.isActive) {
                let activated = false
                if (this.#pushPullController.getFaceSelection() !== null) {
                    // Promote the existing (cross-hatch) face selection to push/pull.
                    activated = this.#pushPullController.promoteToActive()
                } else {
                    activated = this.#tryActivatePushPullFromSelection()
                }
                if (activated) this.#cancelBuildsForPushPull()
                this.#pushSelectionInfo()
            }
            if (this.#pushPullController?.isActive && !this.#pushPullController.isDragging) {
                if (this.#pushPullController.handlePointerDown(e)) {
                    e.preventDefault()
                    e.stopPropagation()
                }
            }
        }, { capture: true })
        canvas.addEventListener("pointermove", (e: PointerEvent) => {
            if (this.#pushPullController?.isDragging) {
                if (this.#pushPullController.handlePointerMove(e)) {
                    e.preventDefault()
                    e.stopPropagation()
                }
            }
        }, { capture: true })
        canvas.addEventListener("pointerup", (e: PointerEvent) => {
            if (this.#pushPullController?.isDragging) {
                if (this.#pushPullController.handlePointerUp(e)) {
                    e.preventDefault()
                    e.stopPropagation()
                }
            }
        }, { capture: true })
        document.addEventListener("keydown", (e: KeyboardEvent) => {
            // Escape/etc. while a push/pull drag is active.
            if (this.#pushPullController?.isActive) {
                this.#pushPullController.handleKeyDown(e)
            }
        })
        document.addEventListener("keyup", (e: KeyboardEvent) => {
            // Releasing shift ends an armed-but-not-yet-dragging push/pull and
            // reverts to the plain (cross-hatch) face selection. An in-progress
            // drag finishes on pointerup. Push/pull lives only in face/auto modes.
            if (e.key !== "Shift" || !this.#pushPullController) return
            const ppMode = this.#selectionMode === "face" || this.#selectionMode === "auto"
            if (ppMode && this.#pushPullController.isActive && !this.#pushPullController.isDragging) {
                this.#pushPullController.dropToHighlight()
                this.#pushSelectionInfo()
                this.#needsRender = true
            }
        })
    }

    get isPushPullActive(): boolean {
        return this.#pushPullController?.getFaceSelection() !== null
    }

    get controls(): CameraController {
        return this.#controls
    }

    resetCamera(): void {
        this.#controls.resetView()
    }

    setViewFront(): void {
        this.#controls.setViewFront()
    }
    setViewBack(): void {
        this.#controls.setViewBack()
    }
    setViewRight(): void {
        this.#controls.setViewRight()
    }
    setViewLeft(): void {
        this.#controls.setViewLeft()
    }
    setViewTop(): void {
        this.#controls.setViewTop()
    }
    setViewBottom(): void {
        this.#controls.setViewBottom()
    }

    /** Current render resolution (device-pixel-scaled). Used for benchmark viewport. */
    get renderSize(): { width: number; height: number } {
        return { width: this.#fullWidth || 800, height: this.#fullHeight || 600 }
    }

    /** Last scale applied to interactive preview (1 or 0.5 when camera half-res is active during motion). */
    get lastRenderedResolutionScale(): number {
        return this.#lastRenderedResolutionScale
    }

    /** Optical center in [0,1] UV space (matches preview / mesh viewer). */
    get viewCenter(): Vec2f {
        return this.#viewCenter
    }

    #getCompactSelectedIds(): number[] {
        if (!this.#selectionDirty) return this.#cachedSelectedIds
        this.#cachedSelectedIds.length = 0
        for (let i = 0; i < this.#selectedObjectIds.length; i++) {
            if (this.#selectedObjectIds[i]) this.#cachedSelectedIds.push(i)
        }
        this.#selectionDirty = false
        return this.#cachedSelectedIds
    }

    get selectedObjectIds(): number[] {
        return [...this.#getCompactSelectedIds()]
    }

    /**
     * Given leaf node IDs from a CSG operator selection (union, subtract, etc.),
     * find the root (smallest ancestor containing all) and return its full descendant tree.
     * This allows primary (solid) vs child (dashed) highlighting for all operators.
     */
    getSelectionIdsWithRoot(leafIds: number[]): number[] {
        if (leafIds.length === 0) return []
        const nodeById = new Map(this.#sceneNodeCache.map(n => [n.id, n]))
        const leafSet = new Set(leafIds)
        let candidate: number | undefined = this.#parentById.get(leafIds[0])
        while (candidate !== undefined) {
            const node = nodeById.get(candidate)
            const descendants = node?.getAllDescendantIds?.() ?? [candidate]
            if (leafIds.every(id => descendants.includes(id))) {
                return descendants
            }
            candidate = this.#parentById.get(candidate)
        }
        return leafIds
    }

    /**
     * Split selected IDs into primary (no selected ancestor) and children (have selected ancestor).
     * Used for Monaco editor highlighting: primary gets solid border, children get dashed.
     * Resolves virtual caps (extrude top/bottom) to their polygon2d so the profile is highlighted.
     */
    getSelectionPrimaryAndChildIds(): { primary: number[]; children: number[] } {
        const rawIds = this.#getCompactSelectedIds()
        const ids = new Set<number>()
        for (const id of rawIds) {
            const node = this.#pushPullNodes.get(id)
            const resolved = node?.type === "virtualCap" ? this.resolvePolygon2dForHover(id) : null
            ids.add(resolved ?? id)
        }
        const selectedSet = new Set(ids)
        const primary: number[] = []
        const children: number[] = []
        for (const id of ids) {
            let pid: number | undefined = id
            let hasSelectedAncestor = false
            while ((pid = this.#parentById.get(pid)) !== undefined) {
                if (selectedSet.has(pid)) {
                    hasSelectedAncestor = true
                    break
                }
            }
            if (hasSelectedAncestor) children.push(id)
            else primary.push(id)
        }
        return { primary, children }
    }

    setSelection(ids: number[], notify = false): void {
        this.#selectedObjectIds.fill(false)
        for (const id of ids) {
            this.#selectedObjectIds[id] = true
        }
        this.#selectedEdges = []
        this.#selectionDirty = true
        if (notify) this.selectionChange$.next(this.selectedObjectIds)
        this.#pushSelectionInfo()
        this.#needsRender = true
    }

    getSceneNodes(): NodeStub[] {
        return this.#sceneNodeCache
    }

    setViewCenter(x: number, y: number, editorOffsetPx?: number): void {
        this.#viewCenter = vec2(x, y)
        this.#controls.setViewCenter(x, y)
        this.#preview.setSelectionInfoLeft(editorOffsetPx ?? 0)
        this.#needsRender = true
        this.#updatePivotCursor()
    }

    /**
     * Project the camera-controller's world-space pivot into CSS pixel
     * coordinates of the canvas and update the DOM cursor overlay. Replaces
     * the per-pixel WGSL pivot-cursor blend (see `preview.wgsl` history)
     * with a much cheaper main-thread DOM positioning.
     *
     * Called on every camera change ({@link CameraController.change$}), on
     * `setViewCenter`, and on canvas resize. Cheap — one mat4 inverse + a
     * handful of FMAs + a CSS `transform` write per call, no per-frame work
     * when the camera is idle.
     */
    #updatePivotCursor(): void {
        const canvas = this.#preview.canvas
        const cssW = canvas.clientWidth
        const cssH = canvas.clientHeight
        if (cssW <= 0 || cssH <= 0) {
            this.#preview.setPivotCursor(0, 0, false)
            return
        }
        const cam = this.#controls
        const pv = cam.state.pivot
        if (!pv) {
            this.#preview.setPivotCursor(0, 0, false)
            return
        }
        // Mirrors the projection the WGSL camera uniform used to carry —
        // see the deleted block in `render-worker-core.mts#uploadCameraIfDirty`.
        const invCam = new Mat4x4f(new Float32Array(cam.viewTransform.data)).inverse()
        const pCam = invCam.transformPoint(vec3(pv.x, pv.y, pv.z))
        const zoom = cam.zoom
        if (zoom <= 0) {
            this.#preview.setPivotCursor(0, 0, false)
            return
        }
        const aspectRt = cssW / cssH
        const uvAspX = ((pCam.x - cam.cameraPosition.x) / zoom) * 0.5 + 0.5
        const uvAspY = ((pCam.y - cam.cameraPosition.y) / zoom) * 0.5 + 0.5
        const uvPivotX = (uvAspX - 0.5) / aspectRt + this.#viewCenter.x
        const uvPivotY = uvAspY - 0.5 + this.#viewCenter.y
        const cssX = uvPivotX * cssW
        // UV Y is bottom-up (clip-space convention); CSS Y is top-down.
        const cssY = (1 - uvPivotY) * cssH
        // Generous off-screen margin — the cursor SVG is 32×32, so positions
        // up to 32 px outside still need a sliver visible.
        const visible = cssX >= -32 && cssX <= cssW + 32 && cssY >= -32 && cssY <= cssH + 32
        this.#preview.setPivotCursor(cssX, cssY, visible)
    }

    set xrayMode(enabled: boolean) {
        this.#xrayMode = enabled
        this.#settings.updatePreview("xrayMode", enabled)
        this.#needsRender = true
    }
    get xrayMode(): boolean {
        return this.#xrayMode
    }

    /**
     * Isolate-view target. 0 = off (full scene). Otherwise the scene node id whose
     * subtree should be rendered alone. The worker RECOMPILES the preview SDF from
     * the isolated subtree(s) as root (no DSL re-eval, no param re-upload) and
     * re-renders — so this posts a `setIsolatedIds` message rather than flagging a
     * render. Empty = full scene.
     */
    set isolatedIds(ids: number[]) {
        const next = [...ids]
        if (this.#isolatedIds.length === next.length && this.#isolatedIds.every((v, i) => v === next[i])) return
        this.#isolatedIds = next
        this.#worker.postMessage({ type: "setIsolatedIds", isolatedIds: next })
    }
    get isolatedIds(): number[] {
        return this.#isolatedIds
    }

    set beamEnabled(enabled: boolean) {
        this.#beamEnabled = enabled
        this.#settings.updatePreview("beamOptimization", enabled)
        this.#needsRender = true
    }
    get beamEnabled(): boolean {
        return this.#beamEnabled
    }

    get previewShading(): PreviewShadingParams {
        return { ...this.#previewShading }
    }

    /** Dev tools: tune SDF preview diffuse/specular/fresnel (not persisted). */
    setPreviewShading(params: PreviewShadingParams): void {
        this.#previewShading = { ...params }
        this.#needsRender = true
    }

    get rayMarchParams(): RayMarchParams {
        return { ...this.#rayMarchParams }
    }

    /** Dev tools: tune ray march quality constants (not persisted). */
    setRayMarchParams(params: RayMarchParams): void {
        this.#rayMarchParams = { ...params }
        this.#needsRender = true
    }

    get upscaleParams(): UpscaleParams {
        return { ...this.#upscaleParams }
    }

    /**
     * Dev tools: FSR1 spatial-upscale settings (render scale during motion +
     * upsample mode). Persistence lives in the dev-tools section snapshot (same
     * as ray-march params); not stored here.
     */
    setUpscaleParams(params: UpscaleParams): void {
        this.#upscaleParams = { ...params }
        this.#needsRender = true
    }

    get previewNormalShading(): boolean {
        return this.#previewNormalShading
    }

    set previewNormalShading(enabled: boolean) {
        if (this.#previewNormalShading === enabled) return
        this.#previewNormalShading = enabled
        this.#settings.updatePreview("previewNormalShading", enabled)
        this.#needsRender = true
    }

    set bvhEnabled(enabled: boolean) {
        if (this.#bvhEnabled === enabled) return
        this.#bvhEnabled = enabled
        this.#settings.updatePreview("bvhOptimization", enabled)
        // BVH is baked into the shader at compile time; caller must trigger a rebuild
        this.#worker.postMessage({ type: "setBvhEnabled", enabled })
    }
    get bvhEnabled(): boolean {
        return this.#bvhEnabled
    }

    set featureGraphOcclusion(mode: FeatureGraphOcclusionMode) {
        if (this.#featureGraphOcclusion === mode) return
        this.#featureGraphOcclusion = mode
        this.#settings.updatePreview("featureGraphOcclusion", mode)
        this.#worker.postMessage({ type: "setFeatureGraphOcclusionMode", mode })
        this.#needsRender = true
    }
    get featureGraphOcclusion(): FeatureGraphOcclusionMode {
        return this.#featureGraphOcclusion
    }

    set featureGraphLineWidth(px: number) {
        if (this.#featureGraphLineWidth === px) return
        this.#featureGraphLineWidth = px
        this.#settings.updatePreview("featureGraphLineWidth", px)
        this.#worker.postMessage({ type: "setFeatureGraphLineWidth", px })
        this.#needsRender = true
    }
    get featureGraphLineWidth(): number {
        return this.#featureGraphLineWidth
    }

    set featureGraphDifferentiateSegments(on: boolean) {
        if (this.#featureGraphDifferentiateSegments === on) return
        this.#featureGraphDifferentiateSegments = on
        this.#settings.updatePreview("featureGraphDifferentiateSegments", on)
        this.#worker.postMessage({ type: "setFeatureGraphDifferentiateSegments", on })
        this.#needsRender = true
    }
    get featureGraphDifferentiateSegments(): boolean {
        return this.#featureGraphDifferentiateSegments
    }

    /**
     * Per-pixel SDF step-count heatmap. Replaces the shaded preview output
     * with a coloured ramp keyed on cumulative `sceneSDF_fast` calls per
     * pixel — diagnostic complement to the per-pass GPU timestamp profiler.
     * Not persisted to settings (debug-only).
     */
    set stepHeatmapEnabled(enabled: boolean) {
        if (this.#stepHeatmapEnabled === enabled) return
        this.#stepHeatmapEnabled = enabled
        this.#worker.postMessage({ type: "setStepHeatmapEnabled", enabled })
        this.#needsRender = true
    }
    get stepHeatmapEnabled(): boolean {
        return this.#stepHeatmapEnabled
    }

    /**
     * Deferred selection shading: route the scene pass through geometryMain
     * (SDF → G-buffer) + shadeMain (G-buffer → frame) so selection/hover
     * repaints reuse the retained G-buffer and skip the SDF march. Off by
     * default; debug-only (not persisted).
     */
    set deferredShadingEnabled(enabled: boolean) {
        if (this.#deferredShadingEnabled === enabled) return
        this.#deferredShadingEnabled = enabled
        this.#worker.postMessage({ type: "setDeferredShading", enabled })
        this.#needsRender = true
    }
    get deferredShadingEnabled(): boolean {
        return this.#deferredShadingEnabled
    }

    setSelectionMode(mode: SelectionMode): void {
        this.#selectionMode = mode
        this.#settings.updateGlobal({ preview: { selectionMode: mode } })
        this.#selectedObjectIds.fill(false)
        this.#selectedEdges = []
        // Drop any face/cap surface selection and interactive FeatureGraph
        // (edge/corner/auto) selection + overlay highlight so each mode switch
        // starts clean.
        this.#pushPullController?.deselect()
        this.#worker.postMessage({ type: "clearFgSelection" })
        this.#selectionDirty = true
        this.selectionChange$.next([])
        this.#pushSelectionInfo()
        this.#needsRender = true
    }
    get selectionMode(): SelectionMode {
        return this.#selectionMode
    }

    set outlineMode(_mode: OutlineMode) {
        this.#outlineMode = _mode
        this.#needsRender = true
    }
    get outlineMode(): OutlineMode {
        return this.#outlineMode
    }

    set outlineThickness(px: number) {
        // Capped at 4 to match the shader-side ceiling in outline.wgsl.
        // The outline pass scans (2t+1)² neighbour ID loads per pixel, so a
        // thickness of 8 cost 4× more per-pixel work than the new max of 4.
        this.#outlineThickness = Math.max(1, Math.min(4, Math.round(px)))
        this.#needsRender = true
    }
    get outlineThickness(): number {
        return this.#outlineThickness
    }

    set outlineColor(rgb: [number, number, number]) {
        this.#outlineColor = [rgb[0], rgb[1], rgb[2]]
        this.#needsRender = true
    }
    get outlineColor(): [number, number, number] {
        return [...this.#outlineColor]
    }

    /** Update the shape color palette on the GPU. Call when theme changes. */
    setShapePalette(palette: Vec3f[]): void {
        const paletteData = paletteToFloat32Array(palette)
        const alignedData = new Float32Array(PALETTE_SIZE * 4)
        for (let i = 0; i < PALETTE_SIZE; i++) {
            alignedData[i * 4] = paletteData[i * 3]
            alignedData[i * 4 + 1] = paletteData[i * 3 + 1]
            alignedData[i * 4 + 2] = paletteData[i * 3 + 2]
            alignedData[i * 4 + 3] = 0.0
        }
        this.#worker.postMessage({ type: "writeBuffers", colorPalette: alignedData.buffer }, [alignedData.buffer])
        this.#needsRender = true
    }

    /** Update selection styles (outline, face tint, edge color). Call when theme changes. */
    setSelectionStyles(styles: SelectionStyles): void {
        this.#outlineColor = [styles.outline.color[0], styles.outline.color[1], styles.outline.color[2]]
        this.#selectionStyles = {
            face: { darken: styles.face.darken, tint: [...styles.face.tint] },
            edge: { color: [...styles.edge.color] },
        }
        this.#needsRender = true
    }

    set cameraOptimization(enabled: boolean) {
        this.#cameraOptimization = enabled
        this.#settings.updatePreview("cameraOptimization", enabled)
        this.#needsRender = true
    }
    get cameraOptimization(): boolean {
        return this.#cameraOptimization
    }

    requestRender(): void {
        this.#needsRender = true
    }

    startLoop(): void {
        if (this.#started) return
        this.#started = true
        requestAnimationFrame((t: number) => this.#update(t))
    }

    stopLoop(): void {
        this.#started = false
    }

    #buildRenderPayload(
        resOverride?: [number, number],
        opts?: { forceFullResolution?: boolean }
    ): Extract<MainToWorkerMessage, { type: "render" }> {
        const cam = this.#controls
        const p = this.#renderPayload
        p.cameraState = cam.state
        p.viewTransform = new Float32Array(cam.viewTransform.data)
        p.cameraPosition[0] = cam.cameraPosition.x
        p.cameraPosition[1] = cam.cameraPosition.y
        p.cameraPosition[2] = cam.cameraPosition.z
        if (resOverride) {
            p.cameraRes[0] = resOverride[0]
            p.cameraRes[1] = resOverride[1]
        } else {
            p.cameraRes[0] = this.#fullWidth > 0 && this.#fullHeight > 0 ? this.#fullWidth : 1
            p.cameraRes[1] = this.#fullWidth > 0 && this.#fullHeight > 0 ? this.#fullHeight : 1
        }
        const faceSel = this.#pushPullController?.getFaceSelection?.()
        if (faceSel && faceSel.mode <= 3) {
            const children = this.#childrenByParent.get(faceSel.nodeId) ?? []
            const ids = this.#getCompactSelectedIds().filter(
                id => id !== this.#lastClickedId && !children.includes(id)
            )
            const highlightId = faceSel.mode === 3 ? 1022 : 1023
            if (!ids.includes(highlightId)) ids.push(highlightId)
            p.selectionState.selectedObjectIds = ids
        } else {
            p.selectionState.selectedObjectIds = this.#getCompactSelectedIds()
        }
        p.selectionState.selectedEdges = this.#selectedEdges
        p.selectionState.hoveredObjectId = this.#hoveredObjectId
        p.selectionState.hoveredEdges = this.#hoveredEdges
        p.viewSettings.xrayMode = this.#xrayMode
        p.viewSettings.beamEnabled = this.#beamEnabled
        // corner appended as 5 (not renumbered) to keep existing values stable
        // in the SAB 3-bit field and the preview shader.
        p.viewSettings.selectionMode = { object: 0, seam: 1, edge: 2, face: 3, auto: 4, corner: 5 }[this.#selectionMode]
        p.viewSettings.outlineMode = { none: 0, solid: 1, dashed: 2, dotted: 3 }[this.#outlineMode]
        p.viewSettings.outlineThickness = this.#outlineThickness
        p.viewSettings.outlineColor = this.#outlineColor
        p.viewSettings.selectionStyles = this.#selectionStyles
        p.viewSettings.previewShading = { ...this.#previewShading }
        p.viewSettings.previewNormalShading = this.#previewNormalShading
        p.viewSettings.rayMarchParams = { ...this.#rayMarchParams }
        p.viewSettings.upscaleParams = { ...this.#upscaleParams }
        p.viewCenter[0] = this.#viewCenter.x
        p.viewCenter[1] = this.#viewCenter.y
        const reduceRes =
            !opts?.forceFullResolution &&
            this.#cameraOptimization &&
            this.#controls.isActivelyMoving
        // The reduced-res factor is the dev-tools render-scale knob; the worker
        // then upscales it (FSR1 EASU, +FXAA, or browser-bilinear when mode "off").
        p.resolutionScale = reduceRes ? this.#upscaleParams.renderScale : 1.0
        // Quality reductions during active motion: ray-march cap, beam
        // pre-pass cap, and hit-refinement iterations. Independent of the
        // `cameraOptimization` (halfres) toggle — these are cheaper,
        // visually-subtler forms of motion optimisation that are useful
        // even when the user has halfres disabled. Still gated on
        // `forceFullResolution` so the pick-sync render hits the full
        // SDF quality.
        const reduceQualityForMotion = !opts?.forceFullResolution && this.#controls.isActivelyMoving
        if (reduceQualityForMotion) {
            p.viewSettings.rayMarchParams.maxSteps = this.#rayMarchParams.maxStepsMoving
            p.viewSettings.rayMarchParams.maxBeamSteps = this.#rayMarchParams.maxBeamStepsMoving
            p.viewSettings.rayMarchParams.hitRefineSteps = this.#rayMarchParams.hitRefineStepsMoving
        }
        return p
    }

    /** Publish current camera so worker ray picks match what the user sees (avoids stale last-frame camera). */
    #syncCameraToWorkerForPick(): void {
        if (this.#fullWidth <= 0 || this.#fullHeight <= 0) return
        const payload = this.#buildRenderPayload(undefined, { forceFullResolution: true })
        if (this.#useSharedMemory && this.#sharedBuffer) {
            this.#renderVersion++
            const nextSlot = (1 - getPublishedRenderSlot(this.#sharedBuffer)) as 0 | 1
            writeRenderPayloadSlot(this.#sharedBuffer, nextSlot, payload, this.#fullWidth, this.#fullHeight)
            publishRenderSlot(this.#sharedBuffer, nextSlot, this.#renderVersion)
        } else {
            this.#worker.postMessage(payload, [payload.viewTransform.buffer])
        }
    }

    #update(time: number): void {
        if (this.#started) requestAnimationFrame((t: number) => this.#update(t))
        // Re-render when camera stops moving so we transition from reduced-res to full-res
        const resolutionScale = this.#cameraOptimization && this.#controls.isActivelyMoving ? this.#upscaleParams.renderScale : 1.0
        if (resolutionScale !== this.#lastRenderedResolutionScale) this.#needsRender = true

        // Motion transition: clear hover when movement starts, defer replay until after settled frame is published
        const isMoving = this.#controls.isActivelyMoving
        const wasMoving = this.#wasActivelyMoving
        this.#wasActivelyMoving = isMoving
        if (wasMoving && !isMoving) {
            this.#shouldReplayHoverAfterRender = true
        } else if (!wasMoving && isMoving) {
            this.#clearHoverWhenMovingStarted()
        }

        if (!this.#needsRender) return
        if (this.#fullWidth <= 0 || this.#fullHeight <= 0) return
        // Throttle on main thread: worker is message-driven and has no loop; we cap render messages.
        const minFrameTime = 1000 / this.#targetFPS
        const timeSinceLastRender = time - this.#lastRenderEndTime
        if (this.#lastRenderEndTime > 0 && timeSinceLastRender < minFrameTime) return
        this.#needsRender = false
        this.#lastRenderEndTime = time
        const payload = this.#buildRenderPayload()
        this.#lastRenderedResolutionScale = payload.resolutionScale
        if (this.#useSharedMemory && this.#sharedBuffer) {
            this.#renderVersion++
            const nextSlot = (1 - getPublishedRenderSlot(this.#sharedBuffer)) as 0 | 1
            writeRenderPayloadSlot(
                this.#sharedBuffer,
                nextSlot,
                payload,
                this.#fullWidth > 0 && this.#fullHeight > 0 ? this.#fullWidth : 1,
                this.#fullWidth > 0 && this.#fullHeight > 0 ? this.#fullHeight : 1
            )
            publishRenderSlot(this.#sharedBuffer, nextSlot, this.#renderVersion)
            this.#worker.postMessage({ type: "renderKick", version: this.#renderVersion })
            this.#preview.updateFPS(readFps(this.#sharedBuffer))
        } else {
            this.#worker.postMessage(payload, [payload.viewTransform.buffer])
        }
        if (this.#shouldReplayHoverAfterRender) {
            this.#shouldReplayHoverAfterRender = false
            this.#replayHoverWhenSettled()
        }
    }

    build(src: string, documentName?: string | null): Promise<boolean> {
        const requestId = ++this.#requestIdCounter
        this.#latestBuildRequestId = requestId
        this.#buildChronicleByRequestId.set(requestId, { startWall: performance.now() })
        this.#pendingTranspile.set(requestId, { kind: "build", documentName: documentName ?? undefined })
        return new Promise<boolean>((resolve, reject) => {
            this.#pendingBuild.set(requestId, { resolve, reject })
            this.#transpileWorker.postMessage({ type: "transpile", src: src.trim(), requestId, kind: "build", documentName: documentName ?? undefined })
        })
    }

    /** Source for an empty/null scene: tiny invisible sphere, valid for rendering and interaction. */
    static readonly EMPTY_SCENE_SRC = "return sphere.radius(0.001)"

    /** Clear the preview by building a minimal empty scene (invisible sphere). */
    async clearScene(): Promise<void> {
        await this.build(SDFRenderer.EMPTY_SCENE_SRC)
    }

    async renderMesh(
        _src: string,
        documentName?: string,
        options?: {
            simplifyOnExport?: boolean
            exporter?: ExporterKind
            exporterTuning?: Partial<Record<ExporterKind, unknown>>
            simplifyTuning?: SimplifyTuning
            /** When true, `renderMeshResult` is not rejected if the active tab differs from `documentName` (agent automation). */
            agentAutomation?: boolean
        },
    ): Promise<MeshData> {
        const requestId = ++this.#requestIdCounter
        this.#latestRenderMeshRequestId = requestId
        const simplifyOnExport = options?.simplifyOnExport ?? false
        const exporter = options?.exporter
        const exporterTuning = options?.exporterTuning
        const simplifyTuning = options?.simplifyTuning
        this.#pendingTranspile.set(requestId, {
            kind: "renderMesh",
            documentName,
            simplifyOnExport,
            exporter,
            exporterTuning,
            simplifyTuning,
        })
        return new Promise<MeshData>((resolve, reject) => {
            this.#pendingRenderMesh.set(requestId, {
                resolve,
                reject,
                skipDocumentGuard: options?.agentAutomation === true,
            })
            this.#transpileWorker.postMessage({ type: "transpile", src: _src.trim(), requestId, kind: "renderMesh", documentName })
        })
    }

    async benchmark(frameCount = 3 * 60, waitForGPU = true): Promise<{ totalTime: number; averageFrameTime: number; minFrameTime: number; maxFrameTime: number; framesPerSecond: number; frameTimes: number[] }> {
        const requestId = ++this.#requestIdCounter
        const payload = this.#buildRenderPayload([this.#fullWidth || 800, this.#fullHeight || 600] as [number, number])
        this.#worker.postMessage(payload, [payload.viewTransform.buffer])
        return new Promise(resolve => {
            this.#pendingBenchmark.set(requestId, { resolve })
            this.#worker.postMessage({ type: "benchmark", frameCount, waitForGPU, requestId })
        })
    }

    /** Last worker `#doBuild` timing buckets from the most recent successful build for the active document. */
    getLastBuildTimingMs(): BuildTimingBreakdownMs | null {
        return this.#lastBuildTimingMs
    }

    /** Last transpile + worker round-trip + `#doBuild` breakdown for the active document's last applied build. */
    getLastSceneBuildPipelineMs(): SceneBuildPipelineMs | null {
        return this.#lastSceneBuildPipelineMs
    }

    /**
     * Run a structural build then a param-only build (same scene graph) and return worker-reported
     * `#doBuild` breakdowns. Use with `runBenchmarkSuite` steady-state FPS to separate CPU build from GPU render cost.
     */
    async benchmarkBuild(structuralSrc: string, paramOnlySrc: string): Promise<{
        structural: BuildTimingBreakdownMs | null
        paramOnly: BuildTimingBreakdownMs | null
    }> {
        await this.build(structuralSrc.trim())
        const structural = this.#lastBuildTimingMs
        await this.build(paramOnlySrc.trim())
        const paramOnly = this.#lastBuildTimingMs
        return { structural, paramOnly }
    }

    /** Mesh export options for welcome/recent thumbnails when drawing MDC debug / feature glyphs. */
    #thumbnailMeshExportOptions(): {
        simplifyOnExport?: boolean
        exporter?: ExporterKind
        exporterTuning?: Partial<Record<ExporterKind, unknown>>
        simplifyTuning?: SimplifyTuning
    } {
        const app = this.#settings.getGlobal().app
        const appDev = {
            ...DEFAULT_APP_DEVTOOLS_STATE,
            ...(app.devToolsSections[DEVTOOLS_SECTION_APP] ?? {}),
        }
        const simplifyRaw = appDev.meshSimplifyOnExport
        const simplifyOnExport = typeof simplifyRaw === "boolean" ? simplifyRaw : false
        return {
            simplifyOnExport,
            exporter: app.meshExporter,
            exporterTuning: app.exporterTuning,
            simplifyTuning: app.simplifyTuning,
        }
    }

    async thumbnail(src: string, width?: number, height?: number, documentName?: string): Promise<ImageData> {
        await this.#readyPromise
        const trimmed = src.trim()
        const w = width ?? 256
        const h = height ?? 256
        const key = await sha1Hash(trimmed)
        const mv = this.#settings.getGlobal().meshViewer
        const glyphOverlay =
            mv.mdcDebugPoints ||
            mv.featureGlyphs.line ||
            mv.featureGlyphs.corner ||
            mv.featureGlyphs.seam ||
            mv.featureGlyphs.ring
        const glyphTag = glyphOverlay
            ? `-g${+mv.mdcDebugPoints}${+mv.featureGlyphs.line}${+mv.featureGlyphs.corner}${+mv.featureGlyphs.seam}${+mv.featureGlyphs.ring}`
            : ""
        const cacheKey = `https://galacticad.local/thumbnail/${key}-${w}x${h}${glyphTag}`
        const cached = await this.#getCachedThumbnail(cacheKey)
        if (cached) return cached

        if (glyphOverlay) {
            try {
                const mesh = await this.renderMesh(trimmed, documentName, this.#thumbnailMeshExportOptions())
                const imageData = await captureMeshThumbnailImageData(mesh, w, h, {
                    mdcDebugPoints: mv.mdcDebugPoints,
                    featureGlyphs: {
                        line: mv.featureGlyphs.line,
                        corner: mv.featureGlyphs.corner,
                        seam: mv.featureGlyphs.seam,
                        ring: mv.featureGlyphs.ring,
                    },
                })
                await this.#setCachedThumbnail(cacheKey, imageData)
                return imageData
            } catch {
                log("Sdf").warn("Mesh thumbnail with glyph overlay failed; falling back to SDF raymarch thumbnail")
            }
        }

        const requestId = ++this.#requestIdCounter
        this.#latestThumbnailRequestId = requestId
        const docName = documentName ?? undefined
        this.#pendingTranspile.set(requestId, { kind: "thumbnail", documentName: docName, width: w, height: h })
        const imageData = await new Promise<ImageData>((resolve, reject) => {
            this.#pendingThumbnail.set(requestId, { resolve, reject })
            this.#transpileWorker.postMessage({ type: "transpile", src: trimmed, requestId, kind: "thumbnail", documentName: docName, width: w, height: h })
        })
        await this.#setCachedThumbnail(cacheKey, imageData)
        return imageData
    }

    /**
     * Off-screen SDF raymarch with **normal-vector RGB** shading and testcase camera (for agent automation).
     * Does not use the thumbnail cache. Max dimension 2048 (worker).
     */
    async agentPreviewPixels(
        src: string,
        camera: CameraSettings,
        viewCenter: [number, number],
        width = 1000,
        height = 1000,
        documentName?: string,
        isolatedIds: number[] = [],
        selectedObjectIds: number[] = [],
        deferredShading?: boolean,
    ): Promise<ImageData> {
        await this.#readyPromise
        const trimmed = src.trim()
        const params = computeAgentPreviewCameraParams(camera, width, height, viewCenter)
        try {
            const requestId = ++this.#requestIdCounter
            this.#latestAgentPreviewRequestId = requestId
            const docName = documentName ?? undefined
            this.#pendingTranspile.set(requestId, {
                kind: "agentPreview",
                documentName: docName,
                width: params.cameraRes[0],
                height: params.cameraRes[1],
                cameraState: params.cameraState,
                viewTransform: params.viewTransform,
                cameraPosition: params.cameraPosition,
                viewCenter: params.viewCenter,
                isolatedIds,
                selectedObjectIds,
                deferredShading,
            })
            return await new Promise<ImageData>((resolve, reject) => {
                this.#pendingThumbnail.set(requestId, { resolve, reject, skipDocumentGuard: true })
                this.#transpileWorker.postMessage({ type: "transpile", src: trimmed, requestId, kind: "agentPreview", documentName: docName })
            })
        } finally {
            params.dispose()
        }
    }

    /**
     * Screenshot the *currently displayed* SDF preview frame (already-built scene, live camera/view) as
     * pixels. Does NOT rebuild from source — the worker re-renders its last live frame into an offscreen
     * texture and reads it back, so the result matches what's on screen. Used by the agent screenshot bridge.
     */
    async capturePreviewImageData(): Promise<ImageData> {
        await this.#readyPromise
        if (this.#fullWidth <= 0 || this.#fullHeight <= 0) {
            throw new Error("preview not laid out yet")
        }
        // Snapshot the live camera/view at full resolution. Posting without a transfer list structured-
        // clones the payload, so the worker gets a consistent snapshot and the main render loop keeps its arrays.
        const payload = this.#buildRenderPayload(undefined, { forceFullResolution: true })
        const requestId = ++this.#requestIdCounter
        return await new Promise<ImageData>((resolve, reject) => {
            this.#pendingThumbnail.set(requestId, { resolve, reject, skipDocumentGuard: true })
            this.#worker.postMessage({ type: "capturePreviewFrame", requestId, payload })
        })
    }

    /** Mesh raster normal RGB (opaque), matching testcase camera; runs full CPU/GPU mesh extraction then capture. */
    async agentMeshPreviewPixels(
        src: string,
        camera: CameraSettings,
        viewCenter: [number, number],
        meshOptions: {
            simplifyOnExport?: boolean
            exporter?: ExporterKind
            exporterTuning?: Partial<Record<ExporterKind, unknown>>
            simplifyTuning?: SimplifyTuning
        },
        width = 1000,
        height = 1000,
        documentName?: string,
        overlay?: AgentMeshOverlay,
    ): Promise<ImageData> {
        const mesh = await this.renderMesh(src, documentName, { ...meshOptions, agentAutomation: true })
        // Agent SDF captures hard-code normal-vector shading (see worker
        // `handleAgentPreview`), so default the mesh capture to normals too — keeps
        // mesh/SDF agent renders comparable (e.g. `triangle`). An explicit
        // overlay.renderNormals (`--overlay renderNormals=false`) still wins for a lit capture.
        const effectiveOverlay: AgentMeshOverlay = {
            ...overlay,
            renderNormals: overlay?.renderNormals ?? true,
        }
        return captureAgentMeshImageData(mesh, camera, viewCenter, width, height, effectiveOverlay)
    }

    async #getCachedThumbnail(cacheKey: string): Promise<ImageData | null> {
        try {
            const cache = await caches.open("galacticad-thumbnails")
            const response = await cache.match(cacheKey)
            if (!response) return null
            const blob = await response.blob()
            const bitmap = await createImageBitmap(blob)
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
            const ctx = canvas.getContext("2d")!
            ctx.drawImage(bitmap, 0, 0)
            return ctx.getImageData(0, 0, bitmap.width, bitmap.height)
        } catch {
            return null
        }
    }

    async #setCachedThumbnail(cacheKey: string, imageData: ImageData): Promise<void> {
        try {
            const canvas = new OffscreenCanvas(imageData.width, imageData.height)
            const ctx = canvas.getContext("2d")!
            ctx.putImageData(imageData, 0, 0)
            const blob = await canvas.convertToBlob({ type: "image/png" })
            const cache = await caches.open("galacticad-thumbnails")
            await cache.put(cacheKey, new Response(blob, { headers: { "Content-Type": "image/png" } }))
        } catch {
            // Ignore cache write failures
        }
    }

    dispose(): void {
        for (const sub of this.#controlSubs) sub.unsubscribe()
        this.#controlSubs.length = 0
        this.#tabChangeSub?.unsubscribe()
        this.#resizeObserver?.disconnect()
        const err = new Error("Renderer disposed")
        for (const [, { reject }] of this.#pendingBuild) reject(err)
        this.#pendingBuild.clear()
        for (const [, { reject }] of this.#pendingRenderMesh) reject(err)
        this.#pendingRenderMesh.clear()
        for (const [, { reject }] of this.#pendingThumbnail) reject(err)
        this.#pendingThumbnail.clear()
        const emptyBenchmark = { totalTime: 0, averageFrameTime: 0, minFrameTime: 0, maxFrameTime: 0, framesPerSecond: 0, frameTimes: [] }
        for (const [, { resolve }] of this.#pendingBenchmark) resolve(emptyBenchmark)
        this.#pendingBenchmark.clear()
        this.#transpileWorker.terminate()
        this.#worker.terminate()
        this.#controls.dispose()
        this.selectionChange$.complete()
        this.objectDoubleClick$.complete()
        this.hoverInfo$.complete()
        this.contextMenu$.complete()
        this.pushPullComplete$.complete()
        this.capPullComplete$.complete()
        this.pushPullExit$.complete()
        this.previewSettingsLoaded$.complete()
    }
}
