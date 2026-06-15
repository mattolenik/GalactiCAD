//! Lever 1 (region CSG-tree pruning) soundness + ROI.
//!
//! The pruned view must be BIT-EXACT to the full tree — `f` for any point in the
//! prune ball, and the interval for that ball — or it could change refinement
//! decisions and break the pixel-identical pipeline. This brute-forces random
//! scenes (Min/Max/Blend incl. columns) × random boxes × random points and
//! asserts exact equality, then measures the leaf-count reduction that motivates
//! the lever.

use gcad_kernel::primitives::smin::SminMode;
use gcad_kernel::sdf::{self, CsgNode, Shape};

/// Deterministic LCG (no rand dep; Math.random-free environment parity).
struct Lcg(u64);
impl Lcg {
    fn next_u32(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (self.0 >> 33) as u32
    }
    fn unit(&mut self) -> f64 {
        self.next_u32() as f64 / u32::MAX as f64
    }
    fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.unit()
    }
}

fn leaf(rng: &mut Lcg) -> CsgNode {
    let pos = [rng.range(-5.0, 5.0), rng.range(-5.0, 5.0), rng.range(-5.0, 5.0)];
    if rng.unit() < 0.5 {
        sdf::leaf_at(Shape::Sphere { r: rng.range(0.5, 3.0) }, pos)
    } else {
        let h = [rng.range(0.5, 2.5), rng.range(0.5, 2.5), rng.range(0.5, 2.5)];
        sdf::leaf_at(Shape::Cuboid { half: h }, pos)
    }
}

/// A random CSG tree mixing hard min/max and smooth blends (round + columns).
fn scene(rng: &mut Lcg, depth: u32) -> CsgNode {
    if depth == 0 {
        return leaf(rng);
    }
    let k = 2 + (rng.next_u32() % 4) as usize; // 2..=5 children
    let children: Vec<CsgNode> = (0..k).map(|_| scene(rng, depth - 1)).collect();
    match rng.next_u32() % 4 {
        0 => sdf::union(children),
        1 => sdf::intersect(children),
        2 => sdf::union_smooth(children, SminMode::Round, rng.range(0.3, 1.2), 2.0),
        _ => sdf::union_smooth(children, SminMode::Columns, rng.range(0.3, 1.2), 2.0),
    }
}

#[test]
fn pruned_is_bit_exact_over_random_scenes() {
    let mut rng = Lcg(0x1234_5678_9abc_def0);
    let mut total_full = 0usize;
    let mut total_pruned = 0usize;
    for _ in 0..400 {
        let tree = scene(&mut rng, 3);
        let c = [rng.range(-5.0, 5.0), rng.range(-5.0, 5.0), rng.range(-5.0, 5.0)];
        let half = [rng.range(0.2, 3.0), rng.range(0.2, 3.0), rng.range(0.2, 3.0)];
        let pruned = tree.prune_to_box(c, half);

        // Interval over the prune ball must match exactly.
        let f_iv = tree.interval_over_box(c, half);
        let p_iv = pruned.interval_over_box(c, half);
        assert_eq!(f_iv, p_iv, "interval drift: full {f_iv:?} vs pruned {p_iv:?}");

        // f must match exactly at every point inside the box.
        for _ in 0..16 {
            let p = [
                c[0] + rng.range(-half[0], half[0]),
                c[1] + rng.range(-half[1], half[1]),
                c[2] + rng.range(-half[2], half[2]),
            ];
            let ff = tree.f(p);
            let pf = pruned.f(p);
            assert_eq!(ff.to_bits(), pf.to_bits(), "f drift at {p:?}: full {ff} vs pruned {pf}");
        }

        // Incremental refine to a sub-box stays exact too.
        let sub_half = [half[0] * 0.5, half[1] * 0.5, half[2] * 0.5];
        let sub = pruned.prune_to_box(c, sub_half);
        assert_eq!(tree.interval_over_box(c, sub_half), sub.interval_over_box(c, sub_half));

        total_full += tree.leaf_count();
        total_pruned += pruned.leaf_count();
    }
    // Sanity: pruning actually removed work on average across these scenes.
    assert!(total_pruned < total_full, "pruned {total_pruned} vs full {total_full} — no reduction");
    eprintln!("random-scene leaves: full {total_full} → pruned {total_pruned} ({:.0}% kept)", 100.0 * total_pruned as f64 / total_full as f64);
}

#[test]
fn roi_blended_union_of_many_parts() {
    // A row of 24 smoothly-unioned spheres — the "many blended unions" signature.
    let mut parts = Vec::new();
    for i in 0..24 {
        parts.push(sdf::leaf_at(Shape::Sphere { r: 1.0 }, [i as f64 * 2.2, 0.0, 0.0]));
    }
    let tree = sdf::union_smooth(parts, SminMode::Round, 0.8, 2.0);
    assert_eq!(tree.leaf_count(), 24);

    // A small cell sitting on sphere #5: only its immediate neighbours matter.
    let c = [5.0 * 2.2, 0.0, 0.0];
    let half = [0.5, 0.5, 0.5];
    let pruned = tree.prune_to_box(c, half);

    // Exactness still holds here.
    assert_eq!(tree.interval_over_box(c, half), pruned.interval_over_box(c, half));
    assert_eq!(tree.f(c).to_bits(), pruned.f(c).to_bits());

    eprintln!("ROI: 24-sphere blend, cell on #5 → {} of 24 leaves kept", pruned.leaf_count());
    assert!(pruned.leaf_count() <= 5, "expected aggressive pruning, kept {}", pruned.leaf_count());
}
