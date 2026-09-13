"""Guarded, one-variant Cruella filename declaration refresh; no provider I/O.

Uses the active-generation writer protocol from the filename-declaration
migration, not a full-source import, trigger bypass or observed-audio override.
Preparation/status are read-only. Dry-run executes the guarded transaction and
rolls it back. Apply needs an explicit CLI acknowledgement and immutable intent.
"""
import argparse
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import time

VARIANT = '313ced4c-4f62-4330-bbe9-06dbf0882170'
IDENTITY = 'd8a0c11afb0d9c3fab417c01ffd31068f44abdb0e3ef5807db29e632bcc22968'
EXTERNAL = 'norva-selection:movie:' + IDENTITY
URL_HASH = '6a36cde59f6925d16ba1db2f4f30f9ab8edb747ec9cdc1014601f8508e14d522'
FEED = 'klysmgt-tested-vod'
REVISION = 'selection-vod-20260906-v1'
DECLARATION = {'version': 1, 'language': 'es', 'urlSha256': URL_HASH}
ACK = 'apply-only-audited-cruella-filename-declaration'
UUID = re.compile(r'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$')
HEX = re.compile(r'^[a-f0-9]{64}$')


def require(condition, code):
    if not condition:
        raise RuntimeError(code)


def literal(value):
    return "'" + json.dumps(value, separators=(',', ':')).replace("'", "''") + "'::jsonb"


GUARDS = """not exists (
  select 1 from (values
    ('public.cloud_media_items','public.norva_catalog_generation_guard_begin_statement()'),
    ('public.cloud_media_items','public.norva_catalog_generation_write_guard()'),
    ('public.cloud_title_variants','public.norva_catalog_generation_guard_begin_statement()'),
    ('public.cloud_title_variants','public.norva_catalog_generation_write_guard()'),
    ('public.cloud_title_variants','public.cloud_catalog_refresh_provider_language_hint()')
  ) required(table_name,function_name)
  where not exists(select 1 from pg_catalog.pg_trigger t
    where t.tgrelid=required.table_name::regclass
      and t.tgfoid=required.function_name::regprocedure
      and not t.tgisinternal and t.tgenabled in ('O','A'))
) and current_setting('session_replication_role')='origin'"""


def state_select():
    # Only hashes leave PostgreSQL: never return playback URLs or full metadata.
    return f"""select coalesce(jsonb_agg(row),'[]'::jsonb) from (
 select v.id as variant_id,v.media_item_id,v.user_id,v.source_id,v.title_id,v.generation_id,
   public.norva_get_catalog_write_snapshot(v.source_id,v.user_id) as snapshot,
   ({GUARDS}) as guards_enabled,
   v.external_id,m.external_id as media_external_id,
   v.metadata->>'selectionVodId' as variant_selection_id,
   m.metadata->>'selectionVodId' as media_selection_id,
   v.metadata->>'discoveryFeed' as variant_feed,m.metadata->>'discoveryFeed' as media_feed,
   v.metadata->>'selectionRevision' as variant_revision,m.metadata->>'selectionRevision' as media_revision,
   v.metadata#>>'{{selectionPlaybackValidation,urlSha256}}' as variant_validation_hash,
   m.metadata#>>'{{selectionPlaybackValidation,urlSha256}}' as media_validation_hash,
   encode(sha256(convert_to(v.playback_hint->>'targetUrl','UTF8')),'hex') as variant_target_hash,
   encode(sha256(convert_to(m.playback_hint->>'targetUrl','UTF8')),'hex') as media_target_hash,
   encode(sha256(convert_to(coalesce(v.metadata,'{{}}'::jsonb)::text,'UTF8')),'hex') as variant_metadata_hash,
   encode(sha256(convert_to(coalesce(m.metadata,'{{}}'::jsonb)::text,'UTF8')),'hex') as media_metadata_hash,
   v.metadata->'selectionFilenameAudio' as variant_declaration,
   m.metadata->'selectionFilenameAudio' as media_declaration,
   exists(select 1 from public.cloud_catalog_effective_audio_languages(v.user_id,'movie',v.source_id,'es') e
     where e.variant_id=v.id and e.title_id=v.title_id) as matches_spanish,
   exists(select 1 from public.cloud_catalog_unidentified_audio_variants(v.user_id,'movie',v.source_id) u
     where u.variant_id=v.id and u.title_id=v.title_id) as matches_unidentified
 from public.cloud_catalog_visible_title_variants v
 join public.cloud_media_items m on m.id=v.media_item_id and m.user_id=v.user_id
   and m.source_id=v.source_id and m.generation_id=v.generation_id
 where v.id='{VARIANT}'::uuid and v.external_id='{EXTERNAL}' and v.item_type='movie'
   and m.item_type='movie'
) row;"""


def read_state(db):
    rows = db.execute("BEGIN READ ONLY; SET LOCAL statement_timeout='20s'; SET LOCAL ROLE service_role;\n"
                      + state_select() + '\nROLLBACK;', True)
    require(isinstance(rows, list) and len(rows) == 1, 'exact_visible_variant_missing')
    row = rows[0]
    for key in ('variant_id', 'media_item_id', 'user_id', 'source_id', 'title_id', 'generation_id'):
        require(isinstance(row.get(key), str) and UUID.fullmatch(row[key]), 'invalid_identity')
    require(row['variant_id'] == VARIANT and row.get('external_id') == EXTERNAL
            and row.get('media_external_id') == EXTERNAL, 'file_identity_changed')
    require(row.get('guards_enabled') is True, 'writer_guards_missing')
    require(type(row.get('matches_spanish')) is bool and type(row.get('matches_unidentified')) is bool,
            'language_projection_missing')
    for prefix in ('variant', 'media'):
        require(row.get(prefix + '_selection_id') == IDENTITY, 'selection_identity_changed')
        require(row.get(prefix + '_feed') == FEED and row.get(prefix + '_revision') == REVISION, 'manifest_scope_changed')
        require(row.get(prefix + '_validation_hash') == URL_HASH
                and row.get(prefix + '_target_hash') == URL_HASH, 'url_hash_changed')
        require(isinstance(row.get(prefix + '_metadata_hash'), str)
                and HEX.fullmatch(row[prefix + '_metadata_hash']), 'invalid_metadata_hash')
        require(row.get(prefix + '_declaration') in (None, DECLARATION), 'existing_declaration_conflict')
    snapshot = row.get('snapshot') or {}
    require(snapshot.get('isCatalogVisible') is True and snapshot.get('generationId') == row['generation_id'], 'generation_not_visible')
    for key in ('headRevision', 'configRevision', 'sourceVisibilityEpoch', 'userVisibilityEpoch'):
        require(type(snapshot.get(key)) is int and snapshot[key] >= 0, 'invalid_write_snapshot')
    return row


def apply_sql(plan, commit=False):
    p = literal(plan['before'])
    declaration = literal(DECLARATION)
    # The temporary routine is revoked from public and is called as service_role.
    # SECURITY DEFINER preserves existing table grants, exactly as the audited
    # filename backfill migration; all catalogue statement/row triggers run.
    return f"""BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';
CREATE FUNCTION pg_temp.refresh_audited_selection_filename()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $body$
declare p jsonb:={p}; declaration jsonb:={declaration}; snapshot jsonb;
  variant public.cloud_title_variants%rowtype; media public.cloud_media_items%rowtype;
  media_count integer; variant_count integer; observation_before jsonb; observation_after jsonb;
begin
  perform public.norva_credential_require_service_role();
  if not ({GUARDS}) then raise exception 'writer_guards_missing'; end if;
  -- Follow the established account -> source -> head/lifecycle -> epoch order.
  perform public.norva_credential_lock_account((p->>'user_id')::uuid);
  perform 1 from public.cloud_sources s
    where s.id=(p->>'source_id')::uuid and s.user_id=(p->>'user_id')::uuid for share;
  if not found then raise exception 'source_missing'; end if;
  perform 1 from public.cloud_source_catalog_heads h
    join public.cloud_source_lifecycle l on l.source_id=h.source_id and l.user_id=h.user_id
    where h.source_id=(p->>'source_id')::uuid and h.user_id=(p->>'user_id')::uuid for share of h,l;
  if not found then raise exception 'head_missing'; end if;
  -- FOR UPDATE also avoids a lock-upgrade deadlock at the single epoch bump.
  perform 1 from public.cloud_user_catalog_visibility_epochs e
    where e.user_id=(p->>'user_id')::uuid for update;
  if not found then raise exception 'visibility_epoch_missing'; end if;
  snapshot:=public.norva_get_catalog_write_snapshot((p->>'source_id')::uuid,(p->>'user_id')::uuid);
  if snapshot is distinct from p->'snapshot' or (snapshot->>'isCatalogVisible')::boolean is distinct from true
    then raise exception 'write_snapshot_cas_failed'; end if;
  select m.* into strict media from public.cloud_media_items m
    where m.id=(p->>'media_item_id')::uuid for update;
  select v.* into strict variant from public.cloud_title_variants v
    where v.id='{VARIANT}'::uuid for update;
  if variant.user_id is distinct from (p->>'user_id')::uuid or media.user_id is distinct from variant.user_id
    or variant.source_id is distinct from (p->>'source_id')::uuid or media.source_id is distinct from variant.source_id
    or variant.generation_id is distinct from (snapshot->>'generationId')::uuid or media.generation_id is distinct from variant.generation_id
    or variant.media_item_id is distinct from media.id or variant.title_id is distinct from (p->>'title_id')::uuid
    or variant.item_type is distinct from 'movie' or media.item_type is distinct from 'movie'
    or variant.external_id is distinct from '{EXTERNAL}' or media.external_id is distinct from '{EXTERNAL}'
    then raise exception 'exact_identity_cas_failed'; end if;
  if not exists(select 1 from public.cloud_catalog_visible_title_variants visible
    where visible.id=variant.id and visible.user_id=variant.user_id and visible.source_id=variant.source_id
      and visible.generation_id=variant.generation_id)
    then raise exception 'variant_no_longer_visible'; end if;
  if encode(sha256(convert_to(coalesce(variant.metadata,'{{}}'::jsonb)::text,'UTF8')),'hex') is distinct from p->>'variant_metadata_hash'
    or encode(sha256(convert_to(coalesce(media.metadata,'{{}}'::jsonb)::text,'UTF8')),'hex') is distinct from p->>'media_metadata_hash'
    then raise exception 'metadata_cas_failed'; end if;
  if variant.metadata->>'selectionVodId' is distinct from '{IDENTITY}' or media.metadata->>'selectionVodId' is distinct from '{IDENTITY}'
    or variant.metadata->>'discoveryFeed' is distinct from '{FEED}' or media.metadata->>'discoveryFeed' is distinct from '{FEED}'
    or variant.metadata->>'selectionRevision' is distinct from '{REVISION}' or media.metadata->>'selectionRevision' is distinct from '{REVISION}'
    or variant.metadata#>>'{{selectionPlaybackValidation,urlSha256}}' is distinct from '{URL_HASH}'
    or media.metadata#>>'{{selectionPlaybackValidation,urlSha256}}' is distinct from '{URL_HASH}'
    or encode(sha256(convert_to(variant.playback_hint->>'targetUrl','UTF8')),'hex') is distinct from '{URL_HASH}'
    or encode(sha256(convert_to(media.playback_hint->>'targetUrl','UTF8')),'hex') is distinct from '{URL_HASH}'
    then raise exception 'manifest_hash_cas_failed'; end if;
  if variant.metadata->'selectionFilenameAudio' is not null or media.metadata->'selectionFilenameAudio' is not null
    then raise exception 'declaration_no_longer_absent'; end if;
  perform 1 from public.cloud_title_file_language_observations o
    where o.user_id=variant.user_id and o.variant_id=variant.id for share;
  select coalesce(jsonb_agg(to_jsonb(o) order by o.file_external_id),'[]'::jsonb) into observation_before
    from public.cloud_title_file_language_observations o where o.user_id=variant.user_id and o.variant_id=variant.id;
  perform public.norva_set_catalog_delete_proof(variant.source_id,variant.user_id,variant.generation_id,
    (snapshot->>'headRevision')::bigint,(snapshot->>'configRevision')::bigint,
    (snapshot->>'sourceVisibilityEpoch')::bigint,(snapshot->>'userVisibilityEpoch')::bigint);
  update public.cloud_media_items m set
    write_head_revision=(snapshot->>'headRevision')::bigint,write_config_revision=(snapshot->>'configRevision')::bigint,
    write_source_visibility_epoch=(snapshot->>'sourceVisibilityEpoch')::bigint,
    write_user_visibility_epoch=(snapshot->>'userVisibilityEpoch')::bigint,
    metadata=media.metadata||jsonb_build_object('selectionFilenameAudio',declaration)
    where m.id=media.id and m.metadata is not distinct from media.metadata;
  get diagnostics media_count=ROW_COUNT;
  if media_count<>1 then raise exception 'media_write_count_failed'; end if;
  update public.cloud_title_variants v set
    write_head_revision=(snapshot->>'headRevision')::bigint,write_config_revision=(snapshot->>'configRevision')::bigint,
    write_source_visibility_epoch=(snapshot->>'sourceVisibilityEpoch')::bigint,
    write_user_visibility_epoch=(snapshot->>'userVisibilityEpoch')::bigint,
    metadata=variant.metadata||jsonb_build_object('selectionFilenameAudio',declaration)
    where v.id=variant.id and (v.metadata is not distinct from variant.metadata
      or v.metadata is not distinct from (variant.metadata||jsonb_build_object('selectionFilenameAudio',declaration)));
  get diagnostics variant_count=ROW_COUNT;
  if variant_count<>1 then raise exception 'variant_write_count_failed'; end if;
  if not exists(select 1 from public.cloud_media_items m where m.id=media.id
    and m.metadata=(media.metadata||jsonb_build_object('selectionFilenameAudio',declaration))
    and (to_jsonb(m)-array['metadata','updated_at','write_head_revision','write_config_revision',
      'write_source_visibility_epoch','write_user_visibility_epoch']) is not distinct from
      (to_jsonb(media)-array['metadata','updated_at','write_head_revision','write_config_revision',
      'write_source_visibility_epoch','write_user_visibility_epoch']))
    or not exists(select 1 from public.cloud_title_variants v where v.id=variant.id
    and v.metadata=(variant.metadata||jsonb_build_object('selectionFilenameAudio',declaration))
    and (to_jsonb(v)-array['metadata','updated_at','write_head_revision','write_config_revision',
      'write_source_visibility_epoch','write_user_visibility_epoch']) is not distinct from
      (to_jsonb(variant)-array['metadata','updated_at','write_head_revision','write_config_revision',
      'write_source_visibility_epoch','write_user_visibility_epoch']))
    then raise exception 'unrelated_metadata_changed'; end if;
  select coalesce(jsonb_agg(to_jsonb(o) order by o.file_external_id),'[]'::jsonb) into observation_after
    from public.cloud_title_file_language_observations o where o.user_id=variant.user_id and o.variant_id=variant.id;
  if observation_after is distinct from observation_before then raise exception 'audio_observation_changed'; end if;
  if not exists(select 1 from public.cloud_catalog_effective_audio_languages(variant.user_id,'movie',variant.source_id,'es') effective
    where effective.variant_id=variant.id and effective.title_id=variant.title_id)
    or exists(select 1 from public.cloud_catalog_unidentified_audio_variants(variant.user_id,'movie',variant.source_id) unknown
    where unknown.variant_id=variant.id)
    then raise exception 'language_projection_failed'; end if;
  perform public.norva_bump_user_catalog_visibility_epoch(variant.user_id);
  return jsonb_build_object('updated',true,'media_rows',media_count,'variant_rows',variant_count,
    'language','es','observations_unchanged',true,'provider_requests',0);
end
$body$;
REVOKE ALL ON FUNCTION pg_temp.refresh_audited_selection_filename() FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.refresh_audited_selection_filename() TO service_role;
SET LOCAL ROLE service_role;
SELECT pg_temp.refresh_audited_selection_filename();
RESET ROLE;
DROP FUNCTION pg_temp.refresh_audited_selection_filename();
{'COMMIT' if commit else 'ROLLBACK'};
"""


class DockerDatabase:
    def __init__(self, container='norva-db'):
        require(re.fullmatch(r'[a-zA-Z0-9_.-]{1,80}', container), 'invalid_container')
        self.container = container

    def execute(self, sql, readonly=False):
        args = ['docker', 'exec', '-e', 'PGOPTIONS=-c default_transaction_read_only=' + ('on' if readonly else 'off'),
                '-i', self.container, 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1']
        try:
            result = subprocess.run(args, input=sql, text=True, capture_output=True, timeout=35, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise RuntimeError('database_failed_or_uncertain') from None
        require(result.returncode == 0, 'database_failed_or_uncertain')
        try:
            return json.loads(result.stdout.strip())
        except (ValueError, TypeError):
            raise RuntimeError('database_response_uncertain') from None


def private_write(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as output:
        json.dump(data, output, indent=2)
        output.flush()
        os.fsync(output.fileno())


def operator_hash():
    return hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()


def load_plan(root, now=None):
    plan = json.loads((root / 'plan.private.json').read_text(encoding='utf-8'))
    require(plan.get('operator_sha256') == operator_hash(), 'operator_changed')
    require((now if now is not None else time.time()) < plan.get('expires_at', 0), 'plan_expired')
    require(plan.get('before', {}).get('variant_id') == VARIANT, 'plan_target_changed')
    return plan


def prepare(root, db):
    require(not (root / 'plan.private.json').exists(), 'plan_already_exists')
    before = read_state(db)
    if before['variant_declaration'] == DECLARATION and before['media_declaration'] == DECLARATION:
        require(before['matches_spanish'] is True and before['matches_unidentified'] is False,
                'existing_projection_inconsistent')
        return {'already_applied': True, 'provider_requests': 0}
    require(before['variant_declaration'] is None and before['media_declaration'] is None, 'partial_declaration_requires_review')
    require(before['matches_unidentified'] is True, 'variant_already_identified_requires_review')
    plan = {'prepared_at': time.time(), 'expires_at': time.time() + 1800,
            'operator_sha256': operator_hash(), 'before': before}
    private_write(root / 'plan.private.json', plan)
    return {'prepared': True, 'variants': 1, 'provider_requests': 0}


def valid_result(result):
    expected = {'updated': True, 'media_rows': 1, 'variant_rows': 1, 'language': 'es',
                'observations_unchanged': True, 'provider_requests': 0}
    return isinstance(result, dict) and all(type(result.get(key)) is type(value) and result[key] == value
                                            for key, value in expected.items())


def run_change(root, db, commit=False, acknowledgement=None):
    require(not (root / 'apply-intent.private.json').exists(), 'prior_apply_intent_no_retry')
    plan = load_plan(root)
    require(read_state(db) == plan['before'], 'prepared_state_changed')
    if not commit:
        result = db.execute(apply_sql(plan, False))
        require(valid_result(result), 'dry_run_failed')
        require(read_state(db) == plan['before'], 'dry_run_did_not_rollback')
        private_write(root / 'dry-run.private.json', {'at': time.time(), 'result': result,
                      'operator_sha256': operator_hash(), 'before': plan['before']})
        return {'dry_run_passed': True, 'persisted_rows': 0}
    require(acknowledgement == ACK, 'explicit_apply_ack_required')
    dry = json.loads((root / 'dry-run.private.json').read_text(encoding='utf-8'))
    require(dry.get('operator_sha256') == operator_hash() and dry.get('before') == plan['before']
            and valid_result(dry.get('result')), 'dry_run_missing_or_changed')
    private_write(root / 'apply-intent.private.json', {'at': time.time(), 'operator_sha256': operator_hash()})
    try:
        result = db.execute(apply_sql(plan, True))
        after = read_state(db)
        require(valid_result(result) and after['variant_declaration'] == DECLARATION
                and after['media_declaration'] == DECLARATION and after['matches_spanish'] is True
                and after['matches_unidentified'] is False, 'post_commit_verification_failed')
        private_write(root / 'applied.private.json', {'at': time.time(), 'result': result, 'after': after})
        return {'applied': True, 'variants': 1, 'language': 'es', 'provider_requests': 0}
    except Exception:
        private_write(root / 'uncertain.private.json', {'at': time.time(), 'code': 'apply_uncertain_no_retry'})
        raise RuntimeError('apply_uncertain_no_retry') from None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'dry-run', 'apply', 'status'])
    parser.add_argument('--state-dir', required=True, type=pathlib.Path)
    parser.add_argument('--container', default='norva-db')
    parser.add_argument('--acknowledge')
    args = parser.parse_args(argv)
    os.umask(0o077)
    root = args.state_dir
    require(root.is_absolute() and root.is_dir() and not root.is_symlink(), 'private_state_dir_required')
    if os.name == 'posix':
        require(root.stat().st_mode & 0o077 == 0, 'private_state_dir_permissions_required')
    db = DockerDatabase(args.container)
    if args.action == 'status':
        row = read_state(db)
        return {'declaration_on_media': row['media_declaration'] == DECLARATION,
                'declaration_on_variant': row['variant_declaration'] == DECLARATION,
                'matches_spanish': row['matches_spanish'],
                'matches_unidentified': row['matches_unidentified'],
                'prior_intent': (root / 'apply-intent.private.json').exists(), 'provider_requests': 0}
    # Linux operator only; tests import this module without opening a database.
    import fcntl
    with (root / 'operator.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.action == 'prepare':
            return prepare(root, db)
        return run_change(root, db, args.action == 'apply', args.acknowledge)


if __name__ == '__main__':
    try:
        print(json.dumps(main()))
    except Exception as error:
        code = str(error)
        print(json.dumps({'ok': False, 'code': code if re.fullmatch('[a-zA-Z0-9_:.-]{1,100}', code) else 'filename_refresh_failed'}))
        sys.exit(1)
