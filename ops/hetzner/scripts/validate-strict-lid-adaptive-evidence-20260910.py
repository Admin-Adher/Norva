"""Run real, provider-free VAD tests in the exact candidate and seal the deploy gate.

QA fixtures are the public JFK upstream sample plus test-created silence/short PCM.
No production mounts, environment, credentials or Docker socket enter the sandbox.
"""
import importlib.util
import json
import os
import pathlib
import subprocess
import sys


def main():
    os.umask(0o077)
    root = pathlib.Path('/home/adrien/.norva/strict-lid-adaptive-evidence-20260910')
    spec = importlib.util.spec_from_file_location('deploy', root / 'deploy.py')
    deploy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(deploy)
    stage = deploy.revision_directory(sys.argv[1])
    plan = json.loads(deploy.safe_file(stage, 'plan.private.json').read_text())
    assert deploy.image_identity(plan['image']) == plan['imageIdentity'], 'candidate_changed'
    assert not (stage / 'vad-validation.private.json').exists(), 'proof_already_exists'
    qa = root / 'qa'
    deploy.safe_file(qa, 'fixtures/jfk.wav')
    names = sorted(path.name for path in (qa / 'tests').glob('media-gateway-strict-lid-*.test.js'))
    assert 'media-gateway-strict-lid-real-vad.test.js' in names and len(names) >= 9, 'tests_missing'
    script = """const fs=require('fs'),cp=require('child_process');
fs.mkdirSync('/tmp/suite/services/media-gateway',{recursive:true});
fs.symlinkSync('/app/src','/tmp/suite/services/media-gateway/src','dir');
fs.mkdirSync('/tmp/suite/tests');
const names=JSON.parse(process.argv[1]);
for(const name of names)fs.copyFileSync('/qa/tests/'+name,'/tmp/suite/tests/'+name);
const result=cp.spawnSync(process.execPath,['--test',...names.map(n=>'/tmp/suite/tests/'+n)],{stdio:'inherit'});
process.exit(result.status===null?1:result.status);"""
    args = ['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cpus', '2', '--memory', '768m',
            '--user', str(os.getuid()) + ':' + str(os.getgid()),
            '--pids-limit', '96', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m,mode=1777',
            '--mount', 'type=bind,src=' + str(qa) + ',dst=/qa,readonly',
            '-e', 'NODE_PATH=/app/node_modules',
            '-e', 'NORVA_STRICT_LID_REAL_VAD_FIXTURE=/qa/fixtures/jfk.wav',
            '--entrypoint', 'node', plan['image'], '-e', script, json.dumps(names)]
    result = subprocess.run(args, capture_output=True, timeout=90)
    # These tests only use public/synthetic fixtures and closed mocks.
    sys.stdout.buffer.write(result.stdout)
    sys.stderr.buffer.write(result.stderr)
    assert result.returncode == 0, 'candidate_tests_failed'
    assert deploy.image_identity(plan['image']) == plan['imageIdentity'], 'candidate_changed_after_test'
    proof = {'protocol': 1, 'candidateImageIdentity': plan['imageIdentity'],
             'vadSha256': plan['vadSha256'], 'networkDisabled': True,
             'speechCasePassed': True, 'silenceCasePassed': True, 'shortCasePassed': True}
    deploy.private_write(stage / 'vad-validation.private.json', proof)
    print(json.dumps({'realVadValidation': True, 'networkDisabled': True, 'testFiles': len(names),
                      'speechSilenceAndShortPcmPassed': True, 'deploymentGateWritten': True}))


if __name__ == '__main__':
    main()
