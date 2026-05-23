/**
 * Message protocol for main thread <-> render worker communication.
 * Shared by SDFRendererProxy (main) and render-worker (worker).
 */

import type { CameraState } from "./controls/camera-controller.mjs"
import type { SelectionInfo } from "./components/preview-window.mjs"
import type { MeshData } from "./export/export.mjs"

/**
 * Default world-space voxel edge length (mm) used by mesh extractors (MDC, SHREC,
 * iso-simplicial) when the user has not set one explicitly. Half this value → 8×
 * more voxels → ~8× more time and memory; double this value → 8× cheaper but
 * blockier corners. Each exporter persists its own voxel size; this constant
 * is the seed for both `DEFAULT_MDC_EXPORT_LEVERS.voxelSizeMm` and
 * `DEFAULT_SHREC_TUNING.voxelSizeMm`.
 */
export const DEFAULT_MESH_EXPORT_VOXEL_SIZE_MM = 0.5

/**
 * Selects the algorithm used by `handleRenderMesh` to extract a triangle mesh
 * from the scene SDF.
 *
 * - `"mdc"`: Manifold Dual Contouring entirely on the GPU (default; see
 *   `src/export/mdc.mts` and `src/shaders/mdc.wgsl`).
 * - `"shrec"`: GPU samples (scalar, gradient) on a uniform grid, then a CPU
 *   stage runs dual contouring + MergeSharp vertex relocation (see
 *   `src/export/shrec.mts` and `src/shaders/sample_grid.wgsl`).
 * - `"isoSimplicial"`: GPU batched `sceneSDF` samples for Hermite data, CPU
 *   adaptive octree plus Marching Tetrahedra (`src/export/iso-simplicial/`).
 */
export type ExporterKind = "mdc" | "shrec" | "isoSimplicial"

/**
 * Optional overrides for iso-simplicial export (`IsoSimplicialConstants` in
 * `src/export/iso-simplicial/constants.mts`). Omitted fields use frozen defaults.
 */
export interface IsoSimplicialTuning {
    depthMin?: number
    depthMax?: number
    oversampleQef?: number
    dualVertexBorderFraction?: number
    findRootDepth?: number
    qefRelativeErrorRefineThreshold?: number
    /**
     * When true, run async Phase 5 GPU bisection on MT edge crossings
     * (`extractIsoSimplicialMeshAsync`). When false, linear edge intersection only.
     */
    phase5Snap?: boolean
    /**
     * Extra margin (mm) applied symmetrically when expanding refined scene bounds into the
     * iso-simplicial world cube. Omitted → {@link DEFAULT_ISO_SIMPLICIAL_BOUNDS_PADDING_MM}.
     */
    boundingBoxPaddingMm?: number
    /**
     * Feature-aware subdivision (Path I — explicit primitive features from `sceneSDF_mid`).
     * - `"off"` (default): subdivision uses only `isbig`/`signchange`/`badqef`.
     * - `"signchangeGated"`: additionally subdivide cells where `signchange && !badqef`
     *   *and* any of the cell's 8 corners are within {@link featureRefineProximityFactor}
     *   cell-widths of a feature primitive. Per-corner `SDFResultMid` data is sampled once
     *   at the root and inherited through octree recursion — no per-cell GPU calls.
     */
    featureRefineMode?: "off" | "signchangeGated"
    /**
     * Proximity threshold for `featureRefineMode === "signchangeGated"`: a corner counts as
     * "near a feature" when its sampled `featureDist < featureRefineProximityFactor * cellSize`.
     * Default 2.0 — with the 8-corner inheritance scheme, ≥√3/2 ≈ 0.87 is enough to cover
     * any feature point inside the cell interior; 2.0 also catches features within ~2 cell
     * widths of the surface.
     */
    featureRefineProximityFactor?: number
    /**
     * When true (and `featureRefineMode !== "off"`), the cube-QEF normal equations are augmented
     * with one or two extra Hermite planes per corner derived from the corner's inherited
     * `SDFResultMid` (featurePoint + featureN1/N2). Pulls dual vertices toward sharp features
     * (edges, corners) without a hard constraint — the QEF solve is unchanged, it just sees
     * more equations. Default `false`.
     */
    featurePlaneEnabled?: boolean
    /**
     * Distance gate for `featurePlaneEnabled`: skip a corner's feature planes when its
     * `featureDist` (world units) exceeds `featurePlaneDistFactor * cellSize * worldScale`.
     * Default 1.0 — inject only when the feature is inside or just outside the cell.
     */
    featurePlaneDistFactor?: number
    /**
     * Inject FeatureGraph corners + creases as additional Hermite planes in the per-cell
     * QEF (cube / edge / face). Independent of `featurePlaneEnabled`: that path samples
     * `SDFResultMid` on the GPU; this path consumes the survival-aware FeatureGraph
     * (`src/feature-graph/`) built per export. Composes with the GPU mid-feature planes
     * when both are enabled. Default `false`.
     */
    featureGraphPlanesEnabled?: boolean
    /**
     * Distance gate for `featureGraphPlanesEnabled`: skip an FG corner/crease when its
     * distance to the cell (world units) exceeds `featureGraphPlaneDistFactor * cellSize *
     * worldScale`. Default 0 — inject an FG feature only into cells it passes through.
     * Raising it widens the influence, but a factor ≥ 1 pulls whole rings of flat-face
     * cells onto feature edges (collapsed geometry), so keep it small.
     */
    featureGraphPlaneDistFactor?: number
    /**
     * When true (and `featureGraphPlanesEnabled`), also inject FG planes into the
     * sub-dimensional **edge** and **face** QEFs — not just the cube QEF. Default false.
     *
     * The cube QEF is 3D and a feature's planes correctly intersect at its crease/corner,
     * so cube injection is mispull-free. The edge/face QEFs are sub-dimensional: a feature
     * gated into the cell is projected onto *every* cell-edge / face, including ones the
     * feature does not cross, where the cross-face plane is an extrapolated mispull. At a
     * concave feature that mispull dents sub-vertices inward (a "subtracted slice"). Leave
     * off unless A/B testing shows it helps a specific model.
     */
    featureGraphEdgeFacePlanes?: boolean
}

/** Default iso-simplicial tuning: all fields omitted → worker uses `IsoSimplicialConstants`. */
export const DEFAULT_ISO_SIMPLICIAL_TUNING: IsoSimplicialTuning = {}

/** Padding (mm) added to refined scene bounds when sizing the iso-simplicial sampling cube. */
export const DEFAULT_ISO_SIMPLICIAL_BOUNDS_PADDING_MM = 3.2

/**
 * Tuning knobs for the SHREC / MergeSharp exporter that the user may adjust
 * from Dev Tools at runtime. Mirrors the merge-related subset of
 * `ShrecParams` in `src/export/shrec.mts`; grid-sizing fields stay computed
 * in the worker.
 */
export interface ShrecTuning {
    /** Whether to run the MergeSharp relocation pass. When false, plain DC mass-point output is returned. */
    mergeSharpEnabled: boolean
    /** Singular-value cutoff for the rank-aware QEF pseudo-inverse (fraction of largest eigenvalue). Smaller → more vertices snap to features. */
    mergeRelCutoff: number
    /**
     * Optional extra clamp on per-vertex displacement (mm), in addition to
     * the always-on cell-bounds clamp. `0` disables this extra clamp.
     */
    mergeMaxDisplacement: number
    /**
     * Crease angle threshold in degrees for the post-relocation vertex split.
     * Re-derives per-vertex normals from triangle face normals; vertices whose
     * adjacent triangles span an angle greater than this threshold are split
     * into separate output vertices, each with its own per-side normal. Set
     * to 180 to disable splitting (one smooth group per vertex; normals are
     * still re-derived from face geometry, which kills banding on flat
     * surfaces). Set to 0 to make every triangle its own face. Values `< 0`
     * skip the crease-split pass entirely. Default 30.
     */
    creaseAngleDeg: number
    /**
     * Enable the seam-aware QEF path. When true, cells whose corner voxels
     * report a coherent CSG seam tangent (from `sample_grid.wgsl`) are
     * solved with a 1D constrained least-squares **along the seam line**
     * instead of the full 3D Tikhonov QEF. This eliminates residual
     * sub-voxel jitter on long sharp CSG edges (the artifact that normally
     * shows up as a wavy contour even after Tikhonov regularisation).
     *
     * Cells without a usable seam tangent — smooth blends, sharp corners
     * where 3+ surfaces meet, single-primitive surfaces — fall through to
     * the existing Tikhonov path.
     */
    seamAwareEnabled: boolean
    /**
     * Cosine of the per-cell tangent-agreement threshold the seam-aware
     * path uses to decide that a cell sits on a single coherent seam line.
     * Default `0.97` ≈ `cos(15°)` — strict, only admits cells whose corner
     * tangents are near-coincident. Lower values (e.g. `0.85` ≈ `cos(32°)`)
     * admit more cells; higher values approach `1.0` (only exact agreement).
     */
    seamAgreementCosThreshold: number
    /**
     * Run the post-MergeSharp **chain Laplacian smoothing** for cells
     * placed by the rank-2 pseudo-inverse path. Groups topologically-
     * connected cells with consistent seam tangents into chains, sorts
     * each chain by its dominant tangent axis, and applies several
     * iterations of 1D Laplacian smoothing along the chain. Sub-voxel
     * effect — only useful as a final polish on long sharp edges.
     */
    edgeFitEnabled: boolean
    /**
     * Vertex deduplication radius, expressed as a fraction of `voxelSize`,
     * applied after MergeSharp relocation. Multiple cells whose vertices
     * snapped to the same sharp feature (typically a CSG corner) end up
     * geometrically co-located and are collapsed into a single shared
     * vertex; degenerate triangles around the merged corner are dropped.
     *
     * - `0` → skip the dedup pass (each cell keeps its own vertex; current default).
     * - `0.5` → typical setting for corner cleanup; merges anything within
     *   half a voxel.
     * - `1.0` → aggressive; can merge across cells that share an edge as
     *   well as a face.
     *
     * The pass is the **"merge" half of MergeSharp's name** — it is what
     * gives the algorithm a watertight shared vertex at every corner where
     * three or more surfaces meet. Default `0` is conservative; raise it to
     * actually engage the merge step.
     */
    dedupRadiusVoxels: number
    /**
     * Exponent applied to the SDF gradient magnitude `g = |∇SDF|` when
     * weighting each cube-edge crossing in the QEF.
     *
     * - `0` → uniform weight (every crossing counts the same; current default).
     * - `1` → linear weighting (`w = g`); standard weighted least squares.
     * - `2` → squared weighting (`w = g²`); the IJK reference value, more
     *   aggressive at de-weighting smooth-blend regions.
     *
     * For true SDFs `g = 1` everywhere and any value is equivalent. The knob
     * matters only when the scene contains smooth CSG operators (`opUnionRound`,
     * smooth blends, etc.) where `g < 1` near the blend region; raising the
     * power keeps blend-region samples from dragging the QEF away from
     * adjacent sharp features.
     */
    mergeGradientWeightPower: number
    /**
     * Match MDC mesh export: project MergeSharp QEF Hermite crossings onto
     * explicit / inferred feature loci when the cell has one iso component.
     */
    featureConstrainedPlacement: boolean
    /**
     * Feed SHREC's snap pass from the FeatureGraph instead of the legacy
     * `accumulateContours` walk. The FG path is CSG-survival-aware and
     * smooth-blend-aware — features cut away by a difference op or faded
     * out by a smooth blend are absent from the snap set, so SHREC stops
     * snapping to features that no longer exist on the iso-surface.
     *
     * When false: SHREC consumes the legacy `accumulateContours` walk
     * (primitive contours without CSG filtering). Useful as a regression
     * comparison or fallback if the FG path misbehaves on a particular
     * scene. Default true.
     */
    featureGraphContours: boolean
    /** Voxel edge length in world units (mm). SHREC's own value; independent of MDC. */
    voxelSizeMm: number
}

export const DEFAULT_SHREC_TUNING: ShrecTuning = {
    mergeSharpEnabled: true,
    mergeRelCutoff: 0.05,
    mergeMaxDisplacement: 0,
    creaseAngleDeg: 30,
    mergeGradientWeightPower: 0,
    dedupRadiusVoxels: 0,
    seamAwareEnabled: true,
    seamAgreementCosThreshold: 0.97,
    edgeFitEnabled: false,
    featureConstrainedPlacement: true,
    featureGraphContours: true,
    voxelSizeMm: DEFAULT_MESH_EXPORT_VOXEL_SIZE_MM,
}

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

/**
 * High-impact mesh export (MDC) knobs exposed in Dev Tools and persisted in global settings.
 * Passed to the render worker on each `renderMesh` request.
 */
export interface MdcExportLevers {
    /** Voxel edge length in world units (mm in current export path). Smaller = finer mesh. */
    voxelSizeMm: number
    /** Isosurface level of the SDF; 0 is the nominal surface. */
    isoValue: number
    /** Crease angle (degrees) for vertex splitting; 180 disables; negative values skip the pass. */
    creaseAngleDeg: number
    /** Constrain MDC vertices onto explicit mid-tier line/corner/seam/ring feature loci. */
    featureConstrainedPlacement: boolean
    /** Fraction of triangles to keep after simplification (must be < 1 to simplify). */
    simplifyTargetRatio: number
    /** Max geometric error for simplifier (relative unless `simplifyErrorAbsolute` is set in worker). */
    simplifyTargetError: number
    /** Normal-aware simplification weight; 0 = position only. */
    simplifyNormalWeight: number
    /** Meshoptimizer regularize flag. */
    simplifyRegularize: boolean
}

export const DEFAULT_MDC_EXPORT_LEVERS: MdcExportLevers = {
    voxelSizeMm: DEFAULT_MESH_EXPORT_VOXEL_SIZE_MM,
    isoValue: 0,
    creaseAngleDeg: 30,
    featureConstrainedPlacement: true,
    simplifyTargetRatio: 0.1,
    simplifyTargetError: 0.001,
    simplifyNormalWeight: 0,
    simplifyRegularize: false,
}

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
          shrecTuning?: ShrecTuning
          isoSimplicialTuning?: IsoSimplicialTuning
          simplifyTuning?: SimplifyTuning
          voxelSizeMm?: number
          /** When set, overrides worker defaults for MDC export (Dev Tools). */
          mdcExportLevers?: MdcExportLevers
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
    | { type: "pickPos"; clickUV: [number, number]; requestId: number }
    | { type: "pickObject"; clickUV: [number, number]; requestId: number }
    | { type: "setBvhEnabled"; enabled: boolean }
    | { type: "setFeatureGraphOverlayEnabled"; enabled: boolean }
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
    /** Far clipping distance (default 600). */
    maxDist: number
    /** Max beam pre-pass iterations (default 200). */
    maxBeamSteps: number
    /** Binary-search refinement iterations after a hit (default 6). Higher = sharper surface accuracy. */
    hitRefineSteps: number
    /** Camera z-offset for ray origin (default 300). */
    rayOriginDepth: number
}

export const DEFAULT_RAY_MARCH_PARAMS: RayMarchParams = {
    maxSteps: 300,
    maxDist: 600,
    maxBeamSteps: 200,
    hitRefineSteps: 6,
    rayOriginDepth: 300,
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
    rayMarchParams?: RayMarchParams
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
