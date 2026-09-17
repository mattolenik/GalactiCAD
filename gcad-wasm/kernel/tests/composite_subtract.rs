//! Independent scalar algebra, rather than agreement between kernel evaluators.
use gcad_kernel::scene_bridge::{build_csg_tree, BridgeBlendMode, BridgeNode};

fn sphere(x: f64, r: f64) -> BridgeNode {
    BridgeNode::Sphere { node_id: 1, pos: [x, 0., 0.], r }
}
fn union(children: Vec<BridgeNode>, mode: Option<BridgeBlendMode>, radius: f64) -> BridgeNode {
    BridgeNode::Union { node_id: 2, children, mode, radius, n: Some(3.) }
}
fn subtract(lh: BridgeNode, rh: BridgeNode) -> BridgeNode {
    BridgeNode::Subtract { node_id: 3, lh: Box::new(lh), rh: Box::new(rh), radius: 0., mode: None, n: None }
}
fn intersect(lh: BridgeNode, rh: BridgeNode) -> BridgeNode {
    BridgeNode::Intersect { node_id: 4, lh: Box::new(lh), rh: Box::new(rh), radius: 0., mode: None, n: None }
}

#[test]
fn compound_cutters_obey_independent_boolean_algebra() {
    for separation in [0.6, 2.] {
        let a = sphere(0., 5.);
        let b = sphere(-separation, 1.);
        let c = sphere(separation, 1.);
        let scenes = [
            subtract(a.clone(), union(vec![b.clone(), c.clone()], None, 0.)),
            subtract(a.clone(), intersect(b.clone(), c.clone())),
            subtract(a.clone(), subtract(b.clone(), c.clone())),
            intersect(a.clone(), subtract(b.clone(), c.clone())),
            union(vec![a.clone(), subtract(b.clone(), c.clone())], None, 0.),
            subtract(a, subtract(b, subtract(c, sphere(0., 0.4)))),
        ];
        for (case, scene) in scenes.iter().enumerate() {
            let tree = build_csg_tree(scene).unwrap();
            for i in -70..=70 {
                let p = [i as f64 * 0.1, 0.13, 0.21];
                let distance = |x: f64, r: f64| ((p[0]-x).powi(2)+p[1]*p[1]+p[2]*p[2]).sqrt()-r;
                let (a,b,c,d) = (distance(0.,5.),distance(-separation,1.),distance(separation,1.),distance(0.,0.4));
                let expected = [a.max(-b.min(c)), a.max(-b.max(c)), a.max(-b.max(-c)),
                    a.max(b.max(-c)), a.min(b.max(-c)), a.max(-b.max(-c.max(-d)))][case];
                assert!((tree.f(p)-expected).abs() < 1e-12, "case={case} p={p:?} got={} expected={expected}", tree.f(p));
            }
        }
    }
}

#[test]
fn smooth_compound_cutters_are_complemented_once() {
    for mode in [BridgeBlendMode::Round, BridgeBlendMode::Soft, BridgeBlendMode::Chamfer] {
        let tree = build_csg_tree(&subtract(sphere(0., 5.), union(vec![sphere(-0.6,1.),sphere(0.6,1.)], Some(mode), 0.7))).unwrap();
        for i in -30..=30 {
            let p = [i as f64*0.1,0.17,0.23];
            let distance = |x: f64| ((p[0]-x).powi(2)+p[1]*p[1]+p[2]*p[2]).sqrt()-1.;
            let (b,c) = (distance(-0.6),distance(0.6));
            let r: f64 = 0.7;
            let cutter = match mode {
                BridgeBlendMode::Round => r.max(b.min(c))-((r-b).max(0.).powi(2)+(r-c).max(0.).powi(2)).sqrt(),
                BridgeBlendMode::Soft => b.min(c)-(r-(b-c).abs()).max(0.).powi(2)/(4.*r),
                BridgeBlendMode::Chamfer => b.min(c).min((b+c-r)/2f64.sqrt()),
                _ => unreachable!(),
            };
            let a = (p[0]*p[0]+p[1]*p[1]+p[2]*p[2]).sqrt()-5.;
            assert!((tree.f(p)-a.max(-cutter)).abs()<1e-12, "{mode:?}: {p:?}");
            let h = 1e-6;
            let fd: [f64;3] = std::array::from_fn(|axis| {
                let mut lo=p; let mut hi=p; lo[axis]-=h; hi[axis]+=h;
                (tree.f(hi)-tree.f(lo))/(2.*h)
            });
            let length = fd.iter().map(|v|v*v).sum::<f64>().sqrt();
            let (_, normal) = tree.grad(p);
            for axis in 0..3 { assert!((normal[axis]-fd[axis]/length).abs()<1e-6); }
        }
    }
}

#[test]
fn unsupported_columns_complement_is_a_bridge_error() {
    let cutter = union(vec![sphere(-0.6,1.),sphere(0.6,1.)], Some(BridgeBlendMode::Columns), 0.7);
    assert!(build_csg_tree(&cutter).is_ok(), "direct columns remain supported");
    let result = build_csg_tree(&subtract(sphere(0.,5.),cutter));
    let error = result.unwrap_err();
    assert_eq!(error.unsupported[0].node_id, 3);
    assert!(error.to_string().contains("columns"));
}
