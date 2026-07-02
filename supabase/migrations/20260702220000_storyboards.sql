-- Miniatures de seek (storyboards) — audit UX vs Netflix 2026-07-02, correction #10 web.
--
-- Sprite JPEG unique (≤200 tuiles à intervalle régulier, 212px de large) généré par la
-- gateway en UNE connexion provider (keyframes only), différée par le pregen-gate tant
-- que le compte regarde. Cache cross-user keyé comme les sous-titres IA. Le sprite vit
-- dans le bucket public norva-storyboards ; la gateway y écrit via une URL d'upload
-- signée (jamais de service key côté gateway).
create table if not exists public.catalog_storyboards (
  provider_key text not null,
  item_type text not null,
  external_id text not null,
  status text not null default 'processing', -- processing | ready | failed
  sprite_path text,
  tile_cols int,
  tile_rows int,
  tile_count int,
  interval_sec int,
  job_id uuid,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider_key, item_type, external_id)
);

create index if not exists catalog_storyboards_job_idx on public.catalog_storyboards (job_id);

alter table public.catalog_storyboards enable row level security;
-- Accès uniquement via les edge functions (service role) — pas de policy anon/authenticated.

-- Bucket public en lecture (sprites d'aperçu, aucune donnée sensible).
insert into storage.buckets (id, name, public)
values ('norva-storyboards', 'norva-storyboards', true)
on conflict (id) do nothing;
