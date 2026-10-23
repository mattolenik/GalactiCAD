import type { SDFRenderer } from "../sdf.mjs"
import type { MeshData } from "../export/export.mjs"
import type { AgentRenderRequest } from "./agent-testcase.mjs"
import { base64ToUtf8 } from "./agent-testcase.mjs"
import { imageDataToPngBase64 } from "./image-to-png.mjs"
import { flatFaceNormals } from "../export/crease-split.mjs"

export type AcceptanceRequest = {
    kind: "meshAcceptance"
    action: "prepare" | "export" | "restore" | "view" | "clear"
    captureId: string
    request?: AgentRenderRequest
    mode?: "sdf" | "mesh" | "wire"
    camera?: AgentRenderRequest["camera"]
    viewCenter?: [number, number]
    artifact?: { sourceSha256: string; meshDigest: string; verts: string; tris: string; features: string }
}

async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("")
}

function base64(bytes: Uint8Array): string {
    let out = ""
    for (let i = 0; i < bytes.length; i += 32768) out += String.fromCharCode(...bytes.subarray(i, i + 32768))
    return btoa(out)
}

/** Keep indexed geometry/feature identities for measurement; match production display normals. */
export function acceptanceDisplayMesh(mesh: MeshData): MeshData {
    return flatFaceNormals(mesh.verts, mesh.tris)
}

/** A single retained artifact, owned by the existing serialized agent RPC queue. */
export class MeshAcceptanceCapture {
    private state?: { id: string; req: AgentRenderRequest; source: string; sourceSha256: string; mesh?: MeshData; displayMesh?: MeshData; meshDigest?: string; attempted: boolean }

    constructor(private readonly renderer: SDFRenderer) {}

    async run(input: AcceptanceRequest): Promise<Record<string, unknown>> {
        if (!input || typeof input.captureId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.captureId)) throw new Error("Invalid capture ID")
        if (input.action === "prepare") {
            if (this.state) throw new Error("Capture already prepared; clear it before preparing another")
            const req = input.request
            if (!req || req.meshExport?.exporter !== "sfcc-rs" || req.meshExport.simplifyOnExport !== false) throw new Error("Acceptance capture requires explicit sfcc-rs with simplification disabled")
            if (req.previewUvRect || req.isolatedIds?.length || req.selectedObjectIds?.length) throw new Error("Acceptance capture requires the full unselected scene")
            for (const dim of [req.viewportWidth, req.viewportHeight]) {
                if (!Number.isInteger(dim) || dim! < 1 || dim! > 2048) throw new Error("Acceptance capture dimensions must be explicit, in [1,2048]")
            }
            const source = base64ToUtf8(req.sourceBase64).trim()
            const sourceSha256 = await digest(new TextEncoder().encode(source))
            this.state = { id: input.captureId, req, source, sourceSha256, attempted: false }
            const adapter = await navigator.gpu?.requestAdapter()
            return { captureId: input.captureId, sourceSha256, browser: navigator.userAgent,
                gpuInfoSource: "Default navigator.gpu adapter; render-worker adapter identity is not exposed",
                gpu: adapter ? { ...Object.fromEntries(["vendor", "architecture", "device", "description"].map(k => [k, (adapter.info as unknown as Record<string, string>)[k]])) } : null }
        }
        const s = this.state
        if (!s || s.id !== input.captureId) throw new Error("Missing or stale acceptance capture")
        const identity = { captureId: s.id, sourceSha256: s.sourceSha256 }
        if (input.action === "clear") { this.state = undefined; return identity }
        if (input.action === "restore") {
            if (s.attempted) throw new Error("This capture already has an export attempt/artifact")
            const a = input.artifact
            if (!a || a.sourceSha256 !== s.sourceSha256) throw new Error("Replay source mismatch")
            const fields = [a.verts, a.tris, a.features]
            if (fields.some(x => typeof x !== "string") || fields.reduce((n, x) => n + x.length, 0) > 128 * 1024 * 1024) throw new Error("Invalid or oversized replay artifact")
            const [vb, tb, fb] = fields.map(x => Uint8Array.from(atob(x), c => c.charCodeAt(0)))
            if (vb.length % 32 || tb.length % 12 || fb.length % 40) throw new Error("Replay buffer layout mismatch")
            const hashes = await Promise.all([vb, tb, fb].map(digest))
            const meshDigest = await digest(new TextEncoder().encode(hashes.join("\n")))
            if (meshDigest !== a.meshDigest) throw new Error("Replay mesh digest mismatch")
            const verts = new Float32Array(vb.buffer), tris = new Uint32Array(tb.buffer)
            if (tris.some(i => i >= verts.length / 8)) throw new Error("Replay triangle index outside vertex buffer")
            s.mesh = { verts, tris }
            s.meshDigest = meshDigest
            s.attempted = true
            return { ...identity, meshDigest, triangles: tris.length / 3, vertices: verts.length / 8, replayed: true }
        }
        if (input.action === "export") {
            if (s.attempted) throw new Error("This capture already attempted export; views must reuse its artifact")
            s.attempted = true
            const start = performance.now()
            s.mesh = await this.renderer.renderMesh(s.source, s.req.documentName, { ...s.req.meshExport, agentAutomation: true })
            const pipelineMs = performance.now() - start
            const mesh = s.mesh
            const sfcc = mesh.debug?.sfcc
            if (!sfcc?.execution || !sfcc.validation) throw new Error("SFCC execution metadata/validation missing")
            const buffers = { verts: mesh.verts, tris: mesh.tris, features: sfcc.featureEdges ?? new Float64Array(0) }
            const artifacts: Record<string, { base64: string; bytes: number; sha256: string }> = {}
            for (const [name, data] of Object.entries(buffers)) {
                const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                artifacts[name] = { base64: base64(bytes), bytes: bytes.length, sha256: await digest(bytes) }
            }
            s.meshDigest = await digest(new TextEncoder().encode(["verts", "tris", "features"].map(k => artifacts[k].sha256).join("\n")))
            return { ...identity, meshDigest: s.meshDigest, pipelineMs, triangles: mesh.tris.length / 3, vertices: mesh.verts.length / 8,
                execution: { ...sfcc.execution, sceneSha256: await digest(new TextEncoder().encode(sfcc.execution.sceneJson)) }, stats: sfcc.stats, validation: sfcc.validation, artifacts }
        }
        if (input.action !== "view" || !["sdf", "mesh", "wire"].includes(input.mode!)) throw new Error("Invalid acceptance action/view")
        const camera = input.camera ?? s.req.camera
        const center = input.viewCenter ?? s.req.viewCenter
        const width = s.req.viewportWidth!, height = s.req.viewportHeight!
        const cameraSignature = await digest(new TextEncoder().encode(JSON.stringify({ camera, center, width, height })))
        const start = performance.now()
        let pixels: ImageData
        if (input.mode === "sdf") {
            pixels = await this.renderer.agentPreviewPixels(s.source, camera, center, width, height, s.req.documentName)
        } else {
            if (!s.mesh || !s.meshDigest) throw new Error("No successfully captured mesh for this view")
            const { captureAgentMeshImageData } = await import("./agent-mesh-capture.mjs")
            s.displayMesh ??= acceptanceDisplayMesh(s.mesh)
            pixels = await captureAgentMeshImageData(s.displayMesh, camera, center, width, height, { renderNormals: true, wireframe: input.mode === "wire", theme: "dark" })
        }
        if (pixels.width !== width || pixels.height !== height) throw new Error(`Capture dimensions changed: ${pixels.width}x${pixels.height}, expected ${width}x${height}`)
        return { ...identity, meshDigest: input.mode === "sdf" ? null : s.meshDigest, cameraSignature,
            normalMode: input.mode === "sdf" ? "sdfAnalytical" : "flatFaceNormals",
            width, height, captureMs: performance.now() - start, pngBase64: await imageDataToPngBase64(pixels) }
    }
}
