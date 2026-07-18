-- Page Marketing (admin) — notifications push marketing avec historique.
--
-- L'infra FCM existe déjà (edge _shared/fcm.ts + cloud_push_tokens, alimentée
-- par le bridge WebView Android → onglet Notifications de la page Marketing).
-- Ici : la table d'HISTORIQUE des envois marketing + deux RPC de lecture admin.
-- L'ÉCRITURE du log se fait côté edge (norva-admin /marketing-push, service
-- role) — aucune RPC d'insertion exposée.
--
-- ⚠ NOTIFY pgrst requis (nouvelles fonctions + nouvelle table).
-- Idempotent. supabase_admin.

create table if not exists public.marketing_push_log (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  audience text not null default 'all',
  sent_count int not null default 0,
  fail_count int not null default 0,
  dead_count int not null default 0,
  actor text,
  created_at timestamptz not null default now()
);
comment on table public.marketing_push_log is
  'Historique des notifications push marketing (envoyees par norva-admin /marketing-push). dead_count = tokens morts purges pendant l''envoi.';
create index if not exists marketing_push_log_created_idx on public.marketing_push_log (created_at desc);

-- RLS sans policy : seul le service role (edge) touche la table directement ;
-- la lecture admin passe par la RPC security definer ci-dessous.
alter table public.marketing_push_log enable row level security;

-- ── Historique (50 derniers envois) ─────────────────────────────────────────────
create or replace function public.admin_marketing_push_log()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'id', id, 'title', title, 'body', body, 'audience', audience,
            'sent_count', sent_count, 'fail_count', fail_count, 'dead_count', dead_count,
            'actor', actor, 'created_at', created_at) order by created_at desc), '[]'::jsonb)
          from (select * from public.marketing_push_log order by created_at desc limit 50) t);
end; $$;
revoke all on function public.admin_marketing_push_log() from public, anon, authenticated;
grant execute on function public.admin_marketing_push_log() to authenticated, service_role;

-- ── KPIs de la vue d'ensemble Marketing ─────────────────────────────────────────
create or replace function public.admin_marketing_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return jsonb_build_object(
    'push_devices', (select count(*) from public.cloud_push_tokens),
    'push_users',   (select count(distinct user_id) from public.cloud_push_tokens),
    'notifs_30d',   (select count(*) from public.marketing_push_log where created_at > now() - interval '30 days'),
    'last_notif_at',(select max(created_at) from public.marketing_push_log)
  );
end; $$;
revoke all on function public.admin_marketing_overview() from public, anon, authenticated;
grant execute on function public.admin_marketing_overview() to authenticated, service_role;
