#!/usr/bin/env python3
"""Independent exact final-f32 facet oracle for the frozen three-sheet fixture.
No scene evaluator or meshing implementation is imported. This proves geometric
coverage of the two specified cuboid boundaries; index/worker checks are separate.
"""
from fractions import Fraction as Q
from pathlib import Path
from itertools import combinations
import argparse,json,struct
BOXES=(((-4,Q(1,4)),(-4,4),(-4,4)),((Q(1,2),Q(3,4)),(-4,4),(-4,4)))
def sub(a,b): return tuple(x-y for x,y in zip(a,b))
def cross(a,b): return (a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0])
def dot(a,b): return sum(x*y for x,y in zip(a,b))
def area2(a,b,c): return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])
def interior_overlap(a,b):
    for axis in range(2):
        if min(max(p[axis] for p in a),max(p[axis] for p in b))<=max(min(p[axis] for p in a),min(p[axis] for p in b)): return False
    for tri in (a,b):
        for p,q in zip(tri,tri[1:]+tri[:1]):
            n=(q[1]-p[1],p[0]-q[0])
            left=[dot(n,v) for v in a];right=[dot(n,v) for v in b]
            if min(max(left),max(right))<=max(min(left),min(right)): return False
    return True

def verify(triangles):
    groups={};volume=Q(0);count=0
    for tri in triangles:
        tri=tuple(tuple(Q(x) for x in p) for p in tri)
        assert len(tri)==3 and all(len(p)==3 for p in tri)
        normal=cross(sub(tri[1],tri[0]),sub(tri[2],tri[0]));assert normal!=(0,0,0),'degenerate triangle'
        owners=[i for i,b in enumerate(BOXES) if all(all(b[a][0]<=p[a]<=b[a][1] for a in range(3)) for p in tri)]
        assert len(owners)==1,'triangle bridges components or leaves target cuboids'
        owner=owners[0];b=BOXES[owner]
        faces=[(a,s) for a in range(3) for s in range(2) if all(p[a]==b[a][s] for p in tri)]
        assert len(faces)==1,'triangle does not lie on one target face'
        a,s=faces[0];assert normal[a]*(2*s-1)>0,'wrong outward orientation'
        uv=((a+1)%3,(a+2)%3)
        flat=tuple((p[uv[0]],p[uv[1]]) for p in tri)
        groups.setdefault((owner,a,s),[]).append(flat)
        volume+=dot(tri[0],cross(tri[1],tri[2]))/6;count+=1
    assert len(groups)==12,'missing cuboid face'
    total=Q(0);pairs=0
    for (owner,a,s),tris in groups.items():
        b=BOXES[owner];uv=((a+1)%3,(a+2)%3)
        expected=(b[uv[0]][1]-b[uv[0]][0])*(b[uv[1]][1]-b[uv[1]][0])
        actual=sum(abs(area2(*tri))/2 for tri in tris)
        assert actual==expected,('facet area mismatch',(owner,a,s),actual,expected)
        for x,y in combinations(tris,2):
            assert not interior_overlap(x,y),'overlapping triangle interiors'
            pairs+=1
        total+=actual
    assert total==400 and volume==288,(total,volume)
    return {'triangles':count,'completeOrientedRectangles':12,'surfaceArea':str(total),'orientedVolume':str(volume),'disjointTargetComponents':2,'trianglePairChecks':pairs,'scope':'exact geometric coverage of frozen target; indexed topology verified separately'}

def model():
    out=[]
    for b in BOXES:
        for a in range(3):
            u,v=(a+1)%3,(a+2)%3
            for s in range(2):
                points=[]
                for su,sv in [(0,0),(1,0),(1,1),(0,1)]:
                    p=[0,0,0];p[a]=b[a][s];p[u]=b[u][su];p[v]=b[v][sv];points.append(tuple(p))
                if s==0:points.reverse()
                out.extend([(points[0],points[1],points[2]),(points[0],points[2],points[3])])
    return out

def self_test():
    good=model();result=verify(good)
    negatives=[good[:-1], [good[0],good[0]]+good[2:], [(good[0][0],good[0][2],good[0][1])]+good[1:]]
    for bad in negatives:
        try:verify(bad)
        except AssertionError:pass
        else:raise AssertionError('negative oracle control was accepted')
    result['negativeControlsRejected']=len(negatives)
    return result

def f32(x):return Q.from_float(struct.unpack('f',struct.pack('f',float(x)))[0])
def load_mesh(path):
    d=json.loads(Path(path).read_text())
    if 'assembledTriangles' in d:triangles=d['assembledTriangles']
    else:
        verts=d['verts'];indices=d['tris'];assert len(verts)%8==0 and len(indices)%3==0
        triangles=[[verts[indices[i+j]*8:indices[i+j]*8+3] for j in range(3)] for i in range(0,len(indices),3)]
    return [tuple(tuple(f32(x) for x in point) for point in triangle) for triangle in triangles]

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('mesh',nargs='?');args=parser.parse_args()
    print(json.dumps(verify(load_mesh(args.mesh)) if args.mesh else self_test(),indent=2))
