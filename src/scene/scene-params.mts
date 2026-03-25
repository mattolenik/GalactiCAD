/**
 * Packed scene parameter buffer: one `array<f32>` storage buffer shared across every SDF consumer.
 *
 * **Single GPU buffer** — `RenderWorkerCore.#uniformBuffers.sceneParams` (size `SCENE_PARAMS_BYTE_SIZE`).
 * Preview fragment pass, beam pre-pass (`beamMarch` in the same module as `preview.wgsl`), bounds compute,
 * and `MDCExport` all bind this exact buffer instance. WGSL `@binding` numbers differ per shader
 * (preview/beam: 19, bounds: 6, MDC: 30); only the binding slot changes — byte contents and f32 indices
 * are identical.
 *
 * **Layout** — `SceneInfo.packSceneParams()` after `build()` fills per-node slices (`writeSceneParams`) plus
 * the tail BVH AABB region. Generated WGSL uses `sp_f32` / `sp_vec3` (`scene_params_read.wgsl`) with the
 * same indices in preview, bounds, and MDC because inserts share one codegen path.
 *
 * **Push/pull** — cap drag writes two consecutive f32 (`h`, `posYDelta`) via `writeBuffers({ sceneParams })`
 * into the same buffer. Byte offsets are `(paramOffset + capSlot) * 4` from serialized nodes (`sdf.mts`);
 * slots must match each shape’s `compileAux*` (`extrude`/`loft`: +3/+4, `threaded_rod`: +6/+7).
 */

/** Maximum number of f32 slots in the GPU `sceneParams` buffer (256 KiB). */
export const SCENE_PARAMS_F32_CAPACITY = 65536

export const SCENE_PARAMS_BYTE_SIZE = SCENE_PARAMS_F32_CAPACITY * 4

/**
 * BVH AABB layout: center xyz + half-extent xyz (6 f32). Qualifying nodes get one block each, allocated
 * contiguously after all per-node parameter regions (`SceneInfo.#assignBvhBoundsSlots`).
 */
export const SCENE_PARAM_BOUNDS_F32_COUNT = 6

/** WGSL: read one scalar from `sceneParams` at byte index `offset * 4`. */
export function spF32Wgsl(offset: number): string {
    return `sp_f32(${offset}u)`
}

/** WGSL: read `vec3` from three consecutive f32 slots starting at `offset`. */
export function spVec3Wgsl(offset: number): string {
    return `sp_vec3(${offset}u)`
}

/** WGSL: read `vec2` from two consecutive f32 slots starting at `offset`. */
export function spVec2Wgsl(offset: number): string {
    return `sp_vec2(${offset}u)`
}

/** WGSL: read a column-major `mat3x3f` from nine consecutive f32 slots starting at `offset` (row0 = cols 0–2). */
export function spMat3x3Wgsl(offset: number): string {
    const c = (i: number) => spF32Wgsl(offset + i)
    return `mat3x3f(vec3f(${c(0)}, ${c(1)}, ${c(2)}), vec3f(${c(3)}, ${c(4)}, ${c(5)}), vec3f(${c(6)}, ${c(7)}, ${c(8)}))`
}
