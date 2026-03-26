//:) include "hg_sdf.wgsl"

// Beam optimization compute shader.
//
// The render worker uses `beamMarch` in preview.wgsl (same shader module as the
// fragment pass). This file is a standalone variant; bindings mirror preview's
// beam subset (camera, t_start, polygonVertices, previewParams* uniform banks).
//
// Groups adjacent pixels into TILE_SIZE x TILE_SIZE tiles and performs a single
// beam march per tile at the centroid of the tile's actual pixels (clamped to
// the framebuffer). Partial tiles along the right/bottom (or when W or H < 8)
// no longer use the center of a fictitious full tile, which previously skewed
// the ray origin and broke the empty-space skip bound.
//
// Because the camera is orthographic (all rays share the same direction), the
// SDF at the beam anchor bounds the distance for every pixel in the tile, minus
// a world-space radius derived from the tile's real pixel footprint. Horizontal
// and vertical world spacing differ when aspect != 1 (matches preview.wgsl).
//
// The result (a safe starting-t for per-pixel ray marching) is written to a
// low-resolution storage texture that the fragment shader reads.
// Stored value backs off by tile footprint plus a small multiple of SURF_DIST
// for float / inexact-SDF slack (see textureStore below).

const TILE_SIZE: u32 = 8u;
const MAX_BEAM_STEPS: i32 = 200;
const MAX_DIST: f32 = 300.0;

struct Camera {
    transform: mat4x4f,
    position: vec3f,
    res: vec2f,
    zoom: f32,
    // Pre-transformed light directions (not used in beam shader, but
    // must be present to match the uniform layout)
    lightDir1: vec3f,
    lightDir2: vec3f,
    lightDir3: vec3f,
    viewCenter: vec2f,
    _padView: vec2f,
    lightDir4: vec3f,
    _padLight4: f32,
    previewShade0: vec4f,
    previewShade1: vec4f,
    previewShade2: vec4f,
    previewShade3: vec4f,
};

@group(0) @binding(1) var<uniform> camera: Camera;
@group(0) @binding(8) var tStartOut: texture_storage_2d<r32float, write>;

// Polygon vertex buffer (shared storage for all Polygon2D vertex data).
@group(0) @binding(9) var<storage, read> polygonVertices: array<vec2f>;

@group(0) @binding(19) var<uniform> previewParamsF32: array<vec4f, 4096>;
@group(0) @binding(20) var<uniform> previewParamsVec2: array<vec4f, 4096>;
@group(0) @binding(21) var<uniform> previewParamsVec3: array<vec4f, 4096>;
@group(0) @binding(23) var<uniform> previewParamsMat3: array<mat3x3f, 1024>;
@group(0) @binding(24) var<uniform> previewCapParamDrag: array<vec4f, 4096>;
@group(0) @binding(22) var<storage, read> boundsSceneParams: array<f32>;
//:) include "bounds_scene_params_read.wgsl"

// Fast-path-only auxiliary SDF functions (e.g., per-polygon evaluators) are injected here at runtime.
// Uses sceneAuxFast to exclude full SDFResult functions not needed by the beam shader.
//:) insert sceneAuxFast

// Fast SDF: distance + gradient magnitude + safe march multiplier.
// Contents are replaced at runtime by the scene compiler.
fn sceneSDF_fast(p: vec3f) -> FastSDFResult {
    return sdfFast(0.0, 1.0, 1.0); //:) insert sceneSDF_fast
}

@compute @workgroup_size(8, 8)
fn beamMarch(@builtin(global_invocation_id) gid: vec3u) {
    // Force bindings into the bind group layout (auto-layout strips unused bindings)
    _ = polygonVertices[0];
    _ = previewParamsF32[0];
    _ = previewParamsVec2[0];
    _ = previewParamsVec3[0];
    _ = previewParamsMat3[0];
    _ = previewCapParamDrag[0];
    _ = boundsSceneParams[0];

    // Output texture is at tile resolution: ceil(W/TILE_SIZE) x ceil(H/TILE_SIZE)
    let outDims = textureDimensions(tStartOut);
    if (gid.x >= outDims.x || gid.y >= outDims.y) {
        return;
    }

    // Full pixel resolution from camera uniform
    let res = camera.res;
    let aspect = res.x / res.y;
    let resX = max(u32(res.x), 1u);
    let resY = max(u32(res.y), 1u);

    // Clamped pixel index ranges for this tile (handles partial edge/small viewports)
    let pMin = gid.x * TILE_SIZE;
    let pMax = min(pMin + TILE_SIZE - 1u, resX - 1u);
    let qMin = gid.y * TILE_SIZE;
    let qMax = min(qMin + TILE_SIZE - 1u, resY - 1u);

    // Centroid of pixel centers in pixel coordinates, then UV (0-1)
    let tileCenterPixel = vec2f(
        (f32(pMin) + f32(pMax)) * 0.5 + 0.5,
        (f32(qMin) + f32(qMax)) * 0.5 + 0.5
    );
    let uv = tileCenterPixel / res;

    // Apply the same aspect + viewCenter correction as the fragment shader
    let uvAspect = vec2f(
        (uv.x - camera.viewCenter.x) * aspect + 0.5,
        uv.y - camera.viewCenter.y + 0.5
    );

    // Compute ray origin (mirrors computeRayOrigin in preview.wgsl)
    let offsetX = (uvAspect.x * 2.0 - 1.0) * camera.zoom;
    let offsetY = (uvAspect.y * 2.0 - 1.0) * camera.zoom;
    let rayOrigin = camera.position + vec3f(offsetX, offsetY, 100.0);

    // Transform from camera space into scene space
    let transformedOrigin = (camera.transform * vec4f(rayOrigin, 1.0)).xyz;
    let transformedDir = -camera.transform[2].xyz;

    // World-space radius: max distance from anchor to any pixel center in the tile (camera plane).
    let pixelSizeY = 2.0 * camera.zoom / res.y;
    let pixelSizeX = 2.0 * camera.zoom * aspect / res.x;
    let hx = 0.5 * f32(pMax - pMin) * pixelSizeX;
    let hy = 0.5 * f32(qMax - qMin) * pixelSizeY;
    let tileRadius = sqrt(hx * hx + hy * hy);

    // Beam march: advance conservatively through empty space
    var t: f32 = 0.001;
    for (var i: i32 = 0; i < MAX_BEAM_STEPS; i = i + 1) {
        let p = transformedOrigin + t * transformedDir;
        let sr = sceneSDF_fast(p);
        let d = sr.d * sr.safeStepMul;
        let safeStep = d - tileRadius;

        // Stop when near a surface or past max distance
        if (safeStep < tileRadius || t >= MAX_DIST) {
            break;
        }
        t = t + safeStep;
    }

    // Write the safe starting-t for this tile: tile footprint backoff plus numeric margin.
    let beamTStartExtra = 2.0 * SURF_DIST;
    textureStore(
        tStartOut,
        vec2i(gid.xy),
        vec4f(max(t - tileRadius - beamTStartExtra, 0.0), 0.0, 0.0, 0.0),
    );
}
