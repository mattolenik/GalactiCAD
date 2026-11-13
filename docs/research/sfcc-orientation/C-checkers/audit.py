"""Exact saved-geometry discriminator. Root executes; no SDF calls or mutations."""
from pathlib import Path
from fractions import Fraction as F
from collections import defaultdict, Counter
import hashlib, json, math, struct, sys

def decode(bits):
    value = struct.unpack('>d', int(bits).to_bytes(8, 'big'))[0]
    if not math.isfinite(value):
        raise ValueError('nonfinite captured coordinate')
    return F(value)

def sub(a, b): return tuple(x-y for x, y in zip(a,b))
def cross(a, b): return (a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0])
def normal(p): return cross(sub(p[1],p[0]),sub(p[2],p[0]))
def dot(a,b): return sum(x*y for x,y in zip(a,b))
def sign(x): return (x>0)-(x<0)
def orient(a,b,c): return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])
def on(a,b,p): return orient(a,b,p)==0 and all(min(a[k],b[k])<=p[k]<=max(a[k],b[k]) for k in range(2))
def segments_touch(a,b,c,d):
    s=[sign(orient(a,b,c)),sign(orient(a,b,d)),sign(orient(c,d,a)),sign(orient(c,d,b))]
    return s[0]*s[1]<0 and s[2]*s[3]<0 or on(a,b,c) or on(a,b,d) or on(c,d,a) or on(c,d,b)
def inside(p, polygon):
    winding=0
    for a,b in zip(polygon,polygon[1:]+polygon[:1]):
        if on(a,b,p): return 'boundary'
        if a[1]<=p[1]<b[1] and orient(a,b,p)>0: winding+=1
        if b[1]<=p[1]<a[1] and orient(a,b,p)<0: winding-=1
    return 'inside' if winding else 'outside'
def edge_uses(tris):
    result=defaultdict(list)
    for index,t in enumerate(tris):
        for k in range(3):
            a,b=t[k],t[(k+1)%3]
            result[tuple(sorted((a,b)))].append((index,a,b))
    return result

def topology(tris):
    uses=edge_uses(tris)
    same=[]; nonmanifold=[]
    for edge,rows in sorted(uses.items()):
        if len(rows)>2: nonmanifold.append({'edge':edge,'uses':rows})
        if len(rows)==2 and rows[0][1:]==rows[1][1:]: same.append({'edge':edge,'uses':rows})
    multiplicities=Counter(tuple(sorted(t)) for t in tris)
    return {'vertices':len(set(v for t in tris for v in t)),'triangles':len(tris),'edges':len(uses),
        'boundaryEdges':sum(len(v)==1 for v in uses.values()),'sameDirectionInteriorEdges':same,
        'nonmanifoldEdges':nonmanifold,'duplicateFaces':[{'vertices':t,'count':n,'uses':[(i,tri) for i,tri in enumerate(tris) if tuple(sorted(tri))==t]} for t,n in multiplicities.items() if n>1],
        'scope':'combinatorial edge incidence on captured open mesh; no contact, patch, or outside-frontier proof'}

def fan(points,tris,index,reference=None):
    apex=tris[index][0];lo=index;hi=index+1
    while lo>0 and tris[lo-1][0]==apex: lo-=1
    while hi<len(tris) and tris[hi][0]==apex: hi+=1
    group=tris[lo:hi]
    closed=all(group[k][2]==group[(k+1)%len(group)][1] for k in range(len(group)))
    boundary=[t[1] for t in group]
    repeated=[v for v,n in Counter(boundary).items() if n>1]
    boundary_edges=defaultdict(list)
    for k,(a,b) in enumerate(zip(boundary,boundary[1:]+boundary[:1])):boundary_edges[tuple(sorted((a,b)))].append([k,a,b])
    repeated_edges=[{'edge':e,'uses':u} for e,u in sorted(boundary_edges.items()) if len(u)>1]
    if not closed or apex in boundary:
        return {'triangleRange':[lo,hi],'apex':apex,'boundary':boundary,'closedIdCycle':closed,'apexOccursOnBoundary':apex in boundary}
    normals=[normal([points[i] for i in t]) for t in group]
    summed=tuple(sum(n[k] for n in normals) for k in range(3))
    if not any(summed): return {'triangleRange':[lo,hi],'apex':apex,'boundary':boundary,'closedIdCycle':True,'repeatedBoundaryVertices':repeated,'repeatedBoundaryEdges':repeated_edges,'areaVectorZero':True}
    axis=max(range(3),key=lambda k:abs(summed[k]));direction=sign(summed[axis]);axes=[(axis+1)%3,(axis+2)%3]
    project=lambda p:(p[axes[0]],direction*p[axes[1]])
    xy=[project(points[i]) for i in boundary];center=project(points[apex]);touches=[]
    for i in range(len(xy)):
        for j in range(i):
            if i==j or (i-j)%len(xy) in (1,len(xy)-1):continue
            if segments_touch(xy[i],xy[(i+1)%len(xy)],xy[j],xy[(j+1)%len(xy)]):touches.append([j,i])
    signs=[sign(orient(xy[k],xy[(k+1)%len(xy)],center)) for k in range(len(xy))]
    area=sum(orient((F(0),F(0)),a,b) for a,b in zip(xy,xy[1:]+xy[:1]))
    assert area>0
    assert sum(n[axis]*direction for n in normals)==area
    return {'triangleRange':[lo,hi],'apex':apex,'boundary':boundary,'closedIdCycle':True,'uniqueBoundaryVertices':not repeated,'repeatedBoundaryVertices':repeated,'repeatedBoundaryEdges':repeated_edges,
        'projectionAxes':axes,'projectionSign':direction,'exactProjectedArea2':str(area),
        'nonadjacentProjectedBoundaryContacts':touches,'projectedBoundarySimple':not touches and not repeated,
        'apexInProjectedPolygon':inside(center,xy),'apexInClosedProjectedVisibilityKernel':all(s>=0 for s in signs) if not touches and not repeated else None,
        'projectedTriangleSigns':signs,'negativeTriangleIndices':[lo+k for k,s in enumerate(signs) if s<0],
        'zeroProjectedTriangleIndices':[lo+k for k,s in enumerate(signs) if s==0],
        'triangleSignsAgainstSummedAreaVector':[sign(dot(n,summed)) for n in normals],
        'triangleSignsAgainstStoredReference':[sign(dot(n,reference)) for n in normals] if reference else None,
        'summedAreaVectorDotStoredReferenceSign':sign(dot(summed,reference)) if reference else None,
        'scope':'exact dominant-axis projection of inferred contiguous center fan; source patch and graph polygon identity require independent provenance'}

def self_check():
    boundary=[(F(0),F(0),F(0)),(F(3),F(0),F(0)),(F(3),F(1),F(0)),(F(1),F(1),F(0)),(F(1),F(3),F(0)),(F(0),F(3),F(0))]
    points=boundary+[(F(1,2),F(2),F(0))];tris=[(6,k,(k+1)%6) for k in range(6)]
    report=fan(points,tris,2,(F(0),F(0),F(1)))
    assert report['projectedBoundarySimple'] and report['apexInProjectedPolygon']=='inside'
    assert report['apexInClosedProjectedVisibilityKernel'] is False
    assert report['negativeTriangleIndices']==[2]
    assert not topology(tris)['sameDirectionInteriorEdges']
    reversed_one=list(tris);a,b,c=reversed_one[2];reversed_one[2]=(a,c,b)
    assert len(topology(reversed_one)['sameDirectionInteriorEdges'])==2
    reversed_all=[(a,c,b) for a,b,c in tris]
    assert not topology(reversed_all)['sameDirectionInteriorEdges']
    assert sign(dot(normal([points[i] for i in tris[2]]),(F(0),F(0),F(1))))<0
    assert on((F(0),F(0)),(F(1),F(0)),(F(1,2),F(0)))
    assert segments_touch((F(0),F(0)),(F(1),F(1)),(F(0),F(1)),(F(1),F(0)))
    return {'concaveInsideButOutsideKernel':True,'singleFlipBreaksTwoInteriorEdges':True,'wholeOrientationReversalPreservesIncidence':True}

def main():
    source=Path(sys.argv[1]);destination=Path(sys.argv[2]);controls=self_check()
    data=json.loads(source.read_text());diagnostic=data['admissionAndQueryEvidence'];failure=diagnostic['firstInvalidTriangle'];geometry=failure['candidateGeometry']
    if len(geometry['pointBits'])>4096 or len(geometry['triangles'])>3*4096:raise ValueError('captured geometry exceeds existing limits')
    points=[tuple(decode(x) for x in row) for row in geometry['pointBits']]
    flat=geometry['triangles'];assert len(flat)%3==0
    tris=[tuple(flat[i:i+3]) for i in range(0,len(flat),3)]
    assert all(len(set(t))==3 and all(0<=i<len(points) for i in t) for t in tris)
    index=failure['triangleIndex'];assert tris[index]==tuple(failure['triangle'])
    reference=tuple(decode(x) for x in failure['referenceBits'])
    regions=diagnostic['cellTriangleRanges'];owner=[r for r in regions if r['start']<=index<r['start']+r['count']];assert len(owner)==1
    region=owner[0];start=region['start'];end=start+region['count'];cell_tris=tris[start:end]
    group=fan(points,cell_tris,index-start,reference)
    for k in ['negativeTriangleIndices','zeroProjectedTriangleIndices']:
        if k in group:group[k]=[v+start for v in group[k]]
    group['triangleRange']=[v+start for v in group['triangleRange']]
    modified=list(tris);a,b,c=modified[index];modified[index]=(a,c,b)
    before=topology(tris);after=topology(modified)
    before_keys={tuple(r['edge']) for r in before['sameDirectionInteriorEdges']};after_keys={tuple(r['edge']) for r in after['sameDirectionInteriorEdges']}
    uses=edge_uses(tris)
    row={'scope':'exact saved-geometry topology and center-fan discriminator; no field queries or runtime repair',
        'sourceReceipt':str(source),'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'selfControls':controls,
        'triangleIndex':index,'triangle':tris[index],'cell':region['cell'],'cellTriangleRange':[start,end],
        'firstCellCombinatorics':topology(cell_tris),'componentCombinatorics':before,
        'failingFan':group,'workingZeroAreaTriangleIndices':[i for i,t in enumerate(tris) if not any(normal([points[v] for v in t]))],
        'firstTriangleExactReferenceDotSign':sign(dot(normal([points[v] for v in tris[index]]),reference)),
        'firstTriangleNeighbors':[{'edge':edge,'uses':uses[tuple(sorted(edge))]} for edge in [(a,b),(b,c),(c,a)]],
        'singleTriangleFlipCounterfactual':{'newSameDirectionEdges':sorted(after_keys-before_keys),'removedSameDirectionEdges':sorted(before_keys-after_keys),'afterCombinatorics':after,'onlyFirstTriangleModified':True},
        'fullReferenceOrientationChecked':False,'outsideContactChecked':False,'patchOwnershipEstablished':False}
    destination.write_text(json.dumps(row,indent=2)+'\n')
    print(json.dumps({'output':str(destination),'fan':group,'sameDirectionBefore':len(before_keys),'sameDirectionAfterSingleFlip':len(after_keys),'newInconsistentEdges':sorted(after_keys-before_keys)},indent=2))
if __name__=='__main__':main()
