import type { CameraSettings } from "../storage/settings.mjs"
import type { MdcExportLevers, ShrecTuning, SimplifyTuning } from "../render-worker-protocol.mjs"

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
 * Frozen snapshot for agent render replay (GET /_agent/render) and diffs.
 * `sourceBase64` is UTF-8 scene text (e.g. .gcad) encoded for JSON transport.
 */
export interface AgentTestcaseJson {
    schemaVersion: typeof AGENT_TESTCASE_SCHEMA_VERSION
    sourceBase64: string
    camera: CameraSettings
    viewCenter: [number, number]
    /** Use 1.0 for full-res agent captures; included for future parity. */
    resolutionScale: number
    viewportWidth: number
    viewportHeight: number
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
    meshExport: AgentTestcaseMeshExport
    documentName?: string
}

/** UTF-8 → base64 (browser / app main thread). */
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

export function buildAgentTestcase(input: BuildAgentTestcaseInput): AgentTestcaseJson {
    return {
        schemaVersion: AGENT_TESTCASE_SCHEMA_VERSION,
        sourceBase64: utf8ToBase64(input.sourceUtf8),
        camera: { ...input.camera },
        viewCenter: [input.viewCenter[0], input.viewCenter[1]],
        resolutionScale: input.resolutionScale,
        viewportWidth: input.viewportWidth,
        viewportHeight: input.viewportHeight,
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
    meshExport: AgentTestcaseMeshExport
    documentName?: string
}

function assertAgentTestcaseSchema(tc: { schemaVersion?: number }): void {
    if (tc.schemaVersion !== AGENT_TESTCASE_SCHEMA_VERSION) {
        throw new Error(`Unsupported agent testcase schemaVersion: ${String(tc.schemaVersion)}`)
    }
}

/** Merge saved testcase JSON with optional overrides (GET query / POST body). */
export function mergeAgentRenderRequest(
    testcase: AgentTestcaseJson,
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
        sourceBase64: testcase.sourceBase64,
        camera: { ...testcase.camera },
        viewCenter: [testcase.viewCenter[0], testcase.viewCenter[1]],
        resolutionScale: testcase.resolutionScale,
        viewportWidth: w,
        viewportHeight: h,
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
