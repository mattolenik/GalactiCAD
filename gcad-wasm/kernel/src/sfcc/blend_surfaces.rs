//! Smooth carrier patches introduced by chamfer combiners, including curved
//! branches. Full-tree trimming determines where each supporting patch is live.
use super::tree::SfccTree;
use crate::primitives::smin::SminMode;
use crate::sdf::{BlendKind, CsgNode};
use crate::strata::{CarrierKind, Stratum, StratumIdentity};

#[derive(Clone)]
struct Patch {
    carrier: Stratum,
    bounds: [f64; 6],
}
fn identity(id: usize) -> StratumIdentity {
    StratumIdentity { id, owner_node_id: -1, leaf_index: usize::MAX, local_index: 0, sign: 1. }
}

pub fn append_chamfer_carriers(tree: &mut SfccTree<'_>) -> Vec<(usize, [f64; 6])> {
    use super::field_branches::FieldRef;
    let root = std::sync::Arc::new(tree.root.clone());
    fn walk(
        root: &std::sync::Arc<CsgNode>,
        path: &mut Vec<usize>,
        node: &CsgNode,
        tree: &SfccTree<'_>,
        leaf: &mut usize,
        added: &mut Vec<Patch>,
        domains: &mut Vec<(usize, FieldRef)>,
    ) -> Patch {
        let mut bounds =
            [f64::INFINITY, f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
        match node {
            CsgNode::Leaf(l) => {
                bounds = tree.leaves[*leaf].aabb;
                domains.push((*leaf, FieldRef::new(root.clone(), path.clone())));
                for field in super::feature_set::all_loft_side_fields(l).into_iter() {
                    if tree.leaf_strata(*leaf).iter().any(|s| s.same_primitive_field(&field)) {
                        continue;
                    }
                    added.push(Patch { carrier: field.with_domain(FieldRef::new(root.clone(), path.clone())), bounds });
                }
                *leaf += 1;
            }
            CsgNode::Min(children) | CsgNode::Max(children) | CsgNode::Blend { children, .. } => {
                let operands: Vec<_> = children
                    .iter()
                    .enumerate()
                    .map(|(i, c)| {
                        path.push(i);
                        let patch = walk(root, path, c, tree, leaf, added, domains);
                        path.pop();
                        patch
                    })
                    .collect();
                for operand in &operands {
                    for k in 0..3 {
                        bounds[k] = bounds[k].min(operand.bounds[k]);
                        bounds[k + 3] = bounds[k + 3].max(operand.bounds[k + 3]);
                    }
                }
                if let CsgNode::Blend { kind, mode, r, .. } = node {
                    for k in 0..3 {
                        bounds[k] -= r.abs();
                        bounds[k + 3] += r.abs();
                    }
                    if *mode == SminMode::Chamfer && *r > 0. {
                        let sign = if *kind == BlendKind::Smin { 1. } else { -1. };
                        for i in 0..operands.len() {
                            for j in i + 1..operands.len() {
                                // Each operand is its exact subtree field, not a
                                // collection of zero-surface extensions. This
                                // includes rim/vertex regions and nested blends.
                                added.push(Patch {
                                    carrier: Stratum::combination(
                                        identity(0),
                                        &operands[i].carrier,
                                        &operands[j].carrier,
                                        -sign * r * std::f64::consts::FRAC_1_SQRT_2,
                                    )
                                    .with_domain(FieldRef::new(root.clone(), path.clone())),
                                    bounds,
                                });
                            }
                        }
                    } else if *r > 0. {
                        // Smooth attachments need no crease, but a subsequent
                        // hard cut must intersect the operator's actual surface.
                        added.push(Patch {
                            carrier: Stratum::field(identity(0), FieldRef::new(root.clone(), path.clone()))
                                .with_domain(FieldRef::new(root.clone(), path.clone())),
                            bounds,
                        });
                    }
                }
            }
        }
        Patch { carrier: Stratum::field(identity(0), FieldRef::new(root.clone(), path.clone())), bounds }
    }
    let mut added = Vec::new();
    let mut domains = Vec::new();
    walk(&root, &mut Vec::new(), tree.root, tree, &mut 0, &mut added, &mut domains);
    for (leaf, domain) in domains {
        let range = tree.leaves[leaf].strata_start..tree.leaves[leaf].strata_end;
        for id in range {
            tree.strata[id] = tree.strata[id].clone().with_domain(domain.clone());
        }
    }
    let mut result: Vec<(usize, [f64; 6])> = Vec::new();
    for patch in added {
        let id = tree.strata.len();
        let carrier = if let Some(f) = patch.carrier.planar_coefficients() {
            let len = f[..3].iter().map(|x| x * x).sum::<f64>().sqrt();
            // Different child combinations may describe the same plane. Merge
            // their bounds to avoid tracing duplicate coincident seams.
            if let Some((existing, bounds)) = result.iter_mut().find(|(id, _)| {
                let st = &tree.strata[*id];
                if st.kind != CarrierKind::Plane {
                    return false;
                }
                let n = st.normal(0., 0., 0.);
                (0..3).all(|k| (n[k] - f[k] / len).abs() < 1e-12)
                    && (st.f(0., 0., 0.) - f[3] / len).abs() < 1e-12 * (1. + (f[3] / len).abs())
            }) {
                tree.strata[*existing].merge_domains(&patch.carrier);
                for k in 0..3 {
                    bounds[k] = bounds[k].min(patch.bounds[k]);
                    bounds[k + 3] = bounds[k + 3].max(patch.bounds[k + 3]);
                }
                continue;
            }
            Stratum::plane(identity(id), f[0] / len, f[1] / len, f[2] / len, f[3] / len).with_domain_of(&patch.carrier)
        } else {
            let mut carrier = patch.carrier;
            carrier.id = id;
            carrier
        };
        tree.strata.push(carrier);
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
        leaf_at(Shape::Cuboid { half: [10., 10., 3.] }, [0.; 3])
    }
    fn chamfer(kind: BlendKind, children: Vec<CsgNode>) -> CsgNode {
        CsgNode::Blend { kind, mode: SminMode::Chamfer, r: 1.5, n: 0., children }
    }
    #[test]
    fn nested_chamfers_preserve_affine_field_magnitude() {
        for kind in [BlendKind::Smin, BlendKind::Smax] {
            let root = chamfer(kind, vec![chamfer(kind, vec![slab(), slab()]), slab()]);
            let mut tree = build_tree(&root, build_leaf_strata);
            let patches = append_chamfer_carriers(&mut tree);
            let shift = (1.5 / 2f64.sqrt() + 1.5) / (2f64.sqrt() + 1.);
            let z = 3. + if kind == BlendKind::Smin { shift } else { -shift };
            assert!(root.f([0., 0., z]).abs() < 1e-12);
            assert!(
                patches.iter().any(|&(id, _)| {
                    let st = &tree.strata[id];
                    st.normal(0., 0., z)[2] > 0.99 && st.f(0., 0., z).abs() < 1e-12
                }),
                "nested blend must not treat its child's field as unit-gradient"
            );
        }
    }
    #[test]
    fn hard_combiners_add_no_blend_surfaces() {
        let root = CsgNode::Min(vec![slab(), slab()]);
        let mut tree = build_tree(&root, build_leaf_strata);
        let before = tree.strata.len();
        assert!(append_chamfer_carriers(&mut tree).is_empty());
        assert_eq!(tree.strata.len(), before);
    }
}
