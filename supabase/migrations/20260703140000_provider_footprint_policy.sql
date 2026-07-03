-- Slice 0 (anti-ban « faible empreinte ») — politique d'empreinte par identité provider + compteur de probes.
--
-- Contexte : un provider mono-connexion anti-abus (ex. Ninja / operator1.barfik.org) bannit un compte
-- crawlé trop agressivement (multi-IP + volume + concurrence). Cette table marque une identité en
-- 'low_footprint' et plafonne ses probes/heure. Clé = ce que resolveSourceIdentity() calcule côté edge
-- (identity_id uuid quand résolu, sinon providerKey, sinon serverHost) — texte pour couvrir les 3 cas.

create table if not exists public.provider_footprint_policy (
  identity_key         text primary key,
  mode                 text not null default 'standard' check (mode in ('standard','low_footprint')),
  max_probes_per_hour  int check (max_probes_per_hour is null or max_probes_per_hour > 0),
  notes                text,
  updated_at           timestamptz not null default now()
);
comment on table public.provider_footprint_policy is
  'Politique d''empreinte provider par identité (clé = resolveSourceIdentity().key). mode=low_footprint '
  '→ probes routées par la gateway (IP résidentielle) + plafond max_probes_per_hour (anti-ban).';

create table if not exists public.provider_probe_hits (
  identity_key text        not null,
  occurred_at  timestamptz not null default now()
);
comment on table public.provider_probe_hits is
  'Journal des hits provider (probe) par identité — plafond horaire + observabilité d''empreinte.';
create index if not exists provider_probe_hits_key_time_idx
  on public.provider_probe_hits (identity_key, occurred_at desc);

alter table public.provider_footprint_policy enable row level security;
alter table public.provider_probe_hits enable row level security;
revoke all on table public.provider_footprint_policy from anon, authenticated;
revoke all on table public.provider_probe_hits from anon, authenticated;
grant all on table public.provider_footprint_policy to service_role;
grant all on table public.provider_probe_hits to service_role;

-- Lecture combinée policy + budget horaire (1 appel pour le runner).
create or replace function public.provider_footprint_budget(p_identity_key text)
returns table(mode text, max_probes_per_hour int, hits_last_hour int, allowed boolean)
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_mode text;
  v_max  int;
  v_hits int;
begin
  select p.mode, p.max_probes_per_hour into v_mode, v_max
    from public.provider_footprint_policy p where p.identity_key = p_identity_key;
  v_mode := coalesce(v_mode, 'standard');
  select count(*)::int into v_hits
    from public.provider_probe_hits h
    where h.identity_key = p_identity_key and h.occurred_at > now() - interval '1 hour';
  return query select
    v_mode, v_max, v_hits,
    case when v_mode <> 'low_footprint' then true
         when v_max is null then true
         else v_hits < v_max end;
end;
$fn$;

-- Enregistre un hit provider (appelé par le runner APRÈS un probe d'une identité low_footprint).
create or replace function public.provider_footprint_record_hit(p_identity_key text)
returns void language sql security definer set search_path = public as $fn$
  insert into public.provider_probe_hits(identity_key) values (p_identity_key);
$fn$;

grant execute on function public.provider_footprint_budget(text) to service_role;
grant execute on function public.provider_footprint_record_hit(text) to service_role;

-- Ninja (operator1.barfik.org) — ancien compte banni (multi-IP + volume). Faible empreinte, plafond
-- prudent 40/h (tunable en Slice 2). Ses crons de fond restent DÉSACTIVÉS jusqu'à la livraison du mode.
insert into public.provider_footprint_policy (identity_key, mode, max_probes_per_hour, notes)
values ('d8453dc1-4a95-4538-a05f-749df4f7c588', 'low_footprint', 40,
        'Ninja/barfik — ancien compte banni. Probes via gateway résidentielle + plafond 40/h.')
on conflict (identity_key) do update
  set mode = excluded.mode, max_probes_per_hour = excluded.max_probes_per_hour,
      notes = excluded.notes, updated_at = now();
