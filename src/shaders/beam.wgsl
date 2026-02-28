//:) include "hg_sdf.wgsl"

// Beam optimization compute shader.
//
// Groups adjacent pixels into TILE_SIZE x TILE_SIZE tiles and performs a single
// beam march per tile at the tile center. Because the camera is orthographic
// (all rays share the same direction), the SDF distance at the center bounds
// the distance for every pixel in the tile, minus the tile's spatial radius.
//
// The result (a safe starting-t for per-pixel ray marching) is written to a
// low-resolution storage texture that the fragment shader reads.

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
};

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var tStartOut: texture_storage_2d<r32float, write>;

// Polygon vertex buffer (shared storage for all Polygon2D vertex data).
@group(0) @binding(3) var<storage, read> polygonVertices: array<vec2f>;

// Per-node parameters: .x = h, .y = posYDelta. Indexed by node ID.
@group(0) @binding(4) var<uniform> nodeParams: array<vec4f, 256>;

// Fast-path-only auxiliary SDF functions (e.g., per-polygon evaluators) are injected here at runtime.
// Uses sceneAuxFast to exclude full SDFResult functions not needed by the beam shader.
//:) insert sceneAuxFast

// Fast SDF: only returns vec2f(distance, gradientMagnitude).
// Contents are replaced at runtime by the scene compiler.
fn sceneSDF_fast(p: vec3f) -> vec2f {
    return vec2f(0.0, 1.0); //:) insert sceneSDF_fast
}

@compute @workgroup_size(8, 8)
fn beamMarch(@builtin(global_invocation_id) gid: vec3u) {
    // Force bindings into the bind group layout (auto-layout strips unused bindings)
    _ = polygonVertices[0];
    _ = nodeParams[0];

    // Output texture is at tile resolution: ceil(W/TILE_SIZE) x ceil(H/TILE_SIZE)
    let outDims = textureDimensions(tStartOut);
    if (gid.x >= outDims.x || gid.y >= outDims.y) {
        return;
    }

    // Full pixel resolution from camera uniform
    let res = camera.res;
    let aspect = res.x / res.y;

    // Compute tile center in pixel coordinates, then convert to UV (0-1)
    let tileCenterPixel = vec2f(
        f32(gid.x) * f32(TILE_SIZE) + f32(TILE_SIZE) * 0.5,
        f32(gid.y) * f32(TILE_SIZE) + f32(TILE_SIZE) * 0.5
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

    // Tile radius in world space (half-diagonal of the tile).
    // Pixel spacing is uniform in orthographic: pixelSize = 2 * zoom / resY.
    let pixelSize = 2.0 * camera.zoom / res.y;
    let tileRadius = pixelSize * f32(TILE_SIZE) * 0.707;

    // Beam march: advance conservatively through empty space
    var t: f32 = 0.001;
    for (var i: i32 = 0; i < MAX_BEAM_STEPS; i = i + 1) {
        let p = transformedOrigin + t * transformedDir;
        let sr = sceneSDF_fast(p);
        // In smooth CSG blend regions (g < 1), the SDF over-estimates true distance.
        // Scale by gradient magnitude to get a conservative distance estimate.
        let d = sr.x * min(sr.y, 1.0);
        let safeStep = d - tileRadius;

        // Stop when near a surface or past max distance
        if (safeStep < tileRadius || t >= MAX_DIST) {
            break;
        }
        t = t + safeStep;
    }

    // Write the safe starting-t for this tile.
    // Back off by tileRadius for extra safety at tile boundaries.
    textureStore(tStartOut, vec2i(gid.xy), vec4f(max(t - tileRadius, 0.0), 0.0, 0.0, 0.0));
}
