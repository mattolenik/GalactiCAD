/** The video housing must preserve its flange rim and curved tee transitions. */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { load } from "js-yaml"
import { SceneInfo } from "../../src/scene/scene.mjs"
import { serializeSceneToBridgeJson } from "../../src/export/sfcc-rs/scene-bridge.mjs"
import { initSync, export_sfcc } from "../wasm/pkg/gcad_wasm.js"

initSync({ module: readFileSync(new URL("../wasm/pkg/gcad_wasm_bg.wasm", import.meta.url)) })

test("housing mesh preserves the flange rim and chamfer seams through the tee crossing", () => {
    const { source } = load(readFileSync(new URL("../../docs/manim/scenes/torture_housing.yaml", import.meta.url), "utf8")) as { source: string }
    const scene = new SceneInfo(source)
    const result = export_sfcc(serializeSceneToBridgeJson(scene.root), "{}", -23.5, 10.300000190734863 - 23.5, -23.5, 47)
    try {
        const stats = JSON.parse(result.stats_json)
        assert.equal(stats.validation.edgeIncidence, "passed")
        assert.equal(stats.validation.vertexLinks, "passed")
        assert.equal(stats.validation.faceSegments, "passed")
        const verts = result.verts
        const tris = result.tris
        // Reference roots of the uncut housing body on each cutter's cylinder,
        // on both flange faces. The source digest prevents stale geometry from
        // silently validating an edited demo. These are geometric samples, not
        // a second TypeScript implementation of the scene field.
        const reference = JSON.parse(readFileSync(new URL("./housing-hole-boundaries.json", import.meta.url), "utf8")) as {
            sourceSha256: string
            points: [number, number, number, number, number][]
        }
        assert.equal(createHash("sha256").update(source).digest("hex"), reference.sourceSha256)
        for (const cx of [-7.5, 7.5]) {
            for (const cy of [-7.5, 7.5]) {
                const edges = new Map<string, [number, number]>()
                const onHole = (id: number) => Math.abs(Math.hypot(verts[id*8]! - cx, verts[id*8+1]! - cy) - 1.4) < 1e-4
                for (let i = 0; i < tris.length; i += 3) {
                    for (let j = 0; j < 3; j++) {
                        const a = tris[i+j]!, b = tris[i+(j+1)%3]!
                        if (onHole(a) && onHole(b)) edges.set(`${Math.min(a,b)}:${Math.max(a,b)}`, [a,b])
                    }
                }
                for (const [hx,hy,x,y,z] of reference.points) {
                    if (hx !== cx || hy !== cy) continue
                    let best = Infinity
                    for (const [a,b] of edges.values()) {
                        const d = [0,1,2].map(k => verts[b*8+k]! - verts[a*8+k]!)
                        const q = [x-verts[a*8]!,y-verts[a*8+1]!,z-verts[a*8+2]!]
                        const length2 = d.reduce((sum,v) => sum+v*v, 0)
                        const t = length2 > 0 ? Math.max(0, Math.min(1, q.reduce((sum,v,k) => sum+v*d[k]!, 0)/length2)) : 0
                        const distance = Math.hypot(...q.map((v,k) => v-t*d[k]!))
                        best = Math.min(best, distance)
                    }
                    assert.ok(best <= 0.02, `hole (${cx},${cy}) boundary at (${x},${y},${z}) misses mesh edges by ${best} mm`)
                }
            }
        }
        const rim = new Set<number>()
        for (let i = 0; i < verts.length; i += 8) {
            if (Math.abs(verts[i + 2]! - 19.75) < 1e-4 && Math.abs(Math.hypot(verts[i]!, verts[i + 1]!) - 5.5) < 1e-4) rim.add(i / 8)
        }
        assert.ok(rim.size > 50, "the blend/cutter seam must be sampled explicitly")
        const angles = [...rim].map(i => Math.atan2(verts[i * 8 + 1]!, verts[i * 8]!)).sort((a, b) => a - b)
        for (let i = 0; i < angles.length; i++) {
            const gap = i + 1 < angles.length ? angles[i + 1]! - angles[i]! : angles[0]! + 2 * Math.PI - angles[i]!
            assert.ok(5.5 * (1 - Math.cos(gap / 2)) <= 0.02, "no missing arc of the rim")
        }
        let samples = 0
        let maxError = 0
        for (let t = 0; t < tris.length; t += 3) {
            const ids = [tris[t]!, tris[t + 1]!, tris[t + 2]!]
            // In this neighborhood the exact surface is the cylindrical bore
            // meeting the shifted chamfer plane. Check triangle interiors too:
            // the old mesh's vertices were on-surface while triangles bridged it.
            if (!ids.every(i => verts[i * 8 + 2]! > 19.1 && Math.hypot(verts[i * 8]!, verts[i * 8 + 1]!) < 6.2)) continue
            for (const weights of [[1/3, 1/3, 1/3], [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5]]) {
                const p = [0, 1, 2].map(k => ids.reduce((sum, id, j) => sum + weights[j]! * verts[id * 8 + k]!, 0))
                const error = Math.abs(Math.max(Math.SQRT2 * (p[2]! - 19.75), 5.5 - Math.hypot(p[0]!, p[1]!)))
                maxError = Math.max(maxError, error)
                samples++
            }
        }
        assert.ok(samples > 100, "exercise the pipe/flange neighborhood")
        assert.ok(maxError < 0.02, `rim triangle error ${maxError} exceeds chord tolerance`)

        // Screw holes cross the flat flange and the chamfer around the
        // barrel's cap/mantle rim. Outside both cylinder patches its positive
        // field is hypot(radial,z-19), not either supporting carrier alone.
        let holeSamples = 0
        let maxHoleError = 0
        for (const cx of [-7.5, 7.5]) {
            for (const cy of [-7.5, 7.5]) {
                for (let t = 0; t < tris.length; t += 3) {
                    const p = [tris[t]!, tris[t + 1]!, tris[t + 2]!].map(i => [verts[i * 8]!, verts[i * 8 + 1]!, verts[i * 8 + 2]!])
                    if (!p.every(q => q[2]! > 19.02 && Math.hypot(q[0]! - cx, q[1]! - cy) < 1.65)) continue
                    for (const weights of [[1/3, 1/3, 1/3], [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5]]) {
                        const q = [0, 1, 2].map(k => p.reduce((sum, v, j) => sum + weights[j]! * v[k]!, 0))
                        const radial = Math.hypot(q[0]!, q[1]!) - 8
                        const cap = q[2]! - 19
                        const chamfer = (Math.hypot(radial, cap) + cap - 1.5) / Math.SQRT2
                        const cutter = 1.4 - Math.hypot(q[0]! - cx, q[1]! - cy)
                        maxHoleError = Math.max(maxHoleError, Math.abs(Math.max(chamfer, cutter)))
                        holeSamples++
                    }
                }
            }
        }
        assert.ok(holeSamples > 100, "exercise screw holes through the union's curved rim region")
        assert.ok(maxHoleError < 0.02, `screw-hole triangle error ${maxHoleError} exceeds chord tolerance`)

        // The X-shaped tee boundaries are the transition from either cylinder
        // to the curved chamfer. Restrict to the exposed left-hand junction,
        // away from the bore, dent, flange, end caps and cone port.
        let junctionTriangles = 0
        let transitionEdges = 0
        let centerTriangles = 0
        let centerTransitionEdges = 0
        let straddling = 0
        for (let t = 0; t < tris.length; t += 3) {
            const p = [tris[t]!, tris[t + 1]!, tris[t + 2]!].map(i => [verts[i * 8]!, verts[i * 8 + 1]!, verts[i * 8 + 2]!])
            if (!p.every(q => q[0]! > -8.1 && q[0]! < -1 && q[1]! > -3 && q[1]! < 11 && Math.abs(q[2]!) < 10)) continue
            const a = p.map(q => Math.hypot(q[0]!, q[1]!) - 8)
            const b = p.map(q => Math.hypot(q[0]!, q[2]!) - 6.5)
            if (Math.min(...a) < -0.05 || Math.min(...b) < -0.05) continue
            junctionTriangles++
            const nearCenter = p.every(q => q[0]! < -7.6 && Math.abs(q[1]!) < 2 && Math.abs(q[2]!) < 2)
            if (nearCenter) centerTriangles++
            for (const d of [a, b]) {
                if (Math.min(...d) < 1.48 && Math.max(...d) > 1.52) straddling++
                for (let k = 0; k < 3; k++) {
                    if (Math.abs(d[k]! - 1.5) < 1e-4 && Math.abs(d[(k + 1) % 3]! - 1.5) < 1e-4) {
                        transitionEdges++
                        if (nearCenter) centerTransitionEdges++
                    }
                }
            }
        }
        assert.ok(junctionTriangles > 100, "exercise the exposed tee junction")
        assert.ok(transitionEdges > 40, "both curved chamfer transitions need explicit mesh edges")
        assert.ok(centerTriangles > 20, "exercise the shallow center of the X")
        assert.ok(centerTransitionEdges > 8, "shallow chamfer boundaries must survive near the X center")
        assert.equal(straddling, 0, "triangles must not bridge the X-shaped chamfer boundaries")
    } finally { result.free() }
})
