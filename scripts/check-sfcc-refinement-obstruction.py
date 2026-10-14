#!/usr/bin/env python3
"""Exact witnesses for Result B of docs/research/sfcc-correctness-proofs.tex.

Run with Python 3, without -O. No exporter code or floating-point arithmetic is
used. Depths 2..199 are transcription checks; the two-state invariant and the
all-depth geometric argument are reviewed in sfcc-refinement-obstruction-review.tex.
"""

from fractions import Fraction as F
from itertools import combinations, product


def sub(a, b):
    return tuple(x - y for x, y in zip(a, b))


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def nondyadic(q):
    return bool(q.denominator & (q.denominator - 1))


def check():
    v = (F(1, 3),) * 3
    rays = ((0, 1, -61), (1, 0, -61), (-3, -2, -61))
    base = [tuple(x + F(w, 366) for x, w in zip(v, ray)) for ray in rays]
    vertices = [v, *base]
    assert all(0 < x < 1 and nondyadic(x) for p in vertices for x in p)
    assert {p[2] for p in base} == {F(1, 6)}
    volume6 = dot(cross(sub(base[0], v), sub(base[1], v)), sub(base[2], v))
    assert volume6 == F(1, 133956)

    # These finite invariants exclude grid-edge intersections at EVERY depth:
    # integer combinations of dyadic coordinates remain dyadic.
    assert all(len({w % 3 for w in ray}) == 3 for ray in rays)
    line_forms = ((1, 1), (1, -1), (1, -2))
    line_ends = ((0, 1), (0, 2), (1, 2))
    constants = (F(245, 366), F(-1, 366), F(-121, 366))
    for (a, b), ends, c in zip(line_forms, line_ends, constants):
        assert nondyadic(c)
        assert all(a * base[i][0] + b * base[i][1] == c for i in ends)

    # Coarse apex cells contain all four corners. At subsequent depths the
    # normalized apex offset alternates exactly between these two states.
    for depth in (0, 1):
        h = F(1, 2 ** depth)
        assert len({tuple(x // h for x in p) for p in vertices}) == 1
    states = (F(1, 3), F(2, 3))
    assert {2 * t % 1 for t in states} == set(states)
    assert min(min(t, 1 - t) for t in states) == F(1, 3)
    assert min(abs(t - F(1, 2)) for t in states) == F(1, 6)
    assert F(2, 61) < F(1, 6)

    # Four supporting halfspaces, used only to check the eight apex-cell
    # vertices; this is exact polyhedral geometry, not an SDF implementation.
    faces = []
    for ids in combinations(range(4), 3):
        a, b, c = (vertices[i] for i in ids)
        opposite = vertices[next(i for i in range(4) if i not in ids)]
        n = cross(sub(b, a), sub(c, a))
        faces.append((a, n, dot(n, sub(opposite, a))))

    for depth in range(2, 200):
        h = F(1, 2 ** depth)
        low = tuple((x // h) * h for x in v)
        delta = v[2] - low[2]
        assert delta / h in states
        assert low[2] >= F(1, 4) > base[0][2]
        exits = [tuple(v[k] + delta * ray[k] / 61 for k in range(3)) for ray in rays]
        quarter = tuple((v[k] - low[k]) // (h / 2) for k in (0, 1))
        for p in exits:
            assert p[2] == low[2]
            assert max(abs(p[k] - v[k]) for k in (0, 1)) <= 2 * h / 61
            assert all(low[k] + quarter[k] * h / 2 < p[k]
                       < low[k] + (quarter[k] + 1) * h / 2 for k in (0, 1))
        # A permitted coarser/same/finer neighbor cannot divide that open quarter.
        for neighbor_depth in (depth - 1, depth, depth + 1):
            side = F(1, 2 ** neighbor_depth)
            if (low[2] / side).denominator != 1:
                continue  # This level has no horizontal face at the exit height.
            assert len({tuple(p[k] // side for k in (0, 1)) for p in exits}) == 1
            assert all((p[k] / side).denominator != 1 for p in exits for k in (0, 1))
        for bits in product((0, 1), repeat=3):
            p = tuple(low[k] + bits[k] * h for k in range(3))
            assert any(dot(n, sub(p, a)) * sign < 0 for a, n, sign in faces)
    assert set.intersection(*({v, b} for b in base)) == {v}
    print(f"VERIFIED tetrahedron: six-times-volume={volume6}; generic at all dyadic depths.")
    print("VERIFIED 198 depth checks (2..199): one open quarter, permitted neighbors, exterior corners.")

    # An explicit rational convex 25-gon makes the valence premise nonvacuous.
    # Parabola points, closed by their top chord, are strictly convex in order.
    indices = list(range(-12, 13))
    scale = 6 * 997 * 16
    rays25 = [(3 * i, 3 * i * i + 1, -997) for i in indices]
    polygon = [tuple(x + F(w, scale) for x, w in zip(v, ray)) for ray in rays25]
    assert all(0 < x < 1 and nondyadic(x) for p in polygon for x in p)
    assert {p[2] for p in polygon} == {F(31, 96)}
    assert all(len({w % 3 for w in ray}) == 3 for ray in rays25)
    for k, a in enumerate(polygon):
        j = (k + 1) % len(polygon)
        b = polygon[j]
        assert all(cross(sub(b, a), sub(p, a))[2] > 0
                   for n, p in enumerate(polygon) if n not in (k, j))
        slope = indices[k] + indices[j]
        c = a[1] - slope * a[0]
        assert c == b[1] - slope * b[0] and nondyadic(c)
    assert len(polygon) == 25 > 6 * 4
    print("VERIFIED valence witness: convex rational 25-gon pyramid; 25 rays > 24 face neighbors.")
    print("Scope: obstruction arithmetic, not an exporter success or an exhaustive runtime test.")


if __name__ == "__main__":
    if not __debug__:
        raise SystemExit("Run without -O: this verifier requires assertions.")
    check()
