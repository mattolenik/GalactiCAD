//:) include "hg_sdf.wgsl"

// Define the grid resolution and cell size
const GRID_RES: u32 = 512;
const CELL_SIZE: f32 = 10.0;

// Output buffer for vertices and indices
struct Vertex {
    position: vec3<f32>,
    normal: vec3<f32>,
};

struct Triangle {
    indices: vec3<u32>,
};

@group(0) @binding(0) var<uniform> args: array<vec3f, 1024>;
@group(0) @binding(1) var<storage, read_write> vertices: array<Vertex>;
@group(0) @binding(2) var<storage, read_write> triangles: array<Triangle>;
@group(0) @binding(3) var<storage, read_write> triCount: atomic<u32>;

fn vertexIndex(x: u32, y: u32, z: u32) -> u32 {
    return x + y * GRID_RES + z * GRID_RES * GRID_RES;
}

fn isValidVertex(v: Vertex) -> bool {
    return length(v.normal) > 0.0;
}

fn sceneSDF(p: vec3f) -> f32 {
    return 0f; //:) insert sceneSDF
}

// Approximate the gradient (normal) at a point using central differences
fn estimateNormal(p: vec3<f32>) -> vec3<f32> {
    let epsilon = 0.001;
    let dx = sceneSDF(p + vec3<f32>(epsilon, 0.0, 0.0)) - sceneSDF(p - vec3<f32>(epsilon, 0.0, 0.0));
    let dy = sceneSDF(p + vec3<f32>(0.0, epsilon, 0.0)) - sceneSDF(p - vec3<f32>(0.0, epsilon, 0.0));
    let dz = sceneSDF(p + vec3<f32>(0.0, 0.0, epsilon)) - sceneSDF(p - vec3<f32>(0.0, 0.0, epsilon));
    return normalize(vec3<f32>(dx, dy, dz));
}

// Perform binary search along an edge to find the surface intersection
fn findIntersection(p1: vec3<f32>, p2: vec3<f32>) -> vec3<f32> {
    var a = p1;
    var b = p2;
    var fa = sceneSDF(a);
    var fb = sceneSDF(b);
    for (var i = 0u; i < 8u; i = i + 1u) {
        let mid = (a + b) * 0.5;
        let fmid = sceneSDF(mid);
        if (fa * fmid < 0.0) {
            b = mid;
            fb = fmid;
        } else {
            a = mid;
            fa = fmid;
        }
    }
    return (a + b) * 0.5;
}

// fn solveQEF(intersections: array<vec3<f32>, 12>, normals: array<vec3<f32>, 12>, count: u32) -> vec3<f32> {
//     var ata = mat3x3<f32>();
//     var atb = vec3<f32>(0.0);

//     for (var i = 0u; i < count; i += 1u) {
//         let n = normals[i];
//         let p = intersections[i];
//         ata += mat3x3<f32>(
//             n.x * n.x, n.x * n.y, n.x * n.z,
//             n.y * n.x, n.y * n.y, n.y * n.z,
//             n.z * n.x, n.z * n.y, n.z * n.z
//         );
//         atb += dot(n, p) * n;
//     }

//     // Solve ata * x = atb using Cramer's rule
//     let det = determinant(ata);
//     if (abs(det) < 1e-6) {
//         // Near-singular case: fallback to average points
//         var avg = vec3<f32>(0.0);
//         for (var i = 0u; i < count; i += 1u) {
//             avg += intersections[i];
//         }
//         return avg / f32(count);
//     }

//     let invAta = inverse3x3(ata, det);
//     return invAta * atb;
// }
// Compute the QEF to determine the best-fit vertex position
fn solveQEF(intersections: array<vec3<f32>, 12>, normals: array<vec3<f32>, 12>, count: u32) -> vec3<f32> {
    // Placeholder implementation: average the intersection points
    var sum = vec3<f32>(0.0, 0.0, 0.0);
    for (var i = 0u; i < count; i = i + 1u) {
        sum = sum + intersections[i];
    }
    return sum / f32(count);
}

// Compute determinant explicitly
fn determinant(m: mat3x3<f32>) -> f32 {
    return
        m[0][0] * (m[1][1]*m[2][2] - m[1][2]*m[2][1]) -
        m[0][1] * (m[1][0]*m[2][2] - m[1][2]*m[2][0]) +
        m[0][2] * (m[1][0]*m[2][1] - m[1][1]*m[2][0]);
}

// Explicit inverse calculation for a 3x3 matrix
fn inverse3x3(m: mat3x3<f32>, det: f32) -> mat3x3<f32> {
    let invDet = 1.0 / det;

    return invDet * mat3x3<f32>(
        m[1][1]*m[2][2] - m[1][2]*m[2][1],
        m[0][2]*m[2][1] - m[0][1]*m[2][2],
        m[0][1]*m[1][2] - m[0][2]*m[1][1],

        m[1][2]*m[2][0] - m[1][0]*m[2][2],
        m[0][0]*m[2][2] - m[0][2]*m[2][0],
        m[0][2]*m[1][0] - m[0][0]*m[1][2],

        m[1][0]*m[2][1] - m[1][1]*m[2][0],
        m[0][1]*m[2][0] - m[0][0]*m[2][1],
        m[0][0]*m[1][1] - m[0][1]*m[1][0]
    );
}


@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= GRID_RES || id.y >= GRID_RES || id.z >= GRID_RES) {
        return;
    }

    let base = vec3<f32>(f32(id.x), f32(id.y), f32(id.z)) * CELL_SIZE;

    // Sample SDF at the 8 corners of the cell
    var cornerOffsets = array<vec3<f32>, 8>(
        vec3<f32>(0.0, 0.0, 0.0),
        vec3<f32>(1.0, 0.0, 0.0),
        vec3<f32>(1.0, 1.0, 0.0),
        vec3<f32>(0.0, 1.0, 0.0),
        vec3<f32>(0.0, 0.0, 1.0),
        vec3<f32>(1.0, 0.0, 1.0),
        vec3<f32>(1.0, 1.0, 1.0),
        vec3<f32>(0.0, 1.0, 1.0),
    );

    var sdfValues = array<f32, 8>();
    for (var i = 0u; i < 8u; i = i + 1u) {
        let pos = base + cornerOffsets[i] * CELL_SIZE;
        sdfValues[i] = sceneSDF(pos);
    }

    // Determine if the cell contains the surface
    var inside = false;
    var outside = false;
    for (var i = 0u; i < 8u; i = i + 1u) {
        if (sdfValues[i] < 0.0) {
            inside = true;
        } else {
            outside = true;
        }
    }
    if (!(inside && outside)) {
        return; // Cell does not intersect the surface
    }

    // Define the 12 edges of the cell
    var edgeIndices = array<vec2<u32>, 12>(
        vec2<u32>(0, 1),
        vec2<u32>(1, 2),
        vec2<u32>(2, 3),
        vec2<u32>(3, 0),
        vec2<u32>(4, 5),
        vec2<u32>(5, 6),
        vec2<u32>(6, 7),
        vec2<u32>(7, 4),
        vec2<u32>(0, 4),
        vec2<u32>(1, 5),
        vec2<u32>(2, 6),
        vec2<u32>(3, 7),
    );

    var intersections = array<vec3<f32>, 12>();
    var normals = array<vec3<f32>, 12>();
    var count = 0u;

    for (var i = 0u; i < 12u; i = i + 1u) {
        let a = edgeIndices[i].x;
        let b = edgeIndices[i].y;
        let valA = sdfValues[a];
        let valB = sdfValues[b];
        if ((valA < 0.0 && valB >= 0.0) || (valA >= 0.0 && valB < 0.0)) {
            let p1 = base + cornerOffsets[a] * CELL_SIZE;
            let p2 = base + cornerOffsets[b] * CELL_SIZE;
            let intersection = findIntersection(p1, p2);
            intersections[count] = intersection;
            normals[count] = estimateNormal(intersection);
            count = count + 1u;
        }
    }

    if (count == 0u) {
        return;
    }

    let vertexPos = solveQEF(intersections, normals, count);
    let vertexNormal = estimateNormal(vertexPos);

    let vi = id.x * GRID_RES + id.y * GRID_RES + id.z * GRID_RES;
    vertices[vi] = Vertex(vertexPos, vertexNormal);

    let v000_idx = vertexIndex(id.x, id.y, id.z);
    let v100_idx = vertexIndex(id.x + 1u, id.y, id.z);
    let v010_idx = vertexIndex(id.x, id.y + 1u, id.z);
    let v001_idx = vertexIndex(id.x, id.y, id.z + 1u);

    let v000 = vertices[v000_idx];
    let v100 = vertices[v100_idx];
    let v010 = vertices[v010_idx];
    let v001 = vertices[v001_idx];

    // X-face triangles (YZ-plane)
    if (isValidVertex(v000) && isValidVertex(v010) && isValidVertex(v001) && isValidVertex(vertices[vertexIndex(id.x, id.y + 1u, id.z + 1u)])) {
        let v011_idx = vertexIndex(id.x, id.y + 1u, id.z + 1u);
        let base = atomicAdd(&triCount, 2u);
        triangles[base] = Triangle(vec3<u32>(v000_idx, v010_idx, v011_idx));
        triangles[base + 1u] = Triangle(vec3<u32>(v000_idx, v011_idx, v001_idx));
    }

    // Y-face triangles (XZ-plane)
    if (isValidVertex(v000) && isValidVertex(v100) && isValidVertex(v001) && isValidVertex(vertices[vertexIndex(id.x + 1u, id.y, id.z + 1u)])) {
        let v101_idx = vertexIndex(id.x + 1u, id.y, id.z + 1u);
        let base = atomicAdd(&triCount, 2u);
        triangles[base] = Triangle(vec3<u32>(v000_idx, v101_idx, v100_idx));
        triangles[base + 1u] = Triangle(vec3<u32>(v000_idx, v001_idx, v101_idx));
    }

    // Z-face triangles (XY-plane)
    if (isValidVertex(v000) && isValidVertex(v100) && isValidVertex(v010) && isValidVertex(vertices[vertexIndex(id.x + 1u, id.y + 1u, id.z)])) {
        let v110_idx = vertexIndex(id.x + 1u, id.y + 1u, id.z);
        let base = atomicAdd(&triCount, 2u);
        triangles[base] = Triangle(vec3<u32>(v000_idx, v100_idx, v110_idx));
        triangles[base + 1u] = Triangle(vec3<u32>(v000_idx, v110_idx, v010_idx));
    }
}
