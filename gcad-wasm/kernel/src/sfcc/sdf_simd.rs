//! f64x2 SoA SIMD gradient evaluator (2 points per call) for the iii-d blend cone.
//!
//! The cone evaluates `tree.grad` at the cell's near-surface probe points; this
//! computes the value+unit-normal for TWO points at once in f64x2 lanes. Built only
//! for `wasm32 + simd128`; the scalar path (native, or wasm without the feature) keeps
//! the trait-default `grad_pair` (two scalar `grad` calls).
//!
//! Divergence: a CSG combiner's per-point winner can differ between the two lanes, so
//! (unlike scalar `grad`, which recurses into the single winner) this evaluates EVERY
//! child and lane-selects — correct, at the cost of more child evals. Leaves use a
//! vectorized fast path for translation/scale-only (identity-rotation) sphere/box/
//! cylinder (the dominant CAD primitives); rotated leaves and cone/extrude/loft/lathe
//! fall back to two scalar leaf evals packed into lanes (still correct, no SIMD win).

#![cfg(all(target_arch = "wasm32", target_feature = "simd128"))]

use crate::primitives::smin::SminMode;
use crate::sdf::{BlendKind, CsgNode, Leaf, Pruned, Shape};
use core::arch::wasm32::*;

const IDENTITY_R: [f64; 9] = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];

#[inline(always)]
fn sel(mask: v128, t: v128, f: v128) -> v128 {
    v128_bitselect(t, f, mask)
}
#[inline(always)]
fn len3(x: v128, y: v128, z: v128) -> v128 {
    f64x2_sqrt(f64x2_add(f64x2_add(f64x2_mul(x, x), f64x2_mul(y, y)), f64x2_mul(z, z)))
}
#[inline(always)]
fn max0(x: v128) -> v128 {
    f64x2_max(x, f64x2_splat(0.0))
}
#[inline(always)]
fn min0(x: v128) -> v128 {
    f64x2_min(x, f64x2_splat(0.0))
}
/// sgn matching scalar `shapes::sgn`: `x < 0 ? -1 : 1` (sgn(0)=+1).
#[inline(always)]
fn sgn(x: v128) -> v128 {
    sel(f64x2_lt(x, f64x2_splat(0.0)), f64x2_splat(-1.0), f64x2_splat(1.0))
}

/// (value, [nx,ny,nz]) for two points, each lane one point.
type GradX2 = (v128, [v128; 3]);

// --- vectorized primitives (local-space, two points) -----------------------

#[inline]
fn sphere_x2(lx: v128, ly: v128, lz: v128, r: f64) -> GradX2 {
    let len = len3(lx, ly, lz);
    let val = f64x2_sub(len, f64x2_splat(r));
    let ok = f64x2_gt(len, f64x2_splat(1e-30));
    let inv = sel(ok, f64x2_div(f64x2_splat(1.0), len), f64x2_splat(0.0));
    // degenerate fallback normal [0,1,0]
    let nx = f64x2_mul(lx, inv);
    let ny = sel(ok, f64x2_mul(ly, inv), f64x2_splat(1.0));
    let nz = f64x2_mul(lz, inv);
    (val, [nx, ny, nz])
}

#[inline]
fn box_x2(lx: v128, ly: v128, lz: v128, bx: f64, by: f64, bz: f64) -> GradX2 {
    let dx = f64x2_sub(f64x2_abs(lx), f64x2_splat(bx));
    let dy = f64x2_sub(f64x2_abs(ly), f64x2_splat(by));
    let dz = f64x2_sub(f64x2_abs(lz), f64x2_splat(bz));
    let outside = len3(max0(dx), max0(dy), max0(dz));
    let inside = f64x2_max(f64x2_max(min0(dx), min0(dy)), min0(dz));
    let val = f64x2_add(outside, inside);

    // outside normal = normalize(max0(d)*sgn(l))
    let ox = f64x2_mul(max0(dx), sgn(lx));
    let oy = f64x2_mul(max0(dy), sgn(ly));
    let oz = f64x2_mul(max0(dz), sgn(lz));
    let olen = len3(ox, oy, oz);
    let out_ok = f64x2_gt(olen, f64x2_splat(0.0));
    let oinv = sel(out_ok, f64x2_div(f64x2_splat(1.0), olen), f64x2_splat(0.0));
    let onx = f64x2_mul(ox, oinv);
    let ony = f64x2_mul(oy, oinv);
    let onz = f64x2_mul(oz, oinv);

    // inside normal = dominant face: dx>dy&&dx>dz -> x; elif dy>dz -> y; else z.
    let face_x = v128_and(f64x2_gt(dx, dy), f64x2_gt(dx, dz));
    let face_y = v128_and(v128_not(face_x), f64x2_gt(dy, dz));
    let face_z = v128_and(v128_not(face_x), v128_not(face_y));
    let inx = sel(face_x, sgn(lx), f64x2_splat(0.0));
    let iny = sel(face_y, sgn(ly), f64x2_splat(0.0));
    let inz = sel(face_z, sgn(lz), f64x2_splat(0.0));

    let nx = sel(out_ok, onx, inx);
    let ny = sel(out_ok, ony, iny);
    let nz = sel(out_ok, onz, inz);
    (val, [nx, ny, nz])
}

#[inline]
fn cylinder_x2(lx: v128, ly: v128, lz: v128, r: f64, h: f64) -> GradX2 {
    let cr = f64x2_splat(r.max(1e-6));
    let ch = f64x2_splat(h.max(1e-6));
    let rho = f64x2_sqrt(f64x2_add(f64x2_mul(lx, lx), f64x2_mul(lz, lz)));
    let dr = f64x2_sub(rho, cr);
    let dy = f64x2_sub(f64x2_abs(ly), ch);
    // dist = min(max(dr,dy),0) + len2(max0(dr),max0(dy))
    let inside = f64x2_min(f64x2_max(dr, dy), f64x2_splat(0.0));
    let outside = f64x2_sqrt(f64x2_add(f64x2_mul(max0(dr), max0(dr)), f64x2_mul(max0(dy), max0(dy))));
    let val = f64x2_add(inside, outside);

    // (nr, ny) per the scalar branch structure
    let both_out = v128_and(f64x2_gt(dr, f64x2_splat(0.0)), f64x2_gt(dy, f64x2_splat(0.0)));
    let cap_len = f64x2_sqrt(f64x2_add(f64x2_mul(dr, dr), f64x2_mul(dy, dy)));
    let cap_inv = sel(f64x2_gt(cap_len, f64x2_splat(0.0)), f64x2_div(f64x2_splat(1.0), cap_len), f64x2_splat(0.0));
    let side = f64x2_gt(dr, dy); // dr>dy -> radial wall
    let nr = sel(both_out, f64x2_mul(dr, cap_inv), sel(side, f64x2_splat(1.0), f64x2_splat(0.0)));
    let ny0 = sel(
        both_out,
        f64x2_mul(f64x2_mul(dy, cap_inv), sgn(ly)),
        sel(side, f64x2_splat(0.0), sgn(ly)),
    );

    // assemble world-ish normal: if rho>eps && nr!=0: [nr*lx/rho, ny, nr*lz/rho] normalized
    let rho_ok = f64x2_gt(rho, f64x2_splat(1e-12));
    let nr_nz = v128_not(f64x2_eq(nr, f64x2_splat(0.0)));
    let rinv = sel(rho_ok, f64x2_div(f64x2_splat(1.0), rho), f64x2_splat(0.0));
    let ox = f64x2_mul(f64x2_mul(nr, lx), rinv);
    let oz = f64x2_mul(f64x2_mul(nr, lz), rinv);
    let olen = len3(ox, ny0, oz);
    let oinv = sel(f64x2_gt(olen, f64x2_splat(1e-30)), f64x2_div(f64x2_splat(1.0), olen), f64x2_splat(0.0));
    // main branch (rho_ok && nr!=0)
    let main = v128_and(rho_ok, nr_nz);
    let mnx = f64x2_mul(ox, oinv);
    let mny = f64x2_mul(ny0, oinv);
    let mnz = f64x2_mul(oz, oinv);
    // nr!=0 but rho tiny -> [1,0,0]; else (nr==0) -> [0, ny0 (or 1 if 0), 0]
    let nr_only = v128_and(v128_not(rho_ok), nr_nz);
    let ny_cap = sel(f64x2_eq(ny0, f64x2_splat(0.0)), f64x2_splat(1.0), ny0);
    let nx = sel(main, mnx, sel(nr_only, f64x2_splat(1.0), f64x2_splat(0.0)));
    let ny = sel(main, mny, sel(nr_only, f64x2_splat(0.0), ny_cap));
    let nz = sel(main, mnz, f64x2_splat(0.0));
    (val, [nx, ny, nz])
}

// --- leaf eval (fast path or scalar fallback) -------------------------------

#[inline]
fn leaf_x2(l: &Leaf, p0: [f64; 3], p1: [f64; 3]) -> GradX2 {
    let identity_rot = l.sim.r == IDENTITY_R;
    let fast = identity_rot && matches!(l.shape, Shape::Sphere { .. } | Shape::Cuboid { .. } | Shape::Cylinder { .. });
    if fast {
        // local = (p - t)/s - pos  (identity rotation)
        let s = l.sim.s;
        let pack = |a: f64, b: f64| f64x2(a, b);
        let lx = f64x2_sub(
            f64x2_div(f64x2_sub(pack(p0[0], p1[0]), f64x2_splat(l.sim.t[0])), f64x2_splat(s)),
            f64x2_splat(l.pos[0]),
        );
        let ly = f64x2_sub(
            f64x2_div(f64x2_sub(pack(p0[1], p1[1]), f64x2_splat(l.sim.t[1])), f64x2_splat(s)),
            f64x2_splat(l.pos[1]),
        );
        let lz = f64x2_sub(
            f64x2_div(f64x2_sub(pack(p0[2], p1[2]), f64x2_splat(l.sim.t[2])), f64x2_splat(s)),
            f64x2_splat(l.pos[2]),
        );
        let (val, n) = match l.shape {
            Shape::Sphere { r } => sphere_x2(lx, ly, lz, r),
            Shape::Cuboid { half } => box_x2(lx, ly, lz, half[0], half[1], half[2]),
            Shape::Cylinder { r, h } => cylinder_x2(lx, ly, lz, r, h),
            _ => unreachable!(),
        };
        let sign = f64x2_splat(l.sign);
        let val = f64x2_mul(f64x2_mul(sign, f64x2_splat(s)), val);
        (val, [f64x2_mul(sign, n[0]), f64x2_mul(sign, n[1]), f64x2_mul(sign, n[2])])
    } else {
        // scalar fallback for both lanes
        let f0 = l.f(p0);
        let f1 = l.f(p1);
        let n0 = l.normal(p0);
        let n1 = l.normal(p1);
        (f64x2(f0, f1), [f64x2(n0[0], n1[0]), f64x2(n0[1], n1[1]), f64x2(n0[2], n1[2])])
    }
}

// --- node view (shared over CsgNode + Pruned) -------------------------------

enum View<'a, N> {
    Leaf(&'a Leaf),
    Min(&'a [N]),
    Max(&'a [N]),
    Blend { kind: BlendKind, mode: SminMode, r: f64, n: f64, children: &'a [N] },
}

trait SimdNode: Sized {
    fn view(&self) -> View<'_, Self>;
}

impl SimdNode for CsgNode {
    fn view(&self) -> View<'_, Self> {
        match self {
            CsgNode::Leaf(l) => View::Leaf(l),
            CsgNode::Min(c) => View::Min(c),
            CsgNode::Max(c) => View::Max(c),
            CsgNode::Blend { kind, mode, r, n, children } => {
                View::Blend { kind: *kind, mode: *mode, r: *r, n: *n, children }
            }
        }
    }
}

impl SimdNode for Pruned<'_> {
    fn view(&self) -> View<'_, Self> {
        match self {
            Pruned::Leaf(l) => View::Leaf(l),
            Pruned::Min(c) => View::Min(c),
            Pruned::Max(c) => View::Max(c),
            Pruned::Blend { kind, mode, r, n, children } => {
                View::Blend { kind: *kind, mode: *mode, r: *r, n: *n, children }
            }
        }
    }
}

fn grad_x2<N: SimdNode>(node: &N, p0: [f64; 3], p1: [f64; 3]) -> GradX2 {
    match node.view() {
        View::Leaf(l) => leaf_x2(l, p0, p1),
        View::Min(ch) => {
            let (mut bv, mut bg) = grad_x2(&ch[0], p0, p1);
            for c in &ch[1..] {
                let (v, g) = grad_x2(c, p0, p1);
                let lt = f64x2_lt(v, bv);
                bv = sel(lt, v, bv);
                bg = [sel(lt, g[0], bg[0]), sel(lt, g[1], bg[1]), sel(lt, g[2], bg[2])];
            }
            (bv, bg)
        }
        View::Max(ch) => {
            let (mut bv, mut bg) = grad_x2(&ch[0], p0, p1);
            for c in &ch[1..] {
                let (v, g) = grad_x2(c, p0, p1);
                let gt = f64x2_gt(v, bv);
                bv = sel(gt, v, bv);
                bg = [sel(gt, g[0], bg[0]), sel(gt, g[1], bg[1]), sel(gt, g[2], bg[2])];
            }
            (bv, bg)
        }
        View::Blend { kind, mode, r, n: _n, children } => {
            let sgn_v = if kind == BlendKind::Smax { f64x2_splat(-1.0) } else { f64x2_splat(1.0) };
            // maintain per-lane nearest two by sgn*value
            let inf = f64x2_splat(f64::INFINITY);
            let (mut va, mut vb) = (inf, inf);
            let mut ga = [f64x2_splat(0.0); 3];
            let mut gb = [f64x2_splat(0.0); 3];
            for c in children.iter() {
                let (cv, cg) = grad_x2(c, p0, p1);
                let v = f64x2_mul(sgn_v, cv);
                let lt_a = f64x2_lt(v, va);
                let lt_b = f64x2_lt(v, vb);
                // shift-in: new b = lt_a ? old a : (lt_b ? v : old b)
                let nvb = sel(lt_a, va, sel(lt_b, v, vb));
                let ngb = [
                    sel(lt_a, ga[0], sel(lt_b, cg[0], gb[0])),
                    sel(lt_a, ga[1], sel(lt_b, cg[1], gb[1])),
                    sel(lt_a, ga[2], sel(lt_b, cg[2], gb[2])),
                ];
                let nva = sel(lt_a, v, va);
                let nga = [sel(lt_a, cg[0], ga[0]), sel(lt_a, cg[1], ga[1]), sel(lt_a, cg[2], ga[2])];
                va = nva;
                vb = nvb;
                ga = nga;
                gb = ngb;
            }
            // Round smin weights + value (only Round vectorized; matches mech).
            let rr = f64x2_splat(r);
            let (wa, wb, value) = if mode == SminMode::Round {
                let both_lt = v128_and(f64x2_lt(va, rr), f64x2_lt(vb, rr));
                let a_le_b = f64x2_le(va, vb);
                let wa = sel(both_lt, f64x2_sub(rr, va), sel(a_le_b, f64x2_splat(1.0), f64x2_splat(0.0)));
                let wb = sel(both_lt, f64x2_sub(rr, vb), sel(a_le_b, f64x2_splat(0.0), f64x2_splat(1.0)));
                // value = sgn * (max(r, min(va,vb)) - hypot(max0(r-va), max0(r-vb)))
                let mn = f64x2_min(va, vb);
                let ux = max0(f64x2_sub(rr, va));
                let uy = max0(f64x2_sub(rr, vb));
                let hyp = f64x2_sqrt(f64x2_add(f64x2_mul(ux, ux), f64x2_mul(uy, uy)));
                let sv = f64x2_sub(f64x2_max(rr, mn), hyp);
                (wa, wb, f64x2_mul(sgn_v, sv))
            } else {
                // non-Round: fall back to nearest (Soft etc. rare in CAD); use a-weight 1.
                (f64x2_splat(1.0), f64x2_splat(0.0), f64x2_mul(sgn_v, va))
            };
            // blended grad = normalize(wa*ga + wb*gb)
            let mut gx = f64x2_add(f64x2_mul(wa, ga[0]), f64x2_mul(wb, gb[0]));
            let mut gy = f64x2_add(f64x2_mul(wa, ga[1]), f64x2_mul(wb, gb[1]));
            let mut gz = f64x2_add(f64x2_mul(wa, ga[2]), f64x2_mul(wb, gb[2]));
            let l = len3(gx, gy, gz);
            let ok = f64x2_gt(l, f64x2_splat(1e-12));
            let inv = sel(ok, f64x2_div(f64x2_splat(1.0), l), f64x2_splat(1.0));
            gx = f64x2_mul(gx, inv);
            gy = f64x2_mul(gy, inv);
            gz = f64x2_mul(gz, inv);
            // where len too small, fall back to ga
            gx = sel(ok, gx, ga[0]);
            gy = sel(ok, gy, ga[1]);
            gz = sel(ok, gz, ga[2]);
            (value, [gx, gy, gz])
        }
    }
}

/// Public entry: value+normal for two points via the f64x2 evaluator, unpacked to
/// the scalar `(f, [x,y,z])` pair the `SdfQuery::grad_pair` override returns.
pub fn grad_pair_csg(node: &CsgNode, p0: [f64; 3], p1: [f64; 3]) -> ((f64, [f64; 3]), (f64, [f64; 3])) {
    unpack(grad_x2(node, p0, p1))
}
pub fn grad_pair_pruned(node: &Pruned<'_>, p0: [f64; 3], p1: [f64; 3]) -> ((f64, [f64; 3]), (f64, [f64; 3])) {
    unpack(grad_x2(node, p0, p1))
}

#[inline]
fn unpack((v, g): GradX2) -> ((f64, [f64; 3]), (f64, [f64; 3])) {
    let v0 = f64x2_extract_lane::<0>(v);
    let v1 = f64x2_extract_lane::<1>(v);
    let g0 = [f64x2_extract_lane::<0>(g[0]), f64x2_extract_lane::<0>(g[1]), f64x2_extract_lane::<0>(g[2])];
    let g1 = [f64x2_extract_lane::<1>(g[0]), f64x2_extract_lane::<1>(g[1]), f64x2_extract_lane::<1>(g[2])];
    ((v0, g0), (v1, g1))
}
