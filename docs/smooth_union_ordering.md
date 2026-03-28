# Smooth Union Ordering

This document explains how multi-operand smooth unions are ordered and evaluated, why the old behavior produced visible artifacts, and what the new behavior changes.

## Background

The project supports smooth union modes such as:

- `round`
- `soft`
- `chamfer`
- `columns`
- `stairs`

These operators are naturally defined as binary operations. For two shapes, the implementation is straightforward: evaluate the two signed distances and apply the corresponding smooth-union formula.

The problem appears when a user writes a union with three or more operands:

```javascript
union(a, b, c, d).round(1.0)
```

Before this change, the runtime converted that into a left-associated binary tree:

```text
round(round(round(a, b), c), d)
```

That ordering preserved source argument order, but it also meant the final surface was defined by repeated pairwise blending rather than by looking at the active contributors at the current sample point.

## Why Left-Fold Ordering Was A Problem

Binary smooth unions are not associative. In other words:

```text
round(round(a, b), c) != round(a, round(b, c))
```

That matters most in regions where three or more shapes meet.

### Visible Symptoms

The old left-fold structure could produce:

- smooth unions that appeared to stop abruptly
- blend regions that looked correct between two operands but changed character when a third operand entered the area
- order-dependent results, where reordering operands changed the shape
- cases where the surface looked more like "smooth between the first two, then merged with the rest" rather than a coherent multi-shape blend

This was especially noticeable for `round` unions, but the same structural issue affected the other smooth union modes as well.

## Previous Implementation

`union(a, b, c, ...)` used to build a chain of binary `Union` nodes. The effective evaluation order was:

```text
acc0 = a
acc1 = blend(acc0, b)
acc2 = blend(acc1, c)
acc3 = blend(acc2, d)
...
```

This had a few important implications:

1. The result depended on operand order.
2. Later operands were blended against an already blended accumulator rather than against the original nearby primitives.
3. Triple-contact regions were not treated as a distinct case. They were just the result of repeated binary merges.

## New Implementation

`union(a, b, c, ...)` now preserves the full operand list in a single `Union` node instead of lowering immediately to a binary chain.

For `3+` operand smooth unions, the evaluator now:

1. Evaluates all direct child operands at the current sample point.
2. Picks the two nearest contributors by distance.
3. Applies the existing binary smooth-union operator only to that nearest pair.

Conceptually, the new behavior is:

```text
children = [a, b, c, d]
nearestA, nearestB = twoClosest(children, p)
result = blend(nearestA, nearestB)
```

For `2` operands, behavior is unchanged: the existing binary smooth-union logic is used directly.

For hard unions with no blend radius, behavior is also unchanged: we still reduce to the nearest distance as usual.

## What Improved

The new strategy removes the most problematic part of the old design:

- it no longer bakes left-fold order directly into the final smooth surface for `3+` operands
- it makes the result depend more on local geometry and less on declaration order
- it avoids repeatedly blending an already blended accumulator with a fresh primitive

In practice, this should reduce the "smooth union abruptly ends" artifact that can happen when three or more shapes participate in the same smooth union.

## What Did Not Change

This is a practical v1, not a mathematically exact N-ary smooth-union formulation for every mode.

The implementation still uses the existing binary smooth operator once it identifies the two strongest local contributors. That means:

- the result is still pairwise at each sample
- it is not a full N-way blend across all active shapes
- triple-contact and higher-order contact regions are approximated by selecting the nearest two contributors

This is intentional. It gives a much better local ordering model without requiring a completely new closed-form N-ary definition for every blend mode.

## Implications By Mode

### `round` and `soft`

These modes benefit the most from the new ordering model because the old artifacts were especially visible when several rounded shapes overlapped.

The new behavior is still not a true N-ary smooth minimum, but it is usually a better approximation than a left fold because it blends the locally dominant pair instead of the historical accumulator.

### `chamfer`, `columns`, and `stairs`

These modes do not have an obvious general-purpose N-ary extension in the current implementation.

For them, the new behavior should be read as:

- identify the two shapes that matter most at this sample
- apply the existing binary mode to that pair

This is still an approximation, but it is a more local and less order-sensitive approximation than the previous left-fold model.

## Metadata And Shading Consequences

The rendering pipeline still carries pairwise blend metadata:

- primary ID
- secondary ID
- one blend weight
- pairwise seam information

That means the system can still only fully describe two contributors at a time, even when more than two shapes are close together.

Under the new ordering model:

- those metadata fields now refer to the two nearest local contributors
- they no longer implicitly reflect the left-fold history of the union tree

This is usually a better match for what the user sees, but it is still fundamentally pairwise metadata.

## Performance Implications

There is a trade-off.

The old left-fold tree could short-circuit through the tree structure naturally because it only ever considered one new operand at a time. The new smooth-union path for `3+` operands evaluates all direct children so it can select the nearest pair.

That means:

- multi-operand smooth unions may cost more per sample
- the cost increase is localized to `3+` operand smooth unions
- `2` operand smooth unions and hard unions keep the simpler path

This trade-off was accepted because the primary goal of the change is geometric stability and less order-sensitive behavior.

## Summary

The old system encoded multi-operand smooth unions as a left-folded binary tree. That preserved argument order, but it also made the final surface heavily dependent on declaration order and caused visible artifacts when three or more shapes overlapped.

The new system keeps the full operand list and, for `3+` smooth unions, blends the two nearest contributors at each sample point. This does not create a mathematically exact N-ary smooth union, but it removes the strongest source of ordering artifacts and better matches the local geometry the user expects to see.
