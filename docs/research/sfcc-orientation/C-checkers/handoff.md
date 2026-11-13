# C: independent rotation-system and triangulation audit

Parent source: `/tmp/sfcc-orientation-base` (179 restored inputs, HEAD `4bd4ab7`).
Working directory: `/tmp/sfcc-orientation-c`.

This packet changes no kernel source. It adds two independent Python checkers:
`audit.py` and `rotation.py`. The agent inspected source and saved receipts, wrote
these checkers and statically parsed their syntax. Root alone executed them under
the declared 60-second watchdogs; no field/curve queries, runtime changes, build,
component reconstruction or visual QA were performed by this agent.

## Executed evidence

Root reports both scripts pass:

- `audit.py`, 0.096 seconds: saved round29 full geometry and first-failure receipt.
  Output `round30-orientation/orientation-C.json`.
- `rotation.py`, 0.046 seconds: A's new successful first-cell graph/patch capture.
  Output `round30-orientation/orientation-C-rotation.json`.

Each output records its exact input-receipt SHA256. Root retains execution records
and should hash/archive the scripts themselves. The checkers use standard Python
only; the coordinate checker uses exact rational arithmetic on captured binary64
coordinates. Neither script evaluates an SDF or changes a mesh.

## The failure is not merely one backwards triangle

The first cell has 19 used vertices, 30 triangles and 41 undirected edges, with
10 boundary edges. It contains **seven duplicated face groups** and **eight edges
with more than two incident triangles**. Those same seven duplicate groups and
eight nonmanifold edges account for all such defects found in the captured
1,700-triangle component. This is an edge-incidence census, not a full vertex-link,
contact, patch-coverage or retained-outside proof.

Triangles 10 through 29 form a contiguous center fan around point636. Reconstructing
its directed boundary from the emitted fan triangles gives the same 20-entry walk
later recorded by A's actual patch capture:

```
453,455,633,632,628,629,630,631,454,456,
628,632,633,455,454,631,630,629,628,461
```

Eight boundary vertices repeat, and seven undirected feature edges occur once in
each direction. For any such boundary edge a→b and b→a, a common apex c emits both
(c,a,b) and (c,b,a). This algebraically guarantees opposite duplicate triangles,
independent of carrier or gradient interpretation. Triangle11 [636,455,633] and
triangle22 [636,633,455] are one exact pair; the other pairs are12/21,13/20,14/27,
15/26,16/25 and17/24.

The fan's summed area vector agrees with the stored reference, while seven individual
triangles oppose it. Consequently a whole-fan orientation reversal cannot repair it.
The inferred projected boundary is not simple. Although the projected apex is inside
its winding region, a simple-polygon visibility-kernel argument is not applicable.
Nonadjacent projected contacts include the repeated edges; the first checker does
not separately classify proper crossings versus all possible touching/overlap cases.

A counterfactual that flips only triangle11 adds a same-direction two-use edge
455/633 and removes no such inconsistency. Its radial edges already have more than
two uses, so the ordinary two-use orientation test cannot hide their nonmanifold
status. The opposite duplicate pair becomes same-oriented duplication, not a disk.
No triangle flip is selected as a repair.

## The rotation system contradicts the required disk embedding

A's exact successful-graph capture has16 vertices and20 undirected edges. Its
half-edge successor is the implementation's previous-neighbour rotation rule.
The checker enumerates every directed-edge orbit exactly and verifies they partition
all half-edges. The graph is connected.

At center628 the recorded cyclic neighbours are:

```
629,632,456,39,461
```

Following the degree-two radial paths gives boundary ports:

| Centre neighbour | Boundary port | Represented path |
| --- | --- | --- |
| 629 | 454 | 628→629→630→631→454 (curve46) |
| 632 | 455 | 628→632→633→455 (curve66) |
| 456 | 456 | 628→456 |
| 39 | 39 | 628→39 |
| 461 | 461 | 628→461 |

The outer boundary cycle is37→40→460→461→453→455→454→456→38→39→37.
Thus the radial port order on that boundary is cyclically461,455,454,456,39.
The center rotation instead orders454 and455 oppositely. Those are the two
native/chamfer source representations identified by the source investigation.

The actual rotation system has four face orbits including the exterior:

```
V-E+F = 16-20+4 = 0.
```

As a connected orientable combinatorial rotation surface this has genus one.
This is **not** a claim that the actual CAD surface has a handle. It demonstrates
that the supplied local rotation system does not embed this disk star in genus zero.
The repeated same-face edges are not necessarily bridges of the abstract graph:
each radial path already connects the center to the outer boundary. Their two-sided
appearance in one face is a consequence of the inconsistent rotation system.

Changing only center628's rotation to the boundary-consistent cyclic order
461,632,629,456,39 yields six face orbits and Euler characteristic two, as expected
for the abstract disk star with five distinct represented radial paths. This is an
exact topology-only discriminator, **not** an authorized geometric repair. It still
retains a fifth represented ray, whereas the established source arrangement has
four physical rays. It can create an artificial strip between equivalent source
representations. Source equivalence, numerical face-port association and ordered
transport of the complete relevant intervals must decide the physical quotient.

## Relevant implementation assumptions

`mesh_feature_graph` sorts neighbours around each vertex by angles in a plane
formed from that vertex's stored normal. These independently selected cyclic orders
are not checked to form a globally compatible disk embedding. Its existing edge
check requires every internal feature edge to be used twice, but counts both uses
in the same patch as sufficient. The captured bad patch satisfies that check.

The selected bad patch is stratum38 and has the repeated walk above. It proceeds
through `fan_from_stratum_vertex`, which projects the average boundary point and
fans every boundary occurrence. `repair_planar_fan` immediately returns success
for a carrier without `certificate_plane`. In the one-loop feature-graph case,
the later sample/contact validation is also skipped (those checks are conditioned
on `loops.len()>1`). The bad patch therefore returned success with no retained
unresolved flag despite opposite duplicate faces and nonmanifold radial edges.

These facts disprove treating aggregate normal agreement, twice-counted feature
edges, or a projected average as proof of an embedded surface patch. They do not
by themselves determine which physical source branch should replace the invalid
representation.

## Controls and recommended next discriminator

The geometry checker includes a simple concave polygon with an apex inside the
polygon but outside its visibility kernel. Its fan has a locally negative triangle
while maintaining opposite interior edge use; reversing that single triangle
breaks two interior edge orientations. This distinguishes a geometric fan fold
from a combinatorial winding reversal. The rotation checker includes a coherent
four-ray disk star (Euler two) and an adjacent center-ray swap (Euler zero).

A safe earlier guard should reject an unsupported repeated-vertex/non-simple patch
walk before fanning it, retaining an explicit unresolved/refusal result. This can
prevent invalid output but is not a completed meshing repair; supported annular or
slit domains would require their own constrained representation rather than a
blanket assumption that every weakly simple walk is physically invalid.

For this witness, B's source proof is the relevant next step: establish whether
ports454/455 are consumed approximations to the same unique physical face root,
then prove ordered equivalence across the full in-cell46/66 spans. A physical-arc
quotient must update shared face consumers, canonical point IDs, all required source
memberships and retained numerical parameters coherently. Mere proximity, deleting
one curve ID, or swapping two neighbours does not supply that authority. The existing
20/39 quotient does not automatically authorize a46/66 quotient.

No runtime repair, general source-patch ownership, current production acceptance,
full contact audit or native/WASM/GPU equivalence is established by C.
