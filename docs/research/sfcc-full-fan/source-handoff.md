# A: common-slab root graph and interpolation error

Initial frozen source: `/tmp/sfcc-fullfan-a`, based on round34 `/tmp/sfcc-ownership-clamp` (207 inputs). Two changed files: `kernel/src/sfcc/exposure_a.rs` module declaration and new `kernel/src/sfcc/fullfan_source_a.rs`. Root alone executes builds, tests and geometry. Author performed source inspection and rustfmt parsing only.

Run filter `fullfan_a_`, receipt environment `SFCC_FULLFAN_A_RECEIPT`. Public experimental API:

`certify(f, cylinder_id, triangles: &[[[f64;3];3]], tolerance) -> Result<serde_json::Value,String>`.

The input triangle order determines `perTriangleSourceBounds`, for B's geometry/export combination. No patch label or mesh/source mutation occurs.

## Mathematical construction

One WORLD X slab encloses all supplied mesh points and extends each end by the unchanged surface tolerance. Every accepted source region uses this identical slab. This permits root equality on shared YZ edges by uniqueness in a common interval.

For every closed projected subtriangle, the source binder verifies actual primitive occurrences/operator ancestry, unclamped twist height, cylinder cap, finite lathe branches, inactive inner competitor, negative groove and cap, and inactive outer sphere. Native is either the actual finite selected side, or a convex-profile inscribed-ball upper bound proves native and its chamfer contribution strictly negative throughout the slab.

With native selected side E, cylinder C, positive groove distance D and represented chamfer factor w, the zero-equivalent expression is

`K=max(E,C,w*(E-D+r),w*(C-D+r))`.

When native contributions are proved strictly negative, only C and its chamfer term remain. The signed groove and cap terms are negative. The outer sphere is below its round cutoff. Therefore K and the full composed field have the same zero set/sign on the slab. The full composed field is not claimed globally monotone: omitted negative terms can have other directional derivatives.

Every retained K term has an interval X derivative strictly below zero; their common magnitude lower bound mu makes K strongly decreasing, including max-facet switches. Strict opposite signs at both common slab ends establish exactly one full-source root for every projected point. Local continuous graphs agree where their domains overlap, since their full-source roots occupy the same slab.

For a C2 term g, barycentric interpolation has error bounded by `M*diameter²/6` over a triangle, where M bounds the Hessian spectral norm (a Frobenius bound suffices). This follows from Taylor expansion around the barycentric point and `sum(lambda_i*|v_i-p|²) <= diameter²/3`. E has only XY, ZY and YY Hessian entries; radial rho has norm 1/rho. Chamfer Hessian bounds use the triangle inequality. Vertices and derivatives are interval-enclosed from represented source coefficients.

The termwise interpolant extrema bound K over the entire affine mesh triangle, including edges. If residual magnitude is <=epsilon, the unique root differs from that mesh point by at most epsilon/mu in X, with identical YZ. Thus the same bound controls both directions between the mesh triangle and the full-source graph over its projected domain.

## Coverage and work accounting

Subdivision uses interval-enclosed exact dyadic midpoints of the original affine triangle; it does not pretend rounded midpoint coordinates exactly partition the domain. The formal two-child midpoint split covers the complete closed parent. No source query is performed on the CPU beyond the existing symbolic interval source expressions.

There is one total cap of128 attempted region certificates across all six triangles, including failed/refined attempts, not128 per triangle. Depth is capped at12 as a secondary refusal guard. Failure emits a precise source/bracket/error gate and triangle/depth or cap context. No tolerance is raised.

## Limits

B must independently establish that supplied projected triangles form the intended embedded disk; A is conditional on those domains. A's root transport keeps YZ and can move an X-face boundary point off its original face. It therefore does not establish intended cell-patch/interface coverage or exact source-curve boundary correspondence. C's boundary witness addresses that distinction. The theorem only covers roots in the common slab; it does not exclude other remote sheets.

The initial attempt may fail conservative nearest-profile, common-slab or interval brackets. A possible next refinement, only if actual evidence requires it, is convex-native support-plane zero reduction across nearest-edge switches. No such extension is part of this frozen candidate.

No standalone build/test result or full-fan success is claimed until root executes the candidate.

## Reviewed input/negative-control revision

Selected author revision is `/tmp/sfcc-fullfan-a-reviewed`. It adds exact YZ nondegeneracy at the source API input boundary and a second focused test covering missing/flipped source cylinder, nonfinite/empty/degenerate inputs, invalid tolerances, conservative refusal at a much tighter tolerance, and 126 repeated input triangles exhausting the single global128-attempt budget. The source test also checks the successful result retains the exact requested tolerance bits and never returns an error bound above it. The attempt guard now refuses before incrementing beyond128.

Root reports the initial candidate passed with15 accepted pieces /24 total attempts and uniform source bound0.0005052995078438982. That success belongs to the initial source; the reviewed negative controls require root execution. No alternate all-support-plane extension was needed or implemented.

Native normal audit: whenever the exact native side contributes to K, `finite_profile_level` invokes `profile_branch`. That helper rejects oblique selected edges and requires the stored normal equal the exact cardinal outward normal determined by represented endpoints and exact orientation. Thus active E does not equate a rounded arbitrary normal to true segment distance. In the proven-inactive-native case, the actual convex polygon vertices and interval-derived edge lengths give an inside-ball bound; the selected E terms are discarded. Meridian coefficients are interval-derived from finite segment vertices, not trusted cached rounded normals.

The theorem concerns the real mathematical composed geometry defined by represented source input. It is not a bitwise CPU/WGSL evaluator equivalence claim or a uniform proof of platform libm error; those numerical/parity gates remain separate.
