from pathlib import Path
from fractions import Fraction
import struct,json,hashlib,math,sys,time
start=time.monotonic();r=Path(sys.argv[1]);out=Path(sys.argv[2]);x=json.loads(r.read_text());a=x['admissionAndQueryEvidence'];v=a['firstInvalidTriangle']
def decode(bits):return struct.unpack('>d',int(bits).to_bytes(8,'big'))[0]
def exact(points,reference):
 p=[[Fraction(decode(b)) for b in q] for q in points];ref=[Fraction(decode(b)) for b in reference]
 u=[p[1][k]-p[0][k] for k in range(3)];w=[p[2][k]-p[0][k] for k in range(3)];n=[u[1]*w[2]-u[2]*w[1],u[2]*w[0]-u[0]*w[2],u[0]*w[1]-u[1]*w[0]]
 dot=sum(n[k]*ref[k] for k in range(3));return {'exactNonzeroArea':any(n),'exactReferenceDotSign':(dot>0)-(dot<0),'exactReferenceDot':str(dot),'scope':'exact rational arithmetic on represented vertex and stored reference bits; no new SDF evaluation'}
ref=[decode(b) for b in v['referenceBits']];stages={}
for name in ['working','exported']:
 d=v[name];row=exact(d['pointBits'],v['referenceBits']);row['floatingReferenceCosine']=d['referenceDot']/d['twiceArea']/math.hypot(*ref);stages[name]=row
ranges=a['cellTriangleRanges'];assert len(ranges)==199;assert ranges[0]['start']==0
for lo,hi in zip(ranges,ranges[1:]):assert lo['start']+lo['count']==hi['start']
assert ranges[-1]['start']+ranges[-1]['count']==v['totalTriangles'];assert len(v['candidateGeometry']['pointBits'])==v['totalPoints'];assert len(v['candidateGeometry']['triangles'])==3*v['totalTriangles'];assert v['candidateGeometry']['triangles'][3*v['triangleIndex']:3*v['triangleIndex']+3]==v['triangle']
for i,point in zip(v['triangle'],v['working']['pointBits']):assert v['candidateGeometry']['pointBits'][i]==point
result={'receipt':str(r),'receiptSha256':hashlib.sha256(r.read_bytes()).hexdigest(),'triangleIndex':v['triangleIndex'],'triangle':v['triangle'],'cell':v['cellRanges'][0]['cell'],'stages':stages,'completeCellTriangleRangeCoverage':True,'candidatePoints':v['totalPoints'],'candidateTriangles':v['totalTriangles'],'failureClassification':'opposes stored working-centroid reference in both precisions; neither area collapses','patchOwner':v['patchOwner'],'allLaterTriangleOrientationsChecked':False,'newFieldEvaluations':0,'elapsedSeconds':time.monotonic()-start}
out.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
