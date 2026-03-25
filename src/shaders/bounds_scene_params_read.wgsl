fn sp_f32(offset: u32) -> f32 {
    return boundsSceneParams[offset];
}

fn sp_vec3(offset: u32) -> vec3f {
    return vec3f(boundsSceneParams[offset], boundsSceneParams[offset + 1u], boundsSceneParams[offset + 2u]);
}

fn sp_vec2(offset: u32) -> vec2f {
    return vec2f(boundsSceneParams[offset], boundsSceneParams[offset + 1u]);
}
