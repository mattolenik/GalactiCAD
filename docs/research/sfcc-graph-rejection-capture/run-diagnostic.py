from pathlib import Path
import os,sys,json,hashlib,subprocess,time,signal,shutil
repo=Path('/Users/matt/gcad/galacticad');root=repo/'.testresults/sfcc-critical-repairs/e4-invalid-construction/round19-graph-capture'
source=Path(sys.argv[1]);label=sys.argv[2];mode=sys.argv[3];job=root/label
compiler='/opt/homebrew/Cellar/rust/1.99.0_1/bin/rustc';cargo='/opt/homebrew/Cellar/rust/1.99.0_1/bin/cargo'
env=dict(os.environ,RUSTC=compiler,RUSTFLAGS='',CARGO_TARGET_DIR='/tmp/sfcc-graph-stage1-target',CARGO_PROFILE_RELEASE_LTO='false',CARGO_PROFILE_RELEASE_CODEGEN_UNITS='16',VERSION='0.1.0')
receipt_names={'SFCC_CORRELATED_SELECTED_RECEIPT':'correlated-source.json','SFCC_TRANSPORT_A_RECEIPT':'transport.json','SFCC_PRIVATE_A_RECEIPT':'private-focused.json','SFCC_INTEGRATED_FACE_RECEIPT':'face-root.json','SFCC_STORAGE_A_RECEIPT':'source-storage.json','SFCC_STORAGE_INTEGRATED_RECEIPT':'storage-lifecycle.json','SFCC_GRAPH_CAPTURE_RECEIPT':'graph-controls.json'}
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
if mode=='build':
 start=time.monotonic()
 for i,filt in enumerate(sys.argv[4:] or ['correlated_']):run('focused-'+str(i),[str(exe),filt,'--nocapture','--test-threads=1'],max(1,60-(time.monotonic()-start)))
elif mode=='capture':
 assert not (job/'private-receipt.json').exists()
 env['SFCC_PRIVATE_A_RECEIPT']=str(job/'private-receipt.json')
 env['SFCC_PRIVATE_A_SOURCE_MANIFEST_SHA256']=hashlib.sha256((job/'manifest.json').read_bytes()).hexdigest()
 run('original-capture',[str(exe),'private_a_original_knob_serial_round0_diagnostic','--nocapture','--test-threads=1'],120)
else:raise SystemExit('bad mode')
for row in manifest['files']:assert hashlib.sha256((source/row['path']).read_bytes()).hexdigest()==row['sha256'],row['path']
