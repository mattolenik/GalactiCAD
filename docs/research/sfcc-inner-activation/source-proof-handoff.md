# A: inner-round activation, continued crease and native ghost family

Selected source: `/tmp/sfcc-activation-a-final-qualified`, based on the 189-input
`/tmp/sfcc-activation-base` (HEAD `78136e8`). This agent inspected and edited
source and ran rustfmt only. Root alone executes builds, tests and geometry.
Production and all private query/memory/geometry limits are unchanged.

## Files and callers

Three files differ from the common baseline:

- `gcad-wasm/kernel/src/sfcc/exposure_a.rs`: register `activation_a`.
- `gcad-wasm/kernel/src/sfcc/activation_a.rs`: finite meridian proof helper and
  immutable borrowed source certificate. No construction caller or mutation.
- `gcad-wasm/kernel/src/sfcc/activation_a_tests.rs`: four source/association and
  rejection controls. Filter `activation_a_`; required receipt environment
  `SFCC_ACTIVATION_A_RECEIPT`. A second receipt `activation-A-ghost.json` is
  written beside the first.

B uses `meridian_bound` to improve the existing interval/face proof. C may use the
image methods as source premises, but must supply numerical trace, face, consumer
and rollback authority independently. The source certificate borrows the exact
feature registry; `bound_to` checks that instance. Its immutable source paths,
registered primitive occurrences, curve source pairs and embedded carriers are
rebound at construction. Source IDs are observations, not selection authority.

## Finite meridian distance without the old global-radius restriction

`meridian_bound(leaf, rho, world_y)` returns one strictly closest finite profile
segment, its outward unit normal, the exterior distance enclosure and strict
projection/other-edge margins. `rho` is radius ABOUT THAT LEAF'S X/Z center;
`world_y` is world height. The helper accepts identity frames, closed finite
profiles with 3..64 nondegenerate/non-None edges, and either sign, but always
returns the unsigned positive exterior distance.

Exterior is proved by either:

1. For every edge that intersects the box's Y band, its possible intersection
   with a positive-radial ray lies strictly left of the box. Horizontal edges in
   the band must also lie strictly left. Thus no ray from any box point toward
   positive radial infinity crosses the closed profile; winding is outside.
2. The uniquely nearest selected edge is globally supporting: exact orientation
   predicates place every profile vertex on the other side of its line, while
   the query box is strictly separated on the exterior side.

The first route handles the nonconvex competing lathe below its maximum profile
radius. The second handles the convex groove. The helper does not infer exterior
from a rounded stored normal. Unit normals and distances are enclosed from the
represented segment endpoints. Finite projection lies strictly inside the segment;
every other finite segment has distance lower bound above the selected upper
bound. The same segment and normal coefficients must persist in every certified
subinterval. The caller must bind the coordinate frame: A explicitly requires
other/groove/sphere X/Z centers to match the native/cylinder center, in addition
to the existing source-junction restrictions.

## Activation equations

Let E be the finite native twisted-extrusion scalar, L the competing lathe scalar,
I the inner round minimum, C the cylinder scalar, and G the subtractive groove.
Let `ri` be the inner-round radius and `rc` the physical chamfer radius. The
compiled common carrier is `Q = w*H + w*G + o`, with `H=max(I,C)`. Its radius
`rhat=o/w` is separately interval-enclosed; it is not silently identified with rc.

The selected meridian branches are affine:

```text
dGroove = ng_r*rho + ng_y*y + bg
L       = nl_r*rho + nl_y*y + bl
```

Incoming E=I=0 and C<=0 give the source crease `dGroove=rc`. The inner-round
activation is the unique intersection of `dGroove=rc` and `L=ri`. Its slope along
the groove offset is

```text
y' = -ng_r/ng_y > 0
k  = nl_r + nl_y*y' > 0.
```

Both physical (rc) and generated (rhat) activation points are solved independently
from these source equations. Positive outgoing/incoming derivative and strict
finite-source restrictions make the event unique on this supported branch. The
borrowed registry and actual curve pair are required; proximity alone is not a
premise. The event-image separation is bounded by the original numerical allowance.

## Closed incoming curve and regular outgoing continuation

The incoming method uses t in [0,1], interpolating the source radius from R at t=0
to the activation radius at t=1. Its exact native level is E=0. The relation
`L=ri+k*(rho-rhoActivation)` proves L>=ri on this CLOSED ideal interval, including
activation. It does not claim strict inactivity throughout an epsilon halo that
crosses activation.

Outgoing delta in [0,depth] decreases rho from activation. Then

```text
L = ri-k*delta
z = k*delta
E = ri-sqrt(ri^2-z^2)
  = z^2/(ri+sqrt(ri^2-z^2)).
```

The latter expression is used to enclose the nonnegative level without cancellation.
The original finite side has `v=v0z+nz*E` (nz is exactly +/-1),
`u=branchSign*sqrt(rho^2-v^2)`, followed by the actual twist. The inner round's
circle relation makes I=0 exactly in represented-real source arithmetic, and the
source groove remains `G=-rc`. Both the I facet and chamfer facet vanish; other
ancestors are inactive. The generated variant instead uses `G=-rhat` and has its
own root/image; exact equality with the physical full field is not asserted.

The derivative in radius of world height stays nonzero. The coordinate Jacobian
for `(I,G,rho)` has magnitude bounded below by

```text
|u/rho| * nativeWeight * |ng_y|,
nativeWeight = sqrt(ri^2-z^2)/ri > 0.
```

It proves transversality of I and G; the common Q retains a positive w factor.
At activation, outgoing E' tends to zero, matching incoming E'=0, while rho/y and
twist derivatives agree. The ideal physical crease is regular C1 through the
source-activity change. No C2, old-Newton continuity or global continuation claim
is made.

The certificate checks 16 subintervals for each of three families and each of two
radius variants, 96 bounded source-region checks total. It retains strict finite
native profile, native/cylinder caps, closest meridian branches, cap cutter and
outer sphere margins. Only the ideal incoming cylinder closure uses the exact
algebraic C<=0 relation rather than requiring a strict cylinder gap at its start.

## Why the native tail is a ghost feature

For z=ri-L>0, fix E=0. The inner field is

```text
I = ri-sqrt(ri^2+z^2)
  = -z^2/(ri+sqrt(ri^2+z^2)) < 0.
```

Requiring Q=0 then gives `dGroove = rc+I` for the physical source, or `rhat+I` for
the compiled carrier. Together with `L=ri-z`, these are another pair of affine
meridian equations giving an explicit native ghost family. The certificate proves
C<I and positive groove distance over the bounded family; cap and outer operations
remain inactive. For the physical family and every z>0, I<0 and G<0 strictly, while
the physical diagonal Q=0 is the sole active facet. The inner blend is smooth there. Nonzero `grad(I) x grad(G)` implies
`grad(Q)` cannot vanish. This is a regular smooth Q surface, not a crease along E=0.
At z=0 the family shares the activation limit and tangent with the real crease.

Root's executed reviewed packet associates the actual native t=16 own query to
this generated ghost family using its sampled L value to propose z, followed by a
full three-dimensional enclosure check. That is a checked endpoint association,
not proof that the entire old numerical tail is continuous or that every old
parameter follows this family. Runtime clipping still needs bounded raw cut/join
association and an atomic ownership/consumer transaction.

## Public API summary

- `meridian_bound(leaf,rho,world_y) -> Option<MeridianBound>`
- `bind(root,features,source[native,field,cylinder],charts[nativeAlias,composite],depth)`
- `activation_radial(generated)`, `activation_height(generated)`, `activation_image(generated)`
- `incoming_image(t0,t1,generated)`; t=0 is the original lower source junction,
  t=1 activation.
- `outgoing_image(delta0,delta1,generated)`; delta is radial drop from activation.
- `ghost_image(z0,z1,generated)`; z is competitor deficit ri-L, not radial drop.

The supported outgoing radial depth and ghost deficit depth use the same supplied
positive bound, at most0.25. They are different parameterizations. Proof construction
performs zero curve/scene queries. Test scalar samples are diagnostic cross-checks;
one actual native endpoint query is charged through the existing ledger.

## Root execution status and preserved failures

Initial `/tmp/sfcc-activation-a` failed compilation only because two interval-
containing structs unnecessarily derived Debug. No global interval trait was added.
`/tmp/sfcc-activation-a-reviewed` removes those derives and adds the explicit event
separation bound and a coherent changed-center control.

Root reports reviewed activation/continuation, ghost and invalid-source/range
controls PASS. Its fourth test failed because it assumed the changed-center source
family would still be locatable. The existing correlated branch certificate already
rejects a noncoaxial competitor, so that extra assumption was false. The final copy
honestly checks rejection by the upstream source locator instead of fabricating old
IDs or weakening the branch restrictions. The final four-test execution is pending
root's saved receipts; the theorem code is identical to the three passing positives.

Executed reviewed values reported by root:

- physical rhoActivation: [10.433449951584233, 10.433449951584349];
- yActivation: [-2.7364047346689655, -2.736404734668787];
- physical/generated activation-image separation upper:1.3892984391465154e-12 mm;
- height derivative lower:0.6666666666666651;
- transversality determinant lower:0.5085907399463098;
- native endpoint z:0.0014779076874420483;
- actual t=16 point to generated ghost image upper:1.357850526007802e-12 mm,
  below the unchanged3.796655370190979e-7 mm allowance.

The competitor's exterior proof uses the ray case and its selected finite edge2;
the groove's selected finite edge is also2. These indices are executed observations,
not hardcoded event authority.

## Remaining limits

No trace cut, interval identity publication, face rewrite, ghost-tail deletion,
curve splitting, consumer reconstruction or complete component acceptance occurs
in this packet. Actual queries still need their original residual, displacement,
container, source identity, ordering and budget checks. This source theorem does
not prove exact equality in the mixed-activity epsilon halo or every floating query's
success. Identity frames/coaxial centers and the narrow operator/finite-branch class
remain explicit restrictions. Native/WASM/GPU and production agreement are open.


## Final precision qualification and native-endpoint neighbourhood

The final qualified copy leaves the runtime certificate code unchanged and
strengthens the ghost test/receipt. The universal single-physical-facet theorem
belongs to the physical rc family. The generated rhat family has its own Q=0,
while the actual physical diagonal differs by the constant w*(rc-rhat). For
arbitrarily tiny positive z, that constant cannot be ignored relative to I, whose
magnitude vanishes quadratically. No universal physical-facet or exact full-field
zero claim is made for every generated ghost point.

For the actual native t=16 query, the test builds a tiny box enclosing that exact
point and BOTH physical/generated ghost point enclosures. It independently
bounds the finite native E, competing L, groove G and cylinder C there; computes
I=ri-sqrt((ri-E)^2+(ri-L)^2); and checks I>C and physicalDiagonal>I,G strictly.
The existing finite/cap/outer restrictions and the positive native derivative
weight provide a nonzero grad(I)×grad(G), hence nonzero diagonal gradient. The
physical diagonal also dominates the cap and lies above the outer-round inactive
threshold. Thus this particular original endpoint lies in a certified smooth
physical-Q neighbourhood, without relying on the tiny coefficient discrepancy
being exactly zero. The receipt records these separate inequalities.

The coherent-other-center control now expects refusal by the already existing
coaxial source locator. It does not claim that altered source still belongs to the
supported family or manufacture historical dense IDs to force a later rejection.
All four tests in the final-qualified copy still require root execution; the
previously passing source/continuation theorem code is byte-for-byte unchanged
from A-final.
