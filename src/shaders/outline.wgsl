// Outline post-process shader
// Reads the color and object ID textures from the MRT scene pass,
// detects boundaries of selected objects, and composites an outline.

@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var idTex: texture_2d<u32>;
@group(0) @binding(2) var<storage, read> selectedObjectIds: array<u32, 1024>;

// Outline settings: mode (0 = none, 1 = solid, 2 = dashed, 3 = dotted)
struct OutlineSettings {
    mode: u32,
    thickness: f32,
}
@group(0) @binding(3) var<uniform> outlineSettings: OutlineSettings;

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

    // Early out: if outline disabled or nothing is selected, pass through
    if (outlineSettings.mode == 0u) {
        return color;
    }
    let selectedCount = selectedObjectIds[0];
    if (selectedCount == 0u) {
        return color;
    }

    let centerId = textureLoad(idTex, coords, 0).x;
    let centerSel = isSelected(centerId);

    // Check neighbors within thickness radius for a selection boundary.
    // Uses a filled circle pattern; radius capped at 8px for performance.
    let dims = vec2i(textureDimensions(idTex));
    let t = min(i32(outlineSettings.thickness), 8);
    let t2 = t * t;
    var isOutline = false;

    for (var dy: i32 = -t; dy <= t; dy = dy + 1) {
        if (isOutline) { break; }
        for (var dx: i32 = -t; dx <= t; dx = dx + 1) {
            if (dx == 0 && dy == 0) { continue; }
            if (dx * dx + dy * dy > t2) { continue; }
            let nc = clamp(coords + vec2i(dx, dy), vec2i(0), dims - vec2i(1));
            let nId = textureLoad(idTex, nc, 0).x;
            let nSel = isSelected(nId);
            if (centerSel != nSel) {
                isOutline = true;
                break;
            }
        }
    }

    if (isOutline) {
        // Dashed mode: diagonal stripe pattern (marching ants)
        if (outlineSettings.mode == 2u) {
            let dashPos = fragPos.x + fragPos.y;
            let inDash = (i32(dashPos) % 10) < 5;
            if (!inDash) {
                return color;
            }
        }
        // Dotted mode: evenly spaced dots, sized proportionally to thickness
        if (outlineSettings.mode == 3u) {
            let dotSize = max(t, 2);
            let spacing = dotSize * 3;
            let gx = i32(fragPos.x) % spacing;
            let gy = i32(fragPos.y) % spacing;
            let inDot = (gx < dotSize) && (gy < dotSize);
            if (!inDot) {
                return color;
            }
        }
        return vec4f(0.1, 0.1, 0.15, 1.0);
    }

    return color;
}
