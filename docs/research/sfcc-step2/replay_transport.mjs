// Compare actual binary64 inputs and replay native query bits through the current WASM package.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { initSync, audit_field_intervals } from "../../../gcad-wasm/wasm/pkg/gcad_wasm.js"
const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url)))
initSync({ module: readFileSync(new URL("../../../gcad-wasm/wasm/pkg/gcad_wasm_bg.wasm", import.meta.url)) })
const cases = read("inputs.json"), native = read("native-bounds.json"), wasm = read("wasm-bounds.json")
const view = new DataView(new ArrayBuffer(8))
const bits = value => {
    view.setFloat64(0, value, false)
    return view.getBigUint64(0, false).toString(16).padStart(16, "0")
}
const fromBits = value => {
    view.setBigUint64(0, BigInt("0x" + value), false)
    return view.getFloat64(0, false)
}
let queryRows = 0, endpointRows = 0
assert.equal(cases.length, native.length)
assert.equal(native.length, wasm.length)
for (let i = 0; i < cases.length; ++i) {
    assert.deepEqual(native[i].inputs, wasm[i].inputs)
    const query = new Float64Array(native[i].query.map(fromBits))
    const replay = Array.from(audit_field_intervals(JSON.stringify(cases[i].scene), query)).slice(0, 4).map(bits)
    assert.deepEqual(replay, native[i].bounds, `target difference at identical captured inputs, case ${i}`)
    queryRows += Number(native[i].query.some((v, k) => v !== wasm[i].query[k]))
    endpointRows += Number(native[i].bounds.some((v, k) => v !== wasm[i].bounds[k]))
}
console.log(`${cases.length} baked leaf bitsets match; ${queryRows} raw query rows and ${endpointRows} endpoint rows differ; zero endpoint differences with native query bits replayed`)
