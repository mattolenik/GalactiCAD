from pathlib import Path
import json,copy,struct,collections
root=Path('/Users/matt/gcad/galacticad/.testresults/sfcc-critical-repairs/e4-invalid-construction/round21-endpoint-lineage');old=json.loads((root/'selected-fixed/lineage-B.json').read_text());new=json.loads((root/'compact/lineage-B.json').read_text())
def expanded(rows):
 rows=copy.deepcopy(rows);raw={r['raw']['index']:r['data'] for r in rows if r['kind']=='raw_received'}
 for r in rows:
  if r['kind']=='refine_transition':
   s=r['data']['source']
   if s.get('reference')=='raw_received.data':r['data']['source']=copy.deepcopy(raw[s['rawIndex']])
 return rows
def normalize(v):
 roots={}
 def walk(x):
  if isinstance(x,list):return [walk(i) for i in x]
  if isinstance(x,dict):
   return {k:(roots.setdefault(val,'root'+str(len(roots))) if k=='rootAddressProcessLocal' else walk(val)) for k,val in sorted(x.items())}
  return x
 return walk(v)
a=normalize(expanded(old['events']));b=normalize(expanded(new['events']));assert a==b[:len(a)]
(root/'compact/prefix-equivalence.json').write_text(json.dumps({'oldRetainedEventCount':len(a),'newEventCount':len(b),'expandedPrefixExactlyEqual':True,'normalization':'resolve checked raw references and normalize process-local root address labels by sharing partition','newComplete':new['complete'],'targetLineageJoinComplete':new['lineageJoinComplete'],'compactTotalBytes':len(json.dumps(new,separators=(',',':')).encode())},indent=2)+'\n')
dec=lambda h:struct.unpack('>d',bytes.fromhex(h))[0]
for raw in [103,131]:
 print('RAW',raw)
 for e in new['events']:
  if not e.get('raw') or e['raw']['index']!=raw:continue
  if e['kind'] in ['bisection','refine_transition','endpoint_candidate','status_point','status_result','status_reason']:
   d=copy.deepcopy(e['data']);d.pop('source',None)
   if e['kind']=='status_point':
    for k,v in d.items():
     if isinstance(v,list) and len(v)==3 and all(isinstance(x,str)and len(x)==16 for x in v):d[k]=[dec(x) for x in v]
   print(e['kind'],e.get('sample'),json.dumps(d))
 print()
print('Completecompactbytes',len(json.dumps(new,separators=(',',':')).encode()),'alloldprefixmatch',len(a))
