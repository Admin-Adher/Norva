"""Networkless native validation of pump timings and passive readiness."""
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys
import tarfile
import time

ROOT=pathlib.Path('/home/adrien/.norva/passive-qos-diagnostics-native-20260913-r2')
PARENT=ROOT.parent/'passive-observed-grant-20260913/deploy-passive-observed-grant-20260913.py'
TESTS=('passive-live-canary-admission.test.js','enrichment-pilot-admission.test.js',
       'passive-lid-capture.test.js','enrichment-deferred-media-work.test.js',
       'media-gateway-mkv-bounded-reconnect.test.js')
FILES={'tests/'+name for name in TESTS}|{'services/media-gateway/src/index.js',
       'services/media-gateway/src/enrichment-pilot-admission.js',
       'services/media-gateway/src/passive-lid-capture.js','supabase/functions/norva-playback/index.ts',
       'public/webengine/media/s_h264_ac3.mkv'}


def main():
    os.umask(0o077)
    spec=importlib.util.spec_from_file_location('qos_diagnostics_native_parent',PARENT)
    live=importlib.util.module_from_spec(spec);sys.modules[spec.name]=live;spec.loader.exec_module(live)
    live.verify();gw,require=live.gw,live.require
    def viewer_idle():
        health=gw.health()
        require(health.get('ok') is True and all(type(health.get(key)) is int and health[key]==0 for key in
            ('activeSessions','activeViewerSubtitleOperations','pendingViewerSubtitleOperations')),'native_viewer_active_or_unknown')
    viewer_idle()
    memory=dict(line.split(':',1) for line in pathlib.Path('/proc/meminfo').read_text().splitlines())
    require(int(memory['MemAvailable'].split()[0])>=2*1024*1024,'native_memory_pressure')
    require(os.getloadavg()[0]<(os.cpu_count() or 1)*.7,'native_cpu_pressure')
    require(ROOT.is_dir() and not ROOT.is_symlink() and not (ROOT/'payload').exists(),'native_root_not_fresh')
    payload=ROOT/'payload';(payload/'services/media-gateway').mkdir(parents=True,mode=0o700)
    current=gw.inspect();image=current['Image']
    gw.run(['docker','cp',current['Id']+':/app/src',str(payload/'services/media-gateway/src')])
    hashes={}
    with tarfile.open(ROOT/'source.tar') as archive:
        entries=[entry for entry in archive.getmembers() if not entry.isdir()]
        require(len(entries)==len(FILES) and {entry.name for entry in entries}==FILES,'native_archive_scope')
        for entry in entries:
            require(entry.isfile() and 0<entry.size<2000000,'native_archive_entry')
            target=payload/entry.name
            require(target.resolve().is_relative_to(payload.resolve()),'native_archive_escape')
            target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
            data=archive.extractfile(entry).read()
            if entry.name.endswith(('.js','.ts')):data=data.replace(b'\r\n',b'\n')
            target.write_bytes(data);target.chmod(0o644);hashes[entry.name]=gw.sha(data)
    name='norva-passive-qos-diagnostics-native-20260913-r2';reason=None
    with (ROOT/'native-tests.log').open('x') as output:
        process=subprocess.Popen(['docker','run','--name',name,'--rm','--network','none',
            '--cpus','.5','--memory','512m','--pids-limit','64','--read-only',
            '--tmpfs','/tmp:rw,nosuid,nodev,size=64m','-v',str(payload)+':/test:ro',
            '-e','NORVA_CAPTURE_REAL_FFMPEG=1','-e','NORVA_MKV_EARLY_PROBE_NATIVE=1',
            '--entrypoint','node',image,'--test','--test-concurrency=1','--test-reporter=tap',
            *['/test/tests/'+test for test in TESTS]],stdout=output,stderr=output)
        started=time.monotonic()
        try:
            while process.poll() is None:
                time.sleep(.5)
                try:viewer_idle()
                except Exception:reason='viewer_started_or_health_unavailable'
                if time.monotonic()-started>45:reason='native_deadline'
                if reason:break
        finally:
            if process.poll() is None:
                subprocess.run(['docker','stop','--time','1',name],capture_output=True,timeout=10)
            code=process.wait(timeout=15)
    log=(ROOT/'native-tests.log').read_text()
    counts={key:int(match.group(1)) if (match:=re.search(r'^# '+key+r' (\d+)$',log,re.M)) else None
        for key in ('tests','pass','fail','skipped')}
    proof={'exitCode':code,'abortedReason':reason,'image':image,'counts':counts,'sourceHashes':hashes,
        'networkDisabled':True,'newProviderRequests':0,'productionUnchanged':True,
        'syntheticExtractionOnly':True,'testCpuLimit':.5,'testMemoryMiB':512,'testTmpfsMiB':64}
    gw.private_write(ROOT/'native-proof.json',proof)
    live.verify();print(json.dumps(proof))
    require(code==0 and reason is None and counts=={'tests':150,'pass':150,'fail':0,'skipped':0},'native_tests_failed')


if __name__=='__main__':
    try:main()
    except Exception as error:
        code=str(error);print(json.dumps({'ok':False,'code':code if re.fullmatch('[a-zA-Z0-9_:.-]{1,120}',code)
            else 'native_qos_diagnostics_failed'}));sys.exit(1)
