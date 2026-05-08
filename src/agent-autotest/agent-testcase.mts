import yaml from "js-yaml"
import type { CameraSettings } from "../storage/settings.mjs"
import type { MdcExportLevers, ShrecTuning, SimplifyTuning } from "../render-worker-protocol.mjs"
import type { CanvasPreviewUvRect } from "../layout/editor-layout.mjs"

export const AGENT_TESTCASE_SCHEMA_VERSION = 1 as const

/** Mesh / export knobs only (no visual preview toggles). Matches `renderMesh` options shape. */
export interface AgentTestcaseMeshExport {
    simplifyOnExport: boolean
    voxelSizeMm: number
    exporter: "mdc" | "shrec"
    shrecTuning: ShrecTuning
    simplifyTuning: SimplifyTuning
    mdcExportLevers: MdcExportLevers
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
    /** Matches interactive preview (`1` full, `0.5` during camera half-res motion when optimization is on). */
    resolutionScale: number
    viewportWidth: number
    viewportHeight: number
    /**
     * Visible SDF preview on the full canvas (shader UV: u left→right, v bottom→top).
     * When present, agent renders crop to this rect so PNGs omit the editor overlay.
     */
    previewUvRect?: CanvasPreviewUvRect
    meshExport: AgentTestcaseMeshExport
    /** Active document tab name when captured, if any. */
    documentName?: string
}

export interface BuildAgentTestcaseInput {
    sourceUtf8: string
    camera: CameraSettings
    viewCenter: [number, number]
    resolutionScale: number
    viewportWidth: number
    viewportHeight: number
    previewUvRect?: CanvasPreviewUvRect
    meshExport: AgentTestcaseMeshExport
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
        resolutionScale: input.resolutionScale,
        viewportWidth: input.viewportWidth,
        viewportHeight: input.viewportHeight,
        ...(input.previewUvRect !== undefined ? { previewUvRect: { ...input.previewUvRect } } : {}),
        meshExport: {
            simplifyOnExport: input.meshExport.simplifyOnExport,
            voxelSizeMm: input.meshExport.voxelSizeMm,
            exporter: input.meshExport.exporter,
            shrecTuning: { ...input.meshExport.shrecTuning },
            simplifyTuning: { ...input.meshExport.simplifyTuning },
            mdcExportLevers: { ...input.meshExport.mdcExportLevers },
        },
        ...(input.documentName !== undefined ? { documentName: input.documentName } : {}),
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

/** Single render request for WS / HTTP agent automation. */
export interface AgentRenderRequest {
    mode: AgentRenderMode
    sourceBase64: string
    camera: CameraSettings
    viewCenter: [number, number]
    resolutionScale: number
    viewportWidth: number
    viewportHeight: number
    previewUvRect?: CanvasPreviewUvRect
    meshExport: AgentTestcaseMeshExport
    documentName?: string
}

/** Merge saved testcase YAML (in-memory `AgentTestcase`) with optional overrides (GET query / POST body). */
export function mergeAgentRenderRequest(
    testcase: AgentTestcase,
    overrides: Partial<Pick<AgentRenderRequest, "mode">> & {
        viewportWidth?: number
        viewportHeight?: number
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
        resolutionScale: testcase.resolutionScale,
        viewportWidth: w,
        viewportHeight: h,
        ...(testcase.previewUvRect !== undefined
            ? { previewUvRect: { ...testcase.previewUvRect } }
            : {}),
        meshExport: {
            simplifyOnExport: testcase.meshExport.simplifyOnExport,
            voxelSizeMm: testcase.meshExport.voxelSizeMm,
            exporter: testcase.meshExport.exporter,
            shrecTuning: { ...testcase.meshExport.shrecTuning },
            simplifyTuning: { ...testcase.meshExport.simplifyTuning },
            mdcExportLevers: { ...testcase.meshExport.mdcExportLevers },
        },
        documentName: testcase.documentName,
    }
}
