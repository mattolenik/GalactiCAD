//! M6d parallel-vs-serial proof harness: dumps a stable hash of the SFCC mesh
//! (verts byte buffer + tris) for the gate scenes. Build it twice — once with the
//! default (serial) features, once `--features threads` (rayon) — and diff the
//! output; identical hashes ⇒ parallel output == serial output, byte-for-byte.
//!
//!   cargo run -p gcad-kernel --release --example m6d_meshhash > /tmp/serial.txt
//!   cargo run -p gcad-kernel --release --features threads --example m6d_meshhash > /tmp/threads.txt
//!   diff /tmp/serial.txt /tmp/threads.txt   # empty ⇒ identical

use gcad_kernel::primitives::polygon2d::winding_sign;
use gcad_kernel::sdf::{self, CsgNode, Leaf, Shape};
use gcad_kernel::sfcc::feature_set::build_leaf_strata;
use gcad_kernel::sfcc::pipeline::{run_sfcc_pipeline, PipelineTuning, SfccWorldCube};

fn attach_strata(node: &mut CsgNode, leaf_index: &mut usize, first_id: &mut usize) {
    match node {
        CsgNode::Leaf(l) => {
            let strata = build_leaf_strata(&Leaf { strata: Vec::new(), ..l.clone() }, *leaf_index, *first_id);
            *first_id += strata.len();
            *leaf_index += 1;
            l.strata = strata;
        }
        CsgNode::Min(ch) | CsgNode::Max(ch) => ch.iter_mut().for_each(|c| attach_strata(c, leaf_index, first_id)),
        CsgNode::Blend { children, .. } => children.iter_mut().for_each(|c| attach_strata(c, leaf_index, first_id)),
    }
}

fn prepared(mut tree: CsgNode) -> CsgNode {
    tree.assign_leaf_indices();
    let (mut li, mut fi) = (0usize, 0usize);
    attach_strata(&mut tree, &mut li, &mut fi);
    tree
}

/// FNV-1a over the raw verts + tris bytes (order-sensitive: the buffers are
/// already deterministic, so the hash is the byte-identity witness).
fn hash_mesh(verts: &[f32], tris: &[u32]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    let mut feed = |b: u8| {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    };
    for v in verts {
        for b in v.to_le_bytes() {
            feed(b);
        }
    }
    for t in tris {
        for b in t.to_le_bytes() {
            feed(b);
        }
    }
    h
}

fn run(name: &str, tree: &CsgNode, c: &SfccWorldCube) {
    let tuning = PipelineTuning { depth_min: 4, depth_max: 7, ..PipelineTuning::default() };
    let r = run_sfcc_pipeline(tree, c, &tuning);
    println!(
        "{name}: verts={} tris={} leaves={} hash={:016x}",
        r.verts.len() / 8,
        r.tris.len() / 3,
        r.stats.leaves,
        hash_mesh(&r.verts, &r.tris)
    );
}

fn main() {
    let cube20 = SfccWorldCube { min_x: -10.0, min_y: -10.0, min_z: -10.0, size: 20.0 };
    run("box", &prepared(sdf::leaf_at(Shape::Cuboid { half: [10.0, 10.0, 10.0] }, [0.0, 0.0, 0.0])), &cube20);
    run(
        "box-minus-sphere",
        &prepared(sdf::subtract(
            sdf::leaf_at(Shape::Cuboid { half: [10.0, 10.0, 10.0] }, [0.0, 0.0, 0.0]),
            sdf::leaf_at(Shape::Sphere { r: 6.0 }, [5.0, 5.0, 5.0]),
        )),
        &cube20,
    );
    let l_poly: [[f64; 2]; 6] = [[-3.0, -3.0], [3.0, -3.0], [3.0, 0.0], [0.0, 0.0], [0.0, 3.0], [-3.0, 3.0]];
    let lv: Vec<f64> = l_poly.iter().flat_map(|v| [v[0], v[1]]).collect();
    let twisted_l = prepared(sdf::leaf_at(
        Shape::Extrude { verts: lv, wind: winding_sign(&l_poly), h: 5.0, twist_rad: std::f64::consts::FRAC_PI_2 },
        [0.0, 0.0, 0.0],
    ));
    run("twisted-l", &twisted_l, &SfccWorldCube { min_x: -6.0, min_y: -6.0, min_z: -6.0, size: 12.0 });
}
