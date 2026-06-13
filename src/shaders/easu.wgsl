// AMD FidelityFX FSR1 — Edge-Adaptive Spatial Upsampling (EASU), FP32 path.
//
// Ported from docs/reference_impl/fidelityfx-sdk/.../fsr1/ffx_fsr1.h
// (`ffxFsrPopulateEasuConstants` + `ffxFsrEasuFloat`). One full-screen fragment
// pass: for each full-resolution output pixel, samples the reduced-resolution
// scene color through a 12-tap edge-directed kernel and resolves a sharp,
// anti-aliased color. Replaces the browser's bilinear stretch during camera
// motion. Constants (con0..con3) are computed on the CPU per render/display
// size and uploaded as bit-cast floats (see render-worker-core `#updateEasuConstants`).

@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
@group(0) @binding(2) var<uniform> easu: EasuConst;

struct EasuConst {
    con0: vec4<u32>,
    con1: vec4<u32>,
    con2: vec4<u32>,
    con3: vec4<u32>,
};

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

// FSR's `ffxApproximateReciprocal` bit hack. Used ONLY for the gradient
// reciprocals in `easuSet`, whose input is exactly zero on flat regions: a
// finite large result keeps `0 * rcp(0)` at 0 instead of the NaN that an exact
// `1.0 / 0.0` would yield. (Elsewhere the divisors are provably non-zero, so we
// use exact division.)
fn ffxRcpApprox(x: f32) -> f32 {
    return bitcast<f32>(0x7ef07ebbu - bitcast<u32>(x));
}

// Accumulate edge direction + length contribution for one bilinear sub-sample.
// `w` is the precomputed bilinear weight for this corner; lA..lE are the '+'
// luma neighborhood (a=up, b=left, c=center, d=right, e=down).
fn easuSet(dir: ptr<function, vec2f>, len: ptr<function, f32>, w: f32,
           lA: f32, lB: f32, lC: f32, lD: f32, lE: f32) {
    // Horizontal axis.
    let dc = lD - lC;
    let cb = lC - lB;
    var lenX = ffxRcpApprox(max(abs(dc), abs(cb)));
    let dirX = lD - lB;
    (*dir).x += dirX * w;
    lenX = clamp(abs(dirX) * lenX, 0.0, 1.0);
    lenX = lenX * lenX;
    *len += lenX * w;
    // Vertical axis.
    let ec = lE - lC;
    let ca = lC - lA;
    var lenY = ffxRcpApprox(max(abs(ec), abs(ca)));
    let dirY = lE - lA;
    (*dir).y += dirY * w;
    lenY = clamp(abs(dirY) * lenY, 0.0, 1.0);
    lenY = lenY * lenY;
    *len += lenY * w;
}

// One filter tap weight. Color (RGBA, premultiplied) is accumulated by the
// caller so alpha rides through the same kernel as RGB — required to preserve a
// transparent background and antialias the silhouette.
fn easuTapWeight(pixelOffset: vec2f, dir: vec2f, len: vec2f, lob: f32, clp: f32) -> f32 {
    // Rotate offset by gradient direction, then apply anisotropy.
    var ro = vec2f(
        pixelOffset.x * dir.x + pixelOffset.y * dir.y,
        pixelOffset.x * (-dir.y) + pixelOffset.y * dir.x,
    );
    ro = ro * len;
    var d2 = ro.x * ro.x + ro.y * ro.y;
    d2 = min(d2, clp);
    // Approximation of a windowed lanczos2 without sin/rcp/sqrt.
    var wB = (2.0 / 5.0) * d2 - 1.0;
    var wA = lob * d2 - 1.0;
    wB = wB * wB;
    wA = wA * wA;
    wB = (25.0 / 16.0) * wB - (25.0 / 16.0 - 1.0);
    return wB * wA;
}

@fragment
fn fragmentMain(@builtin(position) fragPos: vec4f) -> @location(0) vec4f {
    let con0 = bitcast<vec4f>(easu.con0);
    let con1 = bitcast<vec4f>(easu.con1);
    let con2 = bitcast<vec4f>(easu.con2);
    let con3 = bitcast<vec4f>(easu.con3);

    // Integer output pixel (top-left origin), == FSR's `ip`.
    let ip = floor(fragPos.xy);

    // Position of 'f' (upper-left of the inner 2x2) in input-pixel space.
    var pp = ip * con0.xy + con0.zw;
    let fp = floor(pp);
    pp = pp - fp;

    // Gather centers, in normalized input UV.
    let p0 = fp * con1.xy + con1.zw;
    let p1 = p0 + con2.xy;
    let p2 = p0 + con2.zw;
    let p3 = p0 + con3.xy;

    // Gather4. WebGPU `textureGather` component order (.x = lower-left, going
    // counter-clockwise) matches the D3D/Vulkan order FSR assumes, and both the
    // scene texture and the output are top-left / V-down, so no swizzle is
    // needed. If ported to a differing gather convention, THIS is the single
    // calibration point — reorder the .xyzw reads here.
    let bczzR = textureGather(0, srcTex, srcSampler, p0);
    let bczzG = textureGather(1, srcTex, srcSampler, p0);
    let bczzB = textureGather(2, srcTex, srcSampler, p0);
    let bczzA = textureGather(3, srcTex, srcSampler, p0);
    let ijfeR = textureGather(0, srcTex, srcSampler, p1);
    let ijfeG = textureGather(1, srcTex, srcSampler, p1);
    let ijfeB = textureGather(2, srcTex, srcSampler, p1);
    let ijfeA = textureGather(3, srcTex, srcSampler, p1);
    let klhgR = textureGather(0, srcTex, srcSampler, p2);
    let klhgG = textureGather(1, srcTex, srcSampler, p2);
    let klhgB = textureGather(2, srcTex, srcSampler, p2);
    let klhgA = textureGather(3, srcTex, srcSampler, p2);
    let zzonR = textureGather(0, srcTex, srcSampler, p3);
    let zzonG = textureGather(1, srcTex, srcSampler, p3);
    let zzonB = textureGather(2, srcTex, srcSampler, p3);
    let zzonA = textureGather(3, srcTex, srcSampler, p3);

    // Approximate luma (x2) per gather.
    let bczzL = bczzB * 0.5 + (bczzR * 0.5 + bczzG);
    let ijfeL = ijfeB * 0.5 + (ijfeR * 0.5 + ijfeG);
    let klhgL = klhgB * 0.5 + (klhgR * 0.5 + klhgG);
    let zzonL = zzonB * 0.5 + (zzonR * 0.5 + zzonG);

    let bL = bczzL.x;
    let cL = bczzL.y;
    let iL = ijfeL.x;
    let jL = ijfeL.y;
    let fL = ijfeL.z;
    let eL = ijfeL.w;
    let kL = klhgL.x;
    let lL = klhgL.y;
    let hL = klhgL.z;
    let gL = klhgL.w;
    let oL = zzonL.z;
    let nL = zzonL.w;

    // Accumulate gradient direction / length across the 4 bilinear corners.
    var dir = vec2f(0.0);
    var len = 0.0;
    let w0 = (1.0 - pp.x) * (1.0 - pp.y);
    let w1 = pp.x * (1.0 - pp.y);
    let w2 = (1.0 - pp.x) * pp.y;
    let w3 = pp.x * pp.y;
    easuSet(&dir, &len, w0, bL, eL, fL, gL, jL);
    easuSet(&dir, &len, w1, cL, fL, gL, hL, kL);
    easuSet(&dir, &len, w2, fL, iL, jL, kL, nL);
    easuSet(&dir, &len, w3, gL, jL, kL, lL, oL);

    // Normalize direction (guard the flat case), shape the length.
    let dir2 = dir * dir;
    var dirR = dir2.x + dir2.y;
    let zro = dirR < (1.0 / 32768.0);
    dirR = inverseSqrt(dirR);
    dirR = select(dirR, 1.0, zro);
    dir.x = select(dir.x, 1.0, zro);
    dir = dir * dirR;

    len = len * 0.5;
    len = len * len;

    // Anisotropic kernel stretch + adjustable window. (dir is unit length here,
    // so max(|dir.x|, |dir.y|) >= 1/sqrt(2) and the divisions are safe.)
    let stretch = (dir.x * dir.x + dir.y * dir.y) / max(abs(dir.x), abs(dir.y));
    let len2 = vec2f(1.0 + (stretch - 1.0) * len, 1.0 + (-0.5) * len);
    let lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
    let clp = 1.0 / lob;

    // Min/max of the 4 nearest (f, g, j, k) for deringing (RGBA).
    let fc = vec4f(ijfeR.z, ijfeG.z, ijfeB.z, ijfeA.z);
    let gc = vec4f(klhgR.w, klhgG.w, klhgB.w, klhgA.w);
    let jc = vec4f(ijfeR.y, ijfeG.y, ijfeB.y, ijfeA.y);
    let kc = vec4f(klhgR.x, klhgG.x, klhgB.x, klhgA.x);
    let min4 = min(min(min(fc, gc), jc), kc);
    let max4 = max(max(max(fc, gc), jc), kc);

    // 12-tap accumulation (RGBA — alpha rides the same kernel as color).
    var accC = vec4f(0.0);
    var accW = 0.0;
    var w = easuTapWeight(vec2f(0.0, -1.0) - pp, dir, len2, lob, clp); accC += vec4f(bczzR.x, bczzG.x, bczzB.x, bczzA.x) * w; accW += w; // b
    w = easuTapWeight(vec2f(1.0, -1.0) - pp, dir, len2, lob, clp); accC += vec4f(bczzR.y, bczzG.y, bczzB.y, bczzA.y) * w; accW += w; // c
    w = easuTapWeight(vec2f(-1.0, 1.0) - pp, dir, len2, lob, clp); accC += vec4f(ijfeR.x, ijfeG.x, ijfeB.x, ijfeA.x) * w; accW += w; // i
    w = easuTapWeight(vec2f(0.0, 1.0) - pp, dir, len2, lob, clp); accC += vec4f(ijfeR.y, ijfeG.y, ijfeB.y, ijfeA.y) * w; accW += w; // j
    w = easuTapWeight(vec2f(0.0, 0.0) - pp, dir, len2, lob, clp); accC += vec4f(ijfeR.z, ijfeG.z, ijfeB.z, ijfeA.z) * w; accW += w; // f
    w = easuTapWeight(vec2f(-1.0, 0.0) - pp, dir, len2, lob, clp); accC += vec4f(ijfeR.w, ijfeG.w, ijfeB.w, ijfeA.w) * w; accW += w; // e
    w = easuTapWeight(vec2f(1.0, 1.0) - pp, dir, len2, lob, clp); accC += vec4f(klhgR.x, klhgG.x, klhgB.x, klhgA.x) * w; accW += w; // k
    w = easuTapWeight(vec2f(2.0, 1.0) - pp, dir, len2, lob, clp); accC += vec4f(klhgR.y, klhgG.y, klhgB.y, klhgA.y) * w; accW += w; // l
    w = easuTapWeight(vec2f(2.0, 0.0) - pp, dir, len2, lob, clp); accC += vec4f(klhgR.z, klhgG.z, klhgB.z, klhgA.z) * w; accW += w; // h
    w = easuTapWeight(vec2f(1.0, 0.0) - pp, dir, len2, lob, clp); accC += vec4f(klhgR.w, klhgG.w, klhgB.w, klhgA.w) * w; accW += w; // g
    w = easuTapWeight(vec2f(1.0, 2.0) - pp, dir, len2, lob, clp); accC += vec4f(zzonR.z, zzonG.z, zzonB.z, zzonA.z) * w; accW += w; // o
    w = easuTapWeight(vec2f(0.0, 2.0) - pp, dir, len2, lob, clp); accC += vec4f(zzonR.w, zzonG.w, zzonB.w, zzonA.w) * w; accW += w; // n

    // Normalize and dering.
    return min(max4, max(min4, accC / accW));
}
