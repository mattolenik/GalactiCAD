//:) include "hg_sdf.wgsl"

struct RSParams {
    width: u32,
    cellSize: f32,
    z: f32,
    y: u32,
};
@group(0) @binding(0) var<uniform> params: RSParams;
@group(0) @binding(1) var<storage, read_write> segments: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> segCount: atomic<u32>;
@group(0) @binding(3) var<uniform> args: array<vec3f, 1024>;

fn sceneSDF(p: vec3<f32>) -> f32 {
    return 0; //:) insert sceneSDF
}

// sentinel for “no more edges”
const NO_EDGE: u32 = 0xFFFFFFFFu;

// edgeTable[mask] → up to two (edgeA,edgeB) pairs; 
// edges are numbered: 0=top, 1=right, 2=bottom, 3=left
const edgeTable: array<array<vec2<u32>, 2>, 16> = array<array<vec2<u32>,2>,16>(
    // mask 0
    array<vec2<u32>,2>(
        vec2<u32>(NO_EDGE, NO_EDGE),
        vec2<u32>(NO_EDGE, NO_EDGE)
    ),
    // mask 1 (0001): v0 inside
    array<vec2<u32>,2>(
        vec2<u32>(3u, 0u), vec2<u32>(NO_EDGE, NO_EDGE)
    ),
    // mask 2 (0010): v1 inside
    array<vec2<u32>,2>(
        vec2<u32>(0u, 1u), vec2<u32>(NO_EDGE, NO_EDGE)
    ),
    // mask 3 (0011): v0,v1 inside
    array<vec2<u32>,2>(
        vec2<u32>(3u, 1u), vec2<u32>(NO_EDGE, NO_EDGE)
    ),
    // mask 4 (0100): v2 inside
    array<vec2<u32>,2>(
        vec2<u32>(1u, 2u), vec2<u32>(NO_EDGE, NO_EDGE)
    ),
    // mask 5 (0101): v0,v2 inside (two segments)
    array<vec2<u32>,2>(
        vec2<u32>(0u, 1u), vec2<u32>(2u, 3u)
    ),
    // mask 6 (0110): v1,v2 inside
    array<vec2<u32>,2>(
        vec2<u32>(0u, 2u), vec2<u32>(NO_EDGE, NO_EDGE)
    ),
    // mask 7 (0111): v0,v1,v2 inside
    array<vec2<u32>,2>(
        vec2<u32>(3u, 2u), vec2<u32>(NO_EDGE, NO_EDGE)
    ),
    // mask 8 (1000): v3 inside
    array<vec2<u32>,2>(
        vec2<u32>(2u, 3u), vec2<u32>(NO_EDGE, NO_EDGE)
    ),
    // mask 9 (1001): v0,v3 inside
    array<vec2<u32>,2>(
        vec2<u32>(0u, 2u), vec2<u32>(NO_EDGE, NO_EDGE)
    ),
    // mask 10 (1010): v1,v3 inside (two segments)
    array<vec2<u32>,2>(
        vec2<u32>(1u, 2u), vec2<u32>(3u, 0u)
    ),
    // mask 11 (1011): v0,v1,v3 inside
    array<vec2<u32>,2>(
        vec2<u32>(2u, 1u), vec2<u32>(NO_EDGE, NO_EDGE)
    ),
    // mask 12 (1100): v2,v3 inside
    array<vec2<u32>,2>(
        vec2<u32>(1u, 3u), vec2<u32>(NO_EDGE, NO_EDGE)
    ),
    // mask 13 (1101): v0,v2,v3 inside
    array<vec2<u32>,2>(
        vec2<u32>(0u, 1u), vec2<u32>(NO_EDGE, NO_EDGE)
    ),
    // mask 14 (1110): v1,v2,v3 inside
    array<vec2<u32>,2>(
        vec2<u32>(0u, 3u), vec2<u32>(NO_EDGE, NO_EDGE)
    ),
    // mask 15
    array<vec2<u32>,2>(
        vec2<u32>(NO_EDGE, NO_EDGE),
        vec2<u32>(NO_EDGE, NO_EDGE)
    )
);

fn sample(ix: u32, iy: u32) -> f32 {
    let x = f32(ix) * params.cellSize;
    let y = f32(iy) * params.cellSize;
    return sceneSDF(vec3<f32>(x, y, params.z));
}

fn interp(
    p0: vec2<f32>,
    p1: vec2<f32>,
    v0: f32,
    v1: f32
) -> vec2<f32> {
    let t = v0 / (v0 - v1);
    return p0 + (p1 - p0) * t;
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    if x + 1u >= params.width { return; }

    let v0 = sample(x, params.y);
    let v1 = sample(x + 1u, params.y);
    let v3 = sample(x, params.y + 1u);
    let v2 = sample(x + 1u, params.y + 1u);

    var mask: u32 = 0u;
    if v0 < 0.0 { mask |= 1u; }
    if v1 < 0.0 { mask |= 2u; }
    if v2 < 0.0 { mask |= 4u; }
    if v3 < 0.0 { mask |= 8u; }
    if mask == 0u || mask == 15u { return; }

    let pairs = edgeTable[mask];
    let P = array<vec2<f32>,4>(
        vec2<f32>(f32(x) * params.cellSize, f32(params.y) * params.cellSize),
        vec2<f32>(f32(x + 1) * params.cellSize, f32(params.y) * params.cellSize),
        vec2<f32>(f32(x + 1) * params.cellSize, f32(params.y + 1) * params.cellSize),
        vec2<f32>(f32(x) * params.cellSize, f32(params.y + 1) * params.cellSize)
    );
    let V = array<f32,4>(v0, v1, v2, v3);

    for (var i = 0u; i < 2u; i = i + 1u) {
        let e = pairs[i];
        if e.x == NO_EDGE { continue; }

    // linear interpolation in 2D
        let pa = interp(P[e.x], P[e.y], V[e.x], V[e.y]);
        let pb = interp(P[e.y], P[e.x], V[e.y], V[e.x]);

        let idx = atomicAdd(&segCount, 2u);
        segments[idx + 0u] = pa;
        segments[idx + 1u] = pb;
    }
}
