//! Native reproduction of the bowl sample scene (src/scene/samples/bowl.gcad):
//! taper(180/170, 150, subtract(outerLoft, innerLoft)) — two many-section
//! rounded-square lofts under a slight widening warp. Diagnostics for the
//! missing-polygon-strips export defect. Env knobs:
//!   BOWL_K     scene scale (default 0.25)
//!   BOWL_DEPTH depthMax            (default 8)
//!   BOWL_MODE  taper | identity | plain | suppressed
//! Run with -- --nocapture.
use gcad_kernel::math::similarity::Similarity;
use gcad_kernel::primitives::polygon2d::winding_sign;
use gcad_kernel::sdf::{self, CsgNode, Leaf, Shape};
use gcad_kernel::sfcc::feature_set::build_leaf_strata;
use gcad_kernel::sfcc::pipeline::{run_sfcc_pipeline, PipelineTuning, SfccWorldCube};

const WIDTH: f64 = 170.0;
const TOP_WIDTH: f64 = 180.0;
const HEIGHT: f64 = 150.0;
const CORNER_R: f64 = 15.0;
const WALL: f64 = 0.6;
const FLOOR_T: f64 = 1.8;
const ARC_SLICES: f64 = 8.0;
const CORNER_SEGS: usize = 8;
const MAX_GRID: f64 = 120.0;
const HALF: f64 = WIDTH / 2.0;

/// Rounded-square slice, mirrors `slice(w)` — corner centers at ±cx, arcs of
/// radius w − cx. cx = k·(half − cornerR), SHARED by both shells (concentric).
fn slice(w: f64, cx: f64) -> Vec<[f64; 2]> {
    let rc = w - cx;
    let corners = [[1.0, 1.0], [1.0, -1.0], [-1.0, -1.0], [-1.0, 1.0]];
    let mut pts = Vec::new();
    for c in 0..4 {
        for k in 0..CORNER_SEGS {
            let a = (if c % 2 == 0 { 1.0 - k as f64 / CORNER_SEGS as f64 } else { k as f64 / CORNER_SEGS as f64 })
                * std::f64::consts::FRAC_PI_2;
            pts.push([
                corners[c][0] * (cx + rc * a.cos()),
                corners[c][1] * (cx + rc * a.sin()),
            ]);
        }
    }
    pts
}

/// Teardrop half-width at height y, mirrors `teardropW(y, r)`.
fn teardrop_w(y: f64, r: f64, cx: f64, cy: f64) -> f64 {
    let arc_start = cy - r / std::f64::consts::SQRT_2;
    if y <= arc_start {
        return y + cx - cy + r * std::f64::consts::SQRT_2;
    }
    if y >= cy {
        return cx + r;
    }
    cx + (r * r - (y - cy) * (y - cy)).sqrt()
}

/// One loft over [y0, y1], mirrors `shellLoft` (all constants scaled by k).
fn shell_loft(k: f64, y0: f64, y1: f64, r: f64, wall_w: f64) -> CsgNode {
    let cx = k * (HALF - CORNER_R);
    let cy = k * CORNER_R;
    let dy = (r / std::f64::consts::SQRT_2) / ARC_SLICES;
    let steps = MAX_GRID.min(((y1 - y0) / dy).round()) as usize;
    let mut profs = Vec::with_capacity(steps + 1);
    let mut winds = Vec::with_capacity(steps + 1);
    for i in 0..=steps {
        let y = y0 + (y1 - y0) * i as f64 / steps as f64;
        let w = if y <= cy { teardrop_w(y, r, cx, cy) } else { wall_w };
        let pts = slice(w, cx);
        winds.push(winding_sign(&pts));
        profs.push(pts.iter().flat_map(|p| [p[0], p[1]]).collect::<Vec<f64>>());
    }
    sdf::leaf_at(Shape::Loft { profs, winds, h: (y1 - y0) / 2.0 }, [0.0, (y0 + y1) / 2.0, 0.0])
}

fn subtract_tree(k: f64) -> CsgNode {
    sdf::subtract(
        shell_loft(k, 0.0, HEIGHT * k, CORNER_R * k, HALF * k),
        shell_loft(k, FLOOR_T * k, HEIGHT * k + k, CORNER_R * k - WALL * k, HALF * k - WALL * k),
    )
}

fn prepared(mut tree: CsgNode) -> CsgNode {
    fn attach(node: &mut CsgNode, leaf_index: &mut usize, first_id: &mut usize) {
        match node {
            CsgNode::Leaf(leaf) => {
                let strata =
                    build_leaf_strata(&Leaf { strata: Vec::new(), ..leaf.clone() }, *leaf_index, *first_id);
                *first_id += strata.len();
                *leaf_index += 1;
                leaf.strata = strata;
            }
            CsgNode::Taper { child, .. } => attach(child, leaf_index, first_id),
            CsgNode::Min(children) | CsgNode::Max(children) | CsgNode::Blend { children, .. } => {
                children.iter_mut().for_each(|child| attach(child, leaf_index, first_id))
            }
        }
    }
    tree.assign_leaf_indices();
    attach(&mut tree, &mut 0, &mut 0);
    tree
}

/// Mark warp flags the way the scene bridge does.
fn warp_mark(node: &mut CsgNode) {
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

/// F_taper(p) must equal F_plain(taperPoint(p))·min(s,1) everywhere.
#[test]
fn bowl_warp_field_matches_definition() {
    let k = 0.25;
    let ratio = TOP_WIDTH / WIDTH;
    let height = HEIGHT * k;
    let solid = subtract_tree(k);
    let tree = sdf::taper(ratio, height, Similarity::identity(), solid.clone());
    let mut bad = 0usize;
    let mut checked = 0usize;
    for i in 0..64 {
        for j in 0..16 {
            let fx = i as f64 / 63.0 * 2.0 - 1.0;
            let fy = j as f64 / 15.0;
            let p = [fx * 22.0, fy * 40.0 - 2.0, 0.0];
            let t = (p[1] / height).clamp(0.0, 1.0);
            let s = 1.0 + (ratio - 1.0) * t;
            let q = [p[0] / s, p[1], p[2] / s];
            let expected = solid.f(q) * s.min(1.0);
            let got = tree.f(p);
            checked += 1;
            if (got - expected).abs() > 1e-9 * (1.0 + expected.abs()) || (got < 0.0) != (expected < 0.0) {
                if bad < 5 {
                    println!("MISMATCH at {p:?}: got {got}, expected {expected} (s={s})");
                }
                bad += 1;
            }
        }
    }
    println!("field check: {bad} bad of {checked}");
    assert_eq!(bad, 0);
}

#[test]
#[ignore = "hand-built approximation of the bowl, minutes per run; tests/bowl_exact.rs runs the real scene"]
fn bowl_taper_repro_diagnostics() {
    let k = std::env::var("BOWL_K").ok().and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.25);
    // BOWL_MODE controls:
    //   "taper"     — the real bowl (ratio 180/170, warp + strata suppressed)
    //   "identity"  — ratio-1 warp (bridge leaves strata ON: near-no-taper)
    //   "plain"     — no warp node at all
    //   "suppressed"— no warp node, but leaves marked warped (strata off)
    let mode = std::env::var("BOWL_MODE").unwrap_or_else(|_| "taper".into());
    let ratio = if mode == "identity" { 1.0 } else { TOP_WIDTH / WIDTH };
    let mut tree = if mode == "plain" || mode == "suppressed" {
        subtract_tree(k)
    } else {
        sdf::taper(ratio, HEIGHT * k, Similarity::identity(), subtract_tree(k))
    };
    if matches!(mode.as_str(), "taper" | "suppressed") {
        warp_mark(&mut tree);
    }
    let tree = prepared(tree);
    // The app's exact world cube: padded sampled bounds
    // [-91.5,-2,-91.5]..[91.5,152,91.5], center (0,75,0), side = max extent 183.
    // (Lattice phase against the thin wall drives the hole pattern — a
    // different cube can look clean by luck.)
    let ext = 91.5;
    let cube = SfccWorldCube { min_x: -ext, min_y: 75.0 - ext, min_z: -ext, size: 2.0 * ext };
    let depth_max = std::env::var("BOWL_DEPTH").ok().and_then(|v| v.parse::<u32>().ok()).unwrap_or(8);
    let tuning = PipelineTuning { depth_max, ..PipelineTuning::default() };
    let t0 = std::time::Instant::now();
    let r = run_sfcc_pipeline(&tree, &cube, &tuning);
    println!(
        "bowl(k={k} depth={depth_max} mode={mode}): ok={} tris={} failed_cells={} degenerate={} multi_loop={} \
         manifold(ok={} open={} nm={} mis={}) comps={} off_surface={} [{}ms]",
        r.ok,
        r.tris.len() / 3,
        r.stats.failed_cells,
        r.stats.degenerate_cells,
        r.stats.multi_loop_cells,
        r.manifold.ok,
        r.manifold.open_edges,
        r.manifold.non_manifold_edges,
        r.manifold.misoriented_edges,
        r.manifold.components,
        r.validation.off_surface_vertices,
        t0.elapsed().as_millis(),
    );
    println!("euler per component: {:?}", r.manifold.euler_per_component);
    // Where are the holes? Boundary edges (odd incidence, position-welded),
    // bucketed by y (2mm) — mapping weld ids back to representative vertices.
    let n = r.verts.len() / 8;
    let mut weld = std::collections::HashMap::<[u8; 12], u32>::new();
    let mut canon = vec![0u32; n];
    for i in 0..n {
        let mut bits = [0u8; 12];
        for a in 0..3 {
            bits[a * 4..a * 4 + 4].copy_from_slice(&r.verts[i * 8 + a].to_bits().to_le_bytes());
        }
        let next = weld.len() as u32;
        canon[i] = *weld.entry(bits).or_insert(next);
    }
    let mut edge_count = std::collections::BTreeMap::<(u32, u32), i32>::new();
    for t in r.tris.chunks_exact(3) {
        let tri = [canon[t[0] as usize], canon[t[1] as usize], canon[t[2] as usize]];
        if tri[0] == tri[1] || tri[1] == tri[2] || tri[0] == tri[2] {
            continue;
        }
        for e in 0..3 {
            let a = tri[e].min(tri[(e + 1) % 3]);
            let b = tri[e].max(tri[(e + 1) % 3]);
            *edge_count.entry((a, b)).or_insert(0) += 1;
        }
    }
    // weld id -> original vertex index (first occurrence).
    let mut repr = vec![0usize; weld.len()];
    for i in 0..n {
        repr[canon[i] as usize] = i;
    }
    let mut y_buckets = std::collections::BTreeMap::<i64, usize>::new();
    let mut boundary_n = 0usize;
    for (&(a, _b), &c) in &edge_count {
        if c % 2 != 0 {
            boundary_n += 1;
            let y = r.verts[repr[a as usize] * 8 + 1] as f64;
            *y_buckets.entry((y / (2.0 * k)).round() as i64).or_insert(0) += 1;
        }
    }
    println!("boundary edges: {boundary_n}, y-buckets (2mm·k={:.2}): {:?}", 2.0 * k, y_buckets);
    // Component structure: per-component y-extent + tri count — stacked
    // 1-cell-tall rings confirm vertical weld failure between cell layers.
    {
        let wcount = weld.len();
        let mut parent: Vec<usize> = (0..wcount).collect();
        fn find(p: &mut Vec<usize>, i: usize) -> usize {
            if p[i] == i { i } else { let r = find(p, p[i]); p[i] = r; r }
        }
        for t in r.tris.chunks_exact(3) {
            let ids = [canon[t[0] as usize] as usize, canon[t[1] as usize] as usize, canon[t[2] as usize] as usize];
            let r0 = find(&mut parent, ids[0]);
            let r1 = find(&mut parent, ids[1]);
            let r2 = find(&mut parent, ids[2]);
            parent[r0] = r1;
            parent[r2] = r1;
        }
        let mut root_id = std::collections::HashMap::<usize, usize>::new();
        let mut comp_of = vec![usize::MAX; n];
        let mut members: Vec<Vec<usize>> = Vec::new();
        for i in 0..n {
            let root = find(&mut parent, canon[i] as usize);
            let id = *root_id.entry(root).or_insert_with(|| {
                members.push(Vec::new());
                members.len() - 1
            });
            comp_of[i] = id;
            members[id].push(i);
        }
        let mut tri_count = vec![0usize; members.len()];
        for t in r.tris.chunks_exact(3) {
            tri_count[comp_of[t[0] as usize]] += 1;
        }
        let mut report: Vec<(f64, f64, usize)> = members
            .iter()
            .enumerate()
            .filter(|(_, v)| !v.is_empty())
            .map(|(id, verts)| {
                let mut ylo = f64::INFINITY;
                let mut yhi = f64::NEG_INFINITY;
                for &vi in verts {
                    let y = r.verts[vi * 8 + 1] as f64;
                    ylo = ylo.min(y);
                    yhi = yhi.max(y);
                }
                (ylo, yhi, tri_count[id])
            })
            .collect();
        report.sort_by(|a, b| a.0.total_cmp(&b.0));
        println!("components: {} (report says {}):", report.len(), r.manifold.components);
        for (i, (ylo, yhi, tris)) in report.iter().enumerate().take(60) {
            println!("  comp {i}: y ∈ [{ylo:.2}, {yhi:.2}] ({tris} tris)");
        }
    }
    assert!(!r.tris.is_empty());
}
