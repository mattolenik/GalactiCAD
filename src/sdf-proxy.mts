/**
 * SDFRendererProxy - Main-thread proxy that delegates to the render worker.
 * Keeps DOM-dependent components (CameraController, PushPullController); worker owns GPU.
 */

import { Subject } from "rxjs"
import { fromEvent } from "rxjs"
import { throttleTime } from "rxjs"
import type { Subscription } from "rxjs"
import { SettingsManager } from "./storage/settings.mjs"
import { PreviewWindow } from "./components/preview-window.mjs"
import { CameraController } from "./controls/camera-controller.mjs"
import { vec2, vec3 } from "./vecmat/vector.mjs"
import { PushPullController } from "./interaction/push-pull.mjs"
import type { SelectionInfo } from "./components/preview-window.mjs"
import type { MeshData } from "./export/export.mjs"
import type { WorkerToMainMessage } from "./render-worker-protocol.mjs"
import { DEFAULT_SELECTION_STYLES } from "./selectionStyles.mjs"
import { EdgeKind } from "./edge-kind.mjs"
import type { SelectedEdgePayload } from "./render-worker-protocol.mjs"

export type SelectionMode = "object" | "seam" | "edge" | "face" | "auto"
export type OutlineMode = "none" | "solid" | "dashed" | "dotted"
export { EdgeKind } from "./edge-kind.mjs"

export type { SerializedNode } from "./render-worker-protocol.mjs"

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
}

export class SDFRenderer {
    #preview: PreviewWindow
    #controls: CameraController
    #worker: Worker
    #readyResolve!: () => void
    #readyReject!: (err: unknown) => void
    #readyPromise: Promise<void>
    #sceneNodeCache: NodeStub[] = []
    #selectedObjectIds: boolean[] = new Array(1024).fill(false)
    #selectedEdges: SelectedEdgePayload[] = []
    #hoveredObjectId = 0
    #hoveredEdges: SelectedEdgePayload[] = []
    #compiledPosY = new Map<number, number>()
    #getInteractionRect: (() => DOMRect) | null = null
    #pushPullNodes: Map<number, { type: "extrude"; id: number; pos: { x: number; y: number; z: number }; h: number; child: { vertices: [number, number][]; bufferOffset: number }; twistDegrees?: number } | { type: "loft"; id: number; pos: { x: number; y: number; z: number }; h: number; profiles: { vertices: [number, number][]; bufferOffset: number }[] } | { type: "polygon2d"; id: number; vertices: [number, number][]; bufferOffset: number }> = new Map()
    #childrenByParent = new Map<number, number[]>()
    #needsRender = true
    #started = false
    #xrayMode = false
    #beamEnabled = false
    #selectionMode: SelectionMode = "object"
    #cameraOptimization = true
    #viewCenter = vec2(0.5, 0.5)
    #controlSubs: Subscription[] = []
    #pushPullController: PushPullController | null = null
    #tabsElement: EventTarget | null = null
    #tabChangeSub: Subscription | null = null
    #tabCloseSub: Subscription | null = null
    #tabRenameSub: Subscription | null = null
    #resizeObserver: ResizeObserver | null = null
    #settings = SettingsManager.instance
    #lastRenderEndTime = 0
    #targetFPS = 120
    #fullWidth = 0
    #fullHeight = 0
    #devicePixelRatio = 1
    #outlineMode: OutlineMode = DEFAULT_SELECTION_STYLES.outline.mode
    #outlineThickness = DEFAULT_SELECTION_STYLES.outline.thickness
    #outlineColor: [number, number, number] = [...DEFAULT_SELECTION_STYLES.outline.color]
    #pendingBuildResolve: ((value: void) => void) | null = null
    #pendingRenderMeshResolve: ((value: MeshData) => void) | null = null
    #pendingRenderMeshReject: ((err: unknown) => void) | null = null
    #pendingBenchmarkResolve: ((value: { totalTime: number; averageFrameTime: number; minFrameTime: number; maxFrameTime: number; framesPerSecond: number; frameTimes: number[] }) => void) | null = null

    readonly selectionChange$ = new Subject<number[]>()
    readonly objectDoubleClick$ = new Subject<number>()
    readonly pushPullComplete$ = new Subject<{ nodeId: number; vertices: [number, number][] }>()
    readonly capPullComplete$ = new Subject<{ nodeId: number; newH: number; newPosY: number }>()
    readonly previewSettingsLoaded$ = new Subject<void>()

    constructor(preview: PreviewWindow, tabsElement?: EventTarget | null, getInteractionRect?: () => DOMRect) {
        this.#preview = preview
        this.#controls = new CameraController(preview, vec3(0, 0, 0), 50, 0, Math.PI / 2, tabsElement ?? null, getInteractionRect ?? undefined)
        this.#tabsElement = tabsElement ?? null
        this.#getInteractionRect = getInteractionRect ?? null

        this.#readyPromise = new Promise<void>((resolve, reject) => {
            this.#readyResolve = resolve
            this.#readyReject = reject
        })

        const workerUrl = new URL("./render-worker.js", import.meta.url)
        this.#worker = new Worker(workerUrl, { type: "module" })
        this.#worker.onmessage = (e: MessageEvent<WorkerToMainMessage>) => this.#handleWorkerMessage(e.data)

        this.#controlSubs.push(
            this.#controls.select$.subscribe(({ screenPos, shiftKey, altKey }) => {
                const uv = this.#screenToClickUV(screenPos.x, screenPos.y)
                if (uv) this.#worker.postMessage({ type: "click", clickUV: uv, shiftKey, altKey })
            }),
            this.#controls.doubleClick$.subscribe((screenPos) => {
                const uv = this.#screenToClickUV(screenPos.x, screenPos.y)
                if (uv) this.#worker.postMessage({ type: "doubleClick", clickUV: uv })
            }),
            this.#controls.hover$.pipe(throttleTime(80)).subscribe(({ screenPos, altKey }) => {
                const uv = this.#screenToClickUV(screenPos.x, screenPos.y)
                if (uv) this.#worker.postMessage({ type: "hover", clickUV: uv, altKey })
            }),
            this.#controls.change$.subscribe(() => {
                this.#needsRender = true
            })
        )

        this.#resizeObserver = new ResizeObserver(entries => {
            requestAnimationFrame(() => {
                for (const entry of entries) {
                    const w =
                        entry.devicePixelContentBoxSize?.[0].inlineSize ??
                        Math.max(1, Math.round(entry.contentRect.width * devicePixelRatio))
                    const h =
                        entry.devicePixelContentBoxSize?.[0].blockSize ??
                        Math.max(1, Math.round(entry.contentRect.height * devicePixelRatio))
                    this.#fullWidth = w
                    this.#fullHeight = h
                    this.#devicePixelRatio = devicePixelRatio
                    this.#worker.postMessage({ type: "resize", fullWidth: w, fullHeight: h, devicePixelRatio })
                    this.#needsRender = true
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

        this.#loadPreviewSettings()
    }

    #screenToClickUV(clientX: number, clientY: number): [number, number] | null {
        const rect = this.#preview.canvas.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return null
        const u = (clientX - rect.left) / rect.width
        const v = 1 - (clientY - rect.top) / rect.height
        return [u, v]
    }

    #loadPreviewSettings(): void {
        const prev = this.#settings.getPreview()
        const global = this.#settings.getGlobal()
        this.#xrayMode = prev.xrayMode
        this.#cameraOptimization = prev.cameraOptimization
        this.#beamEnabled = prev.beamOptimization
        this.#selectionMode = global.preview.selectionMode
        this.previewSettingsLoaded$.next()
        this.#needsRender = true
    }

    #handleWorkerMessage(msg: WorkerToMainMessage): void {
        switch (msg.type) {
            case "ready":
                this.#readyResolve()
                break
            case "initError":
                this.#readyReject(new Error(msg.error))
                break
            case "buildComplete":
                this.#sceneNodeCache = this.#reconstructNodes(msg.sceneNodes)
                this.#buildPushPullNodes(msg.sceneNodes)
                this.#compiledPosY = new Map(Object.entries(msg.compiledPosY ?? {}).map(([k, v]) => [parseInt(k, 10), v as number]))
                this.#pendingBuildResolve?.()
                this.#pendingBuildResolve = null
                break
            case "clickResult":
                this.#handleClickResult(msg.clickedId, msg.edgeHits, msg.hitPos, msg.clickedNormal, msg.shiftKey, msg.altKey)
                break
            case "selectionChanged":
                this.selectionChange$.next(msg.ids)
                break
            case "selectionInfo":
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
                this.#needsRender = true
                break
            case "objectDoubleClick":
                if (!this.#handleObjectDoubleClick(msg.nodeId, msg.hitPos)) {
                    this.objectDoubleClick$.next(msg.nodeId)
                }
                break
            case "pushPullComplete":
                this.pushPullComplete$.next({ nodeId: msg.nodeId, vertices: msg.vertices })
                break
            case "capPullComplete":
                this.capPullComplete$.next({ nodeId: msg.nodeId, newH: msg.newH, newPosY: msg.newPosY })
                break
            case "renderMeshResult":
                if (msg.mesh) {
                    this.#pendingRenderMeshResolve?.(msg.mesh)
                } else {
                    this.#pendingRenderMeshReject?.(new Error(msg.error ?? "Unknown error"))
                }
                this.#pendingRenderMeshResolve = null
                this.#pendingRenderMeshReject = null
                break
            case "benchmarkResult":
                this.#pendingBenchmarkResolve?.(msg.result)
                this.#pendingBenchmarkResolve = null
                break
        }
    }

    #getNode(id: number): NodeStub | undefined {
        return this.#sceneNodeCache.find(n => n.id === id)
    }

    #getEffectiveMode(altKey: boolean): SelectionMode {
        if (altKey && this.#selectionMode === "object") return "seam"
        return this.#selectionMode
    }

    #handleClickResult(
        clickedId: number,
        edgeHits: import("./render-worker-protocol.mjs").EdgeHitData[],
        _hitPos: [number, number, number, number],
        _clickedNormal: [number, number, number],
        shiftKey: boolean,
        altKey: boolean,
    ): void {
        const effectiveMode = this.#getEffectiveMode(altKey)

        if (effectiveMode === "seam") {
            const filtered = edgeHits.filter(h => h.kind === EdgeKind.Seam)
            if (filtered.length > 0) {
                if (shiftKey) {
                    for (const hit of filtered) this.#addSelectedEdgeFromHit(hit)
                } else {
                    this.#setSelectedEdgesFromHits(filtered)
                }
                this.#selectedObjectIds.fill(false)
                this.selectionChange$.next([])
                this.#pushSelectionInfo()
                this.#needsRender = true
                return
            }
        } else if (effectiveMode === "edge") {
            const filtered = edgeHits.filter(h => h.kind === EdgeKind.Primitive || h.kind === EdgeKind.SeamSegment)
            if (filtered.length > 0) {
                if (shiftKey) {
                    for (const hit of filtered) this.#addSelectedEdgeFromHit(hit)
                } else {
                    this.#setSelectedEdgesFromHits(filtered)
                }
                this.#selectedObjectIds.fill(false)
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
            this.selectionChange$.next([])
        }
        this.#pushSelectionInfo()
        this.#needsRender = true
    }

    #setSelectedEdgesFromHits(hits: import("./render-worker-protocol.mjs").EdgeHitData[]): void {
        const seen = new Set<string>()
        this.#selectedEdges = []
        for (const hit of hits) {
            const seedKey = hit.seedPoint ? `:${hit.seedPoint[0].toFixed(3)},${hit.seedPoint[1].toFixed(3)},${hit.seedPoint[2].toFixed(3)}` : ""
            const tanKey = hit.seedTangent ? `:t${hit.seedTangent[0].toFixed(3)},${hit.seedTangent[1].toFixed(3)},${hit.seedTangent[2].toFixed(3)}` : ""
            const key = `${hit.kind}:${hit.primaryId}:${hit.secondaryId}:${hit.featureA}:${hit.opType}${seedKey}${tanKey}`
            if (seen.has(key)) continue
            seen.add(key)
            this.#selectedEdges.push({
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
            })
        }
        if (this.#selectedEdges.length > 16) this.#selectedEdges = this.#selectedEdges.slice(0, 16)
        this.#needsRender = true
    }

    #addSelectedEdgeFromHit(hit: import("./render-worker-protocol.mjs").EdgeHitData): void {
        const edge: SelectedEdgePayload = {
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
        const seedKey = hit.seedPoint ? `:${hit.seedPoint[0].toFixed(3)},${hit.seedPoint[1].toFixed(3)},${hit.seedPoint[2].toFixed(3)}` : ""
        const tanKey = hit.seedTangent ? `:t${hit.seedTangent[0].toFixed(3)},${hit.seedTangent[1].toFixed(3)},${hit.seedTangent[2].toFixed(3)}` : ""
        const key = `${hit.kind}:${hit.primaryId}:${hit.secondaryId}:${hit.featureA}:${hit.opType}${seedKey}${tanKey}`
        if (this.#selectedEdges.some(e => {
            const eSeed = e.seedPoint ? `:${e.seedPoint[0].toFixed(3)},${e.seedPoint[1].toFixed(3)},${e.seedPoint[2].toFixed(3)}` : ""
            const eTan = e.seedTangent ? `:t${e.seedTangent[0].toFixed(3)},${e.seedTangent[1].toFixed(3)},${e.seedTangent[2].toFixed(3)}` : ""
            return `${e.kind}:${e.primaryId}:${e.secondaryId}:${e.featureA}:${e.opType}${eSeed}${eTan}` === key
        })) return
        this.#selectedEdges.push(edge)
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
        this.#worker.postMessage({ type: "setSelection", ids: this.selectedObjectIds })
        this.selectionChange$.next(this.selectedObjectIds)
    }

    #findCapParent(polygonId: number): { node: { id: number; pos: { x: number; y: number; z: number }; h: number }; isTop: boolean } | null {
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
        const hitVec = hitPos ? vec3(hitPos[0], hitPos[1], hitPos[2]) : vec3(0, 0, 0)
        if (node.type === "extrude" && (node.twistDegrees ?? 0) === 0) {
            this.#pushPullController.selectFace(node as Parameters<PushPullController["selectFace"]>[0], hitVec)
            this.#pushSelectionInfo()
            return true
        }
        if (node.type === "polygon2d") {
            const parent = this.#findCapParent(nodeId)
            if (parent) {
                const localY = hitVec.y - parent.node.pos.y
                const isTop = localY >= 0
                this.#pushPullController.selectCapFace(parent.node as Parameters<PushPullController["selectCapFace"]>[0], isTop)
                this.#pushSelectionInfo()
                return true
            }
        }
        return false
    }

    #writeSelectionBuffer(): void {
        const selData = new Uint32Array(1024)
        for (let i = 0; i < this.#selectedObjectIds.length && i < 1024; i++) {
            selData[i] = this.#selectedObjectIds[i] ? 1 : 0
        }
        this.#worker.postMessage({ type: "writeBuffers", selectedObjectIds: selData.buffer }, [selData.buffer])
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
        for (const s of serialized) {
            this.#childrenByParent.set(s.id, s.children)
        }
        const polyById = new Map<number, { vertices: [number, number][]; bufferOffset: number }>()
        for (const s of serialized) {
            if (s.shapeType === "polygon2d" && s.vertices && s.bufferOffset !== undefined && s.bufferOffset >= 0) {
                const poly = {
                    vertices: s.vertices.map(v => [v[0], v[1]] as [number, number]),
                    bufferOffset: s.bufferOffset,
                }
                polyById.set(s.id, poly)
                this.#pushPullNodes.set(s.id, { type: "polygon2d", id: s.id, vertices: poly.vertices, bufferOffset: poly.bufferOffset })
            }
        }
        for (const s of serialized) {
            if (s.shapeType === "extrude" && s.pos && s.children.length === 1) {
                const child = polyById.get(s.children[0])
                if (child) {
                    this.#pushPullNodes.set(s.id, {
                        type: "extrude",
                        id: s.id,
                        pos: { x: s.pos[0], y: s.pos[1], z: s.pos[2] },
                        h: s.h ?? 1,
                        child,
                        twistDegrees: s.twistDegrees,
                    })
                }
            } else if (s.shapeType === "loft" && s.pos && s.children.length >= 2) {
                const profiles = s.children.map(cid => polyById.get(cid)).filter((p): p is { vertices: [number, number][]; bufferOffset: number } => p != null)
                if (profiles.length === s.children.length) {
                    this.#pushPullNodes.set(s.id, {
                        type: "loft",
                        id: s.id,
                        pos: { x: s.pos[0], y: s.pos[1], z: s.pos[2] },
                        h: s.h ?? 1,
                        profiles,
                    })
                }
            }
        }
    }

    #reconstructNodes(serialized: import("./render-worker-protocol.mjs").SerializedNode[]): NodeStub[] {
        const byId = new Map<number, NodeStub>()
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
            }
            stub.getAllDescendantIds = () => [
                s.id,
                ...s.children.flatMap(cid => byId.get(cid)?.getAllDescendantIds?.() ?? [cid]),
            ]
            byId.set(s.id, stub)
        }
        return serialized.map(s => byId.get(s.id)!).filter(Boolean)
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
        this.#worker.postMessage({ type: "init", canvas: offscreen }, [offscreen])
        this.#worker.postMessage({ type: "resize", fullWidth: this.#fullWidth, fullHeight: this.#fullHeight, devicePixelRatio: this.#devicePixelRatio })
        await this.#readyPromise
        this.#initPushPull()
    }

    #initPushPull(): void {
        const self = this
        this.#pushPullController = new PushPullController({
            writeBuffers(opts) {
                const transfer: ArrayBuffer[] = []
                if (opts.faceSelection) transfer.push(opts.faceSelection)
                if (opts.polygonVertices) transfer.push(opts.polygonVertices.data)
                if (opts.nodeParams) transfer.push(opts.nodeParams.data)
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
        }
        const canvas = this.#preview.canvas
        canvas.addEventListener("pointerdown", (e: PointerEvent) => {
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
            if (this.#pushPullController?.isActive) {
                this.#pushPullController.handleKeyDown(e)
            }
        })
    }

    get controls(): CameraController {
        return this.#controls
    }

    get selectedObjectIds(): number[] {
        const ids: number[] = []
        for (let i = 0; i < this.#selectedObjectIds.length; i++) {
            if (this.#selectedObjectIds[i]) ids.push(i)
        }
        return ids
    }

    setSelection(ids: number[], notify = false): void {
        this.#selectedObjectIds.fill(false)
        for (const id of ids) {
            this.#selectedObjectIds[id] = true
        }
        this.#selectedEdges = []
        if (notify) this.selectionChange$.next(this.selectedObjectIds)
        this.#pushSelectionInfo()
        this.#needsRender = true
    }

    getSceneNodes(): NodeStub[] {
        return this.#sceneNodeCache
    }

    setViewCenter(x: number, y: number, editorOffsetPx?: number): void {
        this.#viewCenter = vec2(x, y)
        this.#preview.setSelectionInfoLeft(editorOffsetPx ?? 0)
        this.#needsRender = true
    }

    set xrayMode(enabled: boolean) {
        this.#xrayMode = enabled
        this.#settings.updatePreview("xrayMode", enabled)
        this.#needsRender = true
    }
    get xrayMode(): boolean {
        return this.#xrayMode
    }

    set beamEnabled(enabled: boolean) {
        this.#beamEnabled = enabled
        this.#settings.updatePreview("beamOptimization", enabled)
        this.#needsRender = true
    }
    get beamEnabled(): boolean {
        return this.#beamEnabled
    }

    setSelectionMode(mode: SelectionMode): void {
        this.#selectionMode = mode
        this.#settings.updateGlobal({ preview: { selectionMode: mode } })
        this.#selectedObjectIds.fill(false)
        this.#selectedEdges = []
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
        this.#outlineThickness = Math.max(1, Math.min(8, Math.round(px)))
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

    #update(time: number): void {
        requestAnimationFrame((t: number) => this.#update(t))
        if (!this.#needsRender) return
        if (this.#fullWidth <= 0 || this.#fullHeight <= 0) return
        const minFrameTime = 1000 / this.#targetFPS
        const timeSinceLastRender = time - this.#lastRenderEndTime
        if (timeSinceLastRender < minFrameTime) return
        this.#needsRender = false
        this.#lastRenderEndTime = time

        const selectionModeNum = { object: 0, seam: 1, edge: 2, face: 3, auto: 4 }[this.#selectionMode]
        const outlineModeNum = { none: 0, solid: 1, dashed: 2, dotted: 3 }[this.#outlineMode]
        const cam = this.#controls
        const res = this.#fullWidth > 0 && this.#fullHeight > 0
            ? [this.#fullWidth, this.#fullHeight] as [number, number]
            : [1, 1] as [number, number]

        this.#worker.postMessage({
            type: "render",
            cameraState: cam.state,
            viewTransform: cam.viewTransform.data,
            cameraPosition: [cam.cameraPosition.x, cam.cameraPosition.y, cam.cameraPosition.z],
            cameraRes: res,
            selectionState: {
                selectedObjectIds: this.selectedObjectIds,
                selectedEdges: this.#selectedEdges,
                hoveredObjectId: this.#hoveredObjectId,
                hoveredEdges: this.#hoveredEdges,
            },
            viewSettings: {
                xrayMode: this.#xrayMode,
                beamEnabled: this.#beamEnabled,
                selectionMode: selectionModeNum,
                outlineMode: outlineModeNum,
                outlineThickness: this.#outlineThickness,
                outlineColor: this.#outlineColor,
            },
            viewCenter: [this.#viewCenter.x, this.#viewCenter.y],
            resolutionScale: this.#cameraOptimization ? 0.5 : 1.0,
        })
    }

    build(src: string, documentName?: string | null): Promise<void> {
        return new Promise<void>(resolve => {
            this.#pendingBuildResolve = resolve
            this.#worker.postMessage({ type: "build", src: src.trim(), documentName: documentName ?? undefined })
        })
    }

    async renderMesh(_src: string): Promise<MeshData> {
        return new Promise<MeshData>((resolve, reject) => {
            this.#pendingRenderMeshResolve = resolve
            this.#pendingRenderMeshReject = reject
            this.#worker.postMessage({ type: "renderMesh", src: _src })
        })
    }

    async benchmark(frameCount = 100, waitForGPU = true): Promise<{ totalTime: number; averageFrameTime: number; minFrameTime: number; maxFrameTime: number; framesPerSecond: number; frameTimes: number[] }> {
        const selectionModeNum = { object: 0, seam: 1, edge: 2, face: 3, auto: 4 }[this.#selectionMode]
        const outlineModeNum = { none: 0, solid: 1, dashed: 2, dotted: 3 }[this.#outlineMode]
        const cam = this.#controls
        const res = [this.#fullWidth || 800, this.#fullHeight || 600] as [number, number]
        this.#worker.postMessage({
            type: "render",
            cameraState: cam.state,
            viewTransform: cam.viewTransform.data,
            cameraPosition: [cam.cameraPosition.x, cam.cameraPosition.y, cam.cameraPosition.z],
            cameraRes: res,
            selectionState: {
                selectedObjectIds: this.selectedObjectIds,
                selectedEdges: this.#selectedEdges,
                hoveredObjectId: this.#hoveredObjectId,
                hoveredEdges: this.#hoveredEdges,
            },
            viewSettings: {
                xrayMode: this.#xrayMode,
                beamEnabled: this.#beamEnabled,
                selectionMode: selectionModeNum,
                outlineMode: outlineModeNum,
                outlineThickness: this.#outlineThickness,
                outlineColor: this.#outlineColor,
            },
            viewCenter: [this.#viewCenter.x, this.#viewCenter.y],
            resolutionScale: this.#cameraOptimization ? 0.5 : 1.0,
        })
        return new Promise(resolve => {
            this.#pendingBenchmarkResolve = resolve
            this.#worker.postMessage({ type: "benchmark", frameCount, waitForGPU })
        })
    }

    dispose(): void {
        for (const sub of this.#controlSubs) sub.unsubscribe()
        this.#controlSubs.length = 0
        this.#tabChangeSub?.unsubscribe()
        this.#tabCloseSub?.unsubscribe()
        this.#tabRenameSub?.unsubscribe()
        this.#resizeObserver?.disconnect()
        this.#worker.terminate()
        this.#controls.dispose()
        this.selectionChange$.complete()
        this.objectDoubleClick$.complete()
        this.pushPullComplete$.complete()
        this.capPullComplete$.complete()
        this.previewSettingsLoaded$.complete()
    }
}
