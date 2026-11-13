"""Read-only combinatorial rotation-system audit; root executes this checker."""
from pathlib import Path
from collections import Counter
import copy, hashlib, json, sys

def orbits(around):
    darts={(a,b) for a,ns in around.items() for b in ns}
    assert all(len(ns)==len(set(ns)) and len(ns)>=2 for ns in around.values())
    assert all((b,a) in darts for a,b in darts)
    unseen=set(darts);result=[]
    while unseen:
        first=min(unseen);edge=first;walk=[]
        while True:
            assert edge in unseen, 'orbits must partition directed edges'
            unseen.remove(edge);walk.append(edge)
            a,b=edge;ns=around[b];edge=(b,ns[(ns.index(a)-1)%len(ns)])
            if edge==first:break
            assert len(walk)<=len(darts)
        result.append(walk)
    return result

def summarize(around,boundary):
    walks=orbits(around);required=set(map(tuple,boundary));back={(b,a) for a,b in required}
    rows=[]
    for walk in walks:
        vertices=[a for a,b in walk];undirected=Counter(tuple(sorted(e)) for e in walk)
        rows.append({'vertices':vertices,'forwardBoundary':sum(e in required for e in walk),
            'backwardBoundary':sum(e in back for e in walk),'repeatedVertices':[v for v,n in Counter(vertices).items() if n>1],
            'twoSidedSameFaceEdges':[list(e) for e,n in undirected.items() if n>1]})
    v=len(around);e=sum(map(len,around.values()))//2;f=len(walks);chi=v-e+f
    seen=set();todo=[next(iter(around))]
    while todo:
        n=todo.pop()
        if n not in seen:seen.add(n);todo.extend(around[n])
    assert len(seen)==v
    return {'vertices':v,'edges':e,'faceOrbitsIncludingExterior':f,'eulerCharacteristic':chi,
        'orientableRotationSurfaceGenus':(2-chi)//2,'faces':rows,
        'scope':'genus of the orientable combinatorial rotation system, not proof of CAD surface topology'}

def self_check():
    # Four boundary vertices and a star center, all with a coherent disk rotation.
    around={0:[1,4,3],1:[2,4,0],2:[3,4,1],3:[0,4,2],4:[0,1,2,3]}
    boundary=[(0,1),(1,2),(2,3),(3,0)]
    good=summarize(around,boundary)
    assert good['eulerCharacteristic']==2 and good['faceOrbitsIncludingExterior']==5
    bad=copy.deepcopy(around);bad[4]=[1,0,2,3];broken=summarize(bad,boundary)
    assert broken['eulerCharacteristic']==0 and broken['faceOrbitsIncludingExterior']==3
    assert any(f['twoSidedSameFaceEdges'] for f in broken['faces'])
    return {'diskRotationEulerTwo':True,'swappedCenterRaysEulerZero':True}

def main():
    source=Path(sys.argv[1]);output=Path(sys.argv[2]);controls=self_check()
    root=json.loads(source.read_text());capture=root['admissionAndQueryEvidence']['orientationCaptureA'];assert capture['complete']
    graphs=[e['data'] for e in capture['events'] if 'around' in e['data']];assert len(graphs)==1;g=graphs[0]
    around={r['point']:r['neighbors'] for r in g['around']};boundary=g['boundaryForward']
    assert len(around)<=256 and len(g['edges'])<=512
    old=summarize(around,boundary)
    # The largest-degree interior vertex is only a replay locator; source authority is separate.
    boundary_vertices={a for a,b in boundary}|{b for a,b in boundary};internal=[v for v in around if v not in boundary_vertices and len(around[v])>2]
    assert len(internal)==1;center=internal[0];paths=[]
    for first in around[center]:
        previous=center;point=first;path=[center,first]
        while point not in boundary_vertices:
            assert len(around[point])==2
            following=[v for v in around[point] if v!=previous];assert len(following)==1
            previous,point=point,following[0];path.append(point);assert len(path)<=len(around)
        paths.append({'neighbor':first,'port':point,'path':path})
    successor=dict(boundary);assert len(successor)==len(boundary);start=min(successor);ring=[start];p=successor[start]
    while p!=start:ring.append(p);p=successor[p];assert len(ring)<=len(boundary)
    ports={p['port']:p['neighbor'] for p in paths};assert len(ports)==len(paths)
    ordered_ports=[v for v in ring if v in ports];corrected=[ports[v] for v in ordered_ports]
    changed=copy.deepcopy(around);changed[center]=corrected;new=summarize(changed,boundary)
    report={'scope':'exact directed-edge permutation and source-neutral counterfactual; no geometry query or runtime change',
        'sourceReceipt':str(source),'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'selfControls':controls,
        'center':center,'recordedCenterRotation':around[center],'representedRadialPaths':paths,'boundaryCycle':ring,
        'boundaryOrderedPorts':ordered_ports,'boundaryConsistentCenterRotation':corrected,'actual':old,'counterfactual':new,
        'counterfactualChangesOnlyCenterRotation':True,'counterfactualPhysicalRepairAuthorized':False,
        'reasonNotRepair':'boundary-consistent rotation retains every represented radial branch, including possible aliases; source quotient and face-port association are unproved by topology alone'}
    output.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'output':str(output),'center':center,'actualEuler':old['eulerCharacteristic'],'counterfactualEuler':new['eulerCharacteristic'],'actualFaces':old['faceOrbitsIncludingExterior'],'counterfactualFaces':new['faceOrbitsIncludingExterior'],'boundaryPorts':ordered_ports,'recordedPaths':paths},indent=2))
if __name__=='__main__':main()
