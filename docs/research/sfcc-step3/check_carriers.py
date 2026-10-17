#!/usr/bin/env python3
"""Exact certificate counterexamples, using each target's captured input bits.

No production scene evaluator is implemented here. The three-sheet fixture
reduces by hand to three affine forms on [0,1]^3; the sphere check uses only
the exact quadratic equation implied by captured primitive coefficients.
"""
import json
import struct
import sys
from fractions import Fraction as Q


def binary64(bits):
    value = struct.unpack(">d", bytes.fromhex(bits))[0]
    return Q.from_float(value)


for path in sys.argv[1:]:
    records = json.load(open(path, encoding="utf8"))
    assert len(records) == 2
    for record in records:
        values = list(map(binary64, record["inputs"]))
        assert len(values) == 21
        matrix = values[:9]
        assert values[9:] == [1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0]
        norm2 = sum(matrix[3 * row] ** 2 for row in range(3))
        defect = norm2 - 1
        assert defect != 0, "an ideal sphere carrier is not this represented field"
        # These fixtures are planar rotations with a shared c/s pair; the
        # represented sphere is k(x²+y²)+z²=1, k != 1, as an exact real set.
        assert matrix[0] == matrix[4] and matrix[1] == -matrix[3]
        assert matrix[2] == matrix[5] == matrix[6] == matrix[7] == 0
        assert matrix[8] == 1
        print(json.dumps({"target_records": path, "f32": record["f32"],
                          "exact_gram_defect": str(defect),
                          "unit_x_is_carrier_zero_but_not_field_zero": True}))

# Exact local analytic arrangement and all its change points.
a, b, c = Q(1, 4), Q(1, 2), Q(3, 4)
switches = [Q(0), Q(3, 8), Q(5, 8), Q(1)]
forms = [(1, -a), (-1, b), (1, -c)]
roots = []
for index, (slope, offset) in enumerate(forms):
    left, right = switches[index:index + 2]
    root = -offset / slope
    assert left < root < right
    roots.append(root)
    for x in [left, (left + right) / 2, right]:
        actual = min(x - a, max(b - x, x - c))
        assert actual == slope * x + offset
assert roots == [a, b, c]
# Distinct planes, each a disk in the cell. Each lateral face has three
# disjoint arcs. A two-triangle disk at x=1/2 cannot represent all three.
assert len(set(roots)) == 3
assert min(-a, max(b, -c)) < 0 < min(1-a, max(b-1, 1-c))

# Identity transform also does not rescue rounded carrier coefficients.
tiny = Q(1, 2**54)
assert Q.from_float(float(1 + tiny)) == 1
assert 1 + tiny != 1
assert Q.from_float(float(1 - tiny)) == 1
print(json.dumps({"three_sheet_roots": list(map(str, roots)),
                  "lateral_face_arcs": 3, "interior_disk_components": 3,
                  "rounded_box_positive_carrier": "x=1",
                  "declared_box_positive_sheet": str(1+tiny)}))
