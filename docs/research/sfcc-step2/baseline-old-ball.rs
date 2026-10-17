use gcad_kernel::sdf::{self,Shape};
fn main(){
 let p=[16072908759584.,218874968123250.,0.]; let r=219464325271666.; let t=sdf::leaf_at(Shape::Sphere{r},[0.;3]);
 println!("exact integer Pythagorean witness f={:?} ball0={:?} box0={:?}",t.f(p),t.interval_over_ball(p,0.),t.interval_over_box(p,[0.;3]));
 let bad=sdf::leaf_at(Shape::Sphere{r:f64::NAN},[0.;3]);
 let min=gcad_kernel::sdf::CsgNode::Min(vec![bad,t]);
 println!("invalid child folded root box={:?}",min.interval_over_box([0.;3],[1.;3]));
}
