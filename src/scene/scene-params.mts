/**
 * Pass-specific scene parameters:
 * - **Preview/beam**: read-only **uniform** bindings (`previewParamsF32`, `previewParamsVec2`, `previewParamsVec3`, `previewParamsMat3`, `previewCapParamDrag`).
 *   `previewCapParamDrag` mirrors the f32 bank layout (`vec4`-packed) for live cap push/pull; it must stay a **uniform** so the fragment stage does not exceed the storage-buffer-per-stage limit (10).
 *   CPU packs typed `Float32Array`s; WGSL uses `array<vec4f>` for f32/vec2 banks (direct `.x/.y/.z/.w` and `.xy/.zw` access), `array<vec4f>` for vec3 (`.xyz`),
 *   and `array<mat3x3f>` for preview rotation matrices.
 * - **Bounds + MDC**: separate storage buffers (`boundsSceneParams`, `mdcSceneParams`) with identical flat `f32` layout
 *   (`SceneInfo.packSceneParams()`), same indices as legacy `sp_*` codegen (including BVH AABBs).
 *   Preview/beam read BVH bounds from `previewParamsVec3` instead of storage.
 *
 * **Updates:** Param-only worker builds re-upload preview banks from `packPreviewParams()` plus bounds/MDC from `packSceneParams()`.
 * Cap push/pull patches **`previewCapParamDrag`** (8-byte `writeBuffer` at the cap slot from CPU shadow after patching two `f32`; `previewParamsF32` is not re-uploaded mid-drag).
 *
 * `compileParamMode` selects whether TS codegen emits direct preview reads or `sp_*` (bounds/mdc) reads.
 */

/** Maximum number of f32 slots in bounds/MDC storage buffers (256 KiB each). */
export const SCENE_PARAMS_F32_CAPACITY = 65536

export const SCENE_PARAMS_BYTE_SIZE = SCENE_PARAMS_F32_CAPACITY * 4

/** Preview bank capacities (uniform buffers; sizes match WGSL `array<vec4f, 4096>` per vec4 bank). */
export const PREVIEW_UNIFORM_F32_COUNT = 16384
export const PREVIEW_UNIFORM_VEC2_COUNT = 8192
/** vec3 payloads stored as vec4 in `previewParamsVec3` (w unused). Capped so one binding stays ≤64 KiB (WebGPU min). */
export const PREVIEW_UNIFORM_VEC3_COUNT = 4096
/** mat3x3 in uniform: 48 bytes each (9 f32 + 3 padding per column); cap so one binding stays ≤64 KiB. */
export const PREVIEW_UNIFORM_MAT3_COUNT = 1024
/** Floats per mat3 in CPU pack / uniform layout (3 columns × vec4). */
export const PREVIEW_MAT3_PACK_FLOATS = 12

export const PREVIEW_PARAMS_F32_BYTE_SIZE = PREVIEW_UNIFORM_F32_COUNT * 4
export const PREVIEW_PARAMS_VEC2_BYTE_SIZE = PREVIEW_UNIFORM_VEC2_COUNT * 8
export const PREVIEW_PARAMS_VEC3_BYTE_SIZE = PREVIEW_UNIFORM_VEC3_COUNT * 16
export const PREVIEW_PARAMS_MAT3_BYTE_SIZE = PREVIEW_UNIFORM_MAT3_COUNT * 48

export const SCENE_PARAM_BOUNDS_F32_COUNT = 6

export type PreviewParamsOut = {
    f32: Float32Array
    vec2: Float32Array
    /** vec4 per logical vec3 slot (w unused). */
    vec3: Float32Array
    /** Column-major mat3x3, std140-like: 3 columns as vec4 (xyz + pad). */
    mat3: Float32Array
}

export type CompileParamMode = "preview" | "storage"

/** Set during `SceneInfo.compile*` / `compile*ForPreview` before walking the tree. */
export let compileParamMode: CompileParamMode = "storage"

export function setCompileParamMode(m: CompileParamMode): void {
    compileParamMode = m
}

/** WGSL: read one scalar from flat `bounds`/`mdc` storage at f32 index `offset`. */
export function spF32Wgsl(offset: number): string {
    return `sp_f32(${offset}u)`
}

export function spVec3Wgsl(offset: number): string {
    return `sp_vec3(${offset}u)`
}

export function spVec2Wgsl(offset: number): string {
    return `sp_vec2(${offset}u)`
}

export function spMat3x3Wgsl(offset: number): string {
    const c = (i: number) => spF32Wgsl(offset + i)
    return `mat3x3f(vec3f(${c(0)}, ${c(1)}, ${c(2)}), vec3f(${c(3)}, ${c(4)}, ${c(5)}), vec3f(${c(6)}, ${c(7)}, ${c(8)}))`
}

const SWIZ = ["x", "y", "z", "w"] as const

/** Direct uniform: one logical f32 slot → vec4 bank index + component. */
export function ppF32Wgsl(slot: number): string {
    const qi = slot >> 2
    const comp = SWIZ[slot & 3]!
    return `previewParamsF32[${qi}u].${comp}`
}

export function ppVec2Wgsl(slot: number): string {
    const qi = slot >> 1
    const sw = (slot & 1) === 0 ? "xy" : "zw"
    return `previewParamsVec2[${qi}u].${sw}`
}

export function ppVec3Wgsl(slot: number): string {
    return `previewParamsVec3[${slot}u].xyz`
}

export function ppMat3x3Wgsl(matSlot: number): string {
    return `previewParamsMat3[${matSlot}u]`
}

/**
 * Cap half-height and Y offset for extrude / loft / threaded_rod: preview reads live drag values from
 * `previewCapParamDrag` (uniform vec4 bank, same layout as `previewParamsF32`); bounds/MDC use flat storage.
 */
export function capDragOrF32Wgsl(flatOffset: number, previewF32Slot: number): string {
    return compileParamMode === "preview" ? capDragF32Wgsl(previewF32Slot) : spF32Wgsl(flatOffset)
}

function capDragF32Wgsl(slot: number): string {
    const qi = slot >> 2
    const comp = SWIZ[slot & 3]!
    return `previewCapParamDrag[${qi}u].${comp}`
}

/** Scalar: flat index for storage passes, `previewF32Slot` for preview (logical f32 index into typed banks). */
export function f32Wgsl(flatOffset: number, previewSlot: number): string {
    return compileParamMode === "preview" ? ppF32Wgsl(previewSlot) : spF32Wgsl(flatOffset)
}

export function vec2Wgsl(flatOffset: number, previewSlot: number): string {
    return compileParamMode === "preview" ? ppVec2Wgsl(previewSlot) : spVec2Wgsl(flatOffset)
}

export function vec3Wgsl(flatOffset: number, previewSlot: number): string {
    return compileParamMode === "preview" ? ppVec3Wgsl(previewSlot) : spVec3Wgsl(flatOffset)
}

/** `previewMat3Slot` is the matrix-bank index (preview only); `flatOffset` is the scene-param index for storage. */
export function mat3x3Wgsl(flatOffset: number, previewMat3Slot: number): string {
    return compileParamMode === "preview" ? ppMat3x3Wgsl(previewMat3Slot) : spMat3x3Wgsl(flatOffset)
}

/**
 * BVH AABB for union guards: preview/beam read center + half from `previewParamsVec3` (`pp_*`);
 * bounds/MDC use flat `packSceneParams()` via `sp_*`.
 */
export function bvhCenterWgsl(flatOff: number, previewBvhVec3Slot: number): string {
    return compileParamMode === "preview" ? ppVec3Wgsl(previewBvhVec3Slot) : spVec3Wgsl(flatOff)
}

export function bvhHalfWgsl(flatOff: number, previewBvhVec3Slot: number): string {
    return compileParamMode === "preview" ? ppVec3Wgsl(previewBvhVec3Slot + 1) : spVec3Wgsl(flatOff + 3)
}

/** Pack 9 column-major floats (3×3) into one mat3 uniform slot (12 floats with column padding). */
export function packMat3ColumnMajorToPreviewOut(outMat3: Float32Array, matSlot: number, colMajor9: ArrayLike<number>): void {
    const base = matSlot * PREVIEW_MAT3_PACK_FLOATS
    for (let c = 0; c < 3; c++) {
        const o = base + c * 4
        outMat3[o] = colMajor9[c * 3]!
        outMat3[o + 1] = colMajor9[c * 3 + 1]!
        outMat3[o + 2] = colMajor9[c * 3 + 2]!
        outMat3[o + 3] = 0
    }
}
