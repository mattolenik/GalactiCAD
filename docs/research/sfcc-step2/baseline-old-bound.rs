use gcad_kernel::math::similarity::Similarity;
use gcad_kernel::sdf::{CsgNode,Leaf,Shape};
fn main() {
 let a=1.0+2.0_f64.powi(-22); let x=1.0/a; let h=2.0_f64.powi(-53);
 let leaf=Leaf{sign:1.0,sim:Similarity{r:[a,0.,0.,0.,1.,0.,0.,0.,1.],s:1.,t:[0.;3]},pos:[0.;3],shape:Shape::Sphere{r:1.},index:0,strata:vec![]};
 let t=CsgNode::Leaf(leaf); let (lo,hi)=t.interval_over_box([x,0.,0.],[h,0.,0.]);
 println!("a={a:.17e} x={x:.17e} half={h:.17e} f(x)={:.17e} interval=[{lo:.17e},{hi:.17e}] excludes_zero={}",t.f([x,0.,0.]),lo>0.||hi<0.);
}
