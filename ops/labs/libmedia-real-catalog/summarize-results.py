import json,pathlib
r=pathlib.Path(__file__).resolve().parent
d=json.loads((r/'browser.safe.json').read_text(encoding='utf-8'))
out=[]
for index,x in enumerate(d):
 terminal=next((e['ms'] for e in x.get('events',[]) if e['name'] in ('error','ended','operatorStop')),float('inf'))
 samples=[s for s in x.get('samples',[]) if s['ms']<terminal]
 def timeline(s):
  if s.get('nativeVideo'):return s['nativeVideo']['time']
  if x.get('renderSelection')=='MSE-when-supported':return s.get('time',0)/1000
  return s.get('stats',{}).get('videoCurrentTime',0)/1000
 valid=[s for s in samples if timeline(s)>0]
 seek=next((e['ms'] for e in x.get('events',[]) if e['name']=='seekRequested'),None)
 resumed=next((s for s in samples if seek is not None and s['ms']>=seek and timeline(s)>=120.5),None)
 phases=[]
 for name,phase in [('beforeSeek',[s for s in valid if seek is None or s['ms']<seek]),('afterSeek',[s for s in valid if seek is not None and resumed and s['ms']>=resumed['ms']])]:
  if len(phase)<2:continue
  pauses=[];began=None
  for a,b in zip(phase,phase[1:]):
   delta=timeline(b)-timeline(a)
   if -0.01<=delta<=0.02:
    if began is None:began=a['ms']
   elif began is not None:
    duration=a['ms']-began
    if duration>=2000:pauses.append(duration)
    began=None
  if began is not None and phase[-1]['ms']-began>=2000:pauses.append(phase[-1]['ms']-began)
  native=phase[-1].get('nativeVideo') or {}
  phases.append({'phase':name,'wallMs':phase[-1]['ms']-phase[0]['ms'],'mediaSeconds':round(timeline(phase[-1])-timeline(phase[0]),3),'pausesAtLeast2sMs':pauses,'nativeFrames':native.get('frames'),'nativeDropped':native.get('dropped')})
 item={'attempt':index+1,'copy':x['copy'],'index':x['index'],'software':x['software'],'delivery':x.get('delivery','full-range-or-initial-adapter'),'workerEnabled':x.get('workerEnabled',False),'renderSelection':x.get('renderSelection','canvas'),'firstVideoMs':x.get('firstVideoMs'),'loadMs':x.get('loadMs'),'sessionReadyMs':x.get('sessionReadyMs'),'firstAudioMs':x.get('firstAudioMs'),'seekObservedMs':resumed['ms']-seek if resumed else None,'profile':x.get('profile'),'tracks':[{'id':t['id'],'type':t['mediaType'],'language':t.get('metadata',{}).get('language'),'title':t.get('metadata',{}).get('title')} for t in x.get('tracks',[])],'errors':x.get('errors'),'httpFirst':x.get('http',[])[:3],'phases':phases,'expiration':x.get('expiration'),'cleanupError':x.get('cleanupError'),'lastSampleMs':samples[-1]['ms'] if samples else None,'transport':x.get('transport')}
 out.append(item)
(r/'summary.safe.json').write_text(json.dumps(out,indent=2,ensure_ascii=False),encoding='utf-8')
print(json.dumps(out[-3:],ensure_ascii=True))
