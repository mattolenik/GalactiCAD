// Outline post-process shader
// Reads the color and object ID textures from the MRT scene pass,
// detects boundaries of selected objects, and composites a dark outline.

@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var idTex: texture_2d<u32>;
@group(0) @binding(2) var<storage, read> selectedObjectIds: array<u32, 1024>;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
}

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var pos = array(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(1.0, 1.0));
    var output: VertexOutput;
    output.position = vec4f(pos[vertexIndex], 0.0, 1.0);
    output.uv = (pos[vertexIndex] + vec2f(1.0)) * 0.5;
    return output;
}

fn isSelected(id: u32) -> bool {
    if (id == 0xFFFFFFFFu) {
        return false;
    }
    let count = selectedObjectIds[0];
    for (var i: u32 = 1u; i <= count && i < 1024u; i = i + 1u) {
        if (id == selectedObjectIds[i]) {
            return true;
        }
    }
    return false;
}

@fragment
fn fragmentMain(@builtin(position) fragPos: vec4f) -> @location(0) vec4f {
    let coords = vec2i(fragPos.xy);
    let color = textureLoad(colorTex, coords, 0);

    // Early out: if nothing is selected, pass through
    let selectedCount = selectedObjectIds[0];
    if (selectedCount == 0u) {
        return color;
    }

    let centerId = textureLoad(idTex, coords, 0).x;
    let centerSel = isSelected(centerId);

    // Check neighbors for boundary between selected and non-selected regions.
    // Uses a diamond/cross pattern at distances 1 and 2 for a ~2px outline.
    let dims = vec2i(textureDimensions(idTex));
    var offsets = array(
        vec2i(1, 0), vec2i(-1, 0), vec2i(0, 1), vec2i(0, -1),
        vec2i(1, 1), vec2i(-1, 1), vec2i(1, -1), vec2i(-1, -1),
        vec2i(2, 0), vec2i(-2, 0), vec2i(0, 2), vec2i(0, -2),
    );

    for (var i: i32 = 0; i < 12; i = i + 1) {
        let nc = clamp(coords + offsets[i], vec2i(0), dims - vec2i(1));
        let nId = textureLoad(idTex, nc, 0).x;
        let nSel = isSelected(nId);
        if (centerSel != nSel) {
            return vec4f(0.1, 0.1, 0.15, 1.0);
        }
    }

    return color;
}
