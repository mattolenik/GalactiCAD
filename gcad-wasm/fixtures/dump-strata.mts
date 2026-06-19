/**
 * M4a carrier + curved-feature parity fixture. Closes the M4a-foundation gap:
 * strata CARRIER geometry (f/normal) is now verified against TS, not just the
 * feature extraction. Per scene dumps the baked similarity, the strata' f/normal
 * at a deterministic point cloud, and (cylinder/cone) the native curves/corners.
 * New file (does not touch sibling-owned dumpers/Makefile). Regenerate with
 * `tsx gcad-wasm/fixtures/dump-strata.mts`; `*.txt` gitignored.
 *
 * Text format, per scene:
 *   SCENE <name>
 *   SIM r0..r8 t0 t1 t2 s
 *   SHAPE <box hx hy hz | cylinder r h | cone r h | sphere r>
 *   POS px py pz
 *   NPTS k          then k lines "x y z"
 *   NSTRATA m       then m blocks: "STRATUM <kind>" then k lines "f nx ny nz"
 *   NCURVES nc      then nc lines "CURVE <kind> s0 s1  x0 y0 z0 .. x3 y3 z3" (t=0,.25,.5,.75)
 *   NCORNERS nk     then nk lines "CORNER x y z s0 s1 .."
 */
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { Box } from "../../src/scene/primitives/box.mjs"
import { Cylinder } from "../../src/scene/primitives/cylinder.mjs"
import { Cone } from "../../src/scene/primitives/cone.mjs"
import { Sphere } from "../../src/scene/primitives/sphere.mjs"
import { Rotate } from "../../src/scene/operators/rotate.mjs"
import { Translate } from "../../src/scene/operators/translate.mjs"
import type { Node } from "../../src/scene/base.mjs"
import { compileCpuSdf } from "../../src/export/sfcc/cpu-sdf.mjs"
import { compileNativeFeatures } from "../../src/export/sfcc/feature-set.mjs"
import { applyPoint } from "../../src/export/sfcc/transform-bake.mjs"

const here = dirname(fileURLToPath(import.meta.url))

function lcg(seed: number): () => number {
    let s = seed >>> 0
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0
        return s / 0x100000000
    }
}

const lines: string[] = []
const n3 = new Float64Array(3)
const p = new Float64Array(3)

function emit(name: string, shapeLine: string, pos: [number, number, number], maxDim: number, scene: Node, features: boolean): void {
    const tree = compileCpuSdf(scene)
    const leaf = tree.leaves[0]!
    const sim = leaf.sim
    lines.push(`SCENE ${name}`)
    lines.push(`SIM ${Array.from(sim.r).join(" ")} ${Array.from(sim.t).join(" ")} ${sim.s}`)
    lines.push(shapeLine)
    lines.push(`POS ${pos[0]} ${pos[1]} ${pos[2]}`)

    const rnd = lcg(0x5fce + name.length * 131)
    applyPoint(sim, pos[0], pos[1], pos[2], p)
    const [cx, cy, cz] = [p[0]!, p[1]!, p[2]!]
    const range = 2.5 * sim.s * maxDim
    const K = 48
    const pts: [number, number, number][] = []
    for (let i = 0; i < K; i++) {
        pts.push([cx + (rnd() * 2 - 1) * range, cy + (rnd() * 2 - 1) * range, cz + (rnd() * 2 - 1) * range])
    }
    lines.push(`NPTS ${K}`)
    for (const q of pts) lines.push(`${q[0]} ${q[1]} ${q[2]}`)

    const strata = leaf.strata
    lines.push(`NSTRATA ${strata.length}`)
    for (const st of strata) {
        lines.push(`STRATUM ${st.kind}`)
        for (const q of pts) {
            const f = st.f(q[0], q[1], q[2])
            st.normal(q[0], q[1], q[2], n3)
            lines.push(`${f} ${n3[0]} ${n3[1]} ${n3[2]}`)
        }
    }

    if (features) {
        const fs = compileNativeFeatures(tree)
        lines.push(`NCURVES ${fs.curves.length}`)
        for (const c of fs.curves) {
            const samples: string[] = []
            for (const t of [0, 0.25, 0.5, 0.75]) {
                c.pointAt(t, p)
                samples.push(`${p[0]} ${p[1]} ${p[2]}`)
            }
            lines.push(`CURVE ${c.kind} ${c.adjacentStrata[0]} ${c.adjacentStrata[1]} ${samples.join(" ")}`)
        }
        lines.push(`NCORNERS ${fs.corners.length}`)
        for (const k of fs.corners) lines.push(`CORNER ${k.x} ${k.y} ${k.z} ${k.strata.join(" ")}`)
    } else {
        lines.push(`NCURVES 0`)
        lines.push(`NCORNERS 0`)
    }
}

// Shape params are read back from the primitive nodes (NOT hardcoded): the scene
// primitives store pos/size as f32 (Vec3f), so the f64 the Rust side must rebuild
// with is the f32-rounded value — dumping the node's own numbers keeps both sides
// bit-consistent (matching dump-features.mts).

// Box: plane-carrier coverage (feature extraction itself is gated by features_parity).
const boxP = new Box([1, 2, 3], [0.5, 0.6, 0.7])
emit("box", `SHAPE box ${boxP.size.x} ${boxP.size.y} ${boxP.size.z}`, [boxP.pos.x, boxP.pos.y, boxP.pos.z], 0.7, new Translate([2, -1, 0.5], new Rotate([30, 40, 50], boxP)), false)
// Cylinder: cylinder + plane carriers, 2 rim circles.
const cylP = new Cylinder([0.3, -0.4, 0.2], { r: 4, h: 7 })
emit("cylinder", `SHAPE cylinder ${cylP.r} ${cylP.h}`, [cylP.pos.x, cylP.pos.y, cylP.pos.z], 7, new Translate([1, 0, -2], new Rotate([20, -35, 15], cylP)), true)
// Cone: cone + plane carriers, base circle + apex corner.
const coneP = new Cone([0.1, 0.2, -0.1], { r: 3, h: 5 })
emit("cone", `SHAPE cone ${coneP.r} ${coneP.h}`, [coneP.pos.x, coneP.pos.y, coneP.pos.z], 5, new Translate([-1, 2, 1], new Rotate([10, 25, -40], coneP)), true)
// Sphere: sphere carrier, no features.
const sphP = new Sphere([0.2, -0.3, 0.4], { r: 2.5 })
emit("sphere", `SHAPE sphere ${sphP.r}`, [sphP.pos.x, sphP.pos.y, sphP.pos.z], 2.5, new Translate([0.5, 0.5, 0.5], new Rotate([5, 5, 5], sphP)), false)

writeFileSync(join(here, "strata.txt"), lines.join("\n") + "\n")
console.log(`wrote strata.txt: ${lines.length} lines (box/cylinder/cone/sphere)`)
