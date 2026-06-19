//! Slice 5 / Stage A — cross-INSTANCE worker partition equivalence gate.
//!
//! Proves the three-phase worker split — `prepare` (serial: tagged octree → bytes)
//! → `mesh_partition` (per-worker: rebuild octree from leaves, mesh ONE Morton
//! group into its own table → partial bytes) → `merge` (dedup partials by global
//! key + the S4 tail) — reconstructs the serial `run_sfcc_pipeline` mesh, for
//! N ∈ {1,2,4,8} partitions, on box / box-minus-sphere / rounded-union / twisted-l.
//!
//! Equivalence is CANONICAL (pos_eps = 0), not byte-identical buffer order: separate
//! per-worker tables assign point ids independently, so the merge reconstructs the
//! same mesh up to the canonical (key/position) ordering — exactly the
//! `spatial_partition.rs` separate-table gate, now decomposed across the serializable
//! prepare/mesh/merge boundary (the cargo-testable proxy for separate wasm instances).

use gcad_kernel::parity::{meshes_equivalent, CanonicalizeOptions};
use gcad_kernel::primitives::polygon2d::winding_sign;
use gcad_kernel::sdf::{self, CsgNode, Leaf, Shape};
use gcad_kernel::sfcc::feature_set::build_leaf_strata;
use gcad_kernel::sfcc::pipeline::{run_sfcc_pipeline, PipelineTuning, SfccWorldCube};
use gcad_kernel::sfcc::worker::{merge, mesh_partition, prepare};

// --- scene builders (mirrors spatial_partition.rs; integration test crates can't
//     share a private helper module, so the small builders are duplicated) --------

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

fn box_minus_sphere_scene() -> CsgNode {
    prepared_tree(sdf::subtract(
        sdf::leaf_at(Shape::Cuboid { half: [10.0, 10.0, 10.0] }, [0.0, 0.0, 0.0]),
        sdf::leaf_at(Shape::Sphere { r: 6.0 }, [5.0, 5.0, 5.0]),
    ))
}

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

/// Assert the {prepare → mesh each of N partitions → merge} mesh is canonically
/// equivalent (pos_eps = 0) to the serial single pass, for several N.
fn assert_worker_equiv_serial(name: &str, tree: &CsgNode, c: &SfccWorldCube) {
    let serial = run_sfcc_pipeline(tree, c, &tuning());
    assert!(!serial.tris.is_empty(), "{name}: serial produced triangles");
    assert!(serial.manifold.ok, "{name}: serial is a closed 2-manifold");

    // The serial ~60%: tagged octree → byte buffer. Done ONCE on the "main thread".
    let leaves_bytes = prepare(tree, c, &tuning());

    for &n in &[1usize, 2, 4, 8] {
        // Each "worker" meshes ONE Morton group into its own partial. Independent
        // calls — exactly what separate wasm instances will do.
        let partials: Vec<Vec<u8>> =
            (0..n).map(|i| mesh_partition(tree, c, &tuning(), &leaves_bytes, i, n)).collect();

        // The "main thread" merges the partials by global key + runs the S4 tail.
        let merged = merge(tree, c, &tuning(), &partials);

        assert!(
            merged.manifold.ok,
            "{name}: worker partitions={n} not a closed manifold (open_edges={}, non_manifold_edges={}, misoriented={}, tris serial={} worker={})",
            merged.manifold.open_edges,
            merged.manifold.non_manifold_edges,
            merged.manifold.misoriented_edges,
            serial.tris.len() / 3,
            merged.tris.len() / 3,
        );
        assert_eq!(
            merged.manifold.euler_per_component, serial.manifold.euler_per_component,
            "{name}: worker partitions={n} Euler characteristic drifted"
        );
        assert_eq!(
            merged.tris.len(),
            serial.tris.len(),
            "{name}: worker partitions={n} triangle count differs from serial"
        );

        let sv: Vec<f64> = serial.verts.iter().map(|&f| f as f64).collect();
        let wv: Vec<f64> = merged.verts.iter().map(|&f| f as f64).collect();
        let exact = CanonicalizeOptions { pos_eps: 0.0, compare_normals: true, ..CanonicalizeOptions::default() };
        meshes_equivalent(&sv, &serial.tris, &wv, &merged.tris, &exact)
            .unwrap_or_else(|e| panic!("{name}: worker partitions={n} NOT canonically identical to serial: {e}"));
    }
    println!(
        "[worker-partition] {name}: prepare→mesh(1,2,4,8)→merge == serial (canonical, pos_eps=0); leaf buffer = {} bytes",
        leaves_bytes.len()
    );
}

#[test]
fn box_worker_partition_equiv_serial() {
    assert_worker_equiv_serial("box", &box_scene(), &cube20());
}

#[test]
fn box_minus_sphere_worker_partition_equiv_serial() {
    assert_worker_equiv_serial("box-minus-sphere", &box_minus_sphere_scene(), &cube20());
}

#[test]
fn rounded_union_worker_partition_equiv_serial() {
    assert_worker_equiv_serial("rounded-union", &rounded_union_scene(), &cube20());
}

#[test]
fn twisted_l_worker_partition_equiv_serial() {
    let (tree, c) = twisted_l_scene();
    assert_worker_equiv_serial("twisted-l", &tree, &c);
}
