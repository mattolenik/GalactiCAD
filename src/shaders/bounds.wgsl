//:) include "hg_sdf.wgsl"

// Compute shader to estimate the scene SDF bounding box.
//
// Notes:
// - WebGPU/WGSL has no floating-point atomics, so we quantize positions to i32 using `scale`.
// - This finds the bounds of the *inside region* (sdf <= isoValue) sampled on a grid.
// - For best results, run a coarse pass then a refined pass on CPU.

struct BoundsUniforms {
    // xyz = searchMin (mm), w = step (mm)
    searchMinStep: vec4f,
    // xyz = searchMax (mm), w = isoValue
    searchMaxIso: vec4f,
    // xyz = dims, w unused
    dims: vec4u,
    // scale used for quantization (e.g. 1000 => microns)
    scale: f32,
    _pad0: vec3f,
}

@group(0) @binding(0) var<uniform> uniforms: BoundsUniforms;

// One output record per dispatched workgroup (no atomics).
struct TileBounds {
    // Quantized to i32 at `uniforms.scale`.
    minQ: vec4i,
    maxQ: vec4i,
    // 0 if no inside samples were seen by this workgroup; 1 otherwise.
    anyInside: u32,
    // Pad to 48 bytes total with 16-byte struct alignment (avoid vec3 alignment rules).
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
}

@group(0) @binding(1) var<storage, read_write> out: array<TileBounds>;

// Placeholder for the actual scene Signed Distance Function
fn sceneSDF(p: vec3f) -> SDFResult {
    return sdfTrue(0.0, 0u, vec3f(0.0)); //:) insert sceneSDF
}

fn isInside(p: vec3f) -> bool {
    return sceneSDF(p).d <= uniforms.searchMaxIso.w;
}

fn linearToGrid(i: u32, dims: vec3u) -> vec3u {
    let xy = dims.x * dims.y;
    let z = i / xy;
    let rem = i - z * xy;
    let y = rem / dims.x;
    let x = rem - y * dims.x;
    return vec3u(x, y, z);
}

var<workgroup> wgMinX: array<i32, 256>;
var<workgroup> wgMinY: array<i32, 256>;
var<workgroup> wgMinZ: array<i32, 256>;
var<workgroup> wgMaxX: array<i32, 256>;
var<workgroup> wgMaxY: array<i32, 256>;
var<workgroup> wgMaxZ: array<i32, 256>;
var<workgroup> wgAny: array<u32, 256>;

// Workgroup-parallel reduction, no atomics:
// - Each invocation processes at most one sample (linear index).
// - Workgroup reduces to one min/max and writes one TileBounds record.
@compute @workgroup_size(256, 1, 1)
fn computeBounds(
    @builtin(local_invocation_id) localId: vec3u,
    @builtin(workgroup_id) workgroupId: vec3u,
    @builtin(num_workgroups) numWg: vec3u
) {
    let dims = uniforms.dims.xyz;
    let total = dims.x * dims.y * dims.z;

    // Linearize the dispatched workgroup index (works for 1D/2D/3D dispatch).
    let wgLinear = workgroupId.x + workgroupId.y * numWg.x + workgroupId.z * numWg.x * numWg.y;
    let lane = localId.x;
    let i = wgLinear * 256u + lane;

    // Sentinels for "no sample".
    var minx = 2147483647;
    var miny = 2147483647;
    var minz = 2147483647;
    var maxx = -2147483648;
    var maxy = -2147483648;
    var maxz = -2147483648;
    var foundInside = 0u;

    if (i < total) {
        let gid = linearToGrid(i, dims);
        let step = uniforms.searchMinStep.w;
        let p = uniforms.searchMinStep.xyz + vec3f(gid) * step;

        // Skip anything outside the nominal search max (can happen due to ceil'd dims).
        if (!any(p > uniforms.searchMaxIso.xyz)) {
            if (isInside(p)) {
                let s = uniforms.scale;
                let ix = i32(round(p.x * s));
                let iy = i32(round(p.y * s));
                let iz = i32(round(p.z * s));
                minx = ix; miny = iy; minz = iz;
                maxx = ix; maxy = iy; maxz = iz;
                foundInside = 1u;
            }
        }
    }

    wgMinX[lane] = minx;
    wgMinY[lane] = miny;
    wgMinZ[lane] = minz;
    wgMaxX[lane] = maxx;
    wgMaxY[lane] = maxy;
    wgMaxZ[lane] = maxz;
    wgAny[lane] = foundInside;
    workgroupBarrier();

    // Parallel reduce (256 -> 1).
    for (var stride = 128u; stride >= 1u; stride = stride >> 1u) {
        if (lane < stride) {
            let o = lane + stride;
            wgMinX[lane] = min(wgMinX[lane], wgMinX[o]);
            wgMinY[lane] = min(wgMinY[lane], wgMinY[o]);
            wgMinZ[lane] = min(wgMinZ[lane], wgMinZ[o]);
            wgMaxX[lane] = max(wgMaxX[lane], wgMaxX[o]);
            wgMaxY[lane] = max(wgMaxY[lane], wgMaxY[o]);
            wgMaxZ[lane] = max(wgMaxZ[lane], wgMaxZ[o]);
            wgAny[lane] = wgAny[lane] | wgAny[o];
        }
        workgroupBarrier();
        if (stride == 1u) { break; }
    }

    if (lane == 0u) {
        // If the workgroup saw nothing inside, write sentinel mins/maxs.
        let hasAnyInside = wgAny[0];
        let mn = vec4i(wgMinX[0], wgMinY[0], wgMinZ[0], 0);
        let mx = vec4i(wgMaxX[0], wgMaxY[0], wgMaxZ[0], 0);
        if (wgLinear < arrayLength(&out)) {
            out[wgLinear] = TileBounds(mn, mx, hasAnyInside, 0u, 0u, 0u);
        }
    }
}

