# A: bounded lower chamfer source continuation

Source: `/tmp/sfcc-lower-a`, copied from selected `/tmp/sfcc-closure-a-cell`.
No build, test or geometry execution was performed by this agent. Root must run `lower_a_` with `SFCC_LOWER_A_RECEIPT` set. Production is untouched.

## Changed files and reach

- `gcad-wasm/kernel/src/sfcc/exposure_a.rs`: registers proof module only.
- `gcad-wasm/kernel/src/sfcc/upper_source_a.rs`: makes existing finite-profile and cap proof helpers visible to their parent. Same implementation and callers.
- `gcad-wasm/kernel/src/sfcc/lower_source_a.rs`: source-binding proof; no runtime construction/admission caller.
- `gcad-wasm/kernel/src/sfcc/lower_source_a_tests.rs`: two original-source tests, scalar cross-checks and unsupported/source/interval/embedded-carrier controls.

No knobs, query caps, native ownership predicates, fingerprints, chart storage, geometry, exports or constructor behavior changes.

## Source theorem

Let E be the finite twisted extrusion scalar, C the finite cylinder scalar, and G the signed subtractive groove scalar. Source occurrence binding, exact represented identity frames, the inner round's inactive competitor, finite cap dominance, the cut cap, and inactive outer round are all checked. The meridian is a strictly convex closed polygon; the selected segment is strictly closest with interior projection and positive exterior distance. The twisted extrusion's selected finite edge is strictly closest (not just a supporting zero plane).

Set a=E=C in [-depth,0], with depth>0, depth<=0.25 and depth<r, where r is the chamfer radius. From represented source coefficients:

- rho=R+a;
- v=v0z+nz*a (nz is exactly +/-1);
- groove exterior distance = r+a, hence G=-r-a;
- y=y_edge+groove_y+[(r+a)-nr*(rho-r_edge)]/ny;
- u=sign*sqrt(rho^2-v^2), followed by the actual extrusion twist.

The implementation computes enclosing intervals from represented edge endpoints rather than trusting rounded stored normals. It requires rho>0, |u|>0, nonzero ny, and strict positivity of the exterior groove distance. Height is affine in a with derivative (1-nr)/ny; its absolute lower bound proves interval order and injection. The source-coordinate Jacobian is, up to orientation, nz*(u/rho)*ny and is bounded away from zero.

On this entire source interval, E=C=a<=0, G=-r-a<0, and both chamfer diagonal fields w*(E+G+r), w*(C+G+r) equal zero. Other ancestors are inactive. Thus the full represented scalar and both inherited lifted branch scalars vanish in exact real arithmetic. Sampled actual evaluator checks are diagnostics of floating agreement, not the proof.

## Complete local star is a separate conclusion

The strict finite profile/closest edge/cap/ancestor conditions hold at the event a=0. By continuity these strict inequalities persist in some open neighbourhood; this packet does not calculate its radius. The nonzero source-coordinate Jacobian establishes locally invertible coordinates (E,C,g), where g=G+r. The source scalar there is

F=max(E,C,w*(E+g),w*(C+g)),

where w is the positive represented FRAC_1_SQRT_2 constant. G itself is strictly negative and inactive near the event; the round and cap ancestors remain inactive. F<=0 is precisely E<=0, C<=0, E+g<=0, C+g<=0. Its four distinct boundary planes meet in four physical rays:

1. E=C=0, g<0;
2. E=g=0, C<0;
3. C=g=0, E<0;
4. E=C=-g<0, g>0.

The two nonadjacent plane pairs yield only the origin under the remaining inequalities, so there are no additional local crease rays. The new ideal curve parameterizes ray 4. This is a local physical arrangement statement, not completeness of discovered chart records and not an explicit neighbourhood size.

## Source representation and limit

The actual lifted source pair is located through `upper_round_child_matches`, which binds its inherited source path/branch/partner to the registered inner round and cylinder. The helper name is historical: both lower and upper portions belong to the same lifted source pair, but the lower proof here is independently derived from the chamfer region. `curve_source_matches` additionally requires the retained native immutable root Arc, the two retained lifted source descriptors, and the actual embedded traced carriers to match the registry. Coherent foreign registry+curve and mixed foreign lifted descriptors under the original native root are rejection controls. It does not establish which raw interval approaches this lower event.

The candidate event is only an association proposal passed to the existing source junction proof. IDs, proximity, endpoint labels, or an upper source certificate are not premises for the lower theorem. The diagnostic fixture uses the captured lower event coordinates to select the intended branch and source descriptor paths to locate roles.

**Not established:** old chart75's numerical connection/order, an admissible replacement join, corner incidence repair, whole-cell graph, whole-component validity, source patch coverage or native/WASM/GPU equivalence. Do not attach this curve based solely on the certificate. B independently measures the actual raw join and must require a three-dimensional association. The packet retains immutable source identity but makes no runtime storage or mutation integration; runtime installation still needs a matching fresh contract, original curve/span provenance, and atomic corner updates.
