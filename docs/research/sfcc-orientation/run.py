from pathlib import Path
import os,sys,json,hashlib,subprocess,time,signal,shutil
repo=Path('/Users/matt/gcad/galacticad');root=repo/'.testresults/sfcc-critical-repairs/e4-invalid-construction/round30-orientation'
root.mkdir(parents=True,exist_ok=True)
source=Path(sys.argv[1]);label=sys.argv[2];mode=sys.argv[3];job=root/label
compiler='/opt/homebrew/Cellar/rust/1.99.1/bin/rustc';cargo='/opt/homebrew/Cellar/rust/1.99.1/bin/cargo'
env=dict(os.environ,RUSTC=compiler,RUSTFLAGS='',CARGO_TARGET_DIR='/tmp/sfcc-orientation-target',CARGO_PROFILE_RELEASE_LTO='false',CARGO_PROFILE_RELEASE_CODEGEN_UNITS='16',VERSION='0.1.0')
receipt_names={'SFCC_CORRELATED_SELECTED_RECEIPT':'correlated-source.json','SFCC_TRANSPORT_A_RECEIPT':'transport.json','SFCC_PRIVATE_A_RECEIPT':'private-focused.json','SFCC_INTEGRATED_FACE_RECEIPT':'face-root.json','SFCC_STORAGE_A_RECEIPT':'source-storage.json','SFCC_STORAGE_INTEGRATED_RECEIPT':'storage-lifecycle.json','SFCC_GRAPH_CAPTURE_RECEIPT':'graph-controls.json','SFCC_EXPOSURE_A_RECEIPT':'repair-A.json','SFCC_EXPOSURE_B_RECEIPT':'repair-B.json','SFCC_EXPOSURE_C_RECEIPT':'repair-C.json'}
receipt_names.update({'SFCC_JUNCTION_A_RECEIPT':'junction-A.json','SFCC_JUNCTION_B_RECEIPT':'junction-B.json','SFCC_JUNCTION_C_RECEIPT':'junction-C.json'})
receipt_names.update({'SFCC_CONNECTION_A_RECEIPT':'connection-A.json','SFCC_CONNECTION_B_RECEIPT':'connection-B.json','SFCC_CONNECTION_C_RECEIPT':'connection-C.json'})
receipt_names['SFCC_CONNECTION_A_ROLLBACK_RECEIPT']='connection-A-rollback.json'
receipt_names.update({'SFCC_COMPONENT_C_RECEIPT':'source-preflight.json','SFCC_COMPONENT_B_RECEIPT':'component-topology.json','SFCC_COMPONENT_A_RECEIPT':'component-geometry.json'})
receipt_names.update({'SFCC_STAGE4_SOURCE_C_RECEIPT':'source-preflight.json','SFCC_STAGE4_COMPONENT_B_RECEIPT':'component-attempt.json'})
receipt_names.update({'SFCC_UPPER_A_RECEIPT':'upper-A.json','SFCC_UPPER_B_RECEIPT':'upper-B.json','SFCC_UPPER_C_RECEIPT':'upper-C.json'})
receipt_names.update({'SFCC_CLOSURE_A_RECEIPT':'closure-A.json','SFCC_CLOSURE_B_RECEIPT':'closure-B.json','SFCC_CLOSURE_C_RECEIPT':'closure-C.json'})
receipt_names['SFCC_UPPER_CELL_RECEIPT']='cell-replay.json'
receipt_names.update({'SFCC_LOWER_A_RECEIPT':'lower-A.json','SFCC_LOWER_B_RECEIPT':'lower-B.json','SFCC_LOWER_C_RECEIPT':'lower-C.json'})
receipt_names['SFCC_LOWER_B_ASSOCIATION_RECEIPT']='lower-B-association.json'
receipt_names.update({'SFCC_LOWER_RUNTIME_A_RECEIPT':'runtime-A.json','SFCC_LOWER_RUNTIME_B_RECEIPT':'runtime-B.json','SFCC_INVERSE_C_RECEIPT':'inverse-C.json'})
receipt_names.update({'SFCC_ORIENTATION_A_RECEIPT':'orientation-A.json','SFCC_ORIENTATION_B_RECEIPT':'orientation-B.json','SFCC_ORIENTATION_C_RECEIPT':'orientation-C.json'})
for k,v in receipt_names.items():env[k]=str(job/v)
def run(name,cmd,cap):
 start=time.monotonic();timeout=False
 print('START '+name,flush=True)
 with (job/(name+'.log')).open('wb') as log:
  proc=subprocess.Popen(cmd,stdout=log,stderr=subprocess.STDOUT,env=env,start_new_session=True)
  try:code=proc.wait(timeout=cap)
  except subprocess.TimeoutExpired:timeout=True;os.killpg(proc.pid,signal.SIGKILL);code=proc.wait()
 row={'step':name,'command':cmd,'capSeconds':cap,'elapsedSeconds':time.monotonic()-start,'exitCode':code,'timedOut':timeout}
 (job/(name+'-execution.json')).write_text(json.dumps(row,indent=2)+'\n');print(json.dumps(row),flush=True)
 if code:raise SystemExit(code)
if mode=='build':
 job.mkdir(exist_ok=False)
 rows=[]
 for folder,dirs,names in os.walk(source/'gcad-wasm'):
  dirs[:]=sorted(d for d in dirs if d not in ('target','dist','pkg','.git','node_modules'))
  for name in sorted(names):
   p=Path(folder)/name
   if p.suffix in ('.rs','.toml','.lock','.json'):rows.append({'path':str(p.relative_to(source)),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
 manifest={'source':str(source),'files':rows,'compiler':subprocess.check_output([compiler,'-Vv'],text=True),'cargo':subprocess.check_output([cargo,'-V'],text=True),'profile':{'lto':False,'codegenUnits':16,'rustflags':'','VERSION':'0.1.0'},'scope':'isolated diagnostic; not release mesh acceptance'}
 (job/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
 for name,cmd in [('host-load',['uptime']),('host-memory',['memory_pressure','-Q']),('host-disk',['df','-h','/tmp'])]:
  r=subprocess.run(cmd,capture_output=True,text=True,timeout=10);(job/(name+'.txt')).write_text(r.stdout+r.stderr)
 run('clean-kernel',[cargo,'clean','--manifest-path',str(source/'gcad-wasm/Cargo.toml'),'--release','-p','gcad-kernel'],30)
 run('build',[cargo,'test','--manifest-path',str(source/'gcad-wasm/Cargo.toml'),'--locked','--offline','-p','gcad-kernel','--release','--features','serde,sfcc-profile','--lib','--no-run','--message-format=json'],120)
 exes=[]
 for line in (job/'build.log').read_text().splitlines():
  try:r=json.loads(line)
  except ValueError:continue
  if r.get('reason')=='compiler-artifact' and r.get('executable') and r.get('profile',{}).get('test'):exes.append(r['executable'])
 assert len(exes)==1
 exe=job/'kernel-tests';shutil.copy2(exes[0],exe)
 (job/'binary.json').write_text(json.dumps({'path':str(exe),'sha256':hashlib.sha256(exe.read_bytes()).hexdigest()},indent=2)+'\n')
else:
 manifest=json.loads((job/'manifest.json').read_text());exe=job/'kernel-tests'
for row in manifest['files']:assert hashlib.sha256((source/row['path']).read_bytes()).hexdigest()==row['sha256'],row['path']
if mode in ('build','checks'):
 start=time.monotonic()
 for i,filt in enumerate(sys.argv[4:] or ['correlated_']):
  discovery=subprocess.run([str(exe),filt,'--list'],capture_output=True,text=True,timeout=10)
  names=[line[:-6] for line in discovery.stdout.splitlines() if line.endswith(': test')]
  (job/('discovery-'+str(i)+'.json')).write_text(json.dumps({'filter':filt,'tests':names,'exitCode':discovery.returncode},indent=2)+'\n')
  assert discovery.returncode==0 and names, 'No tests discovered for '+filt
  remaining=60-(time.monotonic()-start)
  assert remaining>0, 'Focused budget exhausted'
  run('focused-'+str(i),[str(exe),filt,'--nocapture','--test-threads=1'],remaining)
elif mode=='library-check':
 assert not (job/'library-check-execution.json').exists(), 'Do not overwrite evidence'
 run('library-check',[cargo,'check','--manifest-path',str(source/'gcad-wasm/Cargo.toml'),'--locked','--offline','-p','gcad-kernel','--release','--features','serde','--lib','--message-format=json'],120)
elif mode=='component-attempt':
 filt='stage4_component_b_original_source_attempt'
 assert not (job/'component-attempt.json').exists(), 'Do not overwrite evidence'
 discovery=subprocess.run([str(exe),filt,'--list'],capture_output=True,text=True,timeout=10)
 names=[line[:-6] for line in discovery.stdout.splitlines() if line.endswith(': test')]
 (job/'discovery-component.json').write_text(json.dumps({'filter':filt,'tests':names,'exitCode':discovery.returncode},indent=2)+'\n')
 assert discovery.returncode==0 and len(names)==1, 'Expected exactly one component-attempt test'
 env['SFCC_PRIVATE_A_SOURCE_MANIFEST_SHA256']=hashlib.sha256((job/'manifest.json').read_bytes()).hexdigest()
 run('component-attempt',[str(exe),filt,'--nocapture','--test-threads=1'],120)
else:raise SystemExit('bad mode')
for row in manifest['files']:assert hashlib.sha256((source/row['path']).read_bytes()).hexdigest()==row['sha256'],row['path']
