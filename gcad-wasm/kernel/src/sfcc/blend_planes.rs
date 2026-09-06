//! Planar patches introduced by chamfer combiners. A hard cut through one of
//! these patches has a real crease even though neither primitive carrier lies
//! on the blend's zero set. Keep the affine field coefficients (not just a unit
//! normal) while composing nested chamfers; normalize only for seam tracing.
use super::tree::SfccTree;
use crate::primitives::smin::SminMode;
use crate::sdf::{BlendKind, CsgNode};
use crate::strata::{CarrierKind, Stratum, StratumIdentity};

#[derive(Clone)]
struct Patch {
    field: [f64; 4],
    bounds: [f64; 6],
}

pub fn append_chamfer_planes(tree: &mut SfccTree<'_>) -> Vec<(usize, [f64; 6])> {
    fn walk(
        node: &CsgNode,
        tree: &SfccTree<'_>,
        leaf: &mut usize,
        added: &mut Vec<Patch>,
    ) -> Vec<Patch> {
        let children = match node {
            CsgNode::Leaf(_) => {
                let i = *leaf;
                *leaf += 1;
                return tree
                    .leaf_strata(i)
                    .iter()
                    .filter(|s| s.kind == CarrierKind::Plane)
                    .map(|s| {
                        let n = s.normal(0., 0., 0.);
                        Patch {
                            field: [n[0], n[1], n[2], s.f(0., 0., 0.)],
                            bounds: tree.leaves[i].aabb,
                        }
                    })
                    .collect();
            }
            CsgNode::Min(c) | CsgNode::Max(c) | CsgNode::Blend { children: c, .. } => c,
        };
        let sets: Vec<_> = children
            .iter()
            .map(|c| walk(c, tree, leaf, added))
            .collect();
        let mut out: Vec<Patch> = sets.iter().flatten().cloned().collect();
        if let CsgNode::Blend {
            kind,
            mode: SminMode::Chamfer,
            r,
            ..
        } = node
        {
            if *r <= 0. {
                return out;
            }
            let sign = if *kind == BlendKind::Smin { 1. } else { -1. };
            for i in 0..sets.len() {
                for j in i + 1..sets.len() {
                    for a in &sets[i] {
                        for b in &sets[j] {
                            let mut bounds = [0.; 6];
                            for k in 0..3 {
                                bounds[k] = a.bounds[k].max(b.bounds[k]) - r;
                                bounds[k + 3] = a.bounds[k + 3].min(b.bounds[k + 3]) + r;
                            }
                            if (0..3).any(|k| bounds[k] >= bounds[k + 3]) {
                                continue;
                            }
                            let mut field = [0.; 4];
                            for k in 0..4 {
                                field[k] =
                                    (a.field[k] + b.field[k]) * std::f64::consts::FRAC_1_SQRT_2;
                            }
                            field[3] -= sign * r * std::f64::consts::FRAC_1_SQRT_2;
                            if field[..3].iter().map(|x| x * x).sum::<f64>() < 1e-20 {
                                continue;
                            }
                            let patch = Patch { field, bounds };
                            added.push(patch.clone());
                            out.push(patch);
                        }
                    }
                }
            }
        }
        out
    }
    let mut added = Vec::new();
    walk(tree.root, tree, &mut 0, &mut added);
    let mut result: Vec<(usize, [f64; 6])> = Vec::new();
    for patch in added {
        let f = patch.field;
        let len = f[..3].iter().map(|x| x * x).sum::<f64>().sqrt();
        // Different child-patch combinations can describe the same plane.
        // Trace that carrier once so coincident seams do not create duplicate pins.
        if let Some((_, bounds)) = result.iter_mut().find(|(id, _)| {
            let st = tree.strata[*id];
            let n = st.normal(0., 0., 0.);
            (0..3).all(|k| (n[k] - f[k] / len).abs() < 1e-12)
                && (st.f(0., 0., 0.) - f[3] / len).abs() < 1e-12 * (1. + (f[3] / len).abs())
        }) {
            for k in 0..3 {
                bounds[k] = bounds[k].min(patch.bounds[k]);
                bounds[k + 3] = bounds[k + 3].max(patch.bounds[k + 3]);
            }
            continue;
        }
        let id = tree.strata.len();
        tree.strata.push(Stratum::plane(
            StratumIdentity {
                id,
                owner_node_id: -1,
                leaf_index: usize::MAX,
                local_index: 0,
                sign: 1.,
            },
            f[0] / len,
            f[1] / len,
            f[2] / len,
            f[3] / len,
        ));
        result.push((id, patch.bounds));
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sdf::{leaf_at, Shape};
    use crate::sfcc::{feature_set::build_leaf_strata, tree::build_tree};

    fn slab() -> CsgNode {
        leaf_at(
            Shape::Cuboid {
                half: [10., 10., 3.],
            },
            [0.; 3],
        )
    }
    fn chamfer(kind: BlendKind, children: Vec<CsgNode>) -> CsgNode {
        CsgNode::Blend {
            kind,
            mode: SminMode::Chamfer,
            r: 1.5,
            n: 0.,
            children,
        }
    }
    #[test]
    fn nested_chamfers_preserve_affine_field_magnitude() {
        for kind in [BlendKind::Smin, BlendKind::Smax] {
            let root = chamfer(kind, vec![chamfer(kind, vec![slab(), slab()]), slab()]);
            let mut tree = build_tree(&root, build_leaf_strata);
            let patches = append_chamfer_planes(&mut tree);
            let shift = (1.5 / 2f64.sqrt() + 1.5) / (2f64.sqrt() + 1.);
            let z = 3.
                + if kind == BlendKind::Smin {
                    shift
                } else {
                    -shift
                };
            assert!(root.f([0., 0., z]).abs() < 1e-12);
            assert!(
                patches.iter().any(|&(id, _)| {
                    let st = tree.strata[id];
                    st.normal(0., 0., z)[2] > 0.99 && st.f(0., 0., z).abs() < 1e-12
                }),
                "nested blend must not treat its child's field as unit-gradient"
            );
        }
    }
    #[test]
    fn hard_combiners_add_no_blend_planes() {
        let root = CsgNode::Min(vec![slab(), slab()]);
        let mut tree = build_tree(&root, build_leaf_strata);
        let before = tree.strata.len();
        assert!(append_chamfer_planes(&mut tree).is_empty());
        assert_eq!(tree.strata.len(), before);
    }
}
