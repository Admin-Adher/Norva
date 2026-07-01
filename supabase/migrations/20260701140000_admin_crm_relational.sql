-- Admin CRM — relational foundations (what turns an Ops dashboard into a CRM):
--   • admin_notes        : internal free-text notes per client (who + when).
--   • admin_tags         : the tag/segment catalog (VIP, à risque, pilote…).
--   • admin_client_tags  : which client carries which tag.
--   • admin_events       : real timeline events (notes, tags, admin actions). The read RPC UNIONs
--     these with SYNTHETIC events derived from existing data (signup, provider added, sync) so the
--     timeline is useful immediately without waiting for lifecycle hooks.
-- All tables RLS-on with NO policies → reachable only through the is_admin()-gated SECURITY DEFINER
-- RPCs below. Author of an action = the admin's JWT email.

create table if not exists public.admin_notes (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,
  body         text not null,
  author_email text,
  created_at   timestamptz not null default now()
);
create index if not exists idx_admin_notes_user on public.admin_notes(user_id, created_at desc);
alter table public.admin_notes enable row level security;

create table if not exists public.admin_tags (
  id         uuid primary key default gen_random_uuid(),
  label      text not null unique,
  color      text not null default 'gray',  -- badge palette: gray|green|red|amber|blue
  created_at timestamptz not null default now()
);
alter table public.admin_tags enable row level security;

create table if not exists public.admin_client_tags (
  user_id  uuid not null,
  tag_id   uuid not null references public.admin_tags(id) on delete cascade,
  added_by text,
  added_at timestamptz not null default now(),
  primary key (user_id, tag_id)
);
create index if not exists idx_admin_client_tags_user on public.admin_client_tags(user_id);
alter table public.admin_client_tags enable row level security;

create table if not exists public.admin_events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  kind       text not null,             -- note_added|tag_added|tag_removed|resync|admin_action|…
  summary    text not null,
  meta       jsonb not null default '{}'::jsonb,
  actor      text,
  created_at timestamptz not null default now()
);
create index if not exists idx_admin_events_user on public.admin_events(user_id, created_at desc);
alter table public.admin_events enable row level security;

-- Seed a starter segment palette (id-stable via label unique; safe to re-run).
insert into public.admin_tags(label, color) values
  ('VIP','amber'), ('À risque','red'), ('Pilote','blue'), ('Nouveau','green'), ('Support','gray')
on conflict (label) do nothing;

-- ── Read: everything the fiche's relational panels need, one round-trip ──
create or replace function public.admin_client_crm(p_user_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_tags jsonb; v_all jsonb; v_notes jsonb; v_timeline jsonb;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode='42501'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'label',t.label,'color',t.color) order by t.label), '[]'::jsonb)
    into v_tags from public.admin_client_tags ct join public.admin_tags t on t.id=ct.tag_id where ct.user_id=p_user_id;

  select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'label',t.label,'color',t.color) order by t.label), '[]'::jsonb)
    into v_all from public.admin_tags t;

  select coalesce(jsonb_agg(jsonb_build_object('id',n.id,'body',n.body,'author_email',n.author_email,'created_at',n.created_at) order by n.created_at desc), '[]'::jsonb)
    into v_notes from public.admin_notes n where n.user_id=p_user_id;

  select coalesce(jsonb_agg(row_to_json(e) order by e.at desc), '[]'::jsonb) into v_timeline from (
    select 'signup' as kind, 'Compte créé' as summary, u.created_at as at, '{}'::jsonb as meta
      from auth.users u where u.id=p_user_id
    union all
    select 'provider_added', 'Provider ajouté : '||coalesce(s.display_name, left(s.id::text,8)), s.created_at,
           jsonb_build_object('source_id', s.id)
      from cloud_sources s where s.user_id=p_user_id
    union all
    select 'sync', 'Dernier sync : '||coalesce(s.display_name, left(s.id::text,8)), s.last_synced_at,
           jsonb_build_object('source_id', s.id)
      from cloud_sources s where s.user_id=p_user_id and s.last_synced_at is not null
    union all
    select ev.kind, ev.summary, ev.created_at, ev.meta from public.admin_events ev where ev.user_id=p_user_id
    order by at desc nulls last
    limit 60
  ) e;

  return jsonb_build_object('tags', v_tags, 'all_tags', v_all, 'notes', v_notes, 'timeline', v_timeline);
end; $$;

-- ── Mutations ──
create or replace function public.admin_note_add(p_user_id uuid, p_body text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_id uuid; v_email text; v_body text := btrim(coalesce(p_body,''));
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode='42501'; end if;
  if v_body = '' then raise exception 'empty note' using errcode='22023'; end if;
  v_email := nullif(auth.jwt() ->> 'email', '');
  insert into public.admin_notes(user_id, body, author_email) values (p_user_id, left(v_body, 4000), v_email)
    returning id into v_id;
  insert into public.admin_events(user_id, kind, summary, actor)
    values (p_user_id, 'note_added', 'Note ajoutée', v_email);
  return (select jsonb_build_object('id',n.id,'body',n.body,'author_email',n.author_email,'created_at',n.created_at)
          from public.admin_notes n where n.id=v_id);
end; $$;

create or replace function public.admin_note_delete(p_note_id uuid)
returns boolean language plpgsql volatile security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode='42501'; end if;
  delete from public.admin_notes where id=p_note_id;
  return found;
end; $$;

create or replace function public.admin_tag_create(p_label text, p_color text default 'gray')
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_id uuid; v_label text := btrim(coalesce(p_label,''));
        v_color text := lower(coalesce(nullif(btrim(p_color),''),'gray'));
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode='42501'; end if;
  if v_label = '' then raise exception 'empty label' using errcode='22023'; end if;
  if v_color not in ('gray','green','red','amber','blue') then v_color := 'gray'; end if;
  insert into public.admin_tags(label, color) values (left(v_label,40), v_color)
    on conflict (label) do update set color = excluded.color
    returning id into v_id;
  return (select jsonb_build_object('id',t.id,'label',t.label,'color',t.color) from public.admin_tags t where t.id=v_id);
end; $$;

create or replace function public.admin_tag_toggle(p_user_id uuid, p_tag_id uuid, p_on boolean)
returns boolean language plpgsql volatile security definer set search_path = public as $$
declare v_email text; v_label text;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode='42501'; end if;
  v_email := nullif(auth.jwt() ->> 'email', '');
  select label into v_label from public.admin_tags where id=p_tag_id;
  if v_label is null then raise exception 'unknown tag' using errcode='P0002'; end if;
  if p_on then
    insert into public.admin_client_tags(user_id, tag_id, added_by) values (p_user_id, p_tag_id, v_email)
      on conflict do nothing;
    insert into public.admin_events(user_id, kind, summary, actor)
      values (p_user_id, 'tag_added', 'Tag ajouté : '||v_label, v_email);
  else
    delete from public.admin_client_tags where user_id=p_user_id and tag_id=p_tag_id;
    insert into public.admin_events(user_id, kind, summary, actor)
      values (p_user_id, 'tag_removed', 'Tag retiré : '||v_label, v_email);
  end if;
  return p_on;
end; $$;

revoke all on function public.admin_client_crm(uuid), public.admin_note_add(uuid, text),
  public.admin_note_delete(uuid), public.admin_tag_create(text, text),
  public.admin_tag_toggle(uuid, uuid, boolean) from public, anon;
grant execute on function public.admin_client_crm(uuid), public.admin_note_add(uuid, text),
  public.admin_note_delete(uuid), public.admin_tag_create(text, text),
  public.admin_tag_toggle(uuid, uuid, boolean) to authenticated;
