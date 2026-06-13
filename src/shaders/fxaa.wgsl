// FXAA (Fast Approximate Anti-Aliasing) — FXAA3 "console" quality, ported to WGSL.
//
// A pure luma-driven post-process: detects edges from contrast in the already
// upscaled color and blends along them. Catches every edge type — interior
// creases, shading steps, and silhouettes — without any scene resampling.
//
// Premultiplied-alpha safe: the final blend is bilinear texture samples of the
// full RGBA, so alpha rides along with RGB and the transparent-background
// silhouette stays consistent (no dark/bright halo). Luma for edge detection is
// taken from RGB; the resolution comes from the texture (no uniform needed).

@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler; // linear, clamp-to-edge

const SPAN_MAX: f32 = 8.0;
const REDUCE_MUL: f32 = 1.0 / 8.0;
const REDUCE_MIN: f32 = 1.0 / 128.0;
// Relative + absolute contrast below which a pixel is left untouched.
const EDGE_THRESHOLD: f32 = 1.0 / 8.0;
const EDGE_THRESHOLD_MIN: f32 = 1.0 / 16.0;

struct VertexOutput {
    @builtin(position) position: vec4f,
};

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var pos = array(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(1.0, 1.0));
    var out: VertexOutput;
    out.position = vec4f(pos[vertexIndex], 0.0, 1.0);
    return out;
}

fn luma(c: vec3f) -> f32 {
    return dot(c, vec3f(0.299, 0.587, 0.114));
}

@fragment
fn fragmentMain(@builtin(position) fragPos: vec4f) -> @location(0) vec4f {
    let dims = vec2f(textureDimensions(srcTex));
    let rcp = 1.0 / dims;
    let uv = fragPos.xy * rcp; // pixel-center UV (top-left origin, matches source)

    let cM = textureSampleLevel(srcTex, srcSampler, uv, 0.0);
    let lM = luma(cM.rgb);
    let lNW = luma(textureSampleLevel(srcTex, srcSampler, uv + vec2f(-1.0, -1.0) * rcp, 0.0).rgb);
    let lNE = luma(textureSampleLevel(srcTex, srcSampler, uv + vec2f(1.0, -1.0) * rcp, 0.0).rgb);
    let lSW = luma(textureSampleLevel(srcTex, srcSampler, uv + vec2f(-1.0, 1.0) * rcp, 0.0).rgb);
    let lSE = luma(textureSampleLevel(srcTex, srcSampler, uv + vec2f(1.0, 1.0) * rcp, 0.0).rgb);

    let lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
    let lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
    let range = lMax - lMin;

    // Local contrast too low → not an edge; pass the center pixel through.
    if (range < max(EDGE_THRESHOLD_MIN, lMax * EDGE_THRESHOLD)) {
        return cM;
    }

    // Edge direction from the diagonal luma gradient.
    var dir = vec2f(
        -((lNW + lNE) - (lSW + lSE)),
        ((lNW + lSW) - (lNE + lSE)),
    );
    let dirReduce = max((lNW + lNE + lSW + lSE) * 0.25 * REDUCE_MUL, REDUCE_MIN);
    let rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
    dir = clamp(dir * rcpDirMin, vec2f(-SPAN_MAX), vec2f(SPAN_MAX)) * rcp;

    // Two blends: a narrow pair (rgbaA) and a wider pair (rgbaB). rgbaB is
    // preferred unless it strays outside the local luma range (over-blur), in
    // which case the narrower rgbaA is used. Sampling full RGBA keeps alpha
    // consistent with color.
    let rgbaA = 0.5 * (
        textureSampleLevel(srcTex, srcSampler, uv + dir * (1.0 / 3.0 - 0.5), 0.0) +
        textureSampleLevel(srcTex, srcSampler, uv + dir * (2.0 / 3.0 - 0.5), 0.0)
    );
    let rgbaB = rgbaA * 0.5 + 0.25 * (
        textureSampleLevel(srcTex, srcSampler, uv + dir * (-0.5), 0.0) +
        textureSampleLevel(srcTex, srcSampler, uv + dir * (0.5), 0.0)
    );
    let lB = luma(rgbaB.rgb);
    if (lB < lMin || lB > lMax) {
        return rgbaA;
    }
    return rgbaB;
}
