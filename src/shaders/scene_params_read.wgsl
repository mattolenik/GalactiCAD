fn sp_f32(offset: u32) -> f32 {
    return sceneParams[offset];
}

fn sp_vec3(offset: u32) -> vec3f {
    return vec3f(sceneParams[offset], sceneParams[offset + 1u], sceneParams[offset + 2u]);
}

fn sp_vec2(offset: u32) -> vec2f {
    return vec2f(sceneParams[offset], sceneParams[offset + 1u]);
}
