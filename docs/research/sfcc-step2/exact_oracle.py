#!/usr/bin/env python3
"""Independent exact-rational/algebraic point oracle; no decimal or libm sqrt.
Generate deterministic fixtures with --generate PATH; validate bound JSON with
--check INPUT OUTPUT. Runtime geometry still uses the existing kernel only.
"""
import argparse, itertools, json, math, random, struct
from fractions import Fraction as F


def cases():
    rng=random.Random(32026)
    out=[]
    identity=[1.,0.,0.,0.,1.,0.,0.,0.,1.]
    for i in range(120):
        angle=rng.uniform(-3.,3.)
        cs,sn=math.cos(angle),math.sin(angle)
        rotation=[cs,-sn,0.,sn,cs,0.,0.,0.,1.] if i%3 else identity
        scale=2.**[-100,-10,0,10,100][i%5]
        translation=[0.,0.,0.] if i%4 or scale<1. else [2.**40,-2.**40,2.**40]
        pos=[rng.randrange(-16,17)/8. for _ in range(3)]
        shape={"kind":"sphere","r":rng.randrange(1,33)/8.,"pos":pos} if i%2 else {
            "kind":"box","half":[rng.randrange(1,33)/8. for _ in range(3)],"pos":pos}
        # Identity matrix products and power-of-two scale bake these stored values exactly.
        scene={"kind":"translate","d":translation,"arg":{"kind":"scale","sx":scale,"sy":scale,"sz":scale,
            "arg":{"kind":"rotate","fwd":rotation,"arg":shape}}}
        q=[rng.randrange(-32,33)/8.*scale+translation[a] for a in range(3)]
        h=[0.,0.,0.] if i%3 else [scale/32.]*3
        out.append({"scene":scene,"query":q+h+[max(h)],"matrix":rotation,"scale":scale,"translation":translation,"primitive":shape})
    for scale in [1., 2.**20]:
        for cs,sn in [(math.cos(.713),math.sin(.713)),(.7564029693603516,.6541059017181396)]:
            pos=[cs/2.-.25,-sn/2.,0.]
            mat=[cs,sn,0.,-sn,cs,0.,0.,0.,1.]
            # Exact dyadic construction: fwd*(1/2,0,0)-pos=(1/4,0,0).
            assert F(cs)/2-F(pos[0])==F(1)/4 and -F(sn)/2-F(pos[1])==0
            prim={"kind":"sphere","r":.25,"pos":pos}
            t=[2.**40,-2.**40,0.]
            scene={"kind":"translate","d":t,"arg":{"kind":"scale","sx":scale,"sy":scale,"sz":scale,
                "arg":{"kind":"rotate","fwd":mat,"arg":prim}}}
            q=[t[0]+scale/2.,t[1],0.,0.,0.,0.,0.]
            out.append({"scene":scene,"query":q,"matrix":mat,"scale":scale,"translation":t,"primitive":prim})
    a,b,r=16072908759584,218874968123250,219464325271666
    assert a*a+b*b==r*r
    for exponent in [-100,-10,0,10,100]:
        s=2.**exponent
        prim={"kind":"sphere","r":r*s,"pos":[0.,0.,0.]}
        out.append({"scene":prim,"query":[a*s,b*s,0.,0.,0.,0.,0.],"matrix":identity,"scale":1.,"translation":[0.]*3,"primitive":prim})
    for r in [1e-300,float.fromhex('0x0.0000000000001p-1022'),float.fromhex('0x1.fffffffffffffp1023')]:
        prim={"kind":"sphere","r":r,"pos":[0.,0.,0.]}
        out.append({"scene":prim,"query":[r,0.,0.,0.,0.,0.,0.],"matrix":identity,"scale":1.,"translation":[0.]*3,"primitive":prim})
    return out


def exact_parts(case,p):
    mat=list(map(F,case['matrix']));scale=F(case['scale']);t=list(map(F,case['translation']));prim=case['primitive']
    local=[sum(mat[3*a+b]*(p[b]-t[b])/scale for b in range(3))-F(prim['pos'][a]) for a in range(3)]
    if prim['kind']=='sphere':
        squared=sum(x*x for x in local);inside=-F(prim['r'])
    else:
        q=[abs(x)-F(h) for x,h in zip(local,prim['half'])]
        squared=sum(max(x,F(0))**2 for x in q);inside=max(min(x,F(0)) for x in q)
    return squared,inside


def check_bound(case,p,iv):
    if iv[0] is None or iv[1] is None:
        assert iv[0] is None and iv[1] is None
        return False
    squared,inside=exact_parts(case,p);scale=F(case['scale'])
    if case.get('sign',1.) < 0: iv=[-iv[1],-iv[0]]
    lo,hi=F(iv[0])/scale-inside,F(iv[1])/scale-inside
    # sqrt(squared) >= lo and <= hi, checked without evaluating the radical.
    assert lo<=0 or lo*lo<=squared,(case,'lo',iv)
    assert hi>=0 and squared<=hi*hi,(case,'hi',iv)
    return True


def check(inputs,results):
    assert len(inputs)==len(results)
    finite=points=whole_boxes=zeros=0
    for index,(case,iv) in enumerate(zip(inputs,results)):
        assert isinstance(iv,dict), "oracle requires captured binary64 inputs"
        decode=lambda words:[struct.unpack('>d',bytes.fromhex(v))[0] for v in words]
        state=decode(iv['inputs']);query=decode(iv['query']);bounds=decode(iv['bounds'])
        assert len(state)==21 and len(query)==7 and len(bounds)==4
        assert all(math.isfinite(v) for v in state+query)
        assert state[9]>0 and state[16] in [-1.,1.] and state[17] in [0.,1.]
        primitive={'kind':'sphere' if state[17]==0 else 'box','pos':state[13:16]}
        if primitive['kind']=='sphere':primitive['r']=state[18]
        else:primitive['half']=state[18:21]
        case={'matrix':state[:9],'scale':state[9],'translation':state[10:13],
            'sign':state[16],'primitive':primitive,'query':query}
        iv=[None if math.isnan(v) else v for v in bounds]
        c=list(map(F,case['query'][:3]));h=list(map(F,case['query'][3:6]));r=F(case['query'][6])
        if index>=120:
            squared,inside=exact_parts(case,c)
            assert primitive['kind']=='sphere' and inside<0 and squared==inside*inside
            zeros+=1
        finite+=check_bound(case,c,iv[:2]);points+=1
        for signs in itertools.product([-1,1],repeat=3):
            p=[c[a]+signs[a]*h[a] for a in range(3)]
            check_bound(case,p,iv[:2]);points+=1
        for a in range(3):
            for sign in [-1,1]:
                p=c[:];p[a]+=sign*r
                check_bound(case,p,iv[2:]);points+=1
        if case['matrix']==[1.,0.,0.,0.,1.,0.,0.,0.,1.]:
            # For axis-aligned spheres/boxes, absolute-coordinate monotonicity
            # makes these independently selected real points global extrema.
            center=[F(t)+F(case['scale'])*F(q) for t,q in zip(case['translation'],case['primitive']['pos'])]
            low=[c[a]-h[a] for a in range(3)];high=[c[a]+h[a] for a in range(3)]
            near=[max(low[a],min(center[a],high[a])) for a in range(3)]
            far=[max([low[a],high[a]],key=lambda v:abs(v-center[a])) for a in range(3)]
            check_bound(case,near,iv[:2]);check_bound(case,far,iv[:2]);whole_boxes+=1
    assert finite>=120,(finite,len(inputs))
    print(f'{len(inputs)} independent exact-algebraic queries, {points} exact witness checks, {whole_boxes} full axis-aligned box extrema checks, {zeros} actual exact zeros; {finite} finite box bounds')

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--generate');p.add_argument('--check',nargs=2);args=p.parse_args()
    if args.generate:
        with open(args.generate,'w') as f:f.write('[\n'+',\n'.join(json.dumps(c,separators=(',',':')) for c in cases())+'\n]\n')
    if args.check:
        with open(args.check[0]) as f:inputs=json.load(f)
        with open(args.check[1]) as f:outputs=json.load(f)
        check(inputs,outputs)
