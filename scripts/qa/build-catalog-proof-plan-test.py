"""Emit a self-contained, rollback-only PostgreSQL proof regression fixture.

python scripts/qa/build-catalog-proof-plan-test.py > proof-test.sql
psql -XqAt -v ON_ERROR_STOP=1 -f proof-test.sql
Only session-local tables and functions are created. No application schema needed.
"""
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[2]


def definition(name):
    text = (ROOT / 'supabase/migrations' / name).read_text(encoding='utf-8')
    start = text.index('create or replace function public.norva_active_catalog_refresh_action_current(')
    end = text.index('$function$;', text.index('as $function$', start)) + len('$function$;')
    return text[start:end]


old = definition('20260823122040_catalog_title_active_payload_writer.sql')
new = definition('20261001212500_catalog_refresh_proof_custom_plan.sql')
old_body = re.search(r'as \$function\$(.*?)\$function\$', old, re.S).group(1).strip()
new_body = re.search(r'as \$function\$(.*?)\$function\$', new, re.S).group(1).strip()
assert old_body == new_body.removeprefix('begin\n  return (').removesuffix(');\nend').strip()

schema = '''BEGIN; SET LOCAL statement_timeout='20s'; SET LOCAL search_path=pg_temp;
CREATE TEMP TABLE cloud_source_catalog_generation_categories (generation_id uuid,user_id uuid,source_id uuid,category_kind text,projection_refresh_run_id uuid);
CREATE TEMP TABLE cloud_media_items (id uuid,generation_id uuid,user_id uuid,source_id uuid,item_type text,catalog_version bigint,projection_refresh_run_id uuid);
CREATE TEMP TABLE cloud_title_variants (generation_id uuid,user_id uuid,source_id uuid,item_type text,projection_refresh_run_id uuid,media_item_id uuid);
CREATE TEMP TABLE cloud_live_variants (generation_id uuid,user_id uuid,source_id uuid,projection_refresh_run_id uuid,media_item_id uuid,logical_channel_id uuid,label text,stream_id text);
CREATE TEMP TABLE cloud_live_logical_channels (id uuid,generation_id uuid,user_id uuid,source_id uuid,projection_refresh_run_id uuid,variant_count integer,variant_preview jsonb,default_stream_id text,default_variant jsonb);
'''
old = old.replace('public.', 'pg_temp.').replace('norva_active_catalog_refresh_action_current', 'original_proof')
new = new.replace('public.', 'pg_temp.').replace('norva_active_catalog_refresh_action_current', 'optimized_proof')
fixture = (ROOT / 'tests/sql/catalog-refresh-proof-custom-plan.sql').read_text(encoding='utf-8')
sys.stdout.write(schema + old + '\n' + new + '\n' + fixture + '\nROLLBACK;\n')
