-- =============================================================================
-- Centre de notifications Marketing v1
-- =============================================================================
-- - campagnes push programmables, avec livraison at-most-once ;
-- - automations push personnalisées sur les événements applicatifs sûrs déjà
--   produits par cloud_content_events ;
-- - catalogue en lecture seule des notifications transactionnelles protégées ;
-- - RPC Admin dédiées : aucune écriture directe depuis le navigateur.
--
-- Les jobs passés à processing ne sont jamais réclamés une seconde fois. Si le
-- worker disparaît après un envoi FCM mais avant l'accusé DB, le job passe en
-- failed avec un résultat « inconnu » : l'Admin peut le dupliquer, mais le
-- système ne risque pas de pousser le même message automatiquement deux fois.

create table if not exists public.marketing_notification_schedules (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 2 and 60),
  body text not null check (char_length(btrim(body)) between 2 and 240),
  audience text not null default 'all'
    check (audience in ('all', 'trialing', 'paying', 'monthly', 'free')),
  scheduled_for timestamptz not null,
  timezone text not null default 'Europe/Paris'
    check (char_length(timezone) between 1 and 64),
  status text not null default 'draft'
    check (status in ('draft', 'scheduled', 'processing', 'sent', 'canceled', 'failed')),
  created_by uuid,
  actor text,
  version integer not null default 1 check (version > 0),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  sent_count integer not null default 0 check (sent_count >= 0),
  fail_count integer not null default 0 check (fail_count >= 0),
  dead_count integer not null default 0 check (dead_count >= 0),
  lease_token uuid,
  started_at timestamptz,
  sent_at timestamptz,
  canceled_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists marketing_notification_schedules_due_idx
  on public.marketing_notification_schedules (scheduled_for, created_at)
  where status = 'scheduled';
create index if not exists marketing_notification_schedules_admin_idx
  on public.marketing_notification_schedules (created_at desc);

alter table public.marketing_notification_schedules enable row level security;
revoke all on table public.marketing_notification_schedules from public, anon, authenticated;
grant all on table public.marketing_notification_schedules to service_role;

create table if not exists public.marketing_notification_automation_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 80),
  event_key text not null
    check (event_key in ('new_content', 'subtitle_ready', 'subtitle_empty', 'subtitle_failed')),
  title_template text not null check (char_length(btrim(title_template)) between 2 and 60),
  body_template text not null check (char_length(btrim(body_template)) between 2 and 240),
  delay_minutes integer not null default 0 check (delay_minutes between 0 and 10080),
  enabled boolean not null default false,
  created_by uuid,
  actor text,
  version integer not null default 1 check (version > 0),
  event_count bigint not null default 0 check (event_count >= 0),
  sent_count bigint not null default 0 check (sent_count >= 0),
  fail_count bigint not null default 0 check (fail_count >= 0),
  last_run_at timestamptz,
  last_error text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists marketing_notification_rules_admin_idx
  on public.marketing_notification_automation_rules (archived_at, enabled desc, updated_at desc);
create index if not exists marketing_notification_rules_event_idx
  on public.marketing_notification_automation_rules (event_key)
  where enabled and archived_at is null;

alter table public.marketing_notification_automation_rules enable row level security;
revoke all on table public.marketing_notification_automation_rules from public, anon, authenticated;
grant all on table public.marketing_notification_automation_rules to service_role;

create table if not exists public.marketing_notification_automation_queue (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid not null references public.marketing_notification_automation_rules(id) on delete cascade,
  source_event_id uuid not null references public.cloud_content_events(id) on delete cascade,
  event_key text not null,
  user_id uuid not null,
  title text not null check (char_length(btrim(title)) between 2 and 60),
  body text not null check (char_length(btrim(body)) between 2 and 240),
  scheduled_for timestamptz not null,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'sent', 'canceled', 'failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  sent_count integer not null default 0 check (sent_count >= 0),
  fail_count integer not null default 0 check (fail_count >= 0),
  dead_count integer not null default 0 check (dead_count >= 0),
  started_at timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (rule_id, source_event_id)
);

create index if not exists marketing_notification_automation_due_idx
  on public.marketing_notification_automation_queue (scheduled_for, created_at)
  where status = 'queued';
create index if not exists marketing_notification_automation_rule_history_idx
  on public.marketing_notification_automation_queue (rule_id, created_at desc);

alter table public.marketing_notification_automation_queue enable row level security;
revoke all on table public.marketing_notification_automation_queue from public, anon, authenticated;
grant all on table public.marketing_notification_automation_queue to service_role;

alter table public.marketing_push_log
  add column if not exists origin text not null default 'immediate',
  add column if not exists schedule_id uuid;

do $constraints$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'marketing_push_log_origin_check'
      and conrelid = 'public.marketing_push_log'::regclass
  ) then
    alter table public.marketing_push_log
      add constraint marketing_push_log_origin_check
      check (origin in ('immediate', 'scheduled'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'marketing_push_log_schedule_id_fkey'
      and conrelid = 'public.marketing_push_log'::regclass
  ) then
    alter table public.marketing_push_log
      add constraint marketing_push_log_schedule_id_fkey
      foreign key (schedule_id)
      references public.marketing_notification_schedules(id)
      on delete set null;
  end if;
end
$constraints$;

-- ── Helpers Admin ─────────────────────────────────────────────────────────────

create or replace function public.admin_marketing_notification_center_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'scheduled', (
      select count(*) from public.marketing_notification_schedules where status = 'scheduled'
    ),
    'drafts', (
      select count(*) from public.marketing_notification_schedules where status = 'draft'
    ),
    'active_automations', (
      select count(*) from public.marketing_notification_automation_rules
      where enabled and archived_at is null
    ),
    'automation_failures_7d', (
      select count(*) from public.marketing_notification_automation_queue
      where status = 'failed' and updated_at >= now() - interval '7 days'
    ),
    'next_scheduled_at', (
      select min(scheduled_for) from public.marketing_notification_schedules where status = 'scheduled'
    ),
    'sent_30d', (
      select count(*) from public.marketing_push_log where created_at >= now() - interval '30 days'
    )
  );
end;
$$;

create or replace function public.admin_marketing_notification_schedules(
  p_status text default null,
  p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 200);
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_status is not null and p_status not in ('draft', 'scheduled', 'processing', 'sent', 'canceled', 'failed') then
    raise exception 'invalid status' using errcode = '22023';
  end if;

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id,
      'title', s.title,
      'body', s.body,
      'audience', s.audience,
      'scheduled_for', s.scheduled_for,
      'timezone', s.timezone,
      'status', s.status,
      'version', s.version,
      'sent_count', s.sent_count,
      'fail_count', s.fail_count,
      'dead_count', s.dead_count,
      'actor', s.actor,
      'last_error', s.last_error,
      'created_at', s.created_at,
      'updated_at', s.updated_at
    ) order by
      case when s.status = 'scheduled' then 0 else 1 end,
      case when s.status = 'scheduled' then s.scheduled_for end asc,
      s.created_at desc), '[]'::jsonb)
    from (
      select *
      from public.marketing_notification_schedules
      where p_status is null or status = p_status
      order by
        case when status = 'scheduled' then 0 else 1 end,
        case when status = 'scheduled' then scheduled_for end asc,
        created_at desc
      limit v_limit
    ) s
  );
end;
$$;

create or replace function public.admin_save_marketing_notification_schedule(
  p_title text,
  p_body text,
  p_audience text,
  p_scheduled_for timestamptz,
  p_timezone text default 'Europe/Paris',
  p_id uuid default null,
  p_publish boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.marketing_notification_schedules%rowtype;
  v_actor text;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_title, ''))) not between 2 and 60 then
    raise exception 'title must be 2..60 characters' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_body, ''))) not between 2 and 240 then
    raise exception 'body must be 2..240 characters' using errcode = '22023';
  end if;
  if p_audience not in ('all', 'trialing', 'paying', 'monthly', 'free') then
    raise exception 'invalid audience' using errcode = '22023';
  end if;
  if p_scheduled_for is null or p_scheduled_for > now() + interval '365 days' then
    raise exception 'scheduled time must be within 365 days' using errcode = '22023';
  end if;
  if p_publish and p_scheduled_for < now() + interval '1 minute' then
    raise exception 'scheduled time must be at least one minute in the future' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_timezone, ''))) not between 1 and 64
     or p_timezone !~ '^[A-Za-z0-9_+./-]+$' then
    raise exception 'invalid timezone' using errcode = '22023';
  end if;

  select u.email::text into v_actor from auth.users u where u.id = auth.uid();

  if p_id is null then
    insert into public.marketing_notification_schedules (
      title, body, audience, scheduled_for, timezone, status, created_by, actor
    ) values (
      btrim(p_title), btrim(p_body), p_audience, p_scheduled_for, btrim(p_timezone),
      case when p_publish then 'scheduled' else 'draft' end,
      auth.uid(), v_actor
    ) returning * into v_row;
  else
    update public.marketing_notification_schedules s
       set title = btrim(p_title),
           body = btrim(p_body),
           audience = p_audience,
           scheduled_for = p_scheduled_for,
           timezone = btrim(p_timezone),
           status = case when p_publish then 'scheduled' else 'draft' end,
           actor = coalesce(v_actor, s.actor),
           version = s.version + 1,
           sent_count = 0,
           fail_count = 0,
           dead_count = 0,
           started_at = null,
           sent_at = null,
           canceled_at = null,
           last_error = null,
           updated_at = now()
     where s.id = p_id
       and s.status in ('draft', 'scheduled', 'failed')
     returning * into v_row;
    if not found then
      raise exception 'schedule is immutable or missing' using errcode = '55000';
    end if;
  end if;

  return jsonb_build_object(
    'id', v_row.id,
    'status', v_row.status,
    'scheduled_for', v_row.scheduled_for,
    'version', v_row.version
  );
end;
$$;

create or replace function public.admin_cancel_marketing_notification_schedule(
  p_id uuid,
  p_reason text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  update public.marketing_notification_schedules
     set status = 'canceled',
         canceled_at = now(),
         last_error = left(nullif(btrim(coalesce(p_reason, '')), ''), 300),
         updated_at = now(),
         version = version + 1
   where id = p_id
     and status in ('draft', 'scheduled', 'failed');
  return found;
end;
$$;

create or replace function public.admin_marketing_notification_rules()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id,
      'name', r.name,
      'event_key', r.event_key,
      'title_template', r.title_template,
      'body_template', r.body_template,
      'delay_minutes', r.delay_minutes,
      'enabled', r.enabled,
      'version', r.version,
      'event_count', r.event_count,
      'sent_count', r.sent_count,
      'fail_count', r.fail_count,
      'last_run_at', r.last_run_at,
      'last_error', r.last_error,
      'actor', r.actor,
      'updated_at', r.updated_at,
      'queued_count', (
        select count(*) from public.marketing_notification_automation_queue q
        where q.rule_id = r.id and q.status = 'queued'
      )
    ) order by r.enabled desc, r.updated_at desc), '[]'::jsonb)
    from public.marketing_notification_automation_rules r
    where r.archived_at is null
  );
end;
$$;

create or replace function public.admin_save_marketing_notification_rule(
  p_name text,
  p_event_key text,
  p_title_template text,
  p_body_template text,
  p_delay_minutes integer default 0,
  p_enabled boolean default false,
  p_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.marketing_notification_automation_rules%rowtype;
  v_actor text;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_name, ''))) not between 2 and 80 then
    raise exception 'name must be 2..80 characters' using errcode = '22023';
  end if;
  if p_event_key not in ('new_content', 'subtitle_ready', 'subtitle_empty', 'subtitle_failed') then
    raise exception 'unsupported event' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_title_template, ''))) not between 2 and 60 then
    raise exception 'title template must be 2..60 characters' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_body_template, ''))) not between 2 and 240 then
    raise exception 'body template must be 2..240 characters' using errcode = '22023';
  end if;
  if coalesce(p_delay_minutes, 0) not between 0 and 10080 then
    raise exception 'delay must be between 0 and 10080 minutes' using errcode = '22023';
  end if;

  select u.email::text into v_actor from auth.users u where u.id = auth.uid();

  if p_id is null then
    insert into public.marketing_notification_automation_rules (
      name, event_key, title_template, body_template, delay_minutes,
      enabled, created_by, actor
    ) values (
      btrim(p_name), p_event_key, btrim(p_title_template), btrim(p_body_template),
      coalesce(p_delay_minutes, 0), coalesce(p_enabled, false), auth.uid(), v_actor
    ) returning * into v_row;
  else
    update public.marketing_notification_automation_rules r
       set name = btrim(p_name),
           event_key = p_event_key,
           title_template = btrim(p_title_template),
           body_template = btrim(p_body_template),
           delay_minutes = coalesce(p_delay_minutes, 0),
           enabled = coalesce(p_enabled, false),
           actor = coalesce(v_actor, r.actor),
           version = r.version + 1,
           last_error = null,
           updated_at = now()
     where r.id = p_id and r.archived_at is null
     returning * into v_row;
    if not found then
      raise exception 'automation rule missing' using errcode = 'P0002';
    end if;

    -- Les messages déjà rendus ne doivent pas partir après une modification de
    -- règle : les futurs événements seront préparés avec la nouvelle version.
    update public.marketing_notification_automation_queue
       set status = 'canceled',
           last_error = 'Rule edited before delivery',
           updated_at = now()
     where rule_id = p_id and status = 'queued';
  end if;

  return jsonb_build_object(
    'id', v_row.id,
    'enabled', v_row.enabled,
    'version', v_row.version
  );
end;
$$;

create or replace function public.admin_archive_marketing_notification_rule(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  update public.marketing_notification_automation_rules
     set enabled = false,
         archived_at = now(),
         updated_at = now(),
         version = version + 1
   where id = p_id and archived_at is null;
  if not found then return false; end if;

  update public.marketing_notification_automation_queue
     set status = 'canceled',
         last_error = 'Rule archived before delivery',
         updated_at = now()
   where rule_id = p_id and status = 'queued';
  return true;
end;
$$;

-- Inventaire explicite des moteurs transactionnels existants. Ces lignes ne
-- sont pas des interrupteurs : elles documentent les règles protégées et leur
-- véritable mécanisme de contrôle.
create or replace function public.admin_marketing_system_automations()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return jsonb_build_array(
    jsonb_build_object('id','security-account','name','Sécurité du compte','trigger','Mot de passe, e-mail ou nouvel appareil','channels',jsonb_build_array('E-mail'),'state','active','control','protected','description','Transactionnel et non désactivable depuis Marketing.'),
    jsonb_build_object('id','billing-lifecycle','name','Échec de paiement et win-back','trigger','Événement de facturation confirmé','channels',jsonb_build_array('E-mail','Push conditionnel'),'state','active','control','protected','description','Suit les garde-fous du ledger et du worker lifecycle.'),
    jsonb_build_object('id','trial-ending','name','Fin d’essai','trigger','J-3 et J-1 avant échéance','channels',jsonb_build_array('E-mail'),'state','active','control','protected','description','Échéances calculées par le moteur d’abonnement.'),
    jsonb_build_object('id','import-lifecycle','name','Import terminé ou en échec','trigger','Fin du traitement d’une source','channels',jsonb_build_array('E-mail','Push'),'state','active','control','protected','description','Livraison transactionnelle avec outbox et reprise.'),
    jsonb_build_object('id','new-content','name','Nouveautés du catalogue','trigger','Événement new_content','channels',jsonb_build_array('Dans l’app'),'state','active','control','extendable','event_key','new_content','description','Le message système reste protégé ; un push complémentaire peut être créé ici.'),
    jsonb_build_object('id','subtitle-status','name','Résultat des sous-titres IA','trigger','Prêt, vide ou en échec','channels',jsonb_build_array('E-mail','Dans l’app'),'state','active','control','extendable','event_key','subtitle_ready','description','Le tunnel transactionnel reste protégé ; un push complémentaire peut être créé ici.'),
    jsonb_build_object('id','provider-access','name','Accès fournisseur','trigger','Expiration, masquage ou restauration','channels',jsonb_build_array('E-mail','Push','Dans l’app'),'state','deployment_controlled','control','protected','description','Piloté par feature flags et gates de déploiement, jamais par Marketing.'),
    jsonb_build_object('id','support-replies','name','Réponses du support','trigger','Nouvelle réponse dans un ticket','channels',jsonb_build_array('Dans l’app'),'state','active','control','protected','description','Lié à l’état du ticket et à son destinataire.')
  );
end;
$$;

-- ── Préparation des automations ───────────────────────────────────────────────

create or replace function public.render_marketing_notification_template(
  p_template text,
  p_kind text,
  p_summary text,
  p_payload jsonb,
  p_limit integer
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_result text := coalesce(p_template, '');
  v_title text := coalesce(p_payload ->> 'title', p_payload ->> 'titleLabel', p_payload ->> 'label', '');
begin
  v_result := replace(v_result, '{{summary}}', coalesce(p_summary, ''));
  v_result := replace(v_result, '{{event}}', coalesce(p_kind, ''));
  v_result := replace(v_result, '{{title}}', v_title);
  return left(btrim(v_result), greatest(2, p_limit));
end;
$$;

create or replace function public.enqueue_marketing_notification_automations()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.marketing_notification_automation_rules%rowtype;
  v_title text;
  v_body text;
begin
  if new.kind not in ('new_content', 'subtitle_ready', 'subtitle_empty', 'subtitle_failed') then
    return new;
  end if;

  for r in
    select * from public.marketing_notification_automation_rules
    where enabled and archived_at is null and event_key = new.kind
  loop
    v_title := public.render_marketing_notification_template(
      r.title_template, new.kind, new.summary, new.payload, 60
    );
    v_body := public.render_marketing_notification_template(
      r.body_template, new.kind, new.summary, new.payload, 240
    );

    if char_length(v_title) < 2 then v_title := 'Norva'; end if;
    if char_length(v_body) < 2 then v_body := left(new.summary, 240); end if;

    insert into public.marketing_notification_automation_queue (
      rule_id, source_event_id, event_key, user_id, title, body, scheduled_for
    ) values (
      r.id, new.id, new.kind, new.user_id, v_title, v_body,
      now() + make_interval(mins => r.delay_minutes)
    ) on conflict (rule_id, source_event_id) do nothing;
  end loop;

  return new;
exception when others then
  -- Une automation Marketing ne doit jamais empêcher la création de la cloche
  -- ou de l’événement transactionnel source.
  return new;
end;
$$;

drop trigger if exists trg_enqueue_marketing_notification_automations
  on public.cloud_content_events;
create trigger trg_enqueue_marketing_notification_automations
after insert on public.cloud_content_events
for each row execute function public.enqueue_marketing_notification_automations();

-- ── Worker service-role : claim at-most-once + accusés ───────────────────────

create or replace function public.claim_due_marketing_notification_schedules(
  p_limit integer default 5
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_limit integer := least(greatest(coalesce(p_limit, 5), 1), 20);
begin
  -- Un processing abandonné est explicitement marqué inconnu. Il ne retourne
  -- jamais dans la file, ce qui conserve la garantie at-most-once.
  update public.marketing_notification_schedules
     set status = 'failed',
         last_error = 'Delivery outcome unknown after worker interruption; duplicate manually only after review',
         updated_at = now()
   where status = 'processing'
     and started_at < now() - interval '15 minutes';

  with candidates as (
    select s.id
    from public.marketing_notification_schedules s
    where s.status = 'scheduled' and s.scheduled_for <= now()
    order by s.scheduled_for, s.created_at
    for update skip locked
    limit v_limit
  ), claimed as (
    update public.marketing_notification_schedules s
       set status = 'processing',
           attempt_count = s.attempt_count + 1,
           started_at = now(),
           updated_at = now()
      from candidates c
     where s.id = c.id
     returning s.id, s.title, s.body, s.audience, s.actor
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'title', title, 'body', body, 'audience', audience, 'actor', actor
  )), '[]'::jsonb)
    into v_result
    from claimed;

  return coalesce(v_result, '[]'::jsonb);
end;
$$;

create or replace function public.complete_marketing_notification_schedule(
  p_id uuid,
  p_sent integer,
  p_fail integer,
  p_dead integer,
  p_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.marketing_notification_schedules%rowtype;
begin
  update public.marketing_notification_schedules s
     set status = case when nullif(btrim(coalesce(p_error, '')), '') is null then 'sent' else 'failed' end,
         sent_count = greatest(coalesce(p_sent, 0), 0),
         fail_count = greatest(coalesce(p_fail, 0), 0),
         dead_count = greatest(coalesce(p_dead, 0), 0),
         sent_at = case when nullif(btrim(coalesce(p_error, '')), '') is null then now() else null end,
         last_error = left(nullif(btrim(coalesce(p_error, '')), ''), 300),
         updated_at = now()
   where s.id = p_id and s.status = 'processing'
   returning * into v_row;

  if not found then return false; end if;

  if v_row.status = 'sent' then
    insert into public.marketing_push_log (
      title, body, audience, sent_count, fail_count, dead_count,
      actor, origin, schedule_id
    ) values (
      v_row.title, v_row.body, v_row.audience, v_row.sent_count,
      v_row.fail_count, v_row.dead_count, v_row.actor, 'scheduled', v_row.id
    );
  end if;
  return true;
end;
$$;

create or replace function public.claim_due_marketing_notification_automations(
  p_limit integer default 20
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
begin
  update public.marketing_notification_automation_queue q
     set status = 'failed',
         last_error = 'Delivery outcome unknown after worker interruption; not retried automatically',
         updated_at = now()
   where q.status = 'processing'
     and q.started_at < now() - interval '15 minutes';

  with candidates as (
    select q.id
    from public.marketing_notification_automation_queue q
    join public.marketing_notification_automation_rules r on r.id = q.rule_id
    where q.status = 'queued'
      and q.scheduled_for <= now()
      and r.enabled
      and r.archived_at is null
    order by q.scheduled_for, q.created_at
    for update of q skip locked
    limit v_limit
  ), claimed as (
    update public.marketing_notification_automation_queue q
       set status = 'processing',
           attempt_count = q.attempt_count + 1,
           started_at = now(),
           updated_at = now()
      from candidates c
     where q.id = c.id
     returning q.id, q.rule_id, q.user_id, q.title, q.body, q.event_key
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id,
    'rule_id', rule_id,
    'user_id', user_id,
    'title', title,
    'body', body,
    'event_key', event_key
  )), '[]'::jsonb)
    into v_result
    from claimed;

  return coalesce(v_result, '[]'::jsonb);
end;
$$;

create or replace function public.complete_marketing_notification_automation(
  p_id uuid,
  p_sent integer,
  p_fail integer,
  p_dead integer,
  p_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.marketing_notification_automation_queue%rowtype;
begin
  update public.marketing_notification_automation_queue q
     set status = case when nullif(btrim(coalesce(p_error, '')), '') is null then 'sent' else 'failed' end,
         sent_count = greatest(coalesce(p_sent, 0), 0),
         fail_count = greatest(coalesce(p_fail, 0), 0),
         dead_count = greatest(coalesce(p_dead, 0), 0),
         sent_at = case when nullif(btrim(coalesce(p_error, '')), '') is null then now() else null end,
         last_error = left(nullif(btrim(coalesce(p_error, '')), ''), 300),
         updated_at = now()
   where q.id = p_id and q.status = 'processing'
   returning * into v_row;

  if not found then return false; end if;

  update public.marketing_notification_automation_rules r
     set event_count = r.event_count + 1,
         sent_count = r.sent_count + v_row.sent_count,
         fail_count = r.fail_count + v_row.fail_count + case when v_row.status = 'failed' then 1 else 0 end,
         last_run_at = now(),
         last_error = v_row.last_error,
         updated_at = now()
   where r.id = v_row.rule_id;
  return true;
end;
$$;

create or replace function public.prune_marketing_notification_center()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.marketing_notification_automation_queue
   where status in ('sent', 'canceled', 'failed')
     and updated_at < now() - interval '90 days';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Le navigateur authentifié n'obtient que les RPC Admin. Les claims et accusés
-- restent service-role-only, même si leur nom est découvert via PostgREST.
revoke all on function public.admin_marketing_notification_center_overview() from public, anon, authenticated;
revoke all on function public.admin_marketing_notification_schedules(text, integer) from public, anon, authenticated;
revoke all on function public.admin_save_marketing_notification_schedule(text, text, text, timestamptz, text, uuid, boolean) from public, anon, authenticated;
revoke all on function public.admin_cancel_marketing_notification_schedule(uuid, text) from public, anon, authenticated;
revoke all on function public.admin_marketing_notification_rules() from public, anon, authenticated;
revoke all on function public.admin_save_marketing_notification_rule(text, text, text, text, integer, boolean, uuid) from public, anon, authenticated;
revoke all on function public.admin_archive_marketing_notification_rule(uuid) from public, anon, authenticated;
revoke all on function public.admin_marketing_system_automations() from public, anon, authenticated;

grant execute on function public.admin_marketing_notification_center_overview() to authenticated, service_role;
grant execute on function public.admin_marketing_notification_schedules(text, integer) to authenticated, service_role;
grant execute on function public.admin_save_marketing_notification_schedule(text, text, text, timestamptz, text, uuid, boolean) to authenticated, service_role;
grant execute on function public.admin_cancel_marketing_notification_schedule(uuid, text) to authenticated, service_role;
grant execute on function public.admin_marketing_notification_rules() to authenticated, service_role;
grant execute on function public.admin_save_marketing_notification_rule(text, text, text, text, integer, boolean, uuid) to authenticated, service_role;
grant execute on function public.admin_archive_marketing_notification_rule(uuid) to authenticated, service_role;
grant execute on function public.admin_marketing_system_automations() to authenticated, service_role;

revoke all on function public.render_marketing_notification_template(text, text, text, jsonb, integer) from public, anon, authenticated;
revoke all on function public.enqueue_marketing_notification_automations() from public, anon, authenticated;
revoke all on function public.claim_due_marketing_notification_schedules(integer) from public, anon, authenticated;
revoke all on function public.complete_marketing_notification_schedule(uuid, integer, integer, integer, text) from public, anon, authenticated;
revoke all on function public.claim_due_marketing_notification_automations(integer) from public, anon, authenticated;
revoke all on function public.complete_marketing_notification_automation(uuid, integer, integer, integer, text) from public, anon, authenticated;
revoke all on function public.prune_marketing_notification_center() from public, anon, authenticated;

grant execute on function public.claim_due_marketing_notification_schedules(integer) to service_role;
grant execute on function public.complete_marketing_notification_schedule(uuid, integer, integer, integer, text) to service_role;
grant execute on function public.claim_due_marketing_notification_automations(integer) to service_role;
grant execute on function public.complete_marketing_notification_automation(uuid, integer, integer, integer, text) to service_role;
grant execute on function public.prune_marketing_notification_center() to service_role;

-- Historique enrichi (origine immédiate ou programmée).
drop function if exists public.admin_marketing_push_log(text, text, integer);
create function public.admin_marketing_push_log(
  p_query text default null,
  p_audience text default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', l.id,
      'title', l.title,
      'body', l.body,
      'audience', l.audience,
      'sent_count', l.sent_count,
      'fail_count', l.fail_count,
      'dead_count', l.dead_count,
      'actor', l.actor,
      'origin', l.origin,
      'schedule_id', l.schedule_id,
      'created_at', l.created_at
    ) order by l.created_at desc), '[]'::jsonb)
    from (
      select * from public.marketing_push_log
      where (p_audience is null or audience = p_audience)
        and (
          p_query is null or btrim(p_query) = ''
          or title ilike '%' || btrim(p_query) || '%'
          or body ilike '%' || btrim(p_query) || '%'
          or coalesce(actor, '') ilike '%' || btrim(p_query) || '%'
        )
      order by created_at desc
      limit v_limit
    ) l
  );
end;
$$;
revoke all on function public.admin_marketing_push_log(text, text, integer) from public, anon, authenticated;
grant execute on function public.admin_marketing_push_log(text, text, integer) to authenticated, service_role;

-- Cron self-host : clone la route ops existante lorsqu'elle est disponible afin
-- de conserver l'URL et le secret déjà validés. Le fallback utilise l'endpoint
-- canonique self-host et le secret cron du Vault, sans jamais matérialiser sa
-- valeur dans la migration.
do $cron_install$
declare
  v_command text;
begin
  if pg_catalog.to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron absent; notification center worker not scheduled';
    return;
  end if;

  select j.command into v_command
  from cron.job j
  where j.jobname = 'norva-ops-alert'
  limit 1;

  if v_command is not null then
    v_command := replace(
      v_command,
      '/norva-admin/ops-alert',
      '/norva-admin/notification-center-drain'
    );
  elsif exists (
    select 1 from vault.decrypted_secrets
    where name = 'norva_cron_shared_secret' and decrypted_secret <> ''
  ) then
    v_command := $job$
select net.http_post(
  url := 'https://api.norva.tv/functions/v1/norva-admin/notification-center-drain',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || (
      select decrypted_secret from vault.decrypted_secrets
      where name = 'norva_cron_shared_secret' limit 1
    )
  ),
  body := '{}'::jsonb,
  timeout_milliseconds := 50000
);
$job$;
  else
    raise notice 'notification center worker not scheduled: no reusable cron or Vault secret';
    return;
  end if;

  perform cron.schedule('norva-notification-center-drain', '* * * * *', v_command);
end;
$cron_install$;

notify pgrst, 'reload schema';
