//! Spatial-partition meshing — #3 slice 1 determinism gate.
//!
//! The SFCC mesh phases (face contour + cell mesh) are now separable: they can run
//! over a SUBSET of the octree's surface leaves and write into a SHARED face map +
//! point table, sequentially over N contiguous groups
//! (`run_sfcc_pipeline_partitioned`). This is the in-process correctness substrate
//! for the eventual cross-worker, separate-table parallel mesher (design doc
//! `docs/research/sfcc-spatial-partition-meshing.md`).
//!
//! The invariant proven here: meshing in ANY number of contiguous partitions yields
//! a mesh BYTE-IDENTICAL to the serial single-pass result (pos_eps = 0). It holds
//! because (a) the point-table provenance keys are GLOBAL (lattice-derived), so a
//! boundary face contoured from both adjacent groups dedups exactly; (b) the shared
//! face map resolves T-junctions for free (a coarse cell skips its face toward a
//! finer region, and the finer cells — possibly in another group — contour the
//! sub-faces into the same map); and (c) contiguous groups preserve cell order, so
//! the triangle buffer order is unchanged. This is exactly the "any N == serial"
//! gate the design doc requires before the parallel build can be trusted.

use gcad_kernel::parity::{meshes_equivalent, CanonicalizeOptions};
use gcad_kernel::primitives::polygon2d::winding_sign;
use gcad_kernel::sdf::{self, CsgNode, Leaf, Shape};
use gcad_kernel::sfcc::feature_set::build_leaf_strata;
use gcad_kernel::sfcc::pipeline::{
    run_sfcc_pipeline, run_sfcc_pipeline_partitioned, run_sfcc_pipeline_partitioned_morton,
    run_sfcc_pipeline_separate_partitioned, run_sfcc_pipeline_separate_partitioned_morton, PipelineTuning, SfccWorldCube,
};

fn attach_strata(node: &mut CsgNode, leaf_index: &mut usize, first_id: &mut usize) {
    match node {
        CsgNode::Leaf(l) => {
            let strata = build_leaf_strata(&Leaf { strata: Vec::new(), ..l.clone() }, *leaf_index, *first_id);
            *first_id += strata.len();
            *leaf_index += 1;
            l.strata = strata;
        }
        CsgNode::Min(ch) | CsgNode::Max(ch) => {
            for c in ch.iter_mut() {
                attach_strata(c, leaf_index, first_id);
            }
        }
        CsgNode::Blend { children, .. } => {
            for c in children.iter_mut() {
                attach_strata(c, leaf_index, first_id);
            }
        }
    }
}

fn prepared_tree(mut tree: CsgNode) -> CsgNode {
    tree.assign_leaf_indices();
    let mut leaf_index = 0usize;
    let mut first_id = 0usize;
    attach_strata(&mut tree, &mut leaf_index, &mut first_id);
    tree
}

fn cube20() -> SfccWorldCube {
    SfccWorldCube { min_x: -10.0, min_y: -10.0, min_z: -10.0, size: 20.0 }
}

fn box_scene() -> CsgNode {
    prepared_tree(sdf::leaf_at(Shape::Cuboid { half: [10.0, 10.0, 10.0] }, [0.0, 0.0, 0.0]))
}

/// Subtract: hard booleans → many Min/Max combiners → boolean-seam feature curves +
/// T-junctions where the carve refines. Exercises the owner-query mesh paths and the
/// shared-face-map T-junction stitching across group boundaries.
fn box_minus_sphere_scene() -> CsgNode {
    prepared_tree(sdf::subtract(
        sdf::leaf_at(Shape::Cuboid { half: [10.0, 10.0, 10.0] }, [0.0, 0.0, 0.0]),
        sdf::leaf_at(Shape::Sphere { r: 6.0 }, [5.0, 5.0, 5.0]),
    ))
}

/// A round Smin union (smooth blend) — the blend band has no owners, exercising a
/// different cell-mesh path than the hard booleans.
fn rounded_union_scene() -> CsgNode {
    prepared_tree(sdf::union_smooth(
        vec![
            sdf::leaf_at(Shape::Cuboid { half: [7.0, 7.0, 7.0] }, [-3.0, 0.0, 0.0]),
            sdf::leaf_at(Shape::Sphere { r: 7.0 }, [4.0, 0.0, 0.0]),
        ],
        gcad_kernel::primitives::smin::SminMode::Round,
        3.0,
        2.0,
    ))
}

/// A twisted L-profile extrude — the classify-bound, feature-edge-heavy family.
fn twisted_l_scene() -> (CsgNode, SfccWorldCube) {
    let l_poly: [[f64; 2]; 6] = [[-3.0, -3.0], [3.0, -3.0], [3.0, 0.0], [0.0, 0.0], [0.0, 3.0], [-3.0, 3.0]];
    let verts: Vec<f64> = l_poly.iter().flat_map(|v| [v[0], v[1]]).collect();
    let wind = winding_sign(&l_poly);
    let twist_rad = 90.0_f64 * std::f64::consts::PI / 180.0;
    let tree = prepared_tree(sdf::leaf_at(Shape::Extrude { verts, wind, h: 5.0, twist_rad }, [0.0, 0.0, 0.0]));
    (tree, SfccWorldCube { min_x: -6.0, min_y: -6.0, min_z: -6.0, size: 12.0 })
}

fn tuning() -> PipelineTuning {
    PipelineTuning { depth_min: 4, depth_max: 7, ..PipelineTuning::default() }
}

/// Assert: partitioned(N) is byte-identical to the serial single pass for several N,
/// and the partitioned mesh is itself a valid closed manifold. Returns the leaf
/// count so the caller can sanity-check the partition actually splits work.
fn assert_partition_equiv_serial(name: &str, tree: &CsgNode, c: &SfccWorldCube) {
    let serial = run_sfcc_pipeline(tree, c, &tuning());
    assert!(!serial.tris.is_empty(), "{name}: serial produced triangles");
    assert!(serial.manifold.ok, "{name}: serial is a closed 2-manifold");

    for &n in &[1usize, 2, 3, 5, 8] {
        let part = run_sfcc_pipeline_partitioned(tree, c, &tuning(), n);

        // The strongest statement: byte-identical vertex + triangle buffers.
        assert_eq!(serial.verts, part.verts, "{name}: partitions={n} vertex buffer not byte-identical to serial");
        assert_eq!(serial.tris, part.tris, "{name}: partitions={n} triangle buffer not byte-identical to serial");

        // Topology must be preserved too (catches winding/orientation drift at eps 0).
        assert!(part.manifold.ok, "{name}: partitions={n} not a closed manifold");
        assert_eq!(
            part.manifold.euler_per_component, serial.manifold.euler_per_component,
            "{name}: partitions={n} Euler characteristic drifted"
        );
        let sv: Vec<f64> = serial.verts.iter().map(|&f| f as f64).collect();
        let pv: Vec<f64> = part.verts.iter().map(|&f| f as f64).collect();
        let exact = CanonicalizeOptions { pos_eps: 0.0, compare_normals: true, ..CanonicalizeOptions::default() };
        meshes_equivalent(&sv, &serial.tris, &pv, &part.tris, &exact)
            .unwrap_or_else(|e| panic!("{name}: partitions={n} NOT canonically identical to serial: {e}"));
    }
    println!("[partition] {name}: partitioned(1,2,3,5,8) == serial, byte-identical");
}

#[test]
fn box_partition_equiv_serial() {
    assert_partition_equiv_serial("box", &box_scene(), &cube20());
}

#[test]
fn box_minus_sphere_partition_equiv_serial() {
    assert_partition_equiv_serial("box-minus-sphere", &box_minus_sphere_scene(), &cube20());
}

#[test]
fn rounded_union_partition_equiv_serial() {
    assert_partition_equiv_serial("rounded-union", &rounded_union_scene(), &cube20());
}

#[test]
fn twisted_l_partition_equiv_serial() {
    let (tree, c) = twisted_l_scene();
    assert_partition_equiv_serial("twisted-l", &tree, &c);
}

// ---------------------------------------------------------------------------
// #3 slice 3 — SEPARATE-table partials (the per-worker view), merged by global key.
// ---------------------------------------------------------------------------

/// Assert: the SEPARATE-table partitioned mesher — each contiguous group meshed into
/// its OWN face map + point table (halo-aware: a group's coarse cells contour the
/// finer sub-faces their T-junctions need, since the finer cells may be in another
/// group), then merged by global provenance key — is mesh-equivalent to the serial
/// single pass for several N. This is the correctness gate before the JS Web-Worker
/// orchestration (slice 5).
///
/// Unlike the shared-table slice-1 gate this is CANONICAL equivalence (pos_eps = 0),
/// NOT byte-identical buffer order: separate tables assign point ids independently, so
/// the merge reconstructs the same mesh up to the canonical (key/position) ordering —
/// exactly what the design doc's determinism section states ("canonicalizing the merge
/// yields a result identical to the serial run").
fn assert_separate_partition_equiv_serial(name: &str, tree: &CsgNode, c: &SfccWorldCube) {
    let serial = run_sfcc_pipeline(tree, c, &tuning());
    assert!(!serial.tris.is_empty(), "{name}: serial produced triangles");
    assert!(serial.manifold.ok, "{name}: serial is a closed 2-manifold");

    for &n in &[1usize, 2, 3, 5, 8] {
        let part = run_sfcc_pipeline_separate_partitioned(tree, c, &tuning(), n);

        assert!(
            part.manifold.ok,
            "{name}: separate partitions={n} not a closed manifold (open_edges={}, non_manifold_edges={}, misoriented={}, tris serial={} part={})",
            part.manifold.open_edges,
            part.manifold.non_manifold_edges,
            part.manifold.misoriented_edges,
            serial.tris.len() / 3,
            part.tris.len() / 3,
        );
        assert_eq!(
            part.manifold.euler_per_component, serial.manifold.euler_per_component,
            "{name}: separate partitions={n} Euler characteristic drifted"
        );
        assert_eq!(
            part.tris.len(),
            serial.tris.len(),
            "{name}: separate partitions={n} triangle count differs from serial"
        );

        let sv: Vec<f64> = serial.verts.iter().map(|&f| f as f64).collect();
        let pv: Vec<f64> = part.verts.iter().map(|&f| f as f64).collect();
        let exact = CanonicalizeOptions { pos_eps: 0.0, compare_normals: true, ..CanonicalizeOptions::default() };
        meshes_equivalent(&sv, &serial.tris, &pv, &part.tris, &exact)
            .unwrap_or_else(|e| panic!("{name}: separate partitions={n} NOT canonically identical to serial: {e}"));
    }
    println!("[separate-partition] {name}: separate(1,2,3,5,8) == serial (canonical, pos_eps=0)");
}

// ---------------------------------------------------------------------------
// #3 slice 2 — MORTON/Z-order leaf partition (spatially compact, count-balanced),
// over BOTH the shared-table (slice 1) and separate-table (slice 3) meshers.
// ---------------------------------------------------------------------------

/// Assert: Morton-partitioned meshing — leaves grouped by Z-order (spatially compact)
/// instead of contiguous `(level,key)` ranges — is mesh-equivalent to the serial single
/// pass for several N, for BOTH the shared face map and the separate-table+merge view.
///
/// CANONICAL equivalence (pos_eps = 0), not byte-identical: Morton reorders the cell
/// processing order, so the triangle buffer reorders, but the global point keys make the
/// reconstructed mesh identical up to canonical ordering. This proves slice 2's grouping
/// is correctness-neutral (it only changes load balance / halo size) — the property the
/// JS worker orchestration (slice 5) relies on when it hands each worker a Morton chunk.
fn assert_morton_partition_equiv_serial(name: &str, tree: &CsgNode, c: &SfccWorldCube) {
    let serial = run_sfcc_pipeline(tree, c, &tuning());
    assert!(!serial.tris.is_empty(), "{name}: serial produced triangles");
    assert!(serial.manifold.ok, "{name}: serial is a closed 2-manifold");
    let exact = CanonicalizeOptions { pos_eps: 0.0, compare_normals: true, ..CanonicalizeOptions::default() };

    for &n in &[2usize, 3, 5, 8] {
        for (kind, part) in [
            ("shared-morton", run_sfcc_pipeline_partitioned_morton(tree, c, &tuning(), n)),
            ("separate-morton", run_sfcc_pipeline_separate_partitioned_morton(tree, c, &tuning(), n)),
        ] {
            assert!(
                part.manifold.ok,
                "{name}: {kind} partitions={n} not a closed manifold (open_edges={}, non_manifold_edges={}, misoriented={})",
                part.manifold.open_edges,
                part.manifold.non_manifold_edges,
                part.manifold.misoriented_edges,
            );
            assert_eq!(
                part.manifold.euler_per_component, serial.manifold.euler_per_component,
                "{name}: {kind} partitions={n} Euler characteristic drifted"
            );
            assert_eq!(
                part.tris.len(),
                serial.tris.len(),
                "{name}: {kind} partitions={n} triangle count differs from serial"
            );
            let sv: Vec<f64> = serial.verts.iter().map(|&f| f as f64).collect();
            let pv: Vec<f64> = part.verts.iter().map(|&f| f as f64).collect();
            meshes_equivalent(&sv, &serial.tris, &pv, &part.tris, &exact)
                .unwrap_or_else(|e| panic!("{name}: {kind} partitions={n} NOT canonically identical to serial: {e}"));
        }
    }
    println!("[morton-partition] {name}: shared+separate morton(2,3,5,8) == serial (canonical, pos_eps=0)");
}

#[test]
fn box_morton_partition_equiv_serial() {
    assert_morton_partition_equiv_serial("box", &box_scene(), &cube20());
}

#[test]
fn box_minus_sphere_morton_partition_equiv_serial() {
    assert_morton_partition_equiv_serial("box-minus-sphere", &box_minus_sphere_scene(), &cube20());
}

#[test]
fn rounded_union_morton_partition_equiv_serial() {
    assert_morton_partition_equiv_serial("rounded-union", &rounded_union_scene(), &cube20());
}

#[test]
fn twisted_l_morton_partition_equiv_serial() {
    let (tree, c) = twisted_l_scene();
    assert_morton_partition_equiv_serial("twisted-l", &tree, &c);
}

#[test]
fn box_separate_partition_equiv_serial() {
    assert_separate_partition_equiv_serial("box", &box_scene(), &cube20());
}

#[test]
fn box_minus_sphere_separate_partition_equiv_serial() {
    assert_separate_partition_equiv_serial("box-minus-sphere", &box_minus_sphere_scene(), &cube20());
}

#[test]
fn rounded_union_separate_partition_equiv_serial() {
    assert_separate_partition_equiv_serial("rounded-union", &rounded_union_scene(), &cube20());
}

#[test]
fn twisted_l_separate_partition_equiv_serial() {
    let (tree, c) = twisted_l_scene();
    assert_separate_partition_equiv_serial("twisted-l", &tree, &c);
}
