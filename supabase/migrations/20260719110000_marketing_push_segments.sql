-- Segmentation des notifications push marketing + historique filtrable.
--
-- Segments (source de vérité : cloud_entitlement_projection, multi-rail) :
--   all      — tous les appareils enregistrés (cloud_push_tokens)
--   trialing — comptes en essai
--   paying   — abonnés « vivants » (active/grace/past_due/cancelled_at_period_end,
--              provider <> system) — même prédicat que le MRR du dashboard
--   monthly  — payants en période MENSUELLE (upsell annuel) ; période =
--              coalesce(mapping Revolut, bill_period de la projection)
--   free     — appareils sans essai ni abonnement vivant (win-back)
-- Les comptes internes ne sont PAS exclus : s'auto-notifier sert à recetter.
--
-- admin_marketing_push_log passe de 0 à 3 arguments (recherche + filtre
-- audience + limite) ⇒ DROP de l'ancienne ⇒ ⚠ NOTIFY pgrst requis.
-- Idempotent. supabase_admin.

-- ── Résolution d'un segment → user_ids (appelée par l'edge, service role only) ──
create or replace function public.marketing_push_targets(p_audience text)
returns setof uuid language plpgsql stable security definer set search_path = public as $$
begin
  if p_audience = 'trialing' then
    return query select p.user_id from public.cloud_entitlement_projection p
      where p.status = 'trialing';
  elsif p_audience = 'paying' then
    return query select p.user_id from public.cloud_entitlement_projection p
      where p.status in ('active','grace','past_due','cancelled_at_period_end')
        and p.provider <> 'system';
  elsif p_audience = 'monthly' then
    return query select p.user_id from public.cloud_entitlement_projection p
      left join public.cloud_revolut_customers rc on rc.user_id = p.user_id
      where p.status in ('active','grace','past_due','cancelled_at_period_end')
        and p.provider <> 'system'
        and coalesce(rc.period, p.bill_period) = 'monthly';
  elsif p_audience = 'free' then
    return query select t.user_id from (select distinct user_id from public.cloud_push_tokens) t
      where t.user_id not in (
        select p.user_id from public.cloud_entitlement_projection p
        where p.status = 'trialing'
           or (p.status in ('active','grace','past_due','cancelled_at_period_end') and p.provider <> 'system'));
  else
    return query select distinct user_id from public.cloud_push_tokens;
  end if;
end; $$;
revoke all on function public.marketing_push_targets(text) from public, anon, authenticated;
grant execute on function public.marketing_push_targets(text) to service_role;

-- ── Compteurs d'appareils par segment (sélecteur d'audience du composeur) ───────
create or replace function public.admin_marketing_audience_counts()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return jsonb_build_object(
    'all',      (select count(*) from public.cloud_push_tokens),
    'trialing', (select count(*) from public.cloud_push_tokens t where t.user_id in (select public.marketing_push_targets('trialing'))),
    'paying',   (select count(*) from public.cloud_push_tokens t where t.user_id in (select public.marketing_push_targets('paying'))),
    'monthly',  (select count(*) from public.cloud_push_tokens t where t.user_id in (select public.marketing_push_targets('monthly'))),
    'free',     (select count(*) from public.cloud_push_tokens t where t.user_id in (select public.marketing_push_targets('free')))
  );
end; $$;
revoke all on function public.admin_marketing_audience_counts() from public, anon, authenticated;
grant execute on function public.admin_marketing_audience_counts() to authenticated, service_role;

-- ── Historique : recherche plein-texte simple + filtre audience + limite ────────
drop function if exists public.admin_marketing_push_log();

create or replace function public.admin_marketing_push_log(
  p_query text default null, p_audience text default null, p_limit int default 50
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'id', id, 'title', title, 'body', body, 'audience', audience,
            'sent_count', sent_count, 'fail_count', fail_count, 'dead_count', dead_count,
            'actor', actor, 'created_at', created_at) order by created_at desc), '[]'::jsonb)
          from (
            select * from public.marketing_push_log
            where (p_audience is null or audience = p_audience)
              and (p_query is null or btrim(p_query) = ''
                   or title ilike '%' || btrim(p_query) || '%'
                   or body  ilike '%' || btrim(p_query) || '%'
                   or coalesce(actor, '') ilike '%' || btrim(p_query) || '%')
            order by created_at desc
            limit v_limit
          ) t);
end; $$;
revoke all on function public.admin_marketing_push_log(text, text, int) from public, anon, authenticated;
grant execute on function public.admin_marketing_push_log(text, text, int) to authenticated, service_role;
