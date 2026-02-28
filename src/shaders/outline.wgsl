// Outline post-process shader
// Reads the color and object ID textures from the MRT scene pass,
// detects boundaries of selected objects, and composites an outline.
//
// The scene textures (color + ID) may be at a lower resolution than the canvas
// during camera movement. Color is sampled with hardware bilinear interpolation
// via a sampler; the integer ID texture is sampled with scaled textureLoad.

@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var idTex: texture_2d<u32>;
@group(0) @binding(2) var<storage, read> selectedObjectIds: array<u32, 1024>;

// Outline settings: mode (0 = none, 1 = solid, 2 = dashed, 3 = dotted)
struct OutlineSettings {
    mode: u32,
    thickness: f32,
    color: vec3f,
    canvasWidth: f32,
    dashSpacing: f32,
    dashLength: f32,
    dotSizeMin: f32,
    dotSpacingMultiplier: f32,
}

@group(0) @binding(3) var<uniform> outlineSettings: OutlineSettings;

// Sampler for bilinear upscaling of the color texture
@group(0) @binding(4) var colorSampler: sampler;

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

// Face highlight IDs (1022, 1023) are used for surface selection; we do not draw
// an edge outline around them — only object/edge selection gets outlines.
const FACE_HIGHLIGHT_BOTTOM: u32 = 1022u;
const FACE_HIGHLIGHT_TOP: u32 = 1023u;

fn isSelected(id: u32) -> bool {
    if (id >= 1024u) {
        return false;
    }
    // Exclude face selection IDs — no outline for surface selection
    if (id == FACE_HIGHLIGHT_BOTTOM || id == FACE_HIGHLIGHT_TOP) {
        return false;
    }
    return selectedObjectIds[id] != 0u;
}

@fragment
fn fragmentMain(@builtin(position) fragPos: vec4f, @location(0) uv: vec2f) -> @location(0) vec4f {
    // The vertex shader UV has Y=0 at bottom, Y=1 at top (clip-space convention).
    // Texture coordinates for textureSample/textureLoad use Y=0 at top. Flip V.
    let texUV = vec2f(uv.x, 1.0 - uv.y);

    // Sample color with bilinear interpolation -- handles scene-to-canvas resolution mismatch
    let color = textureSample(colorTex, colorSampler, texUV);

    // Early out: if outline disabled, pass through
    if (outlineSettings.mode == 0u) {
        return color;
    }

    // Map UV to ID texture coordinates (ID texture may be smaller than canvas during movement)
    let idDims = vec2i(textureDimensions(idTex));
    let idCoords = clamp(vec2i(texUV * vec2f(idDims)), vec2i(0), idDims - vec2i(1));
    let centerId = textureLoad(idTex, idCoords, 0).x;
    let centerSel = isSelected(centerId);

    // Check neighbors within thickness radius for a selection boundary.
    // Uses a filled circle pattern; radius capped at 8px for performance.
    // Thickness is specified in screen pixels. Scale to ID-texture pixels so
    // outlines stay the same visual width when the ID texture is at lower
    // resolution during camera movement.
    let scaleRatio = f32(idDims.x) / outlineSettings.canvasWidth;
    let t = min(max(i32(round(outlineSettings.thickness * scaleRatio)), 1), 8);
    let t2 = t * t;
    var isOutline = false;

    for (var dy: i32 = -t; dy <= t; dy = dy + 1) {
        if (isOutline) { break; }
        for (var dx: i32 = -t; dx <= t; dx = dx + 1) {
            if (dx == 0 && dy == 0) { continue; }
            if (dx * dx + dy * dy > t2) { continue; }
            let nc = clamp(idCoords + vec2i(dx, dy), vec2i(0), idDims - vec2i(1));
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
        // fragPos is in canvas pixels, so patterns remain consistent at full resolution
        if (outlineSettings.mode == 2u) {
            let dashPos = fragPos.x + fragPos.y;
            let dashSpacing = i32(outlineSettings.dashSpacing);
            let dashLength = i32(outlineSettings.dashLength);
            let inDash = (i32(dashPos) % dashSpacing) < dashLength;
            if (!inDash) {
                return color;
            }
        }
        // Dotted mode: evenly spaced dots, sized proportionally to thickness
        if (outlineSettings.mode == 3u) {
            let dotSize = max(t, i32(outlineSettings.dotSizeMin));
            let spacing = dotSize * i32(outlineSettings.dotSpacingMultiplier);
            let gx = i32(fragPos.x) % spacing;
            let gy = i32(fragPos.y) % spacing;
            let inDot = (gx < dotSize) && (gy < dotSize);
            if (!inDot) {
                return color;
            }
        }
        return vec4f(outlineSettings.color, 1.0);
    }

    return color;
}
