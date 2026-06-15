/**
 * M5 Node-side smoke test for the wasm `export_sfcc` boundary. Loads the
 * wasm-pack `--target web` pkg under Node (sync-init with the raw .wasm bytes),
 * feeds each `bridge-<name>.json` fixture through `export_sfcc`, and compares the
 * resulting mesh against the TS SFCC reference `bridge-<name>.bin` using the SAME
 * canonical (order-insensitive) compare the Rust parity tests use, with a small
 * position eps. Validates the wasm export end-to-end WITHOUT the app.
 *
 *   tsx gcad-wasm/fixtures/smoke-export-sfcc.mts
 *
 * Prereqs: `cd gcad-wasm/wasm && wasm-pack build --target web`, then
 *          `tsx gcad-wasm/fixtures/dump-bridge.mts`.
 *
 * Exits non-zero on any mismatch.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
// Generated wasm-pack ESM (web target); types come from the sibling .d.ts.
import initWasm, { export_sfcc } from "../wasm/pkg/gcad_wasm.js"

const here = dirname(fileURLToPath(import.meta.url))
const pkgWasm = join(here, "../wasm/pkg/gcad_wasm_bg.wasm")

// Scenes + cubes — MUST match dump-bridge.mts.
const SCENES: Array<{ name: string; min: [number, number, number]; size: number }> = [
    { name: "box", min: [-10, -10, -10], size: 20 },
    { name: "box-minus-sphere", min: [-10, -10, -10], size: 20 },
    { name: "lathe", min: [-3, -3, -3], size: 6 },
    { name: "extrude-twist", min: [-3.5, -3.5, -3.5], size: 7 },
    { name: "loft", min: [-3.5, -3.5, -3.5], size: 7 },
]
const TUNING = JSON.stringify({ depthMin: 4, depthMax: 7 })

// ---- canonical mesh compare (mirrors parity::meshes_equivalent, posEps) -------
function quant(v: number, eps: number): string {
    const x = v === 0 ? 0 : v
    return eps <= 0 ? String(x) : String(Math.round(x / eps))
}
function canonicalize(verts: Float32Array, tris: Uint32Array, posEps: number): { verts: string[]; tris: string[] } {
    const stride = 8
    const identity = (vi: number): string =>
        `${quant(verts[vi * stride]!, posEps)}|${quant(verts[vi * stride + 1]!, posEps)}|${quant(verts[vi * stride + 2]!, posEps)}`
    const refId = new Map<number, string>()
    for (const vi of tris) if (!refId.has(vi)) refId.set(vi, identity(vi))
    const unique = [...new Set(refId.values())].sort()
    const toCanon = new Map<string, number>(unique.map((s, i) => [s, i]))
    const out: string[] = []
    for (let t = 0; t < tris.length; t += 3) {
        const a = toCanon.get(refId.get(tris[t]!)!)!
        const b = toCanon.get(refId.get(tris[t + 1]!)!)!
        const c = toCanon.get(refId.get(tris[t + 2]!)!)!
        const rot = a <= b && a <= c ? [a, b, c] : b <= a && b <= c ? [b, c, a] : [c, a, b]
        out.push(rot.join(","))
    }
    out.sort()
    return { verts: unique, tris: out }
}
function loadBin(path: string): { verts: Float32Array; tris: Uint32Array } {
    const buf = readFileSync(path)
    const vfc = buf.readUInt32LE(0)
    const tic = buf.readUInt32LE(4)
    const verts = new Float32Array(vfc)
    for (let i = 0; i < vfc; i++) verts[i] = buf.readFloatLE(8 + i * 4)
    const tris = new Uint32Array(tic)
    for (let i = 0; i < tic; i++) tris[i] = buf.readUInt32LE(8 + vfc * 4 + i * 4)
    return { verts, tris }
}

async function main(): Promise<void> {
    await initWasm({ module_or_path: readFileSync(pkgWasm) })

    let failures = 0
    for (const sc of SCENES) {
        const sceneJson = readFileSync(join(here, `bridge-${sc.name}.json`), "utf8")
        const res = export_sfcc(sceneJson, TUNING, sc.min[0], sc.min[1], sc.min[2], sc.size)
        const wasmVerts: Float32Array = res.verts
        const wasmTris: Uint32Array = res.tris
        const stats = JSON.parse(res.stats_json)

        const ref = loadBin(join(here, `bridge-${sc.name}.bin`))
        const posEps = 1e-4 * sc.size
        const cw = canonicalize(wasmVerts, wasmTris, posEps)
        const cr = canonicalize(ref.verts, ref.tris, posEps)

        let mismatch: string | null = null
        if (cw.verts.length !== cr.verts.length) mismatch = `verts ${cw.verts.length} vs ${cr.verts.length}`
        else if (cw.tris.length !== cr.tris.length) mismatch = `tris ${cw.tris.length} vs ${cr.tris.length}`
        else {
            for (let i = 0; i < cw.verts.length; i++)
                if (cw.verts[i] !== cr.verts[i]) {
                    mismatch = `vert[${i}] ${cw.verts[i]} vs ${cr.verts[i]}`
                    break
                }
            if (!mismatch)
                for (let i = 0; i < cw.tris.length; i++)
                    if (cw.tris[i] !== cr.tris[i]) {
                        mismatch = `tri[${i}] ${cw.tris[i]} vs ${cr.tris[i]}`
                        break
                    }
        }

        if (mismatch) {
            failures++
            console.error(`✗ ${sc.name}: MISMATCH (${mismatch})`)
        } else {
            console.log(
                `✓ ${sc.name}: ${wasmVerts.length / 8} verts, ${wasmTris.length / 3} tris match TS` +
                    ` (ok=${res.ok} curves=${stats.featureCurves} χ=[${stats.euler.join(",")}])`,
            )
        }
        res.free()
    }
    if (failures > 0) {
        console.error(`\n${failures}/${SCENES.length} scenes failed`)
        process.exit(1)
    }
    console.log(`\nAll ${SCENES.length} scenes: wasm export_sfcc matches the TS SFCC reference.`)
}

await main()
