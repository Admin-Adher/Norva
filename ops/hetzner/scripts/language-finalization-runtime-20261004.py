import datetime,hashlib,json,pathlib,re,runpy,subprocess
c=runpy.run_path('/home/adrien/.norva/language-campaign-20261003.py')
rows=[]
for name in ['norva-edge-functions','norva-edge-functions-2']:
 state=c['inspect'](name)
 root=pathlib.Path(next(m['Source'] for m in state['Mounts'] if m['Destination']=='/home/deno/functions'))
 code=(root/'norva-playback/index.ts').read_text()
 p=subprocess.run(['docker','logs','--timestamps','--since',state['State']['StartedAt'],name],capture_output=True,text=True,timeout=20)
 lines=(p.stdout+'\n'+p.stderr).splitlines();diagnostics=[]
 for pos,line in enumerate(lines):
  if '[norva-playback:language-finalization]' not in line:continue
  block='\n'.join(lines[pos:pos+8]);item={'at':line.split(' ')[0]}
  block=re.sub(r'\x1b\[[0-9;]*m','',block)
  match=re.search(r"[\"']?outcome[\"']?\s*:\s*[\"'](rpc_error|empty_result)[\"']",block)
  if match:item['outcome']=match[1]
  match=re.search(r"[\"']?code[\"']?\s*:\s*[\"']([A-Z0-9]{5,8})[\"']",block)
  allowed={'PT409','22023','23502','23503','23505','23514','57014','55P03','40P01','40001','42501','42883','42703','42P01','PGRST002','PGRST003','PGRST202','PGRST203'}
  if match and match[1] in allowed:item['code']=match[1]
  match=re.search(r'[\"\x27]?elapsedMs[\"\x27]?\s*:\s*(\d+)',block)
  if match:item['elapsedMs']=int(match[1])
  diagnostics.append(item)
 rows.append({'replica':name,'startedAt':state['State']['StartedAt'],'running':state['State']['Running'],
  'sha256':hashlib.sha256(code.encode()).hexdigest(),'diagnosticPresent':'[norva-playback:language-finalization]' in code,
  'finalizationErrors':diagnostics,'databaseTimeoutDiagnostics':(p.stdout+p.stderr).count('database-statement-timeout')})
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'replicas':rows}
c['save'](c['ROOT']/'runtime-finalization-diagnostic.safe.json',result);print(json.dumps(result))
