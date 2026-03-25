fn pp_f32(i: u32) -> f32 {
    let v = previewParamsF32[i >> 2u];
    let r = i & 3u;
    if (r == 0u) { return v.x; }
    if (r == 1u) { return v.y; }
    if (r == 2u) { return v.z; }
    return v.w;
}

fn pp_vec2(i: u32) -> vec2f {
    let v = previewParamsVec2[i >> 1u];
    if ((i & 1u) == 0u) {
        return v.xy;
    }
    return v.zw;
}

fn pp_vec3(i: u32) -> vec3f {
    return previewParamsVec3[i].xyz;
}
