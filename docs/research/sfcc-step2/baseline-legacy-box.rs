use gcad_kernel::{sdf::{self,CsgNode,Leaf,Shape},math::similarity::Similarity,primitives::smin::SminMode};
fn main(){
 let sim=Similarity::from_uniform_scale(f64::MIN_POSITIVE);let p=[4.,4.,0.];
 let leaf=Leaf{sign:1.,sim,pos:[0.;3],shape:Shape::Cuboid{half:[1.;3]},index:0,strata:vec![]};
 println!("all finite input; inverse={:?}; masked leaf.f={:?}",sim.inv_apply_point(p[0],p[1],p[2]),leaf.f(p));
 let t=sdf::union_smooth(vec![CsgNode::Leaf(leaf),sdf::leaf_at(Shape::Sphere{r:100.},[0.;3])],SminMode::Round,0.2,3.);
 println!("legacy opaque ball0={:?}",t.interval_over_ball(p,0.));
}
