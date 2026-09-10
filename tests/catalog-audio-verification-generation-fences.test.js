'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sql = fs.readFileSync(path.join(__dirname,
  '../supabase/migrations/20260910193100_audio_verification_generation_fences.sql'), 'utf8');
const mark = sql.slice(sql.indexOf('create or replace function'), sql.indexOf('$function$;'));

test('audio verification selects only the exact visible owner and current generation', () => {
  assert.match(mark, /from public\.cloud_catalog_visible_title_variants variant/);
  for (const clause of ['variant.user_id = p_user_id', 'variant.id = p_variant_id',
    'variant.external_id = p_file_external_id', "variant.item_type = 'movie'",
    'head.active_generation_id = variant.generation_id']) assert.ok(mark.includes(clause));
  assert.match(mark, /if not found then return false; end if;/);
  assert.ok(mark.indexOf('if not found') < mark.indexOf('update public.cloud_title_file_language_observations'));
});

test('physical verification writes carry every ABA revision without bypassing guards', () => {
  for (const field of ['head_revision', 'config_revision', 'source_visibility_epoch', 'user_visibility_epoch']) {
    assert.ok(mark.includes(`write_${field} = v_owner.${field}`));
  }
  assert.match(mark, /variant\.source_id = v_owner\.source_id/);
  assert.match(mark, /variant\.generation_id = v_owner\.generation_id/);
  assert.doesNotMatch(mark, /exception when|set_config|disable trigger|session_replication_role/i);
});

test('movie cache fanout excludes hidden generations without rewriting episode or transport code', () => {
  assert.match(sql, /v_old text := 'from public\.cloud_title_variants variant'/);
  assert.match(sql, /length\(v_definition\) - length\(replace\(v_definition, v_old, ''\)\) <> length\(v_old\)/);
  assert.match(sql, /execute replace\(v_definition, v_old, 'from public\.cloud_catalog_visible_title_variants variant'\)/);
  assert.doesNotMatch(sql, /update public\.(?:catalog_file_audio_validation_jobs|catalog_file_tracks)|delete from|provider_attempt_count\s*=/i);
});

test('migration retains evidence checks and service-only callable privileges', () => {
  assert.match(mark, /observation\.audio_observed[\s\S]*cardinality\(observation\.audio_languages\) > 0/);
  assert.equal((sql.match(/from public, anon, authenticated;/g) || []).length, 2);
  assert.equal((sql.match(/to service_role;/g) || []).length, 2);
  assert.match(sql, /security definer set search_path = ''/);
  assert.match(sql, /begin;[\s\S]*commit;/);
});
