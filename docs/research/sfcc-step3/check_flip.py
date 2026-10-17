#!/usr/bin/env python3
"""Independent exact f64/f32 common-refinement witness, supplied by coordinator."""
import json, struct
from fractions import Fraction as Q
from pathlib import Path
p=Path(__file__).parent / 'default-box-flip-witness.json'
d=json.loads(p.read_text())
raw=[[struct.unpack('>d',bytes.fromhex(v))[0] for v in row] for row in d['pointBits']]
def orient(p,q,r):
 return (q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0])
rows=[]
for precision in ['f64','f32']:
 points=[[Q(v if precision=='f64' else struct.unpack('f',struct.pack('f',v))[0]) for v in row] for row in raw]
 assert all(v[0]==-3 for v in points)
 uv=[v[1:] for v in points]
 old=[orient(*(uv[i] for i in t)) for t in d['old']]
 new=[orient(*(uv[i] for i in t)) for t in d['new']]
 assert all(x<0 for x in old+new)
 assert sum(old)==sum(new)
 a,b,c,e=uv
 u=[b[k]-a[k] for k in range(2)]
 v=[e[k]-c[k] for k in range(2)]
 w=[c[k]-a[k] for k in range(2)]
 cross=lambda x,y:x[0]*y[1]-x[1]*y[0]
 det=cross(u,v)
 s=cross(w,v)/det
 t=cross(w,u)/det
 assert 0<s<1 and 0<t<1
 assert [a[k]+s*u[k] for k in range(2)]==[c[k]+t*v[k] for k in range(2)]
 rows.append({'precision':precision,'oldAndNewOrientation':'negative','sameExactOrientedArea':True,'oldDiagonalIntersectionParameter':str(s),'newDiagonalIntersectionParameter':str(t)})
result={'cells':d['cells'],'canonicalFace':d['face'],'input':str(p),'checks':rows}

print(json.dumps(result))
