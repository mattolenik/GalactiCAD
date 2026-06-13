// AMD FidelityFX FSR1 — Robust Contrast-Adaptive Sharpening (RCAS), FP32 path.
//
// Ported from docs/reference_impl/fidelityfx-sdk/.../fsr1/ffx_fsr1.h (`FsrRcasF`
// + `FsrRcasCon`). Runs at full resolution on the EASU output, sharpening it in
// place via a 3x3 cross neighborhood. No scaling. The only constant is
// `sharp = exp2(-sharpness)` (the FP32 `FsrRcasF` reads sharpness from `con.x`;
// the packed-half `con.y` is for the FP16 path and is not needed here).

@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var<uniform> rcas: RcasConst;

struct RcasConst {
    sharp: f32, // exp2(-sharpness): 1 = max sharpening, smaller = softer.
};

// Limit at which sharpening starts to look unnatural (0.25 - 1/16).
const FSR_RCAS_LIMIT: f32 = 0.1875;
// Guards keep the per-channel reciprocals finite on uniform black/white
// neighborhoods (where the reference's hardware rcp would yield 0/0 -> NaN).
const EPS: f32 = 1.0e-6;

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

fn loadClamped(p: vec2<i32>, maxC: vec2<i32>) -> vec4f {
    return textureLoad(srcTex, clamp(p, vec2<i32>(0), maxC), 0);
}

@fragment
fn fragmentMain(@builtin(position) fragPos: vec4f) -> @location(0) vec4f {
    let dims = vec2<i32>(textureDimensions(srcTex));
    let maxC = dims - vec2<i32>(1);
    let sp = vec2<i32>(floor(fragPos.xy));

    // 3x3 cross neighborhood: b (up), d (left), e (center), f (right), h (down).
    // RGB drives the sharpening; the center alpha passes through unchanged
    // (RCAS adjusts contrast in place and must not disturb coverage).
    let b = loadClamped(sp + vec2<i32>(0, -1), maxC).rgb;
    let d = loadClamped(sp + vec2<i32>(-1, 0), maxC).rgb;
    let eRGBA = loadClamped(sp, maxC);
    let e = eRGBA.rgb;
    let f = loadClamped(sp + vec2<i32>(1, 0), maxC).rgb;
    let h = loadClamped(sp + vec2<i32>(0, 1), maxC).rgb;

    // Luma x2.
    let bL = b.b * 0.5 + (b.r * 0.5 + b.g);
    let dL = d.b * 0.5 + (d.r * 0.5 + d.g);
    let eL = e.b * 0.5 + (e.r * 0.5 + e.g);
    let fL = f.b * 0.5 + (f.r * 0.5 + f.g);
    let hL = h.b * 0.5 + (h.r * 0.5 + h.g);

    // Min/max of the ring, per channel.
    let mn4 = min(min(min(b, d), f), h);
    let mx4 = max(max(max(b, d), f), h);

    // Limiters (high-precision reciprocals; guarded against degenerate ranges).
    let lowerLimiter = clamp(eL / max(min(min(min(bL, dL), fL), hL), EPS), 0.0, 1.0);
    let hitMin = mn4 / max(4.0 * mx4, vec3f(EPS)) * lowerLimiter;
    let hitMax = (1.0 - mx4) / min(4.0 * mn4 - 4.0, vec3f(-EPS));
    let lobeRGB = max(-hitMin, hitMax);
    let lobe = max(-FSR_RCAS_LIMIT, min(max(max(lobeRGB.r, lobeRGB.g), lobeRGB.b), 0.0)) * rcas.sharp;

    // Resolve.
    let rcpL = 1.0 / (4.0 * lobe + 1.0);
    let outRGB = (lobe * b + lobe * d + lobe * h + lobe * f + e) * rcpL;
    return vec4f(outRGB, eRGBA.a);
}
