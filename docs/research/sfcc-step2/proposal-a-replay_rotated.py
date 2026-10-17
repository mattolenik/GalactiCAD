"""Exact rational replay of captured Rz sphere query regions, not a scene evaluator.

Usage: python3 replay_rotated.py /tmp/sfcc-a-rotated-regions/rotated-*.json
Rz's represented coefficients give norm²=(c²+s²)(x²+y²)+z² exactly.
The independent range extrema separate strict exclusion from zero possibility.
"""
import collections
import json
import sys
from fractions import Fraction

for filename in sys.argv[1:]:
    data = json.load(open(filename))
    k = Fraction(data["c"]) ** 2 + Fraction(data["s"]) ** 2
    counts = collections.Counter()
    rows = []
    for cell in data["cells"]:
        center, half = cell["region"]
        lower = Fraction(0)
        upper = Fraction(0)
        for axis in range(3):
            lo = Fraction(center[axis]) - Fraction(half[axis])
            hi = Fraction(center[axis]) + Fraction(half[axis])
            near = Fraction(0) if lo <= 0 <= hi else min(abs(lo), abs(hi))
            far = max(abs(lo), abs(hi))
            weight = k if axis < 2 else Fraction(1)
            lower += weight * near ** 2
            upper += weight * far ** 2
        classification = "strictly_outside" if lower > 1 else "strictly_inside" if upper < 1 else "zero_possible"
        counts[cell["reason"], classification] += 1
        rows.append({"cell": cell["cell"], "reason": cell["reason"], "class": classification,
                     "lower_squared_minus_one": str(lower-1), "upper_squared_minus_one": str(upper-1)})
    print(json.dumps({"source": filename, "counts": [dict(reason=a, classification=b, count=n)
          for (a,b),n in sorted(counts.items())], "cells": rows}))
