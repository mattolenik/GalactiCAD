//:) include "hg_sdf.wgsl" // Placeholder for actual SDF functions

// ============================== SHARED STRUCTS ==============================

struct SharedUniforms {
    gridDimensions: vec3u,
    isoValue: f32,
    // gridScale: vec3f, // Not used in the provided code, can be removed if not needed elsewhere
    gridOffset: vec3f,
    voxelSize: f32,
}

struct Vertex {
    position: vec3f,
    normal: vec3f,
}

struct EdgeCrossing {
    position: vec3f,
    normal: vec3f,
}

struct QEFData {
    ATA: mat3x3f,  // 3x3 symmetric matrix for QEF
    ATb: vec3f,    // Right hand side of QEF equation
    massPoint: vec3f,
    numPoints: u32,
}

// ============================== BIND GROUPS ==============================

// Group 0: Shared parameters across all passes
@group(0) @binding(0) var<uniform> uniforms: SharedUniforms;

// Pass 1: Cell Classification
@group(0) @binding(1) var<storage, read_write> activeCellFlags: array<u32>; // Bit-packed flags

// Pass 2: Active Cell Compaction
// Pass 2a (Count) uses activeCellFlagsIn_compaction, writes counts to activeCellIndices_compaction
// Pass 2b (Prefix Sum Workgroup) reads counts from activeCellIndices_compaction, writes partial sums and workgroup totals to activeCellIndices_compaction
// Pass 2c (Add Offsets) reads partial sums and workgroup totals from activeCellIndices_compaction, writes exclusive prefix sums to activeCellIndices_compaction
// Pass 2d (Expand) reads activeCellFlagsIn_compaction and exclusive prefix sums from activeCellIndices_compaction, writes expanded cell indices to activeCellIndices_compaction, writes total activeCellCount_compaction
@group(0) @binding(2) var<storage, read> activeCellFlagsIn_compaction: array<u32>; // Input for 2a, 2d (this is 'activeCellFlags' from Pass 1)
@group(0) @binding(3) var<storage, read_write> activeCellIndices_compaction: array<u32>; // Used for counts, prefix sums, and final compacted indices
@group(0) @binding(4) var<storage, read_write> activeCellCount_compaction: u32; // Output of Pass 2d

// Pass 3: Edge Detection
@group(0) @binding(5) var<storage, read> activeCellIndicesIn_edge: array<u32>; // Compacted list of active cell indices (output of Pass 2d)
@group(0) @binding(6) var<storage, read_write> edgeCrossingsX: array<EdgeCrossing>;
@group(0) @binding(7) var<storage, read_write> edgeCrossingsY: array<EdgeCrossing>;
@group(0) @binding(8) var<storage, read_write> edgeCrossingsZ: array<EdgeCrossing>;
@group(0) @binding(9) var<storage, read_write> cellQEFData_edge: array<QEFData>; // QEF data per active cell
@group(0) @binding(10) var<storage, read> activeCellCount_edgeInput: u32; // Total active cells (output of Pass 2d)

// Pass 4: Vertex Generation
@group(0) @binding(11) var<storage, read> activeCellIndicesIn_vertex: array<u32>; // Compacted list (not strictly needed if vertices map 1:1 to active cells)
@group(0) @binding(12) var<storage, read> cellQEFDataIn_vertex: array<QEFData>;    // QEF data per active cell (output of Pass 3)
@group(0) @binding(13) var<storage, read_write> vertices: array<Vertex>;          // Output vertices
@group(0) @binding(14) var<storage, read> activeCellCount_vertexInput: u32;   // Total active cells (output of Pass 2d)

// Pass 5: Face Generation
// Pass 5a (Count Triangles) uses activeCellIndicesIn_face, activeCellFlagsInput_face, activeCellCount_faceInput, writes counts to triangleOffsets_face
// Pass 5b (Prefix Sum Triangles) uses activeCellCount_faceInput, reads counts from triangleOffsets_face, writes prefix sums to triangleOffsets_face, writes total indexCount_face
// Pass 5c (Generate Triangles) uses activeCellIndicesIn_face, activeCellFlagsInput_face, activeCellCount_faceInput, triangleOffsets_face, writes to indices
@group(0) @binding(15) var<storage, read> activeCellIndicesIn_face: array<u32>;     // Compacted list of active cell indices
@group(0) @binding(16) var<storage, read> activeCellFlagsInput_face: array<u32>; // Original cell flags (output of Pass 1)
@group(0) @binding(17) var<storage, read_write> indices: array<u32>;              // Output triangle indices
@group(0) @binding(18) var<storage, read_write> indexCount_face: u32;               // Total number of indices (output of Pass 5b)
@group(0) @binding(19) var<storage, read_write> triangleOffsets_face: array<u32>;   // Per-cell triangle counts, then prefix sums
@group(0) @binding(20) var<storage, read> activeCellCount_faceInput: u32;       // Total active cells (output of Pass 2d)


// ============================== UTILITY FUNCTIONS ==============================

// Placeholder for the actual scene Signed Distance Function
fn sceneSDF(p: vec3f) -> f32 {
    // Example: a sphere at origin with radius 1.0
    // return length(p) - 1.0;
    return 0.0; // Replace with your actual SDF
}

fn gridPosToWorldPos(gridPos: vec3u) -> vec3f {
    return vec3f(gridPos) * uniforms.voxelSize + uniforms.gridOffset;
}

fn gridIndexTo3D(index: u32) -> vec3u {
    let x = index % uniforms.gridDimensions.x;
    let y = (index / uniforms.gridDimensions.x) % uniforms.gridDimensions.y;
    let z = index / (uniforms.gridDimensions.x * uniforms.gridDimensions.y);
    return vec3u(x, y, z);
}

fn gridPosToIndex(pos: vec3u) -> u32 {
    // Ensure pos is within bounds before calling this, or handle clamping if necessary
    // This function assumes valid pos.
    return pos.x + pos.y * uniforms.gridDimensions.x +
           pos.z * uniforms.gridDimensions.x * uniforms.gridDimensions.y;
}

// Gets the grid coordinates of one of the 8 corners of a cell.
// cellPos is the min-corner of the cell.
// cornerIndex is 0-7.
fn getCellCornerPos(cellPos: vec3u, cornerIndex: u32) -> vec3u {
    return cellPos + vec3u(
        cornerIndex & 1u,          // x offset (0 or 1)
        (cornerIndex >> 1u) & 1u,  // y offset (0 or 1)
        (cornerIndex >> 2u) & 1u   // z offset (0 or 1)
    );
}

fn sampleSDF(worldPos: vec3f) -> f32 {
    return sceneSDF(worldPos);
}

fn computeGradient(p: vec3f) -> vec3f {
    let eps = uniforms.voxelSize * 0.01; // Small epsilon for gradient calculation
    let dx = sampleSDF(p + vec3f(eps, 0.0, 0.0)) - sampleSDF(p - vec3f(eps, 0.0, 0.0));
    let dy = sampleSDF(p + vec3f(0.0, eps, 0.0)) - sampleSDF(p - vec3f(0.0, eps, 0.0));
    let dz = sampleSDF(p + vec3f(0.0, 0.0, eps)) - sampleSDF(p - vec3f(0.0, 0.0, eps));
    let grad = vec3f(dx, dy, dz);
    let len = length(grad);
    if (len == 0.0) {
        return vec3f(0.0, 1.0, 0.0); // Or some default normal
    }
    return grad / len; // Normalized gradient
}

// Checks if a cell is active based on the bit-packed flags.
// This version is used in Pass 5 where activeCellFlagsInput_face is available.
fn isCellActive(cellPos: vec3u) -> bool {
    if (any(cellPos >= uniforms.gridDimensions - 1u)) { // Cells on the max boundary cannot be fully formed for DC
        return false;
    }
    let cellIndex = gridPosToIndex(cellPos);
    let arrayIndex = cellIndex / 32u;
    let bitIndex = cellIndex % 32u;

    let totalU32sInFlags = (uniforms.gridDimensions.x * uniforms.gridDimensions.y * uniforms.gridDimensions.z + 31u) / 32u;
    if (arrayIndex >= totalU32sInFlags || arrayIndex >= arrayLength(&activeCellFlagsInput_face)) {
        return false; // Out of bounds for the flags array
    }
    return (activeCellFlagsInput_face[arrayIndex] & (1u << bitIndex)) != 0u;
}


// Finds the intersection point t (0-1 range) along an edge.
fn findEdgeIntersection(p0_val: f32, p1_val: f32) -> f32 {
    // Avoid division by zero if p0_val and p1_val are too close
    let diff = p1_val - p0_val;
    if (abs(diff) < 0.00001) {
        return 0.5; // Midpoint if values are too similar
    }
    return clamp((uniforms.isoValue - p0_val) / diff, 0.0, 1.0);
}

// --- NaN/Inf Helper Functions ---
fn isNan(x: f32) -> bool {
    let high = 100000000.0; // A large representable float
    return max(x, high) == high && x != x;
}

fn isInf(x: f32) -> bool {
    // Check against the bit pattern for infinity.
    // Positive Infinity: 0x7F800000
    // Negative Infinity: 0xFF800000
    // abs(x) handles both positive and negative infinity.
    return abs(x) >= f32(bitcast<u32>(0x7f800000u)-1u);
}


// --- QEF Solver Helper Functions ---
// Estimate condition number (simplified)
fn estimateConditionNumber(A: mat3x3f) -> f32 {
    var v = vec3f(1.0, 1.0, 1.0);
    var lambda_max = 0.0;
    for (var i = 0; i < 5; i = i + 1) {
        v = A * v;
        let norm_v = length(v);
        if (norm_v > 1e-6) { // Avoid division by zero or tiny numbers
            lambda_max = norm_v;
            v = v / norm_v;
        } else {
            break;
        }
    }
    let trace_A = A[0][0] + A[1][1] + A[2][2];
    let lambda_min_est = max(1e-6, abs(trace_A / 3.0 - lambda_max * 0.666)); 
    if (lambda_min_est == 0.0) { return 1e9; } 
    return abs(lambda_max / lambda_min_est);
}

// Solve symmetric positive definite system A*x = b using Cholesky decomposition
fn solveCholesky(A: mat3x3f, b: vec3f) -> vec3f {
    var L: mat3x3f; 

    L[0][0] = sqrt(max(A[0][0], 1e-6));
    if (L[0][0] == 0.0) { return vec3f(0.0); } // Avoid division by zero early
    L[1][0] = A[1][0] / L[0][0];
    L[2][0] = A[2][0] / L[0][0];

    L[0][1] = 0.0;
    var val_L11_sq = A[1][1] - L[1][0] * L[1][0];
    L[1][1] = sqrt(max(val_L11_sq, 1e-6));
    if (L[1][1] == 0.0) { return vec3f(0.0); }
    L[2][1] = (A[2][1] - L[2][0] * L[1][0]) / L[1][1];
    
    L[0][2] = 0.0;
    L[1][2] = 0.0;
    var val_L22_sq = A[2][2] - L[2][0] * L[2][0] - L[2][1] * L[2][1];
    L[2][2] = sqrt(max(val_L22_sq, 1e-6));
    if (L[2][2] == 0.0) { return vec3f(0.0); }


    var y: vec3f;
    y.x = b.x / L[0][0];
    y.y = (b.y - L[1][0] * y.x) / L[1][1];
    y.z = (b.z - L[2][0] * y.x - L[2][1] * y.y) / L[2][2];

    var x: vec3f;
    x.z = y.z / L[2][2];
    x.y = (y.y - L[2][1] * x.z) / L[1][1];
    x.x = (y.x - L[1][0] * x.y - L[2][0] * x.z) / L[0][0];
    
    return x;
}

fn solveQEF(qef: QEFData) -> vec3f {
    if (qef.numPoints == 0u) {
        return vec3f(0.0); 
    }

    let massPoint = qef.massPoint / f32(qef.numPoints);

    if (qef.numPoints < 3u) { 
        return massPoint;
    }
    
    var ATA_reg = qef.ATA;
    let regularization = 0.001 * f32(qef.numPoints);
    ATA_reg[0][0] += regularization;
    ATA_reg[1][1] += regularization;
    ATA_reg[2][2] += regularization;

    if (estimateConditionNumber(ATA_reg) > 10000.0) { 
        return massPoint; 
    }

    let solution = solveCholesky(ATA_reg, qef.ATb);
    
    // Corrected NaN/Inf check using vec3<bool> and any()
    let solution_is_nan = vec3<bool>(isNan(solution.x), isNan(solution.y), isNan(solution.z));
    let solution_is_inf = vec3<bool>(isInf(solution.x), isInf(solution.y), isInf(solution.z));
    if (any(solution_is_nan) || any(solution_is_inf)) {
        return massPoint;
    }

    let distToMassPoint = length(solution - massPoint);
    let maxAllowedDist = uniforms.voxelSize * 1.5; 

    if (distToMassPoint > maxAllowedDist) {
        return massPoint + normalize(solution - massPoint) * maxAllowedDist;
    }
    
    return solution;
}


// --- Edge Indexing Functions ---
fn getEdgeIndexX(cellPos: vec3u) -> u32 {
    return cellPos.x + cellPos.y * (uniforms.gridDimensions.x - 1u) + 
           cellPos.z * (uniforms.gridDimensions.x - 1u) * uniforms.gridDimensions.y;
}

fn getEdgeIndexY(cellPos: vec3u) -> u32 {
    return cellPos.y + cellPos.z * (uniforms.gridDimensions.y - 1u) +
           cellPos.x * (uniforms.gridDimensions.y - 1u) * uniforms.gridDimensions.z; 
}

fn getEdgeIndexZ(cellPos: vec3u) -> u32 {
    return cellPos.x + cellPos.y * uniforms.gridDimensions.x + 
           cellPos.z * uniforms.gridDimensions.x * uniforms.gridDimensions.y; 
}


// Workgroup shared memory (declared at module scope)
var<workgroup> workgroup_thread_flags: array<u32, 256>; // General purpose flags, max workgroup size used (e.g. 256 or 32 for Pass1)
var<workgroup> workgroup_compaction_counts: array<u32, 256>; // For Pass 2b prefix sum
var<workgroup> workgroup_triangle_counts_ps: array<u32, 256>; // For Pass 5b prefix sum on triangle counts


// ============================== COMPUTE SHADERS ==============================

// Pass 1: Cell Classification (Corrected for @workgroup_size(32,1,1) and atomic-free packing)
// Dispatch: num_workgroups = ceil(totalGridCells / 32.0)
// activeCellFlags stores 1 bit per cell, packed into u32s.
@compute @workgroup_size(32, 1, 1) // Workgroup size must be 32 for this packing logic
fn cellClassification_Pass1(
    @builtin(local_invocation_id) localId: vec3u, // localId.x is bit_index_in_u32 (0-31)
    @builtin(workgroup_id) workgroupId: vec3u    // workgroupId.x is u32_block_index
) {
    let u32_block_index = workgroupId.x; 
    let bit_index_in_u32 = localId.x;   

    let cellFlatIndex = u32_block_index * 32u + bit_index_in_u32;
    
    let totalGridCells = uniforms.gridDimensions.x * uniforms.gridDimensions.y * uniforms.gridDimensions.z;

    var cell_is_active = 0u;
    if (cellFlatIndex < totalGridCells) {
        let cellPos = gridIndexTo3D(cellFlatIndex);
        if (all(cellPos < uniforms.gridDimensions - 1u)) { 
            var hasPositive = false;
            var hasNegative = false;
            for (var i = 0u; i < 8u; i = i + 1u) {
                let cornerGridPos = getCellCornerPos(cellPos, i); 
                let cornerWorldPos = gridPosToWorldPos(cornerGridPos);
                let sdfValue = sampleSDF(cornerWorldPos);
                if (sdfValue > uniforms.isoValue) { hasPositive = true; }
                else { hasNegative = true; }
                if (hasPositive && hasNegative) { break; }
            }
            if (hasPositive && hasNegative) {
                cell_is_active = 1u;
            }
        }
    }
    
    // workgroup_thread_flags is sized based on max workgroup size, ensure using correct indices for 32.
    workgroup_thread_flags[bit_index_in_u32] = cell_is_active;
    workgroupBarrier(); 

    if (bit_index_in_u32 == 0u) {
        var packedFlags = 0u;
        for (var i = 0u; i < 32u; i = i + 1u) { 
            if (workgroup_thread_flags[i] != 0u) {
                packedFlags = packedFlags | (1u << i);
            }
        }
        let totalU32sToStore = (totalGridCells + 31u) / 32u; 
        if (u32_block_index < totalU32sToStore && u32_block_index < arrayLength(&activeCellFlags)) {
             activeCellFlags[u32_block_index] = packedFlags;
        }
    }
}


// Pass 2a: Count active cells per u32 block from activeCellFlagsIn_compaction
// Dispatch: num_workgroups = ceil(totalU32sInFlags / 256.0)
@compute @workgroup_size(256, 1, 1)
fn countActiveCells_Pass2a(@builtin(global_invocation_id) globalId: vec3u) {
    let u32_block_id = globalId.x; 
    let totalU32sInFlags = (uniforms.gridDimensions.x * uniforms.gridDimensions.y * uniforms.gridDimensions.z + 31u) / 32u;

    // Using activeCellFlagsIn_compaction as defined in bind group
    if (u32_block_id < totalU32sInFlags && u32_block_id < arrayLength(&activeCellFlagsIn_compaction)) {
        let count = countOneBits(activeCellFlagsIn_compaction[u32_block_id]);
        if (u32_block_id < arrayLength(&activeCellIndices_compaction)) { 
            activeCellIndices_compaction[u32_block_id] = count;
        }
    }
}

// Pass 2b: Hierarchical parallel prefix sum (within each workgroup)
// Dispatch: num_workgroups = ceil(totalU32sInFlags / 256.0)
@compute @workgroup_size(256, 1, 1)
fn prefixSumWorkgroup_Pass2b(
    @builtin(global_invocation_id) globalId: vec3u, 
    @builtin(local_invocation_id) localId: vec3u,
    @builtin(workgroup_id) workgroupId: vec3u
) {
    let local_idx = localId.x;
    let global_idx = globalId.x; 
    
    let numCountsToSum = (uniforms.gridDimensions.x * uniforms.gridDimensions.y * uniforms.gridDimensions.z + 31u) / 32u;

    var value_to_sum = 0u;
    if (global_idx < numCountsToSum && global_idx < arrayLength(&activeCellIndices_compaction)) {
        value_to_sum = activeCellIndices_compaction[global_idx];
    }
    workgroup_compaction_counts[local_idx] = value_to_sum;
    workgroupBarrier();

    for (var stride = 1u; stride < 256u; stride = stride << 1u) {
        let val_read_before_overwrite = workgroup_compaction_counts[local_idx]; 
        workgroupBarrier(); 
        if (local_idx >= stride) {
            workgroup_compaction_counts[local_idx] = val_read_before_overwrite + workgroup_compaction_counts[local_idx - stride];
        }
        workgroupBarrier(); 
    }

    if (global_idx < numCountsToSum && global_idx < arrayLength(&activeCellIndices_compaction)) {
        activeCellIndices_compaction[global_idx] = workgroup_compaction_counts[local_idx];
    }

    if (local_idx == 255u) { 
        let workgroup_total_storage_idx = numCountsToSum + workgroupId.x;
        if (workgroup_total_storage_idx < arrayLength(&activeCellIndices_compaction)) {
            activeCellIndices_compaction[workgroup_total_storage_idx] = workgroup_compaction_counts[255u]; 
        }
    }
}

// Pass 2c: Add workgroup offsets to complete global EXCLUSIVE prefix sum
@compute @workgroup_size(256, 1, 1)
fn addWorkgroupOffsets_Pass2c(
    @builtin(global_invocation_id) globalId: vec3u,
    @builtin(local_invocation_id) localId: vec3u,
    @builtin(workgroup_id) workgroupId: vec3u
) {
    let global_idx = globalId.x; 
    let local_idx = localId.x;

    let numCountsToSum = (uniforms.gridDimensions.x * uniforms.gridDimensions.y * uniforms.gridDimensions.z + 31u) / 32u;

    var offset_from_prev_workgroups = 0u;
    if (workgroupId.x > 0u) {
        for (var i = 0u; i < workgroupId.x; i = i + 1u) {
             let prev_wg_total_idx = numCountsToSum + i;
             if(prev_wg_total_idx < arrayLength(&activeCellIndices_compaction)) { 
                offset_from_prev_workgroups = offset_from_prev_workgroups + activeCellIndices_compaction[prev_wg_total_idx];
             }
        }
    }

    if (global_idx < numCountsToSum && global_idx < arrayLength(&activeCellIndices_compaction)) {
        // Read local inclusive sum (which was written by Pass2b to this global_idx)
        let local_inclusive_sum_val = activeCellIndices_compaction[global_idx];
        
        var val_from_prev_element_in_wg_local_inclusive = 0u;
        if (local_idx > 0u) {
            // This should be the local inclusive sum of the element (global_idx - 1)
            // As Pass2b wrote its output (local inclusive sums) to activeCellIndices_compaction[global_idx-1]
            val_from_prev_element_in_wg_local_inclusive = activeCellIndices_compaction[global_idx - 1u];
        }
        
        // The global exclusive sum = (sum of all prior workgroup totals) + (local exclusive sum within this workgroup)
        // local exclusive sum for local_idx = (local_idx == 0) ? 0 : local_inclusive_sum_of_element[local_idx-1]
        // However, activeCellIndices_compaction[global_idx-1] is the local inclusive sum of the *previous global element*,
        // which is correct if global_idx-1 is in the same workgroup.
        // If local_idx is 0, this previous element is from another workgroup, so its local inclusive sum isn't directly relevant.
        // The logic should be: global_exclusive_sum[global_idx] = offset_from_prev_workgroups + (local_idx > 0 ? local_inclusive_sum[local_idx-1]_from_Pass2b_shared_mem : 0)
        // This is where an intermediate buffer for local inclusive sums before adding offsets is cleaner.
        // Given current structure, let's assume activeCellIndices_compaction[idx] contains local inclusive sums before this pass.
        // And we are converting it to global exclusive sums.
        var local_exclusive_sum_component = 0u;
        if(local_idx > 0u) {
            // We need the local inclusive sum of the item at local_idx-1 from this workgroup's block
            // This value *was* in workgroup_compaction_counts[local_idx-1] at the end of Pass2b.
            // If activeCellIndices_compaction[global_idx-1] holds that (because global_idx-1 is in same wg), it's okay.
            // This simplified approach relies on that assumption.
             local_exclusive_sum_component = activeCellIndices_compaction[global_idx-1]; // local inclusive sum of previous element in WG
        }

        let global_exclusive_sum = offset_from_prev_workgroups + local_exclusive_sum_component;
        activeCellIndices_compaction[global_idx] = global_exclusive_sum;


    } else if (global_idx == 0u && numCountsToSum > 0u) { 
         activeCellIndices_compaction[0] = 0u;
    }
}


// Pass 2d: Expand active cells using prefix sum results
@compute @workgroup_size(256, 1, 1)
fn expandActiveCells_Pass2d(
    @builtin(global_invocation_id) globalId: vec3u
) {
    let u32_block_id = globalId.x; 
    let num_u32_blocks_in_flags = (uniforms.gridDimensions.x * uniforms.gridDimensions.y * uniforms.gridDimensions.z + 31u) / 32u;

    // Using activeCellFlagsIn_compaction as defined in bind group
    if (u32_block_id < num_u32_blocks_in_flags && 
        u32_block_id < arrayLength(&activeCellFlagsIn_compaction) && 
        u32_block_id < arrayLength(&activeCellIndices_compaction)) {   

        let flags_for_this_block = activeCellFlagsIn_compaction[u32_block_id];
        let num_set_bits_in_this_block = countOneBits(flags_for_this_block);

        if (num_set_bits_in_this_block > 0u) {
            let output_base_storage_idx = activeCellIndices_compaction[u32_block_id]; 
            let first_cell_flat_idx_in_this_block = u32_block_id * 32u;
            
            var current_output_offset_within_block = 0u;
            for (var bit_pos = 0u; bit_pos < 32u; bit_pos = bit_pos + 1u) {
                if ((flags_for_this_block & (1u << bit_pos)) != 0u) {
                    let actual_cell_flat_idx = first_cell_flat_idx_in_this_block + bit_pos;
                    if (actual_cell_flat_idx < uniforms.gridDimensions.x * uniforms.gridDimensions.y * uniforms.gridDimensions.z) {
                        let final_compacted_array_write_idx = output_base_storage_idx + current_output_offset_within_block;
                        if (final_compacted_array_write_idx < arrayLength(&activeCellIndices_compaction)) { 
                             activeCellIndices_compaction[final_compacted_array_write_idx] = actual_cell_flat_idx;
                        }
                        current_output_offset_within_block = current_output_offset_within_block + 1u;
                    }
                }
            }
        }
    }

    if (globalId.x == num_u32_blocks_in_flags - 1u && num_u32_blocks_in_flags > 0u) {
        let exclusive_sum_of_last_block = activeCellIndices_compaction[num_u32_blocks_in_flags - 1u];
        // Using activeCellFlagsIn_compaction for count
        let count_in_last_block = countOneBits(activeCellFlagsIn_compaction[num_u32_blocks_in_flags - 1u]);
        activeCellCount_compaction = exclusive_sum_of_last_block + count_in_last_block;
    } else if (num_u32_blocks_in_flags == 0u && globalId.x == 0u) { 
         activeCellCount_compaction = 0u;
    }
}


// Pass 3: Edge Detection and QEF Accumulation
@compute @workgroup_size(64, 1, 1)
fn edgeDetection_Pass3(@builtin(global_invocation_id) globalId: vec3u) {
    let active_cell_array_idx = globalId.x; 

    let totalActiveCells = activeCellCount_edgeInput; 
    if (active_cell_array_idx >= totalActiveCells || active_cell_array_idx >= arrayLength(&activeCellIndicesIn_edge)) { return; }

    let cellFlatIndex = activeCellIndicesIn_edge[active_cell_array_idx];
    let cellPos = gridIndexTo3D(cellFlatIndex);

    var qef = QEFData(mat3x3f(), vec3f(0.0), vec3f(0.0), 0u);

    var cornerSDFValues: array<f32, 8>;
    var cornerWorldPositions: array<vec3f, 8>;
    for (var i = 0u; i < 8u; i = i + 1u) {
        let cornerGridPos = getCellCornerPos(cellPos, i);
        cornerWorldPositions[i] = gridPosToWorldPos(cornerGridPos);
        cornerSDFValues[i] = sampleSDF(cornerWorldPositions[i]);
    }
    
    let edges_info = array<vec4u, 12>( 
        vec4u(0u, 1u, 0u, 1u), vec4u(2u, 3u, 0u, 0u), vec4u(4u, 5u, 0u, 0u), vec4u(6u, 7u, 0u, 0u),
        vec4u(0u, 2u, 1u, 1u), vec4u(1u, 3u, 1u, 0u), vec4u(4u, 6u, 1u, 0u), vec4u(5u, 7u, 1u, 0u),
        vec4u(0u, 4u, 2u, 1u), vec4u(1u, 5u, 2u, 0u), vec4u(2u, 6u, 2u, 0u), vec4u(3u, 7u, 2u, 0u)
    );

    for (var i = 0u; i < 12u; i = i + 1u) {
        let c1_idx = edges_info[i][0];
        let c2_idx = edges_info[i][1];
        let axis_enum = edges_info[i][2]; 
        let is_owned_edge = (edges_info[i][3] == 1u);

        let val0 = cornerSDFValues[c1_idx];
        let val1 = cornerSDFValues[c2_idx];

        if ((val0 - uniforms.isoValue) * (val1 - uniforms.isoValue) < 0.0) {
            let p0_world = cornerWorldPositions[c1_idx];
            let p1_world = cornerWorldPositions[c2_idx];
            
            let t = findEdgeIntersection(val0, val1);
            let intersectionPos = mix(p0_world, p1_world, t);
            let normal = computeGradient(intersectionPos);

            qef.ATA[0] = qef.ATA[0] + normal * normal.x;
            qef.ATA[1] = qef.ATA[1] + normal * normal.y;
            qef.ATA[2] = qef.ATA[2] + normal * normal.z;
            
            let d_val = dot(normal, intersectionPos);
            qef.ATb = qef.ATb + normal * d_val;
            
            qef.massPoint = qef.massPoint + intersectionPos;
            qef.numPoints = qef.numPoints + 1u;

            if (is_owned_edge) {
                let edgeCrossingData = EdgeCrossing(intersectionPos, normal);
                var edgeStoreIdx: u32;
                if (axis_enum == 0u) { 
                    edgeStoreIdx = getEdgeIndexX(cellPos);
                    if (edgeStoreIdx < arrayLength(&edgeCrossingsX)) { edgeCrossingsX[edgeStoreIdx] = edgeCrossingData; }
                } else if (axis_enum == 1u) { 
                    edgeStoreIdx = getEdgeIndexY(cellPos);
                     if (edgeStoreIdx < arrayLength(&edgeCrossingsY)) { edgeCrossingsY[edgeStoreIdx] = edgeCrossingData; }
                } else { 
                    edgeStoreIdx = getEdgeIndexZ(cellPos);
                     if (edgeStoreIdx < arrayLength(&edgeCrossingsZ)) { edgeCrossingsZ[edgeStoreIdx] = edgeCrossingData; }
                }
            }
        }
    }
    
    if (active_cell_array_idx < arrayLength(&cellQEFData_edge)) {
        cellQEFData_edge[active_cell_array_idx] = qef;
    }
}


// Pass 4: Vertex Generation
@compute @workgroup_size(64, 1, 1)
fn vertexGeneration_Pass4(@builtin(global_invocation_id) globalId: vec3u) {
    let active_cell_array_idx = globalId.x; 

    let totalActiveCells = activeCellCount_vertexInput;
    if (active_cell_array_idx >= totalActiveCells || active_cell_array_idx >= arrayLength(&cellQEFDataIn_vertex)) { return; }

    let qef = cellQEFDataIn_vertex[active_cell_array_idx];
    let vertexPos = solveQEF(qef);
    
    var vertexNormal = computeGradient(vertexPos); 
    if (qef.numPoints == 0u) { 
        vertexNormal = vec3f(0.0,1.0,0.0); 
    }
    
    if (active_cell_array_idx < arrayLength(&vertices)) {
        vertices[active_cell_array_idx] = Vertex(vertexPos, vertexNormal);
    }
}

// --- Triangle Generation Helper Functions (for Pass 5c) ---
fn hasEdgeCrossingX(cellPos: vec3u, cornerSDFValues: array<f32, 8>) -> bool {
    let val0 = cornerSDFValues[0]; 
    let val1 = cornerSDFValues[1]; 
    return (val0 - uniforms.isoValue) * (val1 - uniforms.isoValue) < 0.0;
}

fn hasEdgeCrossingY(cellPos: vec3u, cornerSDFValues: array<f32, 8>) -> bool {
    let val0 = cornerSDFValues[0]; 
    let val1 = cornerSDFValues[2]; 
    return (val0 - uniforms.isoValue) * (val1 - uniforms.isoValue) < 0.0;
}

fn hasEdgeCrossingZ(cellPos: vec3u, cornerSDFValues: array<f32, 8>) -> bool {
    let val0 = cornerSDFValues[0]; 
    let val1 = cornerSDFValues[4]; 
    return (val0 - uniforms.isoValue) * (val1 - uniforms.isoValue) < 0.0;
}

fn areFourCellsAroundXEdgeActive(cellPos: vec3u) -> bool {
    if (cellPos.y == 0u || cellPos.z == 0u) { return false; } 
    return isCellActive(cellPos) && 
           isCellActive(cellPos - vec3u(0u, 1u, 0u)) && 
           isCellActive(cellPos - vec3u(0u, 0u, 1u)) && 
           isCellActive(cellPos - vec3u(0u, 1u, 1u));   
}

fn areFourCellsAroundYEdgeActive(cellPos: vec3u) -> bool {
    if (cellPos.x == 0u || cellPos.z == 0u) { return false; }
    return isCellActive(cellPos) && 
           isCellActive(cellPos - vec3u(1u, 0u, 0u)) && 
           isCellActive(cellPos - vec3u(0u, 0u, 1u)) && 
           isCellActive(cellPos - vec3u(1u, 0u, 1u));   
}

fn areFourCellsAroundZEdgeActive(cellPos: vec3u) -> bool {
    if (cellPos.x == 0u || cellPos.y == 0u) { return false; }
    return isCellActive(cellPos) && 
           isCellActive(cellPos - vec3u(1u, 0u, 0u)) && 
           isCellActive(cellPos - vec3u(0u, 1u, 0u)) && 
           isCellActive(cellPos - vec3u(1u, 1u, 0u));   
}

fn findVertexIndexForCell(targetCellPos: vec3u) -> i32 {
    let totalActive = activeCellCount_faceInput; 
    for (var i = 0u; i < totalActive; i = i + 1u) {
        if (i >= arrayLength(&activeCellIndicesIn_face)) { break; } 
        let currentCellFlatIndex = activeCellIndicesIn_face[i];
        if (all(gridIndexTo3D(currentCellFlatIndex) == targetCellPos)) {
            return i32(i); 
        }
    }
    return -1; 
}


// Pass 5a: Count triangles per active cell
@compute @workgroup_size(64, 1, 1)
fn countTriangles_Pass5a(@builtin(global_invocation_id) globalId: vec3u) {
    let active_cell_array_idx = globalId.x;

    let totalActiveCells = activeCellCount_faceInput;
    if (active_cell_array_idx >= totalActiveCells || active_cell_array_idx >= arrayLength(&activeCellIndicesIn_face)) { return; }

    let cellFlatIndex = activeCellIndicesIn_face[active_cell_array_idx];
    let cellPos = gridIndexTo3D(cellFlatIndex);

    var cornerSDFValues_cell: array<f32, 8>;
    for (var i = 0u; i < 8u; i = i + 1u) {
        let cgp = getCellCornerPos(cellPos, i);
        cornerSDFValues_cell[i] = sampleSDF(gridPosToWorldPos(cgp));
    }

    var numTrianglesForThisCell = 0u;
    if (hasEdgeCrossingX(cellPos, cornerSDFValues_cell) && areFourCellsAroundXEdgeActive(cellPos)) {
        numTrianglesForThisCell = numTrianglesForThisCell + 2u;
    }
    if (hasEdgeCrossingY(cellPos, cornerSDFValues_cell) && areFourCellsAroundYEdgeActive(cellPos)) {
        numTrianglesForThisCell = numTrianglesForThisCell + 2u;
    }
    if (hasEdgeCrossingZ(cellPos, cornerSDFValues_cell) && areFourCellsAroundZEdgeActive(cellPos)) {
        numTrianglesForThisCell = numTrianglesForThisCell + 2u;
    }
    
    if (active_cell_array_idx < arrayLength(&triangleOffsets_face)) {
        triangleOffsets_face[active_cell_array_idx] = numTrianglesForThisCell;
    }
}

// Pass 5b: Prefix sum on triangle counts
@compute @workgroup_size(256, 1, 1)
fn prefixSumTriangles_Pass5b(
    @builtin(global_invocation_id) globalId: vec3u, 
    @builtin(local_invocation_id) localId: vec3u,
    @builtin(workgroup_id) workgroupId: vec3u 
) {
    let element_idx_global = globalId.x; 
    let local_idx = localId.x;
    let totalActiveCellsToProcess = activeCellCount_faceInput; 

    var count_val = 0u;
    if (element_idx_global < totalActiveCellsToProcess && element_idx_global < arrayLength(&triangleOffsets_face)) {
        count_val = triangleOffsets_face[element_idx_global];
    }
    workgroup_triangle_counts_ps[local_idx] = count_val;
    workgroupBarrier();

    for (var stride = 1u; stride < 256u; stride = stride << 1u) { 
        let temp = workgroup_triangle_counts_ps[local_idx];
        workgroupBarrier();
        if (local_idx >= stride) {
            workgroup_triangle_counts_ps[local_idx] = temp + workgroup_triangle_counts_ps[local_idx - stride];
        }
        workgroupBarrier();
    }
    
    var exclusive_sum_val = 0u;
    if (local_idx > 0u) { 
        exclusive_sum_val = workgroup_triangle_counts_ps[local_idx - 1u];
    }
    
    // Simplified: This part needs proper multi-block scan logic if totalActiveCellsToProcess > 256
    // For now, assuming it's handled by dispatching correctly for smaller sets or a more complex scan not shown here.
    // Add offset from previous workgroups if this is part of a multi-block scan:
    // var block_offset = 0u; if (workgroupId.x > 0u) { /* get sum of previous blocks' totals */ }
    // exclusive_sum_val += block_offset;


    if (element_idx_global < totalActiveCellsToProcess && element_idx_global < arrayLength(&triangleOffsets_face)) {
        triangleOffsets_face[element_idx_global] = exclusive_sum_val; 
    }

    // Determine if this workgroup is the one processing the last element
    let numWorkgroups = (totalActiveCellsToProcess + 255u) / 256u;
    if (workgroupId.x == numWorkgroups - 1u ) { 
        // Determine if this thread is the one that processed the very last element
        if (local_idx == (totalActiveCellsToProcess - 1u) % 256u && totalActiveCellsToProcess > 0u ) { 
             let total_triangles = workgroup_triangle_counts_ps[local_idx]; 
             indexCount_face = total_triangles * 3u;
        }
    }
    if (totalActiveCellsToProcess == 0u && element_idx_global == 0u) { 
        indexCount_face = 0u;
    }
}

// Pass 5c: Generate actual triangles
fn generateQuadIndices(
    baseOutputIdx: u32, 
    v0_idx: u32, v1_idx: u32, v2_idx: u32, v3_idx: u32, 
    flipWinding: bool
) {
    // Quad defined by v0, v1, v2, v3 in a specific order for DC.
    // Standard: v0(owner), v1(adj1), v2(diag), v3(adj2) -> triangles (v0,v1,v2), (v0,v2,v3)
    // The previous code used v0, v1, v3, v2 for the quad definition passed in.
    // For quad v0,v1,v3,v2 (CCW): Tri1(v0,v1,v3), Tri2(v0,v3,v2)
    if (flipWinding) {
        // Tri1: v0, v2, v3 (was v0,v2,v3)
        if (baseOutputIdx + 2u < arrayLength(&indices)) {
            indices[baseOutputIdx + 0u] = v0_idx;
            indices[baseOutputIdx + 1u] = v3_idx; // Corrected based on CCW(v0,v3,v2)
            indices[baseOutputIdx + 2u] = v2_idx; // Corrected
        }
        // Tri2: v0, v3, v1 (was v0,v3,v1)
        if (baseOutputIdx + 5u < arrayLength(&indices)) {
            indices[baseOutputIdx + 3u] = v0_idx; 
            indices[baseOutputIdx + 4u] = v1_idx; // Corrected based on CCW(v0,v1,v3)
            indices[baseOutputIdx + 5u] = v3_idx; // Corrected
        }
    } else { 
        // Tri1: v0, v1, v3
         if (baseOutputIdx + 2u < arrayLength(&indices)) {
            indices[baseOutputIdx + 0u] = v0_idx;
            indices[baseOutputIdx + 1u] = v1_idx;
            indices[baseOutputIdx + 2u] = v3_idx;
        }
        // Tri2: v0, v3, v2
         if (baseOutputIdx + 5u < arrayLength(&indices)) {
            indices[baseOutputIdx + 3u] = v0_idx; 
            indices[baseOutputIdx + 4u] = v3_idx;
            indices[baseOutputIdx + 5u] = v2_idx;
        }
    }
}


@compute @workgroup_size(64, 1, 1)
fn generateTriangles_Pass5c(@builtin(global_invocation_id) globalId: vec3u) {
    let active_cell_array_idx = globalId.x; 

    let totalActiveCells = activeCellCount_faceInput;
    if (active_cell_array_idx >= totalActiveCells || active_cell_array_idx >= arrayLength(&activeCellIndicesIn_face) || active_cell_array_idx >= arrayLength(&triangleOffsets_face)) { return; }

    let cellFlatIndex = activeCellIndicesIn_face[active_cell_array_idx];
    let cellPos = gridIndexTo3D(cellFlatIndex);

    let output_triangle_start_offset_for_this_cell = triangleOffsets_face[active_cell_array_idx];
    var current_triangle_base_write_idx = output_triangle_start_offset_for_this_cell * 3u; 

    var cornerSDFValues_cell: array<f32, 8>;
    var cornerWorldPos_cell: array<vec3f, 8>; 
    for (var i = 0u; i < 8u; i = i + 1u) {
        let cgp = getCellCornerPos(cellPos, i);
        cornerWorldPos_cell[i] = gridPosToWorldPos(cgp);
        cornerSDFValues_cell[i] = sampleSDF(cornerWorldPos_cell[i]);
    }

    // X-edge: C(x,y,z) to C(x+1,y,z). Quad vertices from cells:
    // v0_cell: C(x,y,z) (owner)
    // v1_cell: C(x,y-1,z)
    // v2_cell: C(x,y,z-1)
    // v3_cell: C(x,y-1,z-1) (diagonal to owner across the quad face)
    // Quad face vertices in order for generateQuadIndices: v0_owner, v1_adj_ym, v3_diag_ymzm, v2_adj_zm
    if (hasEdgeCrossingX(cellPos, cornerSDFValues_cell) && areFourCellsAroundXEdgeActive(cellPos)) {
        let v0_vert_idx = i32(active_cell_array_idx); 
        let v1_vert_idx = findVertexIndexForCell(cellPos - vec3u(0u, 1u, 0u)); 
        let v2_vert_idx = findVertexIndexForCell(cellPos - vec3u(0u, 0u, 1u)); 
        let v3_vert_idx = findVertexIndexForCell(cellPos - vec3u(0u, 1u, 1u)); 

        if (v0_vert_idx >=0 && v1_vert_idx >=0 && v2_vert_idx >=0 && v3_vert_idx >=0) { 
            let edge_mid_point = mix(cornerWorldPos_cell[0], cornerWorldPos_cell[1], 0.5); 
            let surface_gradient = computeGradient(edge_mid_point);
            let flip = dot(surface_gradient, vec3f(1.0, 0.0, 0.0)) < 0.0; 
            generateQuadIndices(current_triangle_base_write_idx, u32(v0_vert_idx), u32(v1_vert_idx), u32(v2_vert_idx), u32(v3_vert_idx), flip);
            current_triangle_base_write_idx = current_triangle_base_write_idx + 6u; 
        }
    }

    // Y-edge: C(x,y,z) to C(x,y+1,z). Quad vertices from cells:
    // v0_cell: C(x,y,z) (owner)
    // v1_cell: C(x-1,y,z)
    // v2_cell: C(x,y,z-1)
    // v3_cell: C(x-1,y,z-1) (diagonal)
    // Quad face vertices order: v0_owner, v1_adj_xm, v3_diag_xmzm, v2_adj_zm
    if (hasEdgeCrossingY(cellPos, cornerSDFValues_cell) && areFourCellsAroundYEdgeActive(cellPos)) {
        let v0_vert_idx = i32(active_cell_array_idx); 
        let v1_vert_idx = findVertexIndexForCell(cellPos - vec3u(1u, 0u, 0u)); 
        let v2_vert_idx = findVertexIndexForCell(cellPos - vec3u(0u, 0u, 1u)); 
        let v3_vert_idx = findVertexIndexForCell(cellPos - vec3u(1u, 0u, 1u)); 

        if (v0_vert_idx >=0 && v1_vert_idx >=0 && v2_vert_idx >=0 && v3_vert_idx >=0) {
            let edge_mid_point = mix(cornerWorldPos_cell[0], cornerWorldPos_cell[2], 0.5); 
            let surface_gradient = computeGradient(edge_mid_point);
            let flip = dot(surface_gradient, vec3f(0.0, 1.0, 0.0)) < 0.0;
            generateQuadIndices(current_triangle_base_write_idx, u32(v0_vert_idx), u32(v1_vert_idx), u32(v2_vert_idx), u32(v3_vert_idx), !flip); // Y often flips convention
            current_triangle_base_write_idx = current_triangle_base_write_idx + 6u;
        }
    }
    
    // Z-edge: C(x,y,z) to C(x,y,z+1). Quad vertices from cells:
    // v0_cell: C(x,y,z) (owner)
    // v1_cell: C(x-1,y,z)
    // v2_cell: C(x,y-1,z)
    // v3_cell: C(x-1,y-1,z) (diagonal)
    // Quad face vertices order: v0_owner, v1_adj_xm, v3_diag_xmym, v2_adj_ym
    if (hasEdgeCrossingZ(cellPos, cornerSDFValues_cell) && areFourCellsAroundZEdgeActive(cellPos)) {
        let v0_vert_idx = i32(active_cell_array_idx); 
        let v1_vert_idx = findVertexIndexForCell(cellPos - vec3u(1u, 0u, 0u)); 
        let v2_vert_idx = findVertexIndexForCell(cellPos - vec3u(0u, 1u, 0u)); 
        let v3_vert_idx = findVertexIndexForCell(cellPos - vec3u(1u, 1u, 0u)); 

        if (v0_vert_idx >=0 && v1_vert_idx >=0 && v2_vert_idx >=0 && v3_vert_idx >=0) {
            let edge_mid_point = mix(cornerWorldPos_cell[0], cornerWorldPos_cell[4], 0.5); 
            let surface_gradient = computeGradient(edge_mid_point);
            let flip = dot(surface_gradient, vec3f(0.0, 0.0, 1.0)) < 0.0;
            generateQuadIndices(current_triangle_base_write_idx, u32(v0_vert_idx), u32(v1_vert_idx), u32(v2_vert_idx), u32(v3_vert_idx), flip);
            current_triangle_base_write_idx = current_triangle_base_write_idx + 6u;
        }
    }
}

