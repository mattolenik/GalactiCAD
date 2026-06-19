//! M5 scene bridge: ingest a SERIALIZED scene (the boundary input) → build the
//! Rust [`CsgNode`] tree + attach strata, ready for [`run_sfcc_pipeline`].
//!
//! Port of `compileCpuSdf`'s scene walk (`src/export/sfcc/cpu-sdf.mts`) operating
//! over a serialized node description instead of live `Node` instances. The walk
//! is structurally identical: it folds Subtract into pure min/max via negation
//! parity, bakes Translate/Rotate/uniform-Scale into a [`Similarity`], and
//! rejects everything outside the SFCC v1 subset with [`SceneBridgeError`]
//! (mirroring `SfccUnsupportedError`).
//!
//! The strata are NOT carried across the boundary — they are recomputed in Rust
//! from each leaf's shape/sim/pos/sign via [`build_leaf_strata`] in left-to-right
//! CSG traversal order (matching `compile_native_features`), exactly as the M4
//! parity tests do. The downstream feature compilation reads `leaf.strata`, so
//! the bridge attaches them here.
//!
//! Boundary INPUT shape ([`BridgeNode`]): a self-contained recursive scene tree.
//! Scene primitives store pos/size as f32 on the TS side (`Vec3f`); the serializer
//! WIDENS them to f64 before emitting, so the bridge ingests plain f64 — matching
//! `compileCpuSdf`, which reads `node.pos.x` (an f32-backed value widened to JS
//! number). With `serde` (off by default), the same shape deserializes from JSON.

use crate::math::similarity::Similarity;
use crate::primitives::polygon2d::winding_sign;
use crate::primitives::shapes::{lathe_profile_edges, LatheEdgeKind, LATHE_AXIS_R};
use crate::primitives::smin::SminMode;
use crate::sdf::{self, CsgNode, Leaf, Shape};
use crate::sfcc::feature_set::build_leaf_strata;

#[cfg(feature = "serde")]
use serde::Deserialize;

/// One offending node, mirroring `SfccUnsupportedNode`.
#[derive(Clone, Debug, PartialEq)]
pub struct UnsupportedNode {
    pub node_id: i64,
    pub shape_type: String,
    pub reason: String,
}

/// The bridge could not build a pipeline-ready tree. Mirrors `SfccUnsupportedError`
/// (the `unsupported` path) plus an empty-scene case.
#[derive(Clone, Debug, PartialEq)]
pub struct SceneBridgeError {
    pub unsupported: Vec<UnsupportedNode>,
}

impl std::fmt::Display for SceneBridgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let list: Vec<String> = self
            .unsupported
            .iter()
            .map(|u| format!("{} (#{}): {}", u.shape_type, u.node_id, u.reason))
            .collect();
        write!(f, "SFCC export does not support: {}", list.join("; "))
    }
}

impl std::error::Error for SceneBridgeError {}

/// Smooth-boolean blend mode as it arrives over the boundary (user-facing names,
/// matching the TS `BlendMode` strings). `blend_mode_of` maps these to the
/// internal [`SminMode`] per family, exactly like `blendModeOf` in cpu-sdf.mts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "lowercase"))]
pub enum BridgeBlendMode {
    Round,
    Soft,
    Chamfer,
    Stairs,
    Columns,
}

/// A serialized scene node — the boundary INPUT shape. Recursive (children are
/// inline, not id references), self-contained, and limited to the SFCC v1 subset.
/// `node_id` is advisory (surfaced in error messages); geometry never depends on
/// it. With `serde`, deserializes from a tagged JSON object (`"kind"` field).
#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(Deserialize))]
#[cfg_attr(feature = "serde", serde(tag = "kind", rename_all = "snake_case"))]
pub enum BridgeNode {
    // --- primitives (pos is the LOCAL primitive position; size = half-extents) ---
    Box {
        #[cfg_attr(feature = "serde", serde(default))]
        node_id: i64,
        pos: [f64; 3],
        half: [f64; 3],
    },
    Sphere {
        #[cfg_attr(feature = "serde", serde(default))]
        node_id: i64,
        pos: [f64; 3],
        r: f64,
    },
    Cylinder {
        #[cfg_attr(feature = "serde", serde(default))]
        node_id: i64,
        pos: [f64; 3],
        r: f64,
        h: f64,
        #[cfg_attr(feature = "serde", serde(default))]
        fillet_top: f64,
        #[cfg_attr(feature = "serde", serde(default))]
        fillet_bottom: f64,
        #[cfg_attr(feature = "serde", serde(default))]
        chamfer_top: f64,
        #[cfg_attr(feature = "serde", serde(default))]
        chamfer_bottom: f64,
    },
    Cone {
        #[cfg_attr(feature = "serde", serde(default))]
        node_id: i64,
        pos: [f64; 3],
        r: f64,
        h: f64,
    },
    /// `verts` = the Polygon2D profile (flat `[x0,z0,x1,z1,…]`); `twist_degrees`
    /// is in DEGREES (converted to radians in the bridge, like cpu-sdf.mts).
    Extrude {
        #[cfg_attr(feature = "serde", serde(default))]
        node_id: i64,
        pos: [f64; 3],
        verts: Vec<[f64; 2]>,
        h: f64,
        #[cfg_attr(feature = "serde", serde(default))]
        twist_degrees: f64,
    },
    /// `profiles` = M Polygon2D profiles (each a vertex list); must share a vertex count.
    Loft {
        #[cfg_attr(feature = "serde", serde(default))]
        node_id: i64,
        pos: [f64; 3],
        profiles: Vec<Vec<[f64; 2]>>,
        h: f64,
    },
    /// `verts` = the (r,y) profile revolved around local Y.
    Lathe {
        #[cfg_attr(feature = "serde", serde(default))]
        node_id: i64,
        pos: [f64; 3],
        verts: Vec<[f64; 2]>,
    },

    // --- transforms ----------------------------------------------------------
    Translate {
        #[cfg_attr(feature = "serde", serde(default))]
        node_id: i64,
        d: [f64; 3],
        arg: Box<BridgeNode>,
    },
    /// `fwd` = `Rotate.getWgslMatrices().fwd` (flat row-major; the bridge bakes
    /// the world-from-local transpose via [`Similarity::from_rotation_wgsl_fwd`]).
    Rotate {
        #[cfg_attr(feature = "serde", serde(default))]
        node_id: i64,
        fwd: [f64; 9],
        arg: Box<BridgeNode>,
    },
    Scale {
        #[cfg_attr(feature = "serde", serde(default))]
        node_id: i64,
        sx: f64,
        sy: f64,
        sz: f64,
        arg: Box<BridgeNode>,
    },

    // --- booleans ------------------------------------------------------------
    Union {
        #[cfg_attr(feature = "serde", serde(default))]
        node_id: i64,
        children: Vec<BridgeNode>,
        #[cfg_attr(feature = "serde", serde(default))]
        radius: f64,
        #[cfg_attr(feature = "serde", serde(default))]
        mode: Option<BridgeBlendMode>,
        #[cfg_attr(feature = "serde", serde(default))]
        n: Option<f64>,
    },
    Subtract {
        #[cfg_attr(feature = "serde", serde(default))]
        node_id: i64,
        lh: Box<BridgeNode>,
        rh: Box<BridgeNode>,
        #[cfg_attr(feature = "serde", serde(default))]
        radius: f64,
        #[cfg_attr(feature = "serde", serde(default))]
        mode: Option<BridgeBlendMode>,
        #[cfg_attr(feature = "serde", serde(default))]
        n: Option<f64>,
    },
    Intersect {
        #[cfg_attr(feature = "serde", serde(default))]
        node_id: i64,
        lh: Box<BridgeNode>,
        rh: Box<BridgeNode>,
        #[cfg_attr(feature = "serde", serde(default))]
        radius: f64,
        #[cfg_attr(feature = "serde", serde(default))]
        mode: Option<BridgeBlendMode>,
        #[cfg_attr(feature = "serde", serde(default))]
        n: Option<f64>,
    },
}

impl BridgeNode {
    fn node_id(&self) -> i64 {
        match self {
            BridgeNode::Box { node_id, .. }
            | BridgeNode::Sphere { node_id, .. }
            | BridgeNode::Cylinder { node_id, .. }
            | BridgeNode::Cone { node_id, .. }
            | BridgeNode::Extrude { node_id, .. }
            | BridgeNode::Loft { node_id, .. }
            | BridgeNode::Lathe { node_id, .. }
            | BridgeNode::Translate { node_id, .. }
            | BridgeNode::Rotate { node_id, .. }
            | BridgeNode::Scale { node_id, .. }
            | BridgeNode::Union { node_id, .. }
            | BridgeNode::Subtract { node_id, .. }
            | BridgeNode::Intersect { node_id, .. } => *node_id,
        }
    }

    fn shape_type(&self) -> &'static str {
        match self {
            BridgeNode::Box { .. } => "box",
            BridgeNode::Sphere { .. } => "sphere",
            BridgeNode::Cylinder { .. } => "cylinder",
            BridgeNode::Cone { .. } => "cone",
            BridgeNode::Extrude { .. } => "extrude",
            BridgeNode::Loft { .. } => "loft",
            BridgeNode::Lathe { .. } => "lathe",
            BridgeNode::Translate { .. } => "translate",
            BridgeNode::Rotate { .. } => "rotate",
            BridgeNode::Scale { .. } => "scale",
            BridgeNode::Union { .. } => "union",
            BridgeNode::Subtract { .. } => "subtract",
            BridgeNode::Intersect { .. } => "intersect",
        }
    }
}

/// Scene blend mode → CPU [`SminMode`]. Columns splits by family (the shader's
/// Difference/Intersection columns are distinct formulas); "soft" exists only on
/// unions (the intersect-family switch lacks the case and falls through to Round);
/// `None`/unrecognized → Round. Verbatim port of `blendModeOf`.
fn blend_mode_of(mode: Option<BridgeBlendMode>, union_family: bool) -> SminMode {
    match mode {
        Some(BridgeBlendMode::Columns) => {
            if union_family {
                SminMode::Columns
            } else {
                SminMode::ColumnsI
            }
        }
        Some(BridgeBlendMode::Soft) => {
            if union_family {
                SminMode::Soft
            } else {
                SminMode::Round
            }
        }
        Some(BridgeBlendMode::Chamfer) => SminMode::Chamfer,
        Some(BridgeBlendMode::Stairs) => SminMode::Stairs,
        _ => SminMode::Round,
    }
}

struct WalkState {
    unsupported: Vec<UnsupportedNode>,
}

impl WalkState {
    fn reject(&mut self, node: &BridgeNode, reason: impl Into<String>) -> Option<CsgNode> {
        self.unsupported.push(UnsupportedNode {
            node_id: node.node_id(),
            shape_type: node.shape_type().to_string(),
            reason: reason.into(),
        });
        None
    }
}

/// A leaf at a baked similarity. Strata are attached in a later pass (left-to-right
/// traversal of the built tree), so this only records shape/sim/pos.
fn make_leaf(shape: Shape, sim: Similarity, pos: [f64; 3]) -> CsgNode {
    sdf::leaf(shape, sim, pos)
}

/// Walk the bridge node, mirroring `compileCpuSdf`'s `walk` (negation parity folds
/// Subtract into min/max; the blend kind flips under `neg`). Returns `None` and
/// records an offending node on anything outside the v1 subset.
fn walk(state: &mut WalkState, node: &BridgeNode, sim: Similarity, neg: bool) -> Option<CsgNode> {
    match node {
        // --- primitives ------------------------------------------------------
        BridgeNode::Box { pos, half, .. } => Some(make_leaf(Shape::Cuboid { half: *half }, sim, *pos)),
        BridgeNode::Sphere { pos, r, .. } => Some(make_leaf(Shape::Sphere { r: *r }, sim, *pos)),
        BridgeNode::Cylinder { pos, r, h, fillet_top, fillet_bottom, chamfer_top, chamfer_bottom, .. } => {
            if *fillet_top != 0.0 || *fillet_bottom != 0.0 || *chamfer_top != 0.0 || *chamfer_bottom != 0.0 {
                return state.reject(node, "cylinder fillet/chamfer (needs a torus carrier — v1.5)");
            }
            Some(make_leaf(Shape::Cylinder { r: *r, h: *h }, sim, *pos))
        }
        BridgeNode::Cone { pos, r, h, .. } => Some(make_leaf(Shape::Cone { r: *r, h: *h }, sim, *pos)),
        BridgeNode::Extrude { pos, verts, h, twist_degrees, .. } => {
            let twist_rad = twist_degrees * std::f64::consts::PI / 180.0;
            let wind = winding_sign(verts);
            // Flatten to [x0,z0,x1,z1,…] (the Shape::Extrude layout).
            let flat: Vec<f64> = verts.iter().flat_map(|v| [v[0], v[1]]).collect();
            Some(make_leaf(Shape::Extrude { verts: flat, wind, h: *h, twist_rad }, sim, *pos))
        }
        BridgeNode::Loft { pos, profiles, h, .. } => {
            if profiles.is_empty() {
                return state.reject(node, "loft with no profiles");
            }
            let n = profiles[0].len();
            if !profiles.iter().all(|p| p.len() == n) {
                return state.reject(
                    node,
                    "loft profiles with differing vertex counts (per-edge ruled carriers need 1:1 correspondence — v2)",
                );
            }
            let profs: Vec<Vec<f64>> =
                profiles.iter().map(|pr| pr.iter().flat_map(|v| [v[0], v[1]]).collect()).collect();
            let winds: Vec<f64> = profiles.iter().map(|pr| winding_sign(pr)).collect();
            Some(make_leaf(Shape::Loft { profs, winds, h: *h }, sim, *pos))
        }
        BridgeNode::Lathe { pos, verts, .. } => {
            for &[r, _] in verts {
                if r < -LATHE_AXIS_R {
                    return state.reject(
                        node,
                        format!(
                            "lathe profile vertex at negative radius (r = {r}) — the profile must stay on one side of the revolution axis"
                        ),
                    );
                }
            }
            let wind = winding_sign(verts);
            let edges = lathe_profile_edges(verts, wind);
            if !edges.iter().any(|e| e.kind != LatheEdgeKind::None) {
                return state.reject(node, "degenerate lathe profile (every edge on the revolution axis)");
            }
            Some(make_leaf(Shape::Lathe { edges }, sim, *pos))
        }

        // --- transforms ------------------------------------------------------
        BridgeNode::Translate { d, arg, .. } => {
            let child = Similarity::from_translation(d[0], d[1], d[2]);
            walk(state, arg, Similarity::compose(&sim, &child), neg)
        }
        BridgeNode::Rotate { fwd, arg, .. } => {
            let child = Similarity::from_rotation_wgsl_fwd(fwd);
            walk(state, arg, Similarity::compose(&sim, &child), neg)
        }
        BridgeNode::Scale { sx, sy, sz, arg, .. } => {
            if sx != sy || sy != sz {
                return state.reject(node, format!("non-uniform scale ({sx}, {sy}, {sz})"));
            }
            // `!(sx > 0)` (not `sx <= 0`) so NaN is rejected too — verbatim from
            // the TS `if (!(node.sx > 0))` guard in cpu-sdf.mts.
            #[allow(clippy::neg_cmp_op_on_partial_ord)]
            if !(*sx > 0.0) {
                return state.reject(node, format!("negative/zero scale ({sx})"));
            }
            let child = Similarity::from_uniform_scale(*sx);
            walk(state, arg, Similarity::compose(&sim, &child), neg)
        }

        // --- booleans (folded to min/max via negation parity) ----------------
        BridgeNode::Union { children, radius, mode, n, .. } => {
            let kids: Vec<CsgNode> = children.iter().filter_map(|c| walk(state, c, sim, neg)).collect();
            if kids.len() != children.len() {
                // A child failed; the error is already recorded — propagate None.
                return None;
            }
            if kids.is_empty() {
                return None;
            }
            if kids.len() == 1 {
                return kids.into_iter().next();
            }
            if *radius > 0.0 {
                let m = blend_mode_of(*mode, true);
                let n = n.unwrap_or(4.0);
                Some(CsgNode::Blend {
                    kind: if neg { sdf::BlendKind::Smax } else { sdf::BlendKind::Smin },
                    mode: m,
                    r: *radius,
                    n,
                    children: kids,
                })
            } else if neg {
                Some(CsgNode::Max(kids))
            } else {
                Some(CsgNode::Min(kids))
            }
        }
        BridgeNode::Subtract { lh, rh, radius, mode, n, .. } => {
            let l = walk(state, lh, sim, neg);
            // The right-hand operand is negated (A − B = A ∩ ¬B): flip neg.
            let r = walk(state, rh, sim, !neg);
            let (l, r) = match (l, r) {
                (Some(l), Some(r)) => (l, r),
                (Some(only), None) | (None, Some(only)) => {
                    // One operand failed; the error is recorded only if a reject
                    // ran. If both walked but one returned None for emptiness, ship
                    // the survivor (mirrors the TS `filter(non-null)` single-child).
                    if state.unsupported.is_empty() {
                        return Some(only);
                    }
                    return None;
                }
                (None, None) => return None,
            };
            if *radius > 0.0 {
                let m = blend_mode_of(*mode, false);
                let n = n.unwrap_or(4.0);
                Some(CsgNode::Blend {
                    kind: if neg { sdf::BlendKind::Smin } else { sdf::BlendKind::Smax },
                    mode: m,
                    r: *radius,
                    n,
                    children: vec![l, sdf::negate(r)],
                })
            } else if neg {
                Some(CsgNode::Min(vec![l, sdf::negate(r)]))
            } else {
                Some(CsgNode::Max(vec![l, sdf::negate(r)]))
            }
        }
        BridgeNode::Intersect { lh, rh, radius, mode, n, .. } => {
            let l = walk(state, lh, sim, neg);
            let r = walk(state, rh, sim, neg);
            let (l, r) = match (l, r) {
                (Some(l), Some(r)) => (l, r),
                (Some(only), None) | (None, Some(only)) => {
                    if state.unsupported.is_empty() {
                        return Some(only);
                    }
                    return None;
                }
                (None, None) => return None,
            };
            if *radius > 0.0 {
                let m = blend_mode_of(*mode, false);
                let n = n.unwrap_or(4.0);
                Some(CsgNode::Blend {
                    kind: if neg { sdf::BlendKind::Smin } else { sdf::BlendKind::Smax },
                    mode: m,
                    r: *radius,
                    n,
                    children: vec![l, r],
                })
            } else if neg {
                Some(CsgNode::Min(vec![l, r]))
            } else {
                Some(CsgNode::Max(vec![l, r]))
            }
        }
    }
}

/// Attach each leaf's strata via [`build_leaf_strata`], in left-to-right CSG
/// traversal order (matching `compile_native_features`), so the feature paths see
/// the carriers the TS tree does. Same discipline as the M4 parity tests'
/// `attach_strata`.
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

/// Build the pipeline-ready [`CsgNode`] tree from a serialized scene: walk the
/// SFCC v1 subset, fold negation parity, bake transforms, assign dense leaf
/// indices, then attach per-leaf strata. Returns [`SceneBridgeError`] listing
/// every offending node (mirroring `SfccUnsupportedError`).
pub fn build_csg_tree(root: &BridgeNode) -> Result<CsgNode, SceneBridgeError> {
    let mut state = WalkState { unsupported: Vec::new() };
    let csg = walk(&mut state, root, Similarity::identity(), false);
    if !state.unsupported.is_empty() {
        return Err(SceneBridgeError { unsupported: state.unsupported });
    }
    let mut tree = match csg {
        Some(t) => t,
        None => {
            return Err(SceneBridgeError {
                unsupported: vec![UnsupportedNode {
                    node_id: root.node_id(),
                    shape_type: root.shape_type().to_string(),
                    reason: "empty scene".to_string(),
                }],
            })
        }
    };
    tree.assign_leaf_indices();
    let mut leaf_index = 0usize;
    let mut first_id = 0usize;
    attach_strata(&mut tree, &mut leaf_index, &mut first_id);
    Ok(tree)
}

/// Parse a JSON scene description and build the tree. JSON shape = a [`BridgeNode`]
/// tagged object (the `"kind"` field). `serde`-feature only.
#[cfg(feature = "serde")]
pub fn build_csg_tree_from_json(json: &str) -> Result<CsgNode, String> {
    let root: BridgeNode = serde_json::from_str(json).map_err(|e| format!("scene JSON parse error: {e}"))?;
    build_csg_tree(&root).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn box_builds_a_single_leaf() {
        let scene = BridgeNode::Box { node_id: 0, pos: [0.0, 0.0, 0.0], half: [1.0, 2.0, 3.0] };
        let tree = build_csg_tree(&scene).unwrap();
        match &tree {
            CsgNode::Leaf(l) => {
                assert!(matches!(l.shape, Shape::Cuboid { half } if half == [1.0, 2.0, 3.0]));
                assert_eq!(l.index, 0);
                assert_eq!(l.strata.len(), 6, "box has 6 face strata");
            }
            _ => panic!("expected a leaf"),
        }
    }

    #[test]
    fn subtract_folds_to_max_with_negated_rhs() {
        let scene = BridgeNode::Subtract {
            node_id: 2,
            lh: Box::new(BridgeNode::Box { node_id: 0, pos: [0.0; 3], half: [2.0, 2.0, 2.0] }),
            rh: Box::new(BridgeNode::Sphere { node_id: 1, pos: [2.0, 0.0, 0.0], r: 1.0 }),
            radius: 0.0,
            mode: None,
            n: None,
        };
        let tree = build_csg_tree(&scene).unwrap();
        // Origin: inside box, outside the carve sphere → solid (negative).
        assert!(tree.f([0.0, 0.0, 0.0]) < 0.0);
        // At (2,0,0): inside box, inside the carve → removed (positive).
        assert!(tree.f([2.0, 0.0, 0.0]) > 0.0);
        assert!(matches!(tree, CsgNode::Max(_)));
    }

    #[test]
    fn translate_bakes_into_leaf_position() {
        let scene = BridgeNode::Translate {
            node_id: 1,
            d: [5.0, 0.0, 0.0],
            arg: Box::new(BridgeNode::Sphere { node_id: 0, pos: [0.0; 3], r: 2.0 }),
        };
        let tree = build_csg_tree(&scene).unwrap();
        assert!((tree.f([5.0, 0.0, 0.0]) + 2.0).abs() < 1e-12);
    }

    #[test]
    fn rotate_uses_wgsl_fwd_transpose() {
        // A 90° rotation about Z baked through fwd (row-major world-to-local).
        // fwd for rz=90°: [0,1,0, -1,0,0, 0,0,1] (cos90=0, sin90=1).
        let fwd = [0.0, 1.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
        let scene = BridgeNode::Rotate {
            node_id: 1,
            fwd,
            arg: Box::new(BridgeNode::Box { node_id: 0, pos: [0.0; 3], half: [2.0, 1.0, 1.0] }),
        };
        let tree = build_csg_tree(&scene).unwrap();
        // The box's long +x axis (half 2) rotates to +y in world. A point at
        // (0, 1.5, 0) is now inside (within the rotated 2-long extent).
        assert!(tree.f([0.0, 1.5, 0.0]) < 0.0);
        // The original +x at (1.5,0,0) is now outside (only half=1 there).
        assert!(tree.f([1.9, 0.0, 0.0]) > 0.0);
    }

    #[test]
    fn non_uniform_scale_is_rejected() {
        let scene = BridgeNode::Scale {
            node_id: 1,
            sx: 1.0,
            sy: 2.0,
            sz: 1.0,
            arg: Box::new(BridgeNode::Sphere { node_id: 0, pos: [0.0; 3], r: 1.0 }),
        };
        let err = build_csg_tree(&scene).unwrap_err();
        assert_eq!(err.unsupported.len(), 1);
        assert!(err.unsupported[0].reason.contains("non-uniform scale"));
        assert_eq!(err.unsupported[0].shape_type, "scale");
    }

    #[test]
    fn smooth_union_columns_maps_to_columns_mode() {
        let scene = BridgeNode::Union {
            node_id: 2,
            children: vec![
                BridgeNode::Sphere { node_id: 0, pos: [-1.0, 0.0, 0.0], r: 2.0 },
                BridgeNode::Sphere { node_id: 1, pos: [1.0, 0.0, 0.0], r: 2.0 },
            ],
            radius: 1.0,
            mode: Some(BridgeBlendMode::Columns),
            n: Some(2.0),
        };
        let tree = build_csg_tree(&scene).unwrap();
        match &tree {
            CsgNode::Blend { mode, kind, .. } => {
                assert_eq!(*mode, SminMode::Columns);
                assert_eq!(*kind, sdf::BlendKind::Smin);
            }
            _ => panic!("expected a blend"),
        }
    }

    #[test]
    fn smooth_subtract_columns_maps_to_columns_i() {
        let scene = BridgeNode::Subtract {
            node_id: 2,
            lh: Box::new(BridgeNode::Box { node_id: 0, pos: [0.0; 3], half: [3.0, 3.0, 3.0] }),
            rh: Box::new(BridgeNode::Sphere { node_id: 1, pos: [3.0, 0.0, 0.0], r: 2.0 }),
            radius: 1.0,
            mode: Some(BridgeBlendMode::Columns),
            n: Some(2.0),
        };
        let tree = build_csg_tree(&scene).unwrap();
        match &tree {
            CsgNode::Blend { mode, kind, .. } => {
                assert_eq!(*mode, SminMode::ColumnsI);
                assert_eq!(*kind, sdf::BlendKind::Smax);
            }
            _ => panic!("expected a blend"),
        }
    }

    #[cfg(feature = "serde")]
    #[test]
    fn json_box_roundtrips() {
        let json = r#"{"kind":"box","node_id":0,"pos":[0,0,0],"half":[10,10,10]}"#;
        let tree = build_csg_tree_from_json(json).unwrap();
        assert!(tree.f([0.0, 0.0, 0.0]) < 0.0);
        assert!(tree.f([20.0, 0.0, 0.0]) > 0.0);
    }

    #[cfg(feature = "serde")]
    #[test]
    fn json_subtract_with_children() {
        let json = r#"{
            "kind":"subtract","node_id":2,
            "lh":{"kind":"box","node_id":0,"pos":[0,0,0],"half":[10,10,10]},
            "rh":{"kind":"sphere","node_id":1,"pos":[5,5,5],"r":6}
        }"#;
        let tree = build_csg_tree_from_json(json).unwrap();
        // Near the sphere center the +++ octant is carved out (dist √3·3≈5.2 < r 6).
        assert!(tree.f([8.0, 8.0, 8.0]) > 0.0);
        // The −−− corner is solid.
        assert!(tree.f([-9.5, -9.5, -9.5]) < 0.0);
    }
}
