fn sp_f32(offset: u32) -> f32 {
    return mdcSceneParams[offset];
}

fn sp_vec3(offset: u32) -> vec3f {
    return vec3f(mdcSceneParams[offset], mdcSceneParams[offset + 1u], mdcSceneParams[offset + 2u]);
}

fn sp_vec2(offset: u32) -> vec2f {
    return vec2f(mdcSceneParams[offset], mdcSceneParams[offset + 1u]);
}
