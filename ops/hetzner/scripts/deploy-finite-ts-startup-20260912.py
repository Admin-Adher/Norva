"""Scoped Gateway delta. Reuse the tested idle/alias recovery operator.

No Edge, proxy, model, entitlement, quarantine or enrichment activation change.
Original containers and all earlier release/native receipts remain immutable.
"""
import importlib.util
import json
import os
import pathlib
import re
import sys
import tarfile
import time

ROOT = pathlib.Path('/home/adrien/.norva/finite-ts-startup-20260912-r2')
PARENT = ROOT.parent/'scoped-passive-dormant-20260912'
NATIVE = ROOT.parent/'finite-ts-native-20260912-r4/native-proof.json'
APP_COMMIT = '5cfcba4a54cf9de8d39b5405583c6e0615c4194f'
FILES = ('index.js', 'passive-lid-capture.js', 'finite-ts-startup.js')
IMAGE = 'norva-media-gateway:finite-ts-startup-20260912-r2'


def load(name):
    spec = importlib.util.spec_from_file_location(name, PARENT/'deploy-scoped-passive-dormant-20260912.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


parent = load('finite_ts_parent_release')
op = load('finite_ts_scoped_operator')
op.ROOT, op.NATIVE, op.APP_COMMIT, op.FILES, op.IMAGE = ROOT, NATIVE, APP_COMMIT, FILES, IMAGE
op.PREFIX = op.SERVICE+'-finite-ts-20260912-r2'
# The existing guard must relaunch this entry point, not an old release.
op.__file__ = __file__
gw, require = op.gw, op.require


def source_snapshot(container=None):
    container = container or op.SERVICE
    result = gw.source_snapshot(container)
    # The inherited operator's module inventory predates this new module.
    # Extend this release's attestation, never mutate historical inventories.
    script = "const fs=require('fs'),c=require('crypto'),p='/app/src/finite-ts-startup.js';" \
        "process.stdout.write(JSON.stringify(fs.existsSync(p)?c.createHash('sha256').update(" \
        "fs.readFileSync(p).toString('utf8').replace(/\\r\\n/g,'\\n')).digest('hex'):null));"
    result['finite-ts-startup.js'] = json.loads(gw.run(['docker', 'exec', container, 'node', '-e', script]))
    return result


def verify_gateway(plan, candidate):
    current = gw.inspect(op.SERVICE)
    image = IMAGE if candidate else plan['original']['Config']['Image']
    expected_id = op.saved('receipt.private.json')['candidateContainer'] if candidate else plan['original']['Id']
    require(current['Id'] == expected_id, 'gateway_container_not_owned')
    gw.assert_clone(plan['original'], current, image)
    gw.assert_container_image(current, plan['imageIdentity'] if candidate else plan['originalImageIdentity'])
    require(source_snapshot() == plan['after' if candidate else 'before'], 'gateway_source_changed')
    require(gw.binary_snapshot() == plan['binaries'], 'runtime_binary_changed')
    health = gw.health(); gw.assert_runtime(health, plan['runtime'])
    fence = health.get('languageEnrichmentPilot') or {}
    require(health.get('ok') is True and fence.get('mode') == 'disabled' and fence.get('files') == 0
        and fence.get('passiveSources') == 0, 'dormant_admission_changed')
    require(current['State']['Running'] and current['RestartCount'] == 0
        and not current['State']['OOMKilled'], 'gateway_unhealthy')


op.verify_gateway = verify_gateway


def verify_parent():
    plan = parent.saved('plan.private.json')
    parent.invariant(plan)
    parent.verify_gateway(plan, True)
    require(parent.saved('closed.private.json').get('productionUpdated') is True, 'parent_not_closed')
    require(parent.base.r.crons() == plan['crons'], 'parent_cron_drift')


def stage():
    require(ROOT.is_dir() and not ROOT.is_symlink() and not (ROOT/'plan.private.json').exists(), 'stage_not_fresh')
    verify_parent()
    current = gw.inspect(op.SERVICE)
    gw.assert_image_backed_runtime(current)
    native = json.loads(NATIVE.read_text())
    require(native.get('exitCode') == 0 and native.get('counts') == {'tests': 16, 'pass': 16, 'fail': 0, 'skipped': 0}
        and native.get('networkDisabled') is True and native.get('newProviderRequests') == 0
        and native.get('image') == current['Image'], 'native_proof_not_matching')
    env = dict(v.split('=', 1) for v in current['Config']['Env'] if '=' in v)
    require(env.get('FINITE_TS_FAST_START_ENABLED') != 'false', 'finite_ts_disabled')
    require(env.get('LANGUAGE_ENRICHMENT_ACTIVATION_MODE') == 'disabled'
        and env.get('LANGUAGE_PASSIVE_CAPTURE_ENABLED') == '0'
        and env.get('LANGUAGE_CAPTURE_PIPELINE_ENABLED') == '0'
        and env.get('LANGUAGE_METADATA_LANE_ENABLED') == '0', 'enrichment_not_dormant')
    context = ROOT/'context'; context.mkdir(mode=0o700)
    allowed = {'services/media-gateway/src/'+name: name for name in FILES}
    with tarfile.open(ROOT/'source.tar') as archive:
        entries = [e for e in archive.getmembers() if not e.isdir()]
        require(len(entries) == len(FILES) and {e.name for e in entries} == set(allowed), 'archive_scope')
        for entry in entries:
            require(entry.isfile() and 0 < entry.size < (1500000 if allowed[entry.name] == 'index.js' else 180000), 'archive_entry')
            content = archive.extractfile(entry).read().replace(b'\r\n', b'\n')
            require(gw.sha(content) == native['sourceHashes'][entry.name], 'native_source_drift')
            (context/allowed[entry.name]).write_bytes(content)
            (context/allowed[entry.name]).chmod(0o600)
    before = source_snapshot()
    after = {**before, **{name: gw.sha((context/name).read_bytes()) for name in FILES}}
    base_tag = 'norva-finite-ts-base:20260912-r2'
    gw.run(['docker', 'tag', current['Image'], base_tag])
    require(gw.image_identity(base_tag)['index'] == current['Image'], 'build_base_drift')
    (context/'Dockerfile').write_text('ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n'+
        ''.join('COPY --chmod=0644 '+name+' /app/src/'+name+'\n' for name in FILES))
    gw.run(['docker', 'build', '--network', 'none', '--build-arg', 'BASE_IMAGE='+base_tag, '-t', IMAGE, str(context)])
    for name in FILES:
        gw.run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--memory', '512m', '--cpus', '1',
            '--entrypoint', 'node', IMAGE, '--check', '/app/src/'+name])
    verify_parent()
    paths = [PARENT/name for name in ('plan.private.json', 'receipt.private.json', 'closed.private.json',
        'deploy-scoped-passive-dormant-20260912.py')]
    paths += [NATIVE, pathlib.Path(__file__), ROOT/'source.tar']
    plan = {'commit': APP_COMMIT, 'original': current, 'before': before, 'after': after,
        'originalImageIdentity': gw.image_identity(current['Image']), 'imageIdentity': gw.image_identity(IMAGE),
        'binaries': gw.binary_snapshot(), 'runtime': gw.runtime_snapshot(gw.health()),
        'crons': op.base.r.crons(), 'controls': op.base.r.controls(),
        'otherContainers': {name: gw.inspect(name)['Id'] for name in (*op.base.r.SERVICES, op.base.previous.d.SERVICES[3])},
        'protectedFiles': {str(p): gw.sha(p.read_bytes()) for p in paths}, 'stagedAt': time.time()}
    op.save('plan.private.json', plan)
    op.invariant(plan); op.verify_gateway(plan, False)
    print(json.dumps({'staged': True, 'commit': APP_COMMIT, 'modules': len(FILES),
        'productionUnchanged': True, 'newProviderRequests': 0, 'passiveEnabled': False}))


if __name__ == '__main__':
    os.umask(0o077)
    try:
        phase = sys.argv[1]
        require(phase in ('stage', 'launch', 'run', 'watch', 'recover', 'verify'), 'invalid_phase')
        stage() if phase == 'stage' else getattr(op, phase)()
    except Exception as error:
        code = str(error)
        print(json.dumps({'ok': False, 'code': code if re.fullmatch('[a-zA-Z0-9_:.-]{1,120}', code)
            else 'finite_ts_release_failed'}), flush=True)
        sys.exit(1)
