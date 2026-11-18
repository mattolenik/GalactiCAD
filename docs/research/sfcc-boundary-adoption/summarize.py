from pathlib import Path
import json,hashlib
repo=Path('/Users/matt/gcad/galacticad');r=repo/'.testresults/sfcc-critical-repairs/e4-invalid-construction/round39-adoption';p=r/'Integrated'
def read(p):return json.loads(p.read_text())
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def norm(v):
 if isinstance(v,dict):return {k:norm(x) for k,x in v.items() if k!='rootAddressProcessLocal'}
 if isinstance(v,list):return [norm(x) for x in v]
 return v
d=read(p/'component-attempt.json');old=read(repo/'docs/research/sfcc-span-completeness/Combined/component-attempt.json');a=read(p/'adoption-composition.json');i=d['outsideB']['incidentA'];f=read(Path('/tmp/sfcc-adoption-integrated/gcad-wasm/kernel/fixtures/incident-union-c.json'))
left=norm(d['outsideB']);right=norm(old['outsideB']);left.pop('incidentA')
for v in [left,right]:
 v['curveMemberships']=sorted(v['curveMemberships'],key=lambda x:json.dumps(x,sort_keys=True))
 for k in ['pairedTargetA','secondSegmentB']:v[k]['candidateMembershipsAtSharedPoints']=sorted(v[k]['candidateMembershipsAtSharedPoints'],key=lambda x:json.dumps(x,sort_keys=True))
checks={k:d['candidateInventory'][key]==old['candidateInventory'][key] for k,key in [('candidatePointsIdentical','points'),('candidateTrianglesIdentical','triangles'),('candidateTopologyIdentical','topology')]}
checks.update({'intervalsIdenticalAfterSorting':sorted(d['outcome']['receipt']['intervals'])==sorted(old['outcome']['receipt']['intervals']),'candidateGeneratedQueriesIdentical':d['admissionAndQueryEvidence']['generatedQueries']==old['admissionAndQueryEvidence']['generatedQueries'],'candidateQueryCostsIdentical':d['admissionAndQueryEvidence']['queryCosts']==old['admissionAndQueryEvidence']['queryCosts'],'retainedMetadataIdentical':d['admissionAndQueryEvidence']['secondaryTransactionA']['retainedMetadata']==old['admissionAndQueryEvidence']['secondaryTransactionA']['retainedMetadata'],'outsideEvidenceIdenticalModuloAddressesAndUnorderedRows':left==right})
# The compact fixture changes only identity representation, scope prose and adds provenance.
fi=norm(f);ii=norm(i);fi.pop('parentReceiptSha256');identity=fi.pop('cylinderSourceIdentity');assert identity==ii['cylinderSource'];assert fi['cylinderSource']==identity['id'];fi['cylinderSource']=identity;fi.pop('scope');ii.pop('scope')
checks['entireIncidentFixtureMatchesFreshRuntimeModuloDocumentedNormalization']=fi==ii
checks['allNewConsumerQueriesPostvalidated']=i['newConsumerReplay']['allGeneratedQueriesValidated'] and i['newConsumerReplay']['generatedPostvalidationFailures']==[]
checks['incidentCaptureComplete']=i['complete']
checks['liveStatePreserved']=d['liveStatePreserved'] and d['outsideB']['liveStatePreserved']
assert all(checks.values()),checks
names=[n for q in p.glob('discovery-*.json') if q.name!='discovery-component.json' for n in read(q)['tests']];assert len(names)==len(set(names))==83
last=read(p/'focused-23-execution.json');t=a['transport']['Ok'];s=a['sourceAttempt']['diagnostics'];replay=i['newConsumerReplay'];summary={'selected':'Integrated','sourceManifestSha256':sha(p/'manifest.json'),'componentReceiptSha256':sha(p/'component-attempt.json'),'proofReceiptSha256':sha(p/'adoption-composition.json'),'preservation':checks,'cells':[v['cell'] for v in i['cells']],'triangles':i['triangleCount'],'vertices':len(i['points']),'prospectiveExpandedCells':i['expandedComponentCells'],'prospectiveExpandedFaces':i['expandedComponentFaces'],'sourceChecks':s['attempts'],'sourceAcceptedPieces':s['acceptedPieces'],'sourceCheckCap':s['pieceCap'],'sourceDepthCap':s['depthCap'],'sourceCalls':s['sourceCalls'],'sourceMode':s['slabDomain'],'uniformSourceBound':t['uniformSourceBound'],'projectedMotionUpper':t['projectedMotionUpper'],'additionalWorkingErrorUpper':t['additionalWorkingErrorUpper'],'strictIntermediateOrientationLower':t['strictIntermediateOrientationLower'],'exportedCorrespondenceBound':t['sourceToExportAfterTransportUpper'],'tolerance':t['tolerance'],'consumedEdges':a['bindings']['consumedEdges'],'consumedParameterRange':[31.867718621208247,33.0],'originalCurveRange':[0,33],'result':a['result']['Ok'],'newConsumerGeneratedQueries':replay['generatedQueries'],'newConsumerSeparateCharges':replay['finalChargedQueries'],'focusedTestsPassed':len(names),'focusedCampaignSeconds':60-last['capSeconds']+last['elapsedSeconds'],'librarySeconds':read(p/'library-check-execution.json')['elapsedSeconds'],'componentSeconds':read(p/'component-attempt-execution.json')['elapsedSeconds'],'preservedRefusals':['Capture/component-attempt.json: discrete ownership incorrectly equated to exact raw closed-box containment','Expanded-attempt/adoption-C.json: common slab source piece_cap at128 checks'],'productionChanged':False}
(r/'summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary,indent=2))
