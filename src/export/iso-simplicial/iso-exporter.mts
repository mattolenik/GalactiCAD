/**
 * The iso-simplicial mesh exporter: GPU batched `sceneSDF` samples for Hermite
 * data, then a CPU adaptive octree + Marching Tetrahedra. This is the impl half
 * of the exporter; the light tuning lives in `./iso-tuning.mts`.
 *
 * Lifted from the former `handleRenderMesh` iso branch — it reads everything it
 * needs (device, buffers, scene, bounds, FeatureGraph, abort signal) from the
 * {@link MeshExportContext}.
 */
import isoSampleBatchShaderSource from "../../shaders/iso_sample_batch.wgsl"
import { log } from "../../logging/debug-log.mjs"
import type { MeshData } from "../export.mjs"
import type { MeshExporter } from "../mesh-exporter.mjs"
import {
    createIsoOctreeMidFeatureSampleFn,
    createIsoOctreeSampleFn,
    extractIsoSimplicialMesh,
    extractIsoSimplicialMeshAsync,
    IsoOctree,
    IsoSampleBatch,
    type IsoFeatureRefineOptions,
} from "./index.mjs"
import { QefWorkerPool } from "./qef-worker-pool.mjs"
import { IsoSimplicialConstants } from "./constants.mjs"
import {
    ISO_SIMPLICIAL_DISPLAY_NAME,
    DEFAULT_ISO_SIMPLICIAL_BOUNDS_PADDING_MM,
    DEFAULT_ISO_SIMPLICIAL_TUNING,
    normalizeIsoSimplicialTuning,
    type IsoSimplicialTuning,
} from "./iso-tuning.mjs"

export const isoSimplicialExporter: MeshExporter<IsoSimplicialTuning> = {
    displayName: ISO_SIMPLICIAL_DISPLAY_NAME,
    defaultTuning: DEFAULT_ISO_SIMPLICIAL_TUNING,
    normalizeTuning: normalizeIsoSimplicialTuning,
    async run(ctx, tuning): Promise<MeshData> {
        const isoT = tuning
        log("IsoSimplicialExport").info(`handleRenderMesh: dispatching iso-simplicial, tuning=${JSON.stringify(isoT)}`)
        const tIso0 = globalThis.performance?.now ? globalThis.performance.now() : Date.now()
        const isoSampleModule = ctx.makeSceneCompiler().compile(isoSampleBatchShaderSource, "Iso sample batch")
        const isoBatch = new IsoSampleBatch(
            ctx.helper,
            ctx.uniformBuffers.polygonVertices,
            ctx.uniformBuffers.faceSelection,
            ctx.uniformBuffers.mdcSceneParams,
        )
        // `import.meta.url` here resolves to the render-worker bundle (`/render-worker.js`),
        // and the QEF worker is emitted at its source-tree path under dist.
        const qefWorkerUrl = new URL("./export/iso-simplicial/iso-qef-worker.js", import.meta.url)
        const navAny = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator
        const hwCores = navAny?.hardwareConcurrency ?? 4
        const qefWorkerCount = Math.max(1, Math.min(8, hwCores - 1))
        let qefWorkerPool: QefWorkerPool | undefined
        // QEF worker pool requires SharedArrayBuffer for zero-copy batch I/O; that needs
        // cross-origin isolation (COOP+COEP). Skip pool construction entirely when SAB is
        // missing so iso-simplicial falls back cleanly to inline QEF on this thread.
        if (typeof SharedArrayBuffer === "undefined") {
            log("IsoSimplicialExport").warn("SharedArrayBuffer unavailable (no cross-origin isolation); using inline QEF")
            qefWorkerPool = undefined
        } else {
            try {
                qefWorkerPool = new QefWorkerPool({ workerUrl: qefWorkerUrl, workerCount: qefWorkerCount })
            } catch (e) {
                log("IsoSimplicialExport").warn("QefWorkerPool unavailable, falling back to inline QEF", e)
                qefWorkerPool = undefined
            }
        }
        try {
            const cube = ctx.worldBoundsCube()
            const MIN_DEPTH_FLOOR = 3
            const effectiveDepthMax =
                typeof isoT.depthMax === "number" && Number.isFinite(isoT.depthMax) ?
                    Math.max(MIN_DEPTH_FLOOR, isoT.depthMax)
                :   IsoSimplicialConstants.depthMax
            // Representative scale for inserted scene SDF code that references
            // `uniforms.voxelSize` (Lathe/Loft epsilons): finest octree cell size.
            const isoBatchVoxelSize = (cube.max[0] - cube.min[0]) / Math.pow(2, effectiveDepthMax)
            const sampleFn = createIsoOctreeSampleFn(isoBatch, isoSampleModule, isoBatchVoxelSize)
            const constOverrides = {
                ...(typeof isoT.depthMin === "number" && Number.isFinite(isoT.depthMin) ?
                    { depthMin: Math.max(MIN_DEPTH_FLOOR, isoT.depthMin) }
                :   {}),
                ...(typeof isoT.depthMax === "number" && Number.isFinite(isoT.depthMax) ?
                    { depthMax: Math.max(MIN_DEPTH_FLOOR, isoT.depthMax) }
                :   {}),
                ...(typeof isoT.oversampleQef === "number" && Number.isFinite(isoT.oversampleQef) ?
                    { oversampleQef: isoT.oversampleQef }
                :   {}),
                ...(typeof isoT.dualVertexBorderFraction === "number" && Number.isFinite(isoT.dualVertexBorderFraction) ?
                    { dualVertexBorderFraction: isoT.dualVertexBorderFraction }
                :   {}),
                ...(typeof isoT.findRootDepth === "number" && Number.isFinite(isoT.findRootDepth) ?
                    { findRootDepth: isoT.findRootDepth }
                :   {}),
                ...((
                    typeof isoT.qefRelativeErrorRefineThreshold === "number" &&
                    Number.isFinite(isoT.qefRelativeErrorRefineThreshold)
                ) ?
                    { qefRelativeErrorRefineThreshold: isoT.qefRelativeErrorRefineThreshold }
                :   {}),
            }
            const featureRefineMode = isoT.featureRefineMode ?? "off"
            // FG plumbing: build the FeatureGraph at the iso-simplicial finest-cell
            // size (NOT the SHREC grid size). Only do this when FG-plane injection
            // is enabled — building the FG is a few async GPU dispatches.
            const fgEnabled = isoT.featureGraphPlanesEnabled === true
            const fgResult = fgEnabled ? await ctx.buildFeatureGraph(ctx.scene, isoBatchVoxelSize) : null
            const fgPlaneFields: Pick<
                IsoFeatureRefineOptions,
                "fgPlaneEnabled" | "fgPlaneDistFactor" | "fgEdgeFacePlanes" | "featureGraphCpu" | "featureGraphWorldPositions" | "featureGraphSpatialIndex"
            > = fgEnabled && fgResult
                ? {
                    fgPlaneEnabled: true,
                    fgPlaneDistFactor:
                        typeof isoT.featureGraphPlaneDistFactor === "number" &&
                        Number.isFinite(isoT.featureGraphPlaneDistFactor) &&
                        isoT.featureGraphPlaneDistFactor >= 0
                            ? isoT.featureGraphPlaneDistFactor
                            : 0,
                    fgEdgeFacePlanes: isoT.featureGraphEdgeFacePlanes === true,
                    featureGraphCpu: fgResult.cpu,
                    featureGraphWorldPositions: fgResult.worldPositions,
                    featureGraphSpatialIndex: fgResult.spatialIndex,
                }
                : {}
            const featureRefine: IsoFeatureRefineOptions | undefined = featureRefineMode === "off"
                ? (fgEnabled && fgResult ? { mode: "off", proximityFactor: 2.0, ...fgPlaneFields } : undefined)
                : {
                    mode: featureRefineMode,
                    proximityFactor:
                        typeof isoT.featureRefineProximityFactor === "number" &&
                        Number.isFinite(isoT.featureRefineProximityFactor) &&
                        isoT.featureRefineProximityFactor > 0
                            ? isoT.featureRefineProximityFactor
                            : 2.0,
                    sampleMidFeature: createIsoOctreeMidFeatureSampleFn(isoBatch, isoSampleModule, isoBatchVoxelSize),
                    planeEnabled: isoT.featurePlaneEnabled === true,
                    planeDistFactor:
                        typeof isoT.featurePlaneDistFactor === "number" &&
                        Number.isFinite(isoT.featurePlaneDistFactor) &&
                        isoT.featurePlaneDistFactor > 0
                            ? isoT.featurePlaneDistFactor
                            : 1.0,
                    ...fgPlaneFields,
                }
            const tree = await IsoOctree.build({
                sample: sampleFn,
                bounds: { min: cube.min, max: cube.max },
                constants: Object.keys(constOverrides).length > 0 ? constOverrides : undefined,
                qefWorkerPool,
                featureRefine,
                signal: ctx.signal,
            })
            const tIsoOct = globalThis.performance?.now ? globalThis.performance.now() : Date.now()
            const worldB = {
                min: cube.min as readonly [number, number, number],
                max: cube.max as readonly [number, number, number],
            }
            let mesh: MeshData
            if (isoT.phase5Snap) {
                mesh = await extractIsoSimplicialMeshAsync(tree, {
                    worldBounds: worldB,
                    phase5: { enabled: true, sample: sampleFn, signal: ctx.signal },
                })
            } else {
                mesh = extractIsoSimplicialMesh(tree, { worldBounds: worldB })
            }
            const tIso1 = globalThis.performance?.now ? globalThis.performance.now() : Date.now()
            const r1 = (n: number) => Math.round(n * 10) / 10
            const bp = tree.buildPerf
            log("IsoSimplicialExport").info("iso-simplicial export complete", {
                treeCellCount: tree.treeCellCount,
                triCount: mesh.tris.length / 3,
                octreeMs: Math.round((tIsoOct - tIso0) * 1000) / 1000,
                totalMs: Math.round((tIso1 - tIso0) * 1000) / 1000,
                buildPerf: {
                    frontiers: bp.frontierCount,
                    cellsPerFrontier: bp.cellsPerFrontier,
                    wallMs: r1(bp.totalWallMs),
                    phase1GpuMs: r1(bp.phase1SampleMs),
                    phase2GpuMs: r1(bp.phase2SampleMs),
                    midGpuMs: r1(bp.midSampleMs),
                    nearFeatureGpuMs: r1(bp.nearFeatureSampleMs),
                    qefCpuMs: r1(bp.qefMs),
                    otherCpuMs: r1(bp.otherCpuMs),
                    extractMs: r1((tIso1 - tIsoOct)),
                    qefWorkers: qefWorkerPool?.workerCount ?? 0,
                },
                boundsPaddingMm: DEFAULT_ISO_SIMPLICIAL_BOUNDS_PADDING_MM,
                depthMin: constOverrides.depthMin ?? IsoSimplicialConstants.depthMin,
                depthMax: constOverrides.depthMax ?? IsoSimplicialConstants.depthMax,
                oversampleQef: constOverrides.oversampleQef ?? IsoSimplicialConstants.oversampleQef,
            })
            return mesh
        } finally {
            isoBatch.destroy()
            qefWorkerPool?.destroy()
        }
    },
}
