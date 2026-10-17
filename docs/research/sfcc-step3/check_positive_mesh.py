#!/usr/bin/env python3
"""Exact, fixture-specific global coverage checks, not local SFCC certificates.

This explores a constructive alternative after rejecting the primitive-chart
inference. It proves more than sampled component counts, but deliberately does
not assert preservation of the octree's face traces under the sphere map.
"""
import argparse
from collections import defaultdict
from fractions import Fraction as Q
import json
from pathlib import Path


def sub(a,b): return tuple(x-y for x,y in zip(a,b))
def cross(a,b): return (a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0])
def dot(a,b): return sum(x*y for x,y in zip(a,b))
def edge_chain(tris):
    chain=defaultdict(int)
    for tri in tris:
        for a,b in zip(tri,tri[1:]+tri[:1]):
            assert a!=b
            key=(min(a,b),max(a,b))
            chain[key]+=1 if a<b else -1
    return {key:n for key,n in chain.items() if n}


def sphere(tris):
    assert not edge_chain(tris), "closed oriented 2-chain required"
    assert all(dot(a,cross(b,c))>0 for a,b,c in tris), "radial Jacobian must be strictly positive"
    # Exact +x ray. Non-boundary barycentric containment discharges genericity.
    count=0
    def det(a,b,c):return (b[1]-a[1])*(c[2]-a[2])-(b[2]-a[2])*(c[1]-a[1])
    zero=(Q(0),Q(0),Q(0))
    for a,b,c in tris:
        area=det(a,b,c)
        if not area:continue
        w=(det(zero,b,c)/area,det(a,zero,c)/area,det(a,b,zero)/area)
        if all(x>=0 for x in w):
            x=sum(v*p[0] for v,p in zip(w,(a,b,c)))
            if x>0:
                assert all(v>0 for v in w),"+x ray lies on a mesh edge"
                count+=1
    assert count==1
    # A global radial certificate does not preserve an actual planar face trace.
    p,q=(Q(3),Q(6),Q(6)),(Q(3),Q(-6),Q(6))
    middle=tuple((a+b)/2 for a,b in zip(p,q))
    assert dot(p,p)==dot(q,q)==81 and dot(middle,middle)==45
    assert 81*middle[0]**2/dot(middle,middle)>9
    return {"triangles":len(tris),"positiveRadialJacobians":len(tris),"genericRayDegree":count,
        "claim":"radial projection covers every direction once away from projected mesh edges",
        "facePreservationCounterexample":{"faceX":3,"endpoints":[[3,6,6],[3,-6,6]],
            "chordMidpoint":[3,0,6],"projectedMidpointXSquared":"81/5","faceXSquared":9},
        "notClaimed":"the radial projection preserves the octree face traces or local cell responsibility"}


def rectangle(tris):
    bounds=((-Q(1),Q(1,2)),(-Q(1),Q(1)),(-Q(1),Q(1)))
    assert not edge_chain(tris)
    faces=defaultdict(list)
    for tri in tris:
        assert all(bounds[a][0]<=p[a]<=bounds[a][1] for p in tri for a in range(3))
        owners=[(a,side) for a in range(3) for side in range(2)
                if all(p[a]==bounds[a][side] for p in tri)]
        assert len(owners)==1
        axis,side=owners[0]
        normal=cross(sub(tri[1],tri[0]),sub(tri[2],tri[0]))
        assert normal[axis]*(2*side-1)>0
        faces[axis,side].append(tri)
    assert len(faces)==6
    for (axis,side),face in faces.items():
        boundary=edge_chain(face)
        sides=defaultdict(list)
        others=[a for a in range(3) if a!=axis]
        for (p,q),n in boundary.items():
            assert abs(n)==1
            matches=[(a,s) for a in others for s in range(2) if p[a]==q[a]==bounds[a][s]]
            assert len(matches)==1
            a,s=matches[0]
            t=next(j for j in others if j!=a)
            sides[a,s].append((min(p[t],q[t]),max(p[t],q[t])))
        assert len(sides)==4
        for (a,s),segments in sides.items():
            t=next(j for j in others if j!=a)
            segments.sort()
            assert segments[0][0]==bounds[t][0] and segments[-1][1]==bounds[t][1]
            assert all(left[1]==right[0] for left,right in zip(segments,segments[1:]))
    return {"triangles":len(tris),"completeOrientedPlanarFaces":6,"completeRectangularEdges":12,
        "cutFaceOwner":"second box","exposedCrossOperandCreases":4,
        "claim":"positive planar triangle chains fill all six exact rectangles once",
        "notClaimed":"per-cell nominal-domain certificates or analytical feature-parameter correspondence"}


if __name__=="__main__":
    p=argparse.ArgumentParser()
    p.add_argument("kind",choices=["sphere","rectangle"])
    p.add_argument("mesh")
    p.add_argument("--output")
    args=p.parse_args()
    data=json.loads(Path(args.mesh).read_text())
    if args.kind=="sphere":
        assert data["scene"]=={"kind":"sphere","pos":[0,0,0],"r":9}
    else:
        assert data["scene"]=={"kind":"intersect","lh":{"kind":"box","pos":[0,0,0],"half":[1,1,1]},
            "rh":{"kind":"box","pos":[-1.75,0,0],"half":[2.25,4,4]}}
    tris=[[tuple(Q.from_float(float(x)) for x in point) for point in tri] for tri in data["assembledTriangles"]]
    result=(sphere if args.kind=="sphere" else rectangle)(tris)
    output=json.dumps(result,indent=2)+"\n"
    if args.output:Path(args.output).write_text(output)
    print(output,end="")
