# Selected numerical proof: represented-affine geometric exclusion

The Step 2 consensus establishes a numerical **zero-exclusion** contract for hard CSG
of spheres and boxes. It does not establish component coverage, mesher success,
feature-carrier parity for approximate rotations, termination before a configured
ceiling, embedding, or Hausdorff accuracy.

## Declared field and scope

Every actual parsed and baked finite binary64 coefficient denotes its exact
represented real number. The inputs to a leaf are its actual stored matrix `R`, translation `t`,
positive uniform scale `s`, primitive center `pos`, positive radius/half-extents,
and sign in `{−1,+1}`. Transform composition has already rounded these stored
coefficients; no ideal pre-composition transform is substituted. For real `p`,
let `u = Rᵀ(p−t)/s − pos`. The declared field is `sign*s*phi(u)` where sphere
`phi(u)=||u||₂−r`, and box
`phi(u)=||max(abs(u)−h,0)||₂+min(max_i(abs(u_i)−h_i),0)`.
Hard Min/Max are real pointwise min/max; subtraction is the existing normalized
signed tree. Existing signed occurrence references and postorder owner paths do
not change.

A supported query means that its root and every descendant are sphere/box
leaves and hard Min/Max nodes. A finite mixed/opaque estimate is not certified
merely because some of its leaves have supported shapes. The explicit opaque
operand policy below preserves legacy behavior under blend ancestors.

No orthogonality, determinant, nonsingularity, or special accuracy of `sin/cos`
is required for the enclosure. Thus an approximate rotation is interpreted as
the affine coefficients actually stored, including its nonzero orthogonality
defect. The preexisting discovery carrier-eligibility check remains conservative
and can decline grossly malformed or numerically collapsed carrier geometry;
its tolerance is **never** a premise used to prove an interval.

For a finite center `c` and nonnegative finite half vector `h`, `Q` is the real
closed product `[c_i−h_i,c_i+h_i]`. A finite ordered interval returned by the
supported path contains the declared field at every real point in Q. Ball
queries are enclosed by the coordinate cube of half-extents `[r,r,r]`, so the
same theorem applies throughout the ball. Strict `lo>0` or `hi<0` excludes zero;
equality cannot exclude zero. NaN endpoints mean explicit arithmetic/input
uncertainty and must not participate in a successful fold or cull.

## Arithmetic model and elementary enclosure

Rust binary64 elementary arithmetic uses IEEE round-to-nearest ties-to-even.
If an exact real elementary result rounds to a finite binary64 value, that real
result lies between the rounded value’s adjacent representable neighbors,
including underflow, signed zero, and halfway cases. Therefore the
exact real result of each addition, subtraction, multiplication, and division
is enclosed by expanding **that individual operation** in the required
direction. This is not a one-ULP expansion of an arbitrary final expression.
The bounds reject any nonfinite intermediate endpoint, including overflow or
an outward step from the largest finite value. Rejecting can lose usefulness,
never validity. Multiplication by the exact coefficient zero returns exactly
zero. Input validation precedes that shortcut; a NaN coefficient is not hidden.

Intervals add `[a,b]+[c,d]` as downward `a+c`, upward `b+d`; subtract as downward
`a−d`, upward `b−c`; and multiply a finite point coefficient with sign-appropriate
endpoint selection and outward rounding. The absolute-value image is exact
endpoint selection plus zero when the interval crosses zero. All `min/max`
operations see only prechecked finite operands. Unary sign negation is exact.

The norm routine has no dependency on `hypot`. For nonnegative finite components
`v`, choose represented `m=max(v)`. If zero, the norm is exactly zero. Otherwise
compute the identity `m*sqrt(sum((v_i/m)^2))`. Each divide, square, accumulation,
square root, and final multiplication rounds in the requested direction.
All operands remain nonnegative; truncating a negative lower roundoff endpoint
to zero is valid. Monotonicity at each stage proves the norm lower/upper bounds.
Scaling avoids avoidable overflow in squares; division underflow remains covered
by outward rounding. If the final upper bound overflows, report uncertainty.

The square root operation has a correct-rounding contract, unlike `hypot`.
Primary references checked for this work:

- [Rust binary floating-point semantics](https://doc.rust-lang.org/std/primitive.f32.html)
- [Rust f64 square-root precision](https://doc.rust-lang.org/std/primitive.f64.html#method.sqrt)
- [Rust f64 hypot unspecified precision](https://doc.rust-lang.org/std/primitive.f64.html#method.hypot)
- [WebAssembly numerical operations](https://webassembly.github.io/spec/core/exec/numerics.html)

The guarantee requires ordinary Rust compilation without unsafe fast-math,
reassociation, altered floating environment or flush-to-zero behavior. The implementation preserves release optimization/LTO settings and exercises native and
WASM builds. Target execution evidence is additional to the stated model.

## Analytic geometry and induction

Positive homogeneity gives an exact real algebraic identity. Put
`q=Rᵀ(p−t)−s*pos`. The sphere field is `sign*(||q||−s*r)`. The box field is
`sign*(||max(abs(q)−s*h,0)||+min(max_i(abs(q_i)−s*h_i),0))`.
This eliminates reciprocal-scale amplification in the enclosure without changing
the production evaluator or the declared field.

For boxes, signed-permutation spheres, and the conservative fallback: enclose
each coordinate of `p−t`, then every represented matrix column dot
product and `s*pos` subtraction. The resulting rectangular image contains the
actual transformed parallelepiped, even if R is far from orthogonal. Dependency
loss only enlarges it. Take the exact absolute-coordinate intervals. Both
Euclidean norm over nonnegative coordinates and the box expression are
coordinatewise monotone. Evaluation at their coordinate lower and upper bounds,
with each elementary arithmetic operation outward-rounded, therefore encloses
the entire transformed region. Apply exact sign reversal last.

### Tight sphere geometry under an approximate matrix

The first candidate used only the transformed-coordinate AABB. Its enclosure
was sound, but an actual `Rz(.713)` sphere exported with 8,237 leaves and 5,703
unresolved cells, against the frozen baseline's 1,591/8. This contradicted the
usefulness gate; that variant is rejected. A rotated box stayed at 326/0.
The revised sphere branch preserves radial geometry as follows.

Compute interval entries of `D=R Rᵀ−I` using the actual matrix. Let `e` be an
outward-rounded upper bound on the largest absolute row sum. Since D is real
symmetric, for any real v,

`|vᵀDv| <= sum_ij |Dij| |vi| |vj| <= (1/2) sum_ij |Dij|(vi²+vj²) <= e||v||²`.

Consequently `sqrt(max(0,1−e))*||v|| <= ||Rᵀv|| <= sqrt(1+e)*||v||`.
The computed lower and upper factors round each subtraction/addition and square
root outward. The branch falls back to affine bounds when `e>=1` or arithmetic
fails; that threshold selects a useful formula, not admissible input geometry.

Put `w=t+s R pos` and `b=s(RᵀR pos−pos)`. The exact identity is
`q=Rᵀ(p−w)+b`, with no orthogonality assumption. Enclose w componentwise and
bound near/far Euclidean distances from Q to that center interval in world
coordinates. Compute b through the actual matrix products with outward
arithmetic, then an upper bound B on its norm. The triangle inequalities give
`max(0,L*near−B) <= ||q|| <= U*far+B`, where L/U are the factors above.
Each product/addition/subtraction is again outward rounded. Subtract the
outward enclosure of `s*r`, then apply the leaf sign. This is an analytic
ellipsoidal bound on the represented field, not an ideal-sphere replacement.
Signed permutation matrices use the simpler affine branch, whose box image has
no rotational dependency loss. The independent rational oracle includes
nonzero local centers, f32/f64 rounded rotations, a nonorthogonal matrix, both
signs, huge/tiny scales, and subnormals to challenge the residual term.

For hard nodes, induction uses monotonicity: min of all lower endpoints and min
of all upper endpoints enclose a minimum; max is analogous. Every child is
visited and checked before composition succeeds. Empty hard nodes and accidental
NaNs return uncertainty; `f64::min/max` cannot silently rescue a malformed child.
This same shared leaf path is used for whole-tree, pruned-tree, box, ball, and
discovery entity/point queries.

## Relationship to the floating evaluator and pruning

`Leaf::f` is unchanged. Supported sphere/box evaluation uses the explicit
`len3=(x*x+y*y+z*z).sqrt()` in shapes.rs, with the original inverse-transform
operation order. Those operations can underflow or overflow where the homogeneous,
scale-normalized enclosure remains finite. The old bound's `hypot` use had an
unspecified-precision issue; the supported scalar evaluator is not a hypot call.
The continuous interval theorem therefore does **not** claim to enclose every rounded sample
or preserve floating winners merely because real intervals separate. Supported
hard `Pruned` trees retain every child in its original order at every prune
entry, including recursive and sub-box calls. Their floating evaluation,
gradient routing, and owner routing consequently use the original operands.
This proof does not depend on a guessed norm error budget. Mixed/opaque scopes
keep the legacy pruning policy, explicitly outside this parity theorem.

## Caller audit and actual regions

- `Leaf::interval_over_box`: spheres/boxes enter the checked affine path before
  the old engineering implementation. Unsupported primitives retain legacy
  behavior with basic finite-parameter checks.
- `CsgNode` and `Pruned` box/ball intervals: supported leaves share the path;
  all hard folds propagate invalid children. Balls use the enclosing cube.
- `Builder::certified_empty`: both initial descent and child creation (including
  balance-induced splits) now use `math::grid::cell_enclosure`.
- `collect_coarse_prunes`: its earlier empty-region cull uses the same cell box.
- `discovery_guard`: whole-cell original owner collection uses the same
  `cell_enclosure` as early culls. Point signs, same-sign edges and faces use
  their actual endpoint regions and the shared checked primitive bounds.
- `needs_split_smooth_after_discovery`: same-sign root exclusion uses that same
  actual cell enclosure, including the feature-box rounding strip outside the
  canonical corner hull. It does not substitute a nominal half-size or the
  narrower corner hull.
- Pipeline/coarse octree, face-contour, and cell-mesh regional query views all
  enter `prune_to_box`. Supported hard trees retain all operands, so arbitrary
  query points cannot escape a regional pruning proof (there is no deletion).
- `recovered_crossings_for`: replaces the per-carrier midpoint/`grad_bound`
  rejection with a single shared root interval query. The region encloses both
  the real edge and rounded `a+(b-a)*t`, `0<=t<=1`, by bounding the subtraction,
  all products with `[0,1]`, and final addition. Inconclusive bounds skip no
  carrier numerically. Spatial feature availability and finite recovery sampling
  remain separate, unproved coverage obligations for Step 3.
- Serial, resumable, direct decision, and worker paths use the same builders
  and intervals; no worker-specific alternative bound was added.

`RefineProbe` stores its whole-cell region privately. Production construction
must go through `make_probe`, which obtains `cell_enclosure` from the actual
lattice and cell indices. Missing/failed enclosures yield uncertainty. Public
sample-coordinate mutation is checked before any whole-cell exclusion: the
outward upper bound on each sample-to-center distance must fit its half-extent.
Thus direct construction cannot silently omit the feature-box rounding strip.
Test-only synthetic probes declare their region explicitly. A regression
separately exercises an actual feature-box strip at origin 1e15 and a declared
region containing a zero outside the sample hull.

`enclosing_box` chooses a represented midpoint, then bounds both real distances
to each represented endpoint via outward subtraction. The resulting real
center/half box contains the endpoints; collapsed dimensions stay zero.

The lattice premise is the coherent state produced by `make_lattice`: finite positive world size, finite origins for a successful bound, resolution `2^max_depth`, legal depths through 14, and cell indices `0 <= i < 2^level`. Arbitrarily forged public lattice fields are outside this condition.

The lattice has three rounded spatial constructions: `origin+g*step`,
`origin+index*(world_size/2^level)` plus a second size addition for feature-box
maxima, and `point_to_world(g)+len*step` for contour rectangles/face centers.
`cell_enclosure` covers all three, at every descendant depth through the existing
ceiling. It also encloses the exact dyadic addressed cell
`origin + world_size*[index,index+1]/2^level` with outward products. The index
fractions are exactly representable; multiplying before rounding a per-level
size prevents lost subnormal bits from opening a gap between nominal parent
and child domains. Those nominal domains tile exactly over the real numbers.
At depth d, legal descendant indices range from `ix*2^(d−level)` to
`(ix+1)*2^(d−level)−1`. The endpoints enclose each monotone multiplication and
addition in these maps, including the last `+size` and the independent
fine-step `+len*step`. The largest descendant face endpoint comes from the last
descendant origin plus its extent; smaller face extents and centers are bounded
by monotonicity. Corners and direct centers lie between the direct extrema.
Integers/dyadic index products are exact
because the legal depth is at most 14. Taking the union across depths handles
subnormal sizes without assuming power-of-two scaling remained exact.
The target includes both that nominal dyadic cell (from the stored world_size)
and every actual represented coordinate region used by its descendants. It does
not reconstruct a different pre-serialization world size. Exact subnormal-unit
witnesses exercise max-depth 4 with world_size 7 min-subnormal units (step
underflows to zero), and depth 14 with 24,559 units (rounded-step endpoint
16,384 units). Each actual ancestor interval retains the exact sphere zero at
the nominal far boundary.
If a coordinate operation overflows, the cull returns false. There is no scalar
sample substituted for a regional bound.

The `active_strata` and normal-variation `reach` comparisons choose probes for
existing sampled heuristics. They are not region zero-exclusion certificates;
this change does not claim they prove component coverage or normal cones. Mesh
projection/residual checks similarly accept or reject candidate vertices, not
certify that a discarded spatial region has no zero. Those acceptance and
feature-availability obligations are deliberately distinct from this theorem.

## Mixed and unsupported scope

No whole-field numerical theorem is claimed for cylinder/cone/extrude/loft/lathe
or smooth blend trees. Blend endpoint composition explicitly evaluates its
operand subtrees with the legacy scalar-centered ball estimates, propagating
that policy through nested hard nodes and nested blends. This applies to both
CsgNode and Pruned queries. Regional dominance below a blend uses those same
legacy operand intervals and propagates the opaque policy through recursive
pruning, avoiding a mismatch between dominance and endpoint composition. Public supported-hard queries still use the checked
geometric bounds. The scope is selected by the opaque ancestor, not merely the
leaf's shape. Checked finite-input/endpoint validation remains active in both
policies, so opacity does not disguise a malformed child. The shared legacy
leaf helper checks the evaluated inverse-transform coordinates and their local
position subtraction before calling the existing scalar evaluator, then checks
the scalar, Lipschitz advisory, reach and endpoints. This catches finite-input
overflow that box min/max could otherwise hide: scale MIN_POSITIVE, half-extents
1 and query (4,4,0) produce NaN transformed coordinates although the old scalar
returns zero. Native and actual WASM regressions cover that box under a round
blend, under a further hard ancestor, and through regional views.

This routing corrects an independently exposed usefulness regression. Applying
the new cube enclosure to sphere operands inside a legacy round blend changed
the round-plus-separate-box control from 3,631 leaves / 543 unresolved to
5,860 / 2,621, despite unchanged operator evaluation. The earlier scope
paragraph alone did not prevent that widened opaque estimate. The explicit
legacy routing restores the intended limited scope; no new blend theorem is
claimed. The frozen mixed baseline also includes a cylinder-plus-sphere control
at 2,279 leaves / 8 unresolved.
 Their engineering estimates and useful legacy exports
remain in place. Discovery treats these scopes as intentionally opaque
`[-infinity,+infinity]`, while validating parameters recursively so a NaN input
cannot masquerade as intentional opacity. A supported hard sibling can still
prove a strict neutral ancestor sign in discovery; otherwise opacity survives.
The full exporter may retain legacy culls involving opaque intervals, so this
limited discovery result is not a mixed-tree whole-pipeline guarantee.

## Cost

Checked primitive box bounds use constant work and no allocation: nine affine
coefficient products, endpoint additions/subtractions, two scaled 3D norms, and
shape/sign composition. Non-permutation spheres instead use a 3x3 Gram
defect calculation (27 coefficient products), actual transformed-center and
residual products, and three norm bounds. These matrix-dependent quantities
could be cached per build in Step 4; this candidate deliberately does not add
mutable cache state or change Leaf's public construction layout. Each norm uses three divisions, squares and sums, one
square root and a final multiply. Every arithmetic stage has explicit endpoint
rounding and finiteness checks. Hard interval traversal remains O(nodes), O(depth)
stack. The cell-region union is O(max_depth−level+1), bounded by 15 passes, with
constant stack storage. Supported pruning now builds an O(nodes) unchanged view
instead of recursive dominance bounds; subsequent queries may evaluate more
leaves. There is no claim of a measured overall speed improvement. Formal paired
performance is reserved for Step 4.


## Integration provenance and proof limits

This proof is adapted from candidate B v4; focused integrated validation is recorded
in [the consensus report](../sfcc-step2-exclusion.md). It proves a real-field
range, not inclusion of every rounded `Leaf::f` value. The scalar evaluator
performs division before matrix multiplication and an unscaled explicit norm;
its floating expression is unchanged. Full retention preserves supported query
values, gradients, owner routing and interval formulas structurally. No interval
tuple identity is inferred merely from pointwise scalar parity.

JSON text is first parsed by each target's existing bridge and its transforms
are baked with existing floating arithmetic. Only those actual resulting binary64
leaf coefficients define F. Exact oracles capture those coefficients and query
bits separately on native and WASM. Decimal spellings, JavaScript numbers and
native serde numbers need not be bit-identical; neither ideal JSON arithmetic
nor GPU equality follows. The two targets are checked against their own captured
inputs, including independent re-proofs of exact-zero identities.

The legacy transform/local-coordinate guard catches the documented masked-box
NaN. It does not prove all intermediate arithmetic of unsupported primitive or
blend formulas, nor repair their continuity or Lipschitz assumptions. Feature
candidate availability, carrier equality, finite recovery searches, sampled
normal/stratum heuristics and local filling remain Step 3 obligations. A retained
cell alone is never reported as a component or mesh certificate.
