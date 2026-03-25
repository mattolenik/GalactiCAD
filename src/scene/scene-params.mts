/**
 * Pass-specific scene parameters:
 * - **Preview/beam**: three read-only **uniform** bindings (`previewParamsF32`, `previewParamsVec2`, `previewParamsVec3`).
 *   CPU packs dense `Float32Array`s; WGSL uses `array<vec4f>` for f32 and vec2 banks (four logical f32 / two logical vec2
 *   per `vec4`) and `array<vec4f>` for vec3 (xyz in `.xyz`), so each binding stays ≤64 KiB with tight memory layout.
 * - **Bounds + MDC**: separate storage buffers (`boundsSceneParams`, `mdcSceneParams`) with identical flat `f32` layout
 *   (`SceneInfo.packSceneParams()`), same indices as legacy `sp_*` codegen.
 *
 * **Updates:** Param-only worker builds re-upload all three preview banks from `packPreviewParams()` plus bounds/MDC from
 * `packSceneParams()`. Cap push/pull patches only the `previewParamsF32` shadow via `writeBuffers.previewParamsF32Patch`
 * (see `render-worker-core` / `AGENTS.md`); it does not write bounds/MDC storage mid-drag.
 *
 * `compileParamMode` selects whether TS codegen emits `pp_*` (preview) or `sp_*` (bounds/mdc) reads.
 */

/** Maximum number of f32 slots in bounds/MDC storage buffers (256 KiB each). */
export const SCENE_PARAMS_F32_CAPACITY = 65536

export const SCENE_PARAMS_BYTE_SIZE = SCENE_PARAMS_F32_CAPACITY * 4

/** Preview bank capacities (uniform buffers; sizes match WGSL `array<vec4f, 4096>` per bank). */
export const PREVIEW_UNIFORM_F32_COUNT = 16384
export const PREVIEW_UNIFORM_VEC2_COUNT = 8192
/** vec3 payloads stored as vec4 in `previewParamsVec3` (w unused). Capped so one binding stays ≤64 KiB (WebGPU min). */
export const PREVIEW_UNIFORM_VEC3_COUNT = 4096

export const PREVIEW_PARAMS_F32_BYTE_SIZE = PREVIEW_UNIFORM_F32_COUNT * 4
export const PREVIEW_PARAMS_VEC2_BYTE_SIZE = PREVIEW_UNIFORM_VEC2_COUNT * 8
export const PREVIEW_PARAMS_VEC3_BYTE_SIZE = PREVIEW_UNIFORM_VEC3_COUNT * 16

export const SCENE_PARAM_BOUNDS_F32_COUNT = 6

export type PreviewParamsOut = {
    f32: Float32Array
    vec2: Float32Array
    /** vec4 per logical vec3 slot (w unused). */
    vec3: Float32Array
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

export function ppF32Wgsl(slot: number): string {
    return `pp_f32(${slot}u)`
}

export function ppVec2Wgsl(slot: number): string {
    return `pp_vec2(${slot}u)`
}

export function ppVec3Wgsl(slot: number): string {
    return `pp_vec3(${slot}u)`
}

export function ppMat3x3Wgsl(slot: number): string {
    const c = (i: number) => ppF32Wgsl(slot + i)
    return `mat3x3f(vec3f(${c(0)}, ${c(1)}, ${c(2)}), vec3f(${c(3)}, ${c(4)}, ${c(5)}), vec3f(${c(6)}, ${c(7)}, ${c(8)}))`
}

/** Scalar: flat index for storage passes, `previewF32Slot` for preview (relative to node's f32 bank base). */
export function f32Wgsl(flatOffset: number, previewSlot: number): string {
    return compileParamMode === "preview" ? ppF32Wgsl(previewSlot) : spF32Wgsl(flatOffset)
}

export function vec2Wgsl(flatOffset: number, previewSlot: number): string {
    return compileParamMode === "preview" ? ppVec2Wgsl(previewSlot) : spVec2Wgsl(flatOffset)
}

export function vec3Wgsl(flatOffset: number, previewSlot: number): string {
    return compileParamMode === "preview" ? ppVec3Wgsl(previewSlot) : spVec3Wgsl(flatOffset)
}

export function mat3x3Wgsl(flatOffset: number, previewSlot: number): string {
    return compileParamMode === "preview" ? ppMat3x3Wgsl(previewSlot) : spMat3x3Wgsl(flatOffset)
}

/** BVH AABB: 6 consecutive f32 (center xyz, half xyz). */
export function bvhCenterWgsl(flatOff: number, previewSlot: number): string {
    if (compileParamMode === "preview") {
        return `vec3f(pp_f32(${previewSlot}u), pp_f32(${previewSlot + 1}u), pp_f32(${previewSlot + 2}u))`
    }
    return spVec3Wgsl(flatOff)
}

export function bvhHalfWgsl(flatOff: number, previewSlot: number): string {
    if (compileParamMode === "preview") {
        return `vec3f(pp_f32(${previewSlot}u), pp_f32(${previewSlot + 1}u), pp_f32(${previewSlot + 2}u))`
    }
    return spVec3Wgsl(flatOff)
}
