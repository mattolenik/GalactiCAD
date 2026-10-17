//! Test-only JSON adapter to the existing production bound API.
#[cfg(feature = "serde")]
fn main() {
    use std::io::Read;
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let cases: serde_json::Value = serde_json::from_str(&input).unwrap();
    let out: Vec<_> = cases
        .as_array()
        .unwrap()
        .iter()
        .map(|case| {
            let tree =
                gcad_kernel::scene_bridge::build_csg_tree_from_json(&case["scene"].to_string())
                    .unwrap();
            let q: Vec<f64> = case["query"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_f64().unwrap())
                .collect();
            let c = [q[0], q[1], q[2]];
            let h = [q[3], q[4], q[5]];
            let b = tree.interval_over_box(c, h);
            let r = tree.interval_over_ball(c, q[6]);
            let gcad_kernel::sdf::CsgNode::Leaf(leaf) = &tree else { panic!("fixture needs one leaf"); };
            let mut state = Vec::with_capacity(21);
            for a in 0..3 { for b in 0..3 { state.push(leaf.sim.r[b * 3 + a]); } }
            state.push(leaf.sim.s);
            state.extend(leaf.sim.t);
            state.extend(leaf.pos);
            state.push(leaf.sign);
            match leaf.shape {
                gcad_kernel::sdf::Shape::Sphere { r } => state.extend([0., r, 0., 0.]),
                gcad_kernel::sdf::Shape::Cuboid { half } => { state.push(1.); state.extend(half); }
                _ => panic!("fixture needs sphere/box"),
            }
            let bits = |v: &[f64]| v.iter().map(|v| format!("{:016x}", v.to_bits())).collect::<Vec<_>>();
            serde_json::json!({"bounds":bits(&[b.0,b.1,r.0,r.1]),"inputs":bits(&state),"query":bits(&q)})
        })
        .collect();
    println!("{}", serde_json::to_string(&out).unwrap());
}
#[cfg(not(feature = "serde"))]
fn main() {
    eprintln!("exclusion_probe requires --features serde");
}
