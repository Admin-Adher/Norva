-- « Passer l'intro » crowd-learned (audit UX vs Netflix 2026-07-02, correction #8 web).
--
-- Netflix embarque des timestamps éditoriaux ; Norva les APPREND de l'usage réel :
-- le geste « seek avant précoce » (sauter le générique) est signalé par le player
-- (1 signal par titre+saison+utilisateur, upsert), et les marqueurs servis sont la
-- médiane dès 3 spectateurs indépendants d'accord (norva-catalog /intro-markers).
-- Aucune connexion provider, auto-correctif (les upserts raffinent la médiane).
create table if not exists public.catalog_intro_signals (
  provider_tmdb_id text not null,
  season int not null,
  user_id uuid not null,
  seek_from int not null,
  seek_to int not null,
  updated_at timestamptz not null default now(),
  primary key (provider_tmdb_id, season, user_id)
);

alter table public.catalog_intro_signals enable row level security;
-- Accès uniquement via les edge functions (service role) — pas de policy anon/authenticated.
