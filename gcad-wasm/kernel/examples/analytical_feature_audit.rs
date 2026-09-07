//! Reduced open findings from the completeness audit. These diagnostics expose
//! unsupported coverage; they deliberately do not turn it into a passing test.
use gcad_kernel::{
    primitives::smin::{smin, SminMode},
    sdf::{leaf_at, BlendKind, CsgNode, Shape},
    sfcc::feature_set::compile_feature_set,
    tolerances::resolve_tolerances,
    tuning::SfccTuning,
};

fn main() {
    // In the interior y range, the operand fields are exactly a=x and b=z.
    // The independently derived step corners satisfy x+z=r and x=k*r/n.
    let tree = CsgNode::Blend {
        kind: BlendKind::Smin,
        mode: SminMode::Stairs,
        r: 1.,
        n: 4.,
        children: vec![
            leaf_at(Shape::Cuboid { half: [10.; 3] }, [-10., 0., 0.]),
            leaf_at(Shape::Cuboid { half: [10.; 3] }, [0., 0., -10.]),
        ],
    };
    let (features, _) =
        compile_feature_set(&tree, &resolve_tolerances(&SfccTuning::default(), 40.));
    let mut missing = 0;
    for k in 1..4 {
        let mut max_gap: f64 = 0.;
        for j in 0..=16 {
            let p = [k as f64 * 0.25, -2. + j as f64 * 0.25, 1. - k as f64 * 0.25];
            assert!(tree.f(p).abs() < 1e-12);
            let gap = features
                .curves
                .iter()
                .map(|c| c.project(p[0], p[1], p[2]).1)
                .fold(f64::INFINITY, f64::min);
            max_gap = max_gap.max(gap);
            if gap > 0.002 {
                missing += 1;
            }
        }
        println!(
            "source=root mode=stairs branch=step-{k} expectedArcY=[-2,2] maxCompiledGap={max_gap}"
        );
    }
    // Raw modulo can change sign across a finite jump. This cannot be treated
    // as an ordinary intersection of two continuous zero-surface carriers.
    let cr = 2f64.sqrt() / (4. + 2f64.sqrt());
    let (a, b) = (0.5, 0.5 - cr * 2f64.sqrt());
    for h in [1e-4, 1e-6, 1e-8] {
        let left = smin(SminMode::Columns, a, b - h, 1., 3.);
        let right = smin(SminMode::Columns, a, b + h, 1., 3.);
        println!(
            "source=root mode=columns branch=modulo-wrap h={h} left={left} right={right} jump={}",
            right - left
        );
    }
    println!("stairsMissingSamples={missing}/51; columnsContinuity=unresolved; globalCompleteness=notChecked");
}
