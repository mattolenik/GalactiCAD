import yaml from "js-yaml"
import type { CameraSettings, GlobalSettings } from "../storage/settings.mjs"
import type { SimplifyTuning } from "../render-worker-protocol.mjs"
import type { ExporterKind } from "../export/mesh-exporter.mjs"
import type { CanvasPreviewUvRect } from "../layout/editor-layout.mjs"

export const AGENT_TESTCASE_SCHEMA_VERSION = 1 as const

/** Mesh / export knobs only (no visual preview toggles). Matches `renderMesh` options shape. */
export interface AgentTestcaseMeshExport {
    simplifyOnExport: boolean
    exporter: ExporterKind
    /** Per-exporter tuning keyed by kind; voxel size lives inside each exporter's tuning. */
    exporterTuning: Partial<Record<ExporterKind, unknown>>
    simplifyTuning: SimplifyTuning
}

/**
 * Frozen snapshot for agent render replay (GET /_agent/render/testcase/…) and diffs.
 * Serialized as YAML with `source` as a literal block (UTF-8 scene text, e.g. .gcad).
 */
export interface AgentTestcase {
    schemaVersion: typeof AGENT_TESTCASE_SCHEMA_VERSION
    source: string
    camera: CameraSettings
    viewCenter: [number, number]
    /**
     * Optional render dimensions. When omitted, agent renders default to 1000×1000;
     * values are clamped to [1, 2048] in the render pipeline.
     */
    viewportWidth?: number
    viewportHeight?: number
    /**
     * Visible SDF preview on the full canvas (shader UV: u left→right, v bottom→top).
     * When present, agent renders crop to this rect so PNGs omit the editor overlay.
     */
    previewUvRect?: CanvasPreviewUvRect
    meshExport: AgentTestcaseMeshExport
    /**
     * Mesh-viewer debug overlay toggles when captured (from global meshViewer settings).
     * Omitted when all off. For `mode: "mesh"` agent renders only.
     */
    meshOverlay?: AgentMeshOverlay
    /** Active document tab name when captured, if any. */
    documentName?: string
}

export interface BuildAgentTestcaseInput {
    sourceUtf8: string
    camera: CameraSettings
    viewCenter: [number, number]
    viewportWidth?: number
    viewportHeight?: number
    previewUvRect?: CanvasPreviewUvRect
    meshExport: AgentTestcaseMeshExport
    meshOverlay?: AgentMeshOverlay
    documentName?: string
}

/** UTF-8 → base64 (browser / main thread) for `AgentRenderRequest` wire payloads. */
export function utf8ToBase64(s: string): string {
    return btoa(
        new Uint8Array(new TextEncoder().encode(s)).reduce(
            (acc, b) => acc + String.fromCharCode(b),
            "",
        ),
    )
}

export function base64ToUtf8(b64: string): string {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i)
    }
    return new TextDecoder().decode(bytes)
}

export function buildAgentTestcase(input: BuildAgentTestcaseInput): AgentTestcase {
    return {
        schemaVersion: AGENT_TESTCASE_SCHEMA_VERSION,
        source: input.sourceUtf8,
        camera: { ...input.camera },
        viewCenter: [input.viewCenter[0], input.viewCenter[1]],
        ...(input.viewportWidth !== undefined ? { viewportWidth: input.viewportWidth } : {}),
        ...(input.viewportHeight !== undefined ? { viewportHeight: input.viewportHeight } : {}),
        ...(input.previewUvRect !== undefined ? { previewUvRect: { ...input.previewUvRect } } : {}),
        meshExport: {
            simplifyOnExport: input.meshExport.simplifyOnExport,
            exporter: input.meshExport.exporter,
            exporterTuning: { ...input.meshExport.exporterTuning },
            simplifyTuning: { ...input.meshExport.simplifyTuning },
        },
        ...(input.meshOverlay !== undefined
            ? {
                  meshOverlay: {
                      mdcDebugPoints: input.meshOverlay.mdcDebugPoints,
                      mdcCellVertices: input.meshOverlay.mdcCellVertices,
                      mdcQefPlanes: input.meshOverlay.mdcQefPlanes,
                      ...(input.meshOverlay.featureGlyphs !== undefined
                          ? { featureGlyphs: { ...input.meshOverlay.featureGlyphs } }
                          : {}),
                  },
              }
            : {}),
        ...(input.documentName !== undefined ? { documentName: input.documentName } : {}),
    }
}

/** Maps persisted mesh-viewer settings to agent render overlay (omit when all flags off). */
export function agentMeshOverlayFromSettingsMeshViewer(
    mv: GlobalSettings["meshViewer"],
): AgentMeshOverlay | undefined {
    const fg = mv.featureGlyphs
    const any =
        mv.mdcDebugPoints ||
        fg.line ||
        fg.corner ||
        fg.seam ||
        fg.ring ||
        mv.mdcCellVertices ||
        mv.mdcQefPlanes
    if (!any) return undefined
    return {
        mdcDebugPoints: mv.mdcDebugPoints,
        featureGlyphs: { line: fg.line, corner: fg.corner, seam: fg.seam, ring: fg.ring },
        mdcCellVertices: mv.mdcCellVertices,
        mdcQefPlanes: mv.mdcQefPlanes,
    }
}

const YAML_DUMP_OPTS = {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
    flowLevel: -1,
    quotingType: '"' as const,
    forceQuotes: false,
}

/** Round-trip safe YAML for disk and `GET /_agent/capture-testcase`. */
export function serializeAgentTestcaseYaml(tc: AgentTestcase): string {
    return yaml.dump(tc, YAML_DUMP_OPTS)
}

function assertAgentTestcaseSchema(tc: { schemaVersion?: unknown }): void {
    if (tc.schemaVersion !== AGENT_TESTCASE_SCHEMA_VERSION) {
        throw new Error(`Unsupported agent testcase schemaVersion: ${String(tc.schemaVersion)}`)
    }
}

/** Parse testcase YAML from disk or HTTP; validates `schemaVersion` and `source`. */
export function parseAgentTestcaseYaml(text: string): AgentTestcase {
    const loaded = yaml.load(text)
    if (loaded === null || typeof loaded !== "object") {
        throw new Error("Agent testcase YAML must be a mapping at the root")
    }
    const o = loaded as Record<string, unknown>
    assertAgentTestcaseSchema(o)
    if (typeof o.source !== "string") {
        throw new Error("Agent testcase YAML must include a string `source` (scene body)")
    }
    return loaded as AgentTestcase
}

/** Validate testcase object from the browser bridge (`source` must be plain UTF-8). */
export function normalizeAgentTestcaseFromBridge(data: unknown): AgentTestcase {
    if (data === null || typeof data !== "object") {
        throw new Error("Agent testcase payload must be an object")
    }
    const o = data as Record<string, unknown>
    assertAgentTestcaseSchema(o)
    if (typeof o.source !== "string") {
        throw new Error("Agent testcase must include string `source` (scene body)")
    }
    return data as AgentTestcase
}

export type AgentRenderMode = "sdf" | "mesh"

/**
 * Mesh-viewer debug overlay flags for `mode: "mesh"` agent renders. All
 * fields are optional; missing flags default to `false`. Mirrors the
 * mesh-viewer GUI checkboxes (raw debug points, per-class feature glyphs,
 * per-cell-component vertex markers, per-cell QEF input plane normals).
 *
 * Debug geometry (raw points, feature glyphs, cell vertices, QEF planes) is
 * drawn on the WebGPU canvas with depth testing against the mesh. A stacked
 * 2D canvas adds only the stats HUD and hover callouts; captures composite
 * both so the PNG matches the viewer.
 */
export interface AgentMeshOverlay {
    mdcDebugPoints?: boolean
    featureGlyphs?: { line?: boolean; corner?: boolean; seam?: boolean; ring?: boolean }
    /** Per-cell-component vertex positions (pre-crease-split). */
    mdcCellVertices?: boolean
    /** Per-(cell, component) QEF input plane normals (anchored at the cell mass / feature point). */
    mdcQefPlanes?: boolean
}

/** Single render request for WS / HTTP agent automation. */
export interface AgentRenderRequest {
    mode: AgentRenderMode
    sourceBase64: string
    camera: CameraSettings
    viewCenter: [number, number]
    /** Optional render dims; pipeline defaults to 1000×1000 and clamps to [1, 2048]. */
    viewportWidth?: number
    viewportHeight?: number
    previewUvRect?: CanvasPreviewUvRect
    meshExport: AgentTestcaseMeshExport
    documentName?: string
    /** Mesh-viewer debug glyph overlays (only consulted when `mode === "mesh"`). */
    meshOverlay?: AgentMeshOverlay
}

/** Merge saved testcase YAML (in-memory `AgentTestcase`) with optional overrides (GET query / POST body). */
export function mergeAgentRenderRequest(
    testcase: AgentTestcase,
    overrides: Partial<Pick<AgentRenderRequest, "mode">> & {
        viewportWidth?: number
        viewportHeight?: number
        meshOverlay?: AgentMeshOverlay
    },
): AgentRenderRequest {
    assertAgentTestcaseSchema(testcase)
    const w = overrides.viewportWidth ?? testcase.viewportWidth
    const h = overrides.viewportHeight ?? testcase.viewportHeight
    const mode = overrides.mode ?? "sdf"
    return {
        mode,
        sourceBase64: utf8ToBase64(testcase.source),
        camera: { ...testcase.camera },
        viewCenter: [testcase.viewCenter[0], testcase.viewCenter[1]],
        ...(w !== undefined ? { viewportWidth: w } : {}),
        ...(h !== undefined ? { viewportHeight: h } : {}),
        ...(testcase.previewUvRect !== undefined
            ? { previewUvRect: { ...testcase.previewUvRect } }
            : {}),
        meshExport: {
            simplifyOnExport: testcase.meshExport.simplifyOnExport,
            exporter: testcase.meshExport.exporter,
            exporterTuning: { ...testcase.meshExport.exporterTuning },
            simplifyTuning: { ...testcase.meshExport.simplifyTuning },
        },
        ...(() => {
            const meshOverlay =
                overrides.meshOverlay !== undefined ? overrides.meshOverlay : testcase.meshOverlay
            return meshOverlay !== undefined ? { meshOverlay } : {}
        })(),
    }
}
