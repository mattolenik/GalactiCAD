/** Actual-WASM arithmetic and opaque-descendant exclusion regression gates. */
import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import {test} from "node:test"
import {audit_checked_partial_intervals, initSync} from "../wasm/pkg/gcad_wasm.js"
initSync({module:readFileSync(new URL("../wasm/pkg/gcad_wasm_bg.wasm",import.meta.url))})
const cylinder={kind:"cylinder",pos:[0,0,0],r:1,h:2}
const sphere={kind:"sphere",pos:[0,0,0],r:1}
const opaque={kind:"cone",pos:[0,0,0],r:1,h:2}
const interval=(scene:unknown,c:number[],h:number[])=>audit_checked_partial_intervals(JSON.stringify(scene),new Float64Array([...c,...h]))
function containsZero(v:Float64Array){assert.ok(v[0]!<=0&&v[1]!>=0,`false exclusion: ${v}`)}

test("checked WASM cylinder preserves exact grazing and minimum dimensions",()=>{
    containsZero(interval(cylinder,[1.125,0,0],[.125,.125,.125]))
    containsZero(interval({...cylinder,r:13},[5,0,12],[0,0,0]))
    containsZero(interval({...cylinder,r:1e-9,h:1e-9},[1e-6,0,0],[0,0,0]))
    // Exact dyadic anisotropy: represented matrix is deliberately nonorthogonal.
    containsZero(interval({kind:"rotate",fwd:[2,0,0,0,1,0,0,0,.5],arg:cylinder},[.5,0,0],[0,0,0]))
})
test("checked WASM keeps hidden components and thin cavity sheets",()=>{
    containsZero(interval({...sphere,r:.01,pos:[.013,.017,.019]},[0,0,0],[.1,.1,.1]))
    const shell={kind:"subtract",lh:cylinder,rh:{...cylinder,r:1-1e-8}}
    containsZero(interval(shell,[1,0,0],[.01,.01,.01]))
})
test("opaque union can establish only a one-sided bound",()=>{
    for(const mode of ["round","chamfer"]){
        const scene={kind:"union",radius:.2,mode,children:[sphere,opaque]}
        const inside=interval(scene,[0,0,0],[.1,.1,.1])
        assert.equal(inside[0],-Infinity);assert.ok(inside[1]!<0)
        containsZero(interval(scene,[4,0,0],[.1,.1,.1]))
    }
})
test("checked WASM preserves subnormal uncertainty and invalid arithmetic",()=>{
    const scale=Number.MIN_VALUE
    containsZero(interval({kind:"scale",sx:scale,sy:scale,sz:scale,arg:cylinder},[0,0,0],[scale,scale,scale]))
    const huge={kind:"rotate",fwd:Array(9).fill(Number.MAX_VALUE),arg:cylinder}
    assert.ok(Array.from(interval(huge,[2,2,2],[1,1,1])).every(Number.isNaN))
    assert.ok(Array.from(interval(sphere,[NaN,0,0],[1,1,1])).every(Number.isNaN))
})
