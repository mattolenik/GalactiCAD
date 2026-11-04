import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { DEFAULT_SFCC_TUNING, normalizeSfccTuning } from "./sfcc-tuning.mjs"

test("GUI defaults match the contract checked against the native kernel and WASM bridge", () => {
    const contract = JSON.parse(readFileSync(new URL("../../../gcad-wasm/kernel/fixtures/sfcc-defaults.json", import.meta.url), "utf8"))
    assert.deepEqual(DEFAULT_SFCC_TUNING, contract)
    assert.deepEqual(normalizeSfccTuning({}), contract)
    assert.deepEqual(normalizeSfccTuning(undefined), contract)
})

test("saved obsolete switches are dropped, while explicit experimental choices survive", () => {
    const normalized = normalizeSfccTuning({
        blendCurvatureAnalytic: true, minDihedralDeg: 80, faceSnapEpsFraction: 0.3,
        ambiguityResolution: "refine", jitterRetries: 10, failurePolicy: "throw",
        creaseAngleDeg: 90, debugOutput: true, profile: true,
        multiSheetCells: true, decimateTolMm: 0.05,
    })
    assert.deepEqual(normalized, { ...DEFAULT_SFCC_TUNING, multiSheetCells: true, decimateTolMm: 0.05 })
})

test("invalid new-option values fall back to defaults and numerical budgets remain bounded", () => {
    const normalized = normalizeSfccTuning({
        multiSheetCells: "true", decimateTolMm: NaN, surfaceTolMm: Infinity,
        depthMin: 30, depthMax: 3, qualityMaxEditTrials: 1e9,
    })
    assert.deepEqual(normalized, { ...DEFAULT_SFCC_TUNING, depthMin: 3, depthMax: 14, qualityMaxEditTrials: 100_000 })
})
