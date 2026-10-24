/** Preserve real straight creases when a constrained filling remains unsupported. */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { load } from "js-yaml"
import { SceneInfo } from "../../src/scene/scene.mjs"
import { serializeSceneToBridgeJson } from "../../src/export/sfcc-rs/scene-bridge.mjs"
import { inspectMesh } from "../../test/acceptance/sdf-meshing/diagnostics.mjs"
import { saveRepairEvidence } from "./sfcc-repair-evidence.mjs"
import { initSync, export_sfcc } from "../wasm/pkg/gcad_wasm.js"

type Span = {curveId:number; range:[number,number]; positions:[number[],number[]]}
type Case = {sourceSha256:string; cube:[number,number,number,number]; spans:Span[]}
const baseline = JSON.parse(readFileSync(new URL("./sfcc-collateral-creases.json",import.meta.url),"utf8")) as {cases:Record<string,Case>}
initSync({module:readFileSync(new URL("../wasm/pkg/gcad_wasm_bg.wasm",import.meta.url))})

for (const model of ["knob","mess2"]) test(`${model} retains analytic crease constraints in unresolved best-effort output`, t => {
    const expected=baseline.cases[model]!
    const {source}=load(readFileSync(new URL(`../../docs/manim/scenes/torture_${model}.yaml`,import.meta.url),"utf8")) as {source:string}
    assert.equal(createHash("sha256").update(source).digest("hex"),expected.sourceSha256)
    const scene=serializeSceneToBridgeJson(new SceneInfo(source).root)
    const result=export_sfcc(scene,"{}",...expected.cube)
    try {
        const stats=JSON.parse(result.stats_json),verts=result.verts,tris=result.tris,features=result.feature_edges
        const audit=inspectMesh(verts,tris,features)
        saveRepairEvidence(t.name,scene,result,[],audit)
        const invalid=new Set(audit.defects.map(d=>d.triangle)),validEdges=new Set<string>()
        const key=(a:number,b:number)=>`${Math.min(a,b)}:${Math.max(a,b)}`
        for(let i=0;i<tris.length;i+=3)if(!invalid.has(i/3))for(let k=0;k<3;k++)validEdges.add(key(tris[i+k]!,tris[i+(k+1)%3]!))
        const rows=new Map<number,Array<{a:number;b:number;lo:number;hi:number}>>()
        for(let i=0;i<features.length;i+=5){
            const [a,b,id,start,end]=Array.from(features.subarray(i,i+5)) as [number,number,number,number,number]
            if(!validEdges.has(key(a,b)))continue
            if(!rows.has(id))rows.set(id,[])
            rows.get(id)!.push({a,b,lo:Math.min(start,end),hi:Math.max(start,end)})
        }
        let maximum=0
        for(const span of expected.spans){
            const edges=rows.get(span.curveId)??[]
            let end=span.range[0]
            for(const e of edges.toSorted((a,b)=>a.lo-b.lo))if(e.lo<=end+1e-10)end=Math.max(end,e.hi)
            assert.ok(end>=span.range[1]-1e-10,`lost analytic curve ${span.curveId} interval ${span.range}`)
            for(const u of [0,.25,.5,.75,1]){
                const p=span.positions[0].map((x,k)=>x*(1-u)+span.positions[1][k]!*u)
                let best=Infinity
                for(const e of edges){
                    const a=[0,1,2].map(k=>verts[e.a*8+k]!),d=[0,1,2].map(k=>verts[e.b*8+k]!-a[k]!)
                    const length2=d.reduce((s,x)=>s+x*x,0)
                    const v=length2?Math.max(0,Math.min(1,d.reduce((s,x,k)=>s+x*(p[k]!-a[k]!),0)/length2)):0
                    best=Math.min(best,Math.hypot(...p.map((x,k)=>x-a[k]!-v*d[k]!)))
                }
                maximum=Math.max(maximum,best)
                assert.ok(best<=1e-5,`analytic crease ${span.curveId} was flattened by ${best} mm`)
            }
        }
        // These models remain unsupported. Retaining a crease must not turn the
        // known malformed filling into an accepted cell or a coverage certificate.
        assert.equal(stats.validation.localCoverage.scope,"outsideScope")
        assert.equal(stats.validation.localCoverage.certifiedCells,0)
        assert.ok(stats.validation.localCoverage.unresolved.some((w:{reason:string})=>w.reason==="constrained_fan_unresolved"))
        assert.notEqual(stats.validation.status,"passed")
        t.diagnostic(JSON.stringify({triangles:tris.length/3,invalidTriangles:audit.invalidTriangles,spans:expected.spans.length,maxCreaseDistance:maximum,
            unresolvedFillings:stats.validation.localCoverage.unresolved.length,featureChains:stats.validation.featureChains.status}))
    } finally { result.free() }
})
