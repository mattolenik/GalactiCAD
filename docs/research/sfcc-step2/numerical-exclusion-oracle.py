#!/usr/bin/env python3
"""Exact binary64-rational/algebraic witness comparisons; no decimal precision.
Run on SFCC_BOUND_RECORDS emitted by numerical_exclusion.rs. This validates
finite boundary/center witnesses, supplementing (not replacing) the region proof.
"""
from fractions import Fraction as F
import itertools, json, sys

def q(x): return F.from_float(float(x))
def sqrt_bounds(sum_sq, offset, lo, hi):
    # lo <= sqrt(sum_sq)+offset <= hi, by rational squares and signs.
    l,u = lo-offset,hi-offset
    return (l <= 0 or l*l <= sum_sq) and u >= 0 and u*u >= sum_sq

count=0
for line in open(sys.argv[1]):
    d=json.loads(line)
    r,t,pos,c,h = ([q(x) for x in d[k]] for k in ('matrix','t','pos','c','half'))
    scale,lo,hi=q(d['scale']),q(d['lo']),q(d['hi'])
    if d['sign'] < 0: lo,hi=-hi,-lo
    for signs in [*itertools.product((-1,1),repeat=3),(0,0,0)]:
        p=[c[i]+signs[i]*h[i] for i in range(3)]
        a=[sum(r[b*3+i]*(p[b]-t[b]) for b in range(3))-scale*pos[i] for i in range(3)]
        if d['kind']==0:
            valid=sqrt_bounds(sum(x*x for x in a),-scale,lo,hi)
        else:
            margins=[abs(x)-scale for x in a]
            valid=sqrt_bounds(sum(max(x,0)**2 for x in margins),min(max(margins),0),lo,hi)
        assert valid,(d,signs)
        count+=1
# The near-rotation stress case has a rational zero inside the represented box.
a=1+F(1,2**22)
c=q(1/float(a)); h=F(1,2**53)
assert c-h < 1/a < c+h
print(f'{count} exact algebraic endpoint/center checks passed; rational transformed root containment passed')
