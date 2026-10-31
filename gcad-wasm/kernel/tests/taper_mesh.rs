//! End-to-end SFCC meshing of taper-warp scenes (field-only under the warp):
//! geometry correctness through the full pipeline — octree certification,
//! contouring, cell meshing, assembly — plus closed-mesh topology and
//! determinism across two runs. Warped regions carry no analytic carriers by
//! design (see docs/feat/sfcc/taper.md); these tests pin the fallback path.
use gcad_kernel::math::similarity::Similarity;
use gcad_kernel::sdf::{self, CsgNode, Leaf, Shape};
use gcad_kernel::sfcc::feature_set::build_leaf_strata;
use gcad_kernel::sfcc::pipeline::{run_sfcc_pipeline, PipelineTuning, SfccWorldCube};

fn prepared(mut tree: CsgNode) -> CsgNode {
    fn attach(node: &mut CsgNode, leaf_index: &mut usize, first_id: &mut usize) {
        match node {
            CsgNode::Leaf(leaf) => {
                let strata = build_leaf_strata(
                    &Leaf { strata: Vec::new(), ..leaf.clone() },
                    *leaf_index,
                    *first_id,
                );
                *first_id += strata.len();
                *leaf_index += 1;
                leaf.strata = strata;
            }
            CsgNode::Taper { child, .. } => attach(child, leaf_index, first_id),
            CsgNode::Min(children) | CsgNode::Max(children) | CsgNode::Blend { children, .. } => {
                children.iter_mut().for_each(|child| attach(child, leaf_index, first_id));
            }
        }
    }
    tree.assign_leaf_indices();
    attach(&mut tree, &mut 0, &mut 0);
    tree
}

/// Mark every leaf under a warp the way the scene bridge does (the builders
/// above start from plain leaves, so the warp flags are set after the fact).
fn warp_all(node: &mut CsgNode) {
    fn mark(node: &mut CsgNode, scale: f64) {
        match node {
            CsgNode::Leaf(l) => {
                l.warped = true;
                l.warp_scale = scale;
                l.strata.clear();
            }
            CsgNode::Min(ch) | CsgNode::Max(ch) => ch.iter_mut().for_each(|c| mark(c, scale)),
            CsgNode::Blend { children, .. } => children.iter_mut().for_each(|c| mark(c, scale)),
            CsgNode::Taper { ratio, child, .. } => mark(child, scale * ratio.max(1.0)),
        }
    }
    mark(node, 1.0);
}

fn cube(size: f64) -> SfccWorldCube {
    SfccWorldCube { min_x: -size, min_y: -size, min_z: -size, size: size * 2.0 }
}

fn closed_mesh(verts: &[f32], tris: &[u32]) {
    assert!(tris.len() % 3 == 0);
    assert!(!tris.is_empty(), "empty mesh");
    // Stride-8 vertex buffer (pos, pad, normal, pad); weld by exact position
    // bits — degenerate best-effort cells may emit duplicate vertex IDs at
    // coincident positions; geometry is what closes.
    assert!(verts.len() % 8 == 0);
    let n = verts.len() / 8;
    let mut weld = std::collections::HashMap::<[u8; 12], u32>::new();
    let mut canonical = vec![0u32; n];
    for i in 0..n {
        let mut bits = [0u8; 12];
        for k in 0..3 {
            bits[k * 4..k * 4 + 4].copy_from_slice(&verts[i * 8 + k].to_bits().to_le_bytes());
        }
        let next = weld.len() as u32;
        canonical[i] = *weld.entry(bits).or_insert(next);
    }
    let mut edges = std::collections::BTreeMap::<(u32, u32), i32>::new();
    for t in tris.chunks_exact(3) {
        let tri = [canonical[t[0] as usize], canonical[t[1] as usize], canonical[t[2] as usize]];
        if tri[0] == tri[1] || tri[1] == tri[2] || tri[0] == tri[2] {
            continue; // degenerate slivers are allowed by the remesher
        }
        for k in 0..3 {
            let a = tri[k].min(tri[(k + 1) % 3]);
            let b = tri[k].max(tri[(k + 1) % 3]);
            *edges.entry((a, b)).or_insert(0) += 1;
        }
    }
    // Every undirected edge must appear an even number of times (each triangle
    // contribution pairs up across adjacent faces in a closed surface).
    for (e, count) in edges {
        assert_eq!(count % 2, 0, "boundary edge {e:?} with odd incidence {count}");
    }
}

/// Vertex position (x, y, z) from the stride-8 buffer.
fn v(verts: &[f32], i: usize) -> [f32; 3] {
    [verts[i * 8], verts[i * 8 + 1], verts[i * 8 + 2]]
}

fn taper_prism(ratio: f64) -> CsgNode {
    // A box spanning the whole band: the classic draft-angle part.
    sdf::taper(
        ratio,
        8.0,
        Similarity::identity(),
        sdf::leaf_at(Shape::Cuboid { half: [2.0, 4.0, 2.0] }, [0.0, 4.0, 0.0]),
    )
}

#[test]
fn tapered_prism_meshes_closed_and_deterministic() {
    for ratio in [0.5f64, 1.8] {
        let mut tree = taper_prism(ratio);
        warp_all(&mut tree);
        let tree = prepared(tree);
        let tuning = PipelineTuning::default();
        let a = run_sfcc_pipeline(&tree, &cube(10.0), &tuning);
        assert!(
            a.manifold.ok,
            "ratio {ratio}: mesh not closed (open={}, nm={}, mis={})",
            a.manifold.open_edges,
            a.manifold.non_manifold_edges,
            a.manifold.misoriented_edges
        );
        assert_eq!(a.manifold.components, 1, "ratio {ratio}");
        let b = run_sfcc_pipeline(&tree, &cube(10.0), &tuning);
        assert!(!a.tris.is_empty(), "ratio {ratio}: no triangles");
        closed_mesh(&a.verts, &a.tris);
        assert_eq!(a.verts, b.verts, "ratio {ratio}: verts not deterministic");
        assert_eq!(a.tris, b.tris, "ratio {ratio}: tris not deterministic");
        // Geometry sanity: the mesh respects the warp. At y=4 (band middle)
        // the cross-section half-width is 2·(1 + (ratio−1)·0.5).
        let expect = 2.0 * (1.0 + (ratio - 1.0) * 0.5);
        let mut max_abs_x = 0.0f32;
        for i in 0..(a.verts.len() / 8) {
            let p = v(&a.verts, i);
            if (p[1] - 4.0).abs() < 0.35 {
                max_abs_x = max_abs_x.max(p[0].abs());
            }
        }
        assert!(
            (max_abs_x - expect as f32).abs() < 0.2,
            "ratio {ratio}: mid-band half-width {max_abs_x}, expected ~{expect}"
        );
    }
}

#[test]
fn taper_over_subtract_meshes_the_carved_draft() {
    // subtract(box, cylinder-ish carve) under a taper — the bowl.gcad shape of
    // the operator (taper over a hard boolean).
    let mut tree = sdf::taper(
        0.6,
        10.0,
        Similarity::identity(),
        sdf::subtract(
            sdf::leaf_at(Shape::Cuboid { half: [4.0, 5.0, 4.0] }, [0.0, 5.0, 0.0]),
            sdf::leaf_at(Shape::Cylinder { r: 1.5, h: 6.0 }, [0.0, 5.0, 0.0]),
        ),
    );
    warp_all(&mut tree);
    let tree = prepared(tree);
    let result = run_sfcc_pipeline(&tree, &cube(12.0), &PipelineTuning::default());
    assert!(!result.tris.is_empty());
    closed_mesh(&result.verts, &result.tris);
    // The carved bore shrinks with height: at y=5 (s = 0.7) the bore radius is
    // 1.05 and the outer wall 2.8. No mesh vertex may sit inside the bore
    // except near its own surface.
    for i in 0..(result.verts.len() / 8) {
        let p = v(&result.verts, i);
        if (p[1] - 5.0).abs() < 0.3 {
            let r = (p[0] * p[0] + p[2] * p[2]).sqrt();
            assert!(
                r > 0.85 || r < 0.001,
                "vertex inside the carved bore at y≈5: r={r}"
            );
        }
    }
}

#[test]
fn taper_inside_a_blend_still_meshes() {
    // union(round-blend).taper(): the blend surface itself runs through the
    // warp; refinement (not carriers) resolves it.
    let mut tree = sdf::taper(
        0.7,
        9.0,
        Similarity::identity(),
        sdf::union_smooth(
            vec![
                sdf::leaf_at(Shape::Sphere { r: 3.0 }, [-1.5, 4.5, 0.0]),
                sdf::leaf_at(Shape::Sphere { r: 2.5 }, [1.5, 4.0, 0.5]),
            ],
            gcad_kernel::primitives::smin::SminMode::Round,
            0.8,
            3.0,
        ),
    );
    warp_all(&mut tree);
    let tree = prepared(tree);
    let result = run_sfcc_pipeline(&tree, &cube(10.0), &PipelineTuning::default());
    assert!(!result.tris.is_empty());
    closed_mesh(&result.verts, &result.tris);
}
