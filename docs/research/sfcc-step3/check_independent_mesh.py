#!/usr/bin/env python3
"""Prove the bounded Step 3 C obstruction from actual exported f32 bits.

This is an independent fixture oracle, not a general scene evaluator. Successful
exit confirms the counterexample; it does not mean the Step 3 acceptance gate passed.
"""
from fractions import Fraction as Q
import json
from pathlib import Path
import struct
import sys
from collections import defaultdict


def read_mesh(path):
    data = json.loads(path.read_text())
    values = [Q(struct.unpack('<f', struct.pack('<I', b))[0]) for b in data['vertexBits']]
    vertices = [values[i:i+3] for i in range(0, len(values), 8)]
    return data, [tuple(vertices[i] for i in data['triangles'][j:j+3])
                  for j in range(0, len(data['triangles']), 3)]


def cross(a, b):
    return a[0]*b[1] - a[1]*b[0]


def sub(a, b):
    return [x-y for x, y in zip(a, b)]


def ray_crossings(triangles, y=Q(-7, 4), z=Q(5, 2)):
    result = set()
    for a, b, c in triangles:
        u, v, w = sub(b[1:], a[1:]), sub(c[1:], a[1:]), sub([y, z], a[1:])
        det = cross(u, v)
        if det == 0:
            continue
        beta, gamma = cross(w, v)/det, cross(u, w)/det
        if beta >= 0 and gamma >= 0 and beta+gamma <= 1:
            result.add(a[0] + beta*(b[0]-a[0]) + gamma*(c[0]-a[0]))
    return sorted(result)


def fixture_field(x):
    # Exact identity in [0,1] x [-3,3]^2, derived from the three signed boxes.
    return min(x-Q(1,4), max(Q(1,2)-x, x-Q(3,4)))


def det3(a,b,c):
    return a[0]*(b[1]*c[2]-b[2]*c[1])-a[1]*(b[0]*c[2]-b[2]*c[0])+a[2]*(b[0]*c[1]-b[1]*c[0])


def verify_sphere(path):
    data,triangles=read_mesh(path)
    assert data['scene']=={'kind':'sphere','pos':[0,0,0],'r':9}
    assert all(det3(a,b,c)>0 for a,b,c in triangles)
    # Prove closed oriented manifold structure, including single-cycle links.
    edges, fans=defaultdict(list),defaultdict(dict)
    tris=data['triangles']
    for j in range(0,len(tris),3):
        t=tris[j:j+3]
        assert len(set(t))==3
        for k in range(3):
            a,b,c=t[k],t[(k+1)%3],t[(k+2)%3]
            edges[min(a,b),max(a,b)].append(1 if a<b else -1)
            assert b not in fans[a]
            fans[a][b]=c
    assert all(sorted(use)==[-1,1] for use in edges.values())
    for fan in fans.values():
        start=next(iter(fan)); point=start; seen=set()
        while point not in seen:
            seen.add(point); point=fan[point]
        assert point==start and len(seen)==len(fan)
    seen=set(); todo=[next(iter(fans))]
    while todo:
        v=todo.pop()
        if v not in seen:
            seen.add(v);todo.extend(fans[v])
    assert len(seen)==len(fans)
    # A generic ray avoids every edge plane. Every cone is positively oriented,
    # so its count cannot change across a shared edge: one triangle leaves and
    # its oppositely directed neighbor enters. Closed vertex links extend this
    # to the finite exceptional vertex directions (see proof accompanying it).
    generic=None
    for d in [[1,37,101],[17,43,89],[29,71,113],[53,127,211]]:
        signs=[[det3(a,b,d),det3(b,c,d),det3(c,a,d)] for a,b,c in triangles]
        if any(0 in s for s in signs):
            continue
        count=sum(all(v>0 for v in s) for s in signs)
        assert count==1,(path,d,count)
        generic=d;break
    assert generic is not None
    return {'artifact':path.name,'radialDegree':1,'genericDirection':generic,
            'triangles':len(triangles),'closedOrientedManifoldWithSingleCycleLinks':True,
            'allExactTriangleConeDeterminantsPositive':True}


def verify_obstruction(path):
    data, triangles = read_mesh(path)
    # Input JSON dyadics are exactly parsed/baked on both measured targets.
    scene = data['scene']
    assert scene['children'][0]['pos'] == [-1.875, 0, 0]
    assert scene['children'][0]['half'] == [2.125, 4, 4]
    assert scene['children'][1]['lh']['pos'] == [2.25, 0, 0]
    assert scene['children'][1]['lh']['half'] == [1.75, 4, 4]
    assert scene['children'][1]['rh']['pos'] == [-1.625, 0, 0]
    assert scene['children'][1]['rh']['half'] == [2.375, 4, 4]
    # Exposed solid intervals on every ray with |y|,|z|<4 are [-4,1/4] and
    # [1/2,3/4]. They imply four boundary crossings, without export samples.
    expected = [Q(-4), Q(1,4), Q(1,2), Q(3,4)]
    actual = ray_crossings(triangles)
    assert actual == [Q(-4), Q(3,4)], (path, actual)
    witness_cells = data['cells']
    assert len(witness_cells) == 9
    assert all(not c['degenerate'] for c in witness_cells)
    for c in witness_cells:
        assert c.get('featureCurve', c.get('curve')) == -1
        assert c.get('featureCorner', c.get('corner')) == -1
        if 'decisions' in c:
            assert c['decisions'] == [{'reason':'smooth_pass', 'round':0, 'split':False}]
            assert c['reportedUnresolved'] is False
            assert all(m['fallback'] is False for m in c['meshes'])
            if c['faceTrace'] is not None:
                assert c['faceTrace']['expectedArcCount']==3
                assert c['faceTrace']['actualArcCount']==1
                assert c['faceTrace']['pins']==0
        if 'directSplit' in c:
            assert c['directSplit'] is False
    spurious = []
    for index, tri in enumerate(triangles):
        if all(abs(p[1]) < 3 and abs(p[2]) < 3 for p in tri) and {p[0] for p in tri} == {Q(1,4),Q(3,4)}:
            center = [sum(p[a] for p in tri)/3 for a in range(3)]
            residual = fixture_field(center[0])
            assert abs(residual) == Q(1,12)
            spurious.append({'triangle':index, 'centroid':[str(x) for x in center], 'field':str(residual)})
    assert spurious
    return {'artifact':path.name, 'expectedRayCrossings':[str(x) for x in expected],
            'actualRayCrossings':[str(x) for x in actual], 'acceptedResponsibleCells':len(witness_cells),
            'spuriousTriangleCount':len(spurious), 'oneSpuriousInteriorWitness':spurious[0]}


def verify_clipped_box(path):
    _, triangles = read_mesh(path)
    lo, hi = [Q(-1)]*3, [Q(1,2),Q(1),Q(1)]
    areas = {(a,s):Q(0) for a in range(3) for s in range(2)}
    groups = {(a,s):[] for a in range(3) for s in range(2)}
    for tri in triangles:
        assert all(lo[a] <= p[a] <= hi[a] for p in tri for a in range(3))
        faces = [(a,s) for a in range(3) for s in range(2)
                 if all(p[a] == [lo,hi][s][a] for p in tri)]
        assert len(faces) == 1
        a,s = faces[0]
        axes = [(a+1)%3, (a+2)%3]
        projected = [[p[k] for k in axes] for p in tri]
        twice = cross(sub(projected[1],projected[0]), sub(projected[2],projected[0]))
        assert twice != 0
        assert (twice > 0) == (s == 1)
        areas[a,s] += abs(twice)/2
        if twice < 0:
            projected.reverse()
        groups[a,s].append(projected)
    for (a,s),area in areas.items():
        expected = (hi[(a+1)%3]-lo[(a+1)%3])*(hi[(a+2)%3]-lo[(a+2)%3])
        assert area == expected
    pair_checks = 0
    for group in groups.values():
        bounds = [([min(p[a] for p in tri) for a in range(2)],
                   [max(p[a] for p in tri) for a in range(2)]) for tri in group]
        for i,left in enumerate(group):
            for j in range(i+1,len(group)):
                if any(bounds[i][1][a] <= bounds[j][0][a] or bounds[j][1][a] <= bounds[i][0][a] for a in range(2)):
                    continue
                pair_checks += 1
                right = group[j]
                # Exact separating-axis test for nondegenerate convex triangles.
                separated = any(all(cross(sub(poly[(k+1)%3], poly[k]),sub(p,poly[k])) <= 0 for p in other)
                                for poly,other in [(left,right),(right,left)] for k in range(3))
                assert separated, ('positive-area triangle overlap',path,i,j)
    # Finite unions of closed triangles are closed. No interior overlaps plus
    # exact total rectangle area leaves no relative open gap; closure then also
    # covers the rectangle boundary. This proves this specific output boundary,
    # not an a-priori certificate for future cells or a curved-field theorem.
    return {'artifact':path.name,'triangles':len(triangles),'exactBoundaryCoverage':True,
            'exactNonoverlapPairChecks':pair_checks,
            'faceAreas':{f'{a}:{s}':str(v) for (a,s),v in areas.items()}}


def main():
    if len(sys.argv)==3 and sys.argv[1]=='--witness':
        print(json.dumps(verify_obstruction(Path(sys.argv[2])),sort_keys=True))
        return
    directory = Path(sys.argv[1] if len(sys.argv)>1 else '/tmp/sfcc-next-c-evidence')
    # The local formula changes sign at precisely three separated simple roots.
    roots = [Q(1,4),Q(1,2),Q(3,4)]
    assert all(fixture_field(x) == 0 for x in roots)
    assert [fixture_field(x)>0 for x in [Q(0),Q(3,8),Q(5,8),Q(1)]] == [False,True,False,True]
    rows = [verify_obstruction(directory / name) for name in ['three-sheet-256.json','wasm-three-sheet-256.json']]
    rows += [verify_clipped_box(directory / name) for name in ['clipped-box.json','wasm-clipped-box.json']]
    rows += [verify_sphere(directory / name) for name in ['sphere.json','wasm-sphere.json']]
    for row in rows:
        print(json.dumps(row,sort_keys=True))


if __name__ == '__main__':
    main()
