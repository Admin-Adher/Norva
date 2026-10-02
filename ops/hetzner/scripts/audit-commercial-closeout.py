"""Read-only commercial evidence. Run on the production Docker host; no secrets emitted."""
import datetime
import json
import subprocess
import urllib.request


def run(args):
    return subprocess.run(args, capture_output=True, text=True, check=True).stdout


def sql(query):
    return json.loads(run(['docker', 'exec', 'norva-db', 'psql', '-X', '-U',
                          'supabase_admin', '-d', 'postgres', '-Atc', query]))


nodes = {'norva-media-gateway': 8081, 'norva-resume-cache-pilot-20260916': 18086}
result = {'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'nodes': {}}
environments = []
hash_script = r"""const fs=require('fs'),path=require('path'),crypto=require('crypto');
const out={};function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
const p=path.join(dir,entry.name);if(entry.isDirectory())walk(p);else if(entry.isFile()){
const raw=fs.readFileSync(p);const data=/\.(js|mjs|py|json)$/.test(p)?Buffer.from(raw.toString('utf8').replace(/\r\n/g,'\n')):raw;
out[path.relative('/app',p)]=crypto.createHash('sha256').update(data).digest('hex');}}}
walk('/app/src');for(const f of ['package.json','package-lock.json'])out[f]=crypto.createHash('sha256').update(fs.readFileSync('/app/'+f,'utf8').replace(/\r\n/g,'\n')).digest('hex');console.log(JSON.stringify(out));"""
for name, port in nodes.items():
    info = json.loads(run(['docker', 'inspect', name]))[0]
    env = dict(item.split('=', 1) for item in info['Config']['Env'] if '=' in item)
    environments.append(env)
    with urllib.request.urlopen('http://127.0.0.1:%s/health' % port, timeout=15) as response:
        health = json.load(response)
    hashes = json.loads(run(['docker', 'exec', name, 'node', '-e', hash_script]))
    result['nodes'][name] = {
        'image': info['Image'], 'sourceRevision': info['Config']['Labels'].get('org.opencontainers.image.revision'),
        'restartPolicy': info['HostConfig']['RestartPolicy']['Name'],
        'health': {key: health.get(key) for key in ['ok', 'version', 'activeSessions', 'providerAdaptiveRoute',
                                                    'providerRouteBenchmark', 'storyboardDurability',
                                                    'sharedMediaCache']},
        'mountDestinations': sorted(mount['Destination'] for mount in info['Mounts']),
        'files': hashes,
    }
    labels = info['Config'].get('Labels') or {}
    compose_files = labels.get('com.docker.compose.project.config_files')
    if compose_files:
        args = ['docker', 'compose', '--env-file',
                labels['com.docker.compose.project.working_dir'] + '/.env.media-vaapi']
        for path in compose_files.split(','):
            args += ['-f', path]
        config = json.loads(run(args + ['config', '--format', 'json']))
        service = config['services'][labels['com.docker.compose.service']]
        result['nodes'][name]['compose'] = {
            'imageMatches': json.loads(run(['docker', 'image', 'inspect', service['image']]))[0]['Id'] == info['Image'],
            'environmentDifferenceKeys': sorted(key for key, value in service.get('environment', {}).items()
                                                if str(value) != env.get(key)),
            'mountsMatch': sorted((m['source'], m['target'], m.get('read_only', False)) for m in service.get('volumes', []))
                          == sorted((m['Source'], m['Destination'], not m['RW']) for m in info['Mounts']),
        }
result['environmentDifferenceKeys'] = sorted(key for key in set(environments[0]) | set(environments[1])
                                           if environments[0].get(key) != environments[1].get(key))
result['sourceParity'] = result['nodes'][list(nodes)[0]]['files'] == result['nodes'][list(nodes)[1]]['files']
result['providerAccess'] = sql("select jsonb_build_object('stage',stage,'revision',revision,'basisPoints',cohort_basis_points,'safe',public.norva_assert_provider_access_rollout_safe()->'safe') from public.cloud_provider_access_rollout where singleton")
result['observation'] = sql("select jsonb_build_object('id',id,'state',state,'notBefore',not_before,'metrics',public.norva_provider_access_rollout_observation_metrics_v2(activity_started_at)) from public.cloud_provider_access_rollout_observations order by created_at desc limit 1")
result['adaptivePolicy'] = sql("select jsonb_agg(jsonb_build_object('policy',policy_key,'enabled',enabled,'shadowMode',shadow_mode)) from public.provider_route_policies")
result['languageRollouts'] = {}
for lane in ['metadata', 'exact_file', 'capture']:
    result['languageRollouts'][lane] = sql('select jsonb_build_object(\'revision\',revision,\'basisPoints\',basis_points) from public.catalog_language_' + lane + '_rollout')
result['partners'] = sql("select jsonb_object_agg(key,enabled) from public.admin_feature_flags where key in ('partners_payouts_live','partners_revolut_api_enabled','partners_shadow_mode','partners_earnings_enabled')")
result['playRetention'] = sql("select jsonb_build_object('enabled',enabled,'communicationsEnabled',communications_enabled) from public.cloud_play_retention_policy")
print(json.dumps(result, indent=2))
