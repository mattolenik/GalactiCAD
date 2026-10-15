#![allow(dead_code)]
use gcad_kernel::sdf::{self, CsgNode, Shape};
use gcad_kernel::sfcc::feature_set::build_leaf_strata;
use gcad_kernel::sfcc::pipeline::SfccWorldCube;
pub const CENTER: [f64; 3] = [0.04125955406450752, 1.53, 1.53];
pub const RADIUS: f64 = 0.01650382162580301;
pub fn prepared(mut tree: CsgNode) -> CsgNode {
    fn attach(tree: &mut CsgNode, first: &mut usize) {
        match tree {
            CsgNode::Leaf(l) => {
                l.strata = build_leaf_strata(l, l.index, *first);
                *first += l.strata.len();
            }
            CsgNode::Min(ch) | CsgNode::Max(ch) | CsgNode::Blend { children: ch, .. } => {
                for c in ch {
                    attach(c, first);
                }
            }
        }
    }
    tree.assign_leaf_indices();
    attach(&mut tree, &mut 0);
    tree
}
pub fn sphere(r: f64, pos: [f64; 3]) -> CsgNode {
    sdf::leaf_at(Shape::Sphere { r }, pos)
}
pub fn box_node() -> CsgNode {
    sdf::leaf_at(Shape::Cuboid { half: [3.; 3] }, [0.; 3])
}
pub fn cube() -> SfccWorldCube {
    SfccWorldCube {
        min_x: -10.,
        min_y: -10.,
        min_z: -10.,
        size: 20.,
    }
}
pub fn hidden() -> (CsgNode, SfccWorldCube) {
    (
        prepared(sdf::union(vec![
            sdf::leaf_at(
                Shape::Cuboid {
                    half: [50., 100., 100.],
                },
                [-50., 0., 0.],
            ),
            sphere(RADIUS, CENTER),
        ])),
        SfccWorldCube {
            min_x: -100.,
            min_y: -100.,
            min_z: -100.,
            size: 200.,
        },
    )
}
pub fn many_hidden() -> (CsgNode, SfccWorldCube) {
    let (t, c) = hidden();
    let CsgNode::Min(mut ch) = t else {
        unreachable!()
    };
    for i in 0..16 {
        ch.push(sphere(0.25, [-50., i as f64 - 8., 0.]));
    }
    (prepared(sdf::union(ch)), c)
}
