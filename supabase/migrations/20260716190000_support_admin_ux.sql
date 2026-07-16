-- =============================================================================
-- Support admin UX : compteurs exacts, pagination + recherche serveur, priorité.
-- =============================================================================
-- Audit UX 2026-07-16 (onglet Support du CRM), 3 correctifs de fond :
--
--   (1) COMPTEURS FAUX (P1) — les onglets/cartes affichaient `open` (= tout non-fermé,
--       open + pending) et `in_progress` (last_from<>user) alors que la LISTE filtre
--       status='open' / 'pending' EXACTEMENT → « Ouverts : 12 » mais 8 lignes.
--       → admin_support_counts gagne `open_exact` / `pending_exact`, et
--         admin_support_list gagne le filtre 'active' (tout non-fermé) pour que la
--         carte « Tickets actifs » (compte `open`) ait une destination exacte.
--
--   (2) PAS DE PAGINATION NI RECHERCHE SERVEUR (P1) — cap dur à 100, total ignoré,
--       recherche client-side sur les seules lignes chargées (au-delà : invisibles).
--       → admin_support_list gagne p_search (email / sujet / corps des messages,
--         volumes tickets = petits) ; l'UI pagine sur `total` (déjà renvoyé).
--       Le RPC renvoie aussi `open_total` (non-fermés du scope user) pour la chip
--       « Tickets ouverts » de la fiche (avant : comptée sur les 10 lignes chargées).
--
--   (3) PRIORITÉ INVISIBLE (P2) — le schéma porte priority (low/normal/high) mais
--       aucune UI ne l'affichait ni ne la modifiait.
--       → nouveau RPC admin_support_set_priority (chip + sélecteur côté CRM).
--
-- ⚠️ admin_support_list change de signature (5 args) : DROP de la 4-args d'abord,
--    sinon surcharge → appels PostgREST ambigus (même précaution que 20260701230000).
-- =============================================================================

-- ── (1) Compteurs exacts ─────────────────────────────────────────────────────────────
create or replace function public.admin_support_counts()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'open',          (select count(*) from cloud_support_tickets where status <> 'closed'),
    'open_exact',    (select count(*) from cloud_support_tickets where status = 'open'),
    'pending_exact', (select count(*) from cloud_support_tickets where status = 'pending'),
    'needs_reply',   (select count(*) from cloud_support_tickets where status <> 'closed' and last_from = 'user'),
    'in_progress',   (select count(*) from cloud_support_tickets where status <> 'closed' and last_from <> 'user'),
    'stale_24h',     (select count(*) from cloud_support_tickets where status <> 'closed' and last_from = 'user' and last_message_at < now() - interval '24 hours'),
    'resolved_7d',   (select count(*) from cloud_support_tickets where status = 'closed' and updated_at > now() - interval '7 days'),
    'resolved_30d',  (select count(*) from cloud_support_tickets where status = 'closed' and updated_at > now() - interval '30 days')
  ) where public.is_admin();
$$;
revoke all on function public.admin_support_counts() from public, anon;
grant execute on function public.admin_support_counts() to authenticated;

-- ── (2) Liste : filtre 'active' + recherche serveur + open_total ─────────────────────
drop function if exists public.admin_support_list(text, uuid, int, int);
create or replace function public.admin_support_list(
  p_status  text default null,   -- 'needs_reply' | 'active' | 'open' | 'pending' | 'closed' | null (tous)
  p_user_id uuid default null,
  p_limit   int  default 50,
  p_offset  int  default 0,
  p_search  text default null    -- ilike sur email client / sujet / corps des messages
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_rows jsonb; v_total bigint; v_open bigint; v_q text := nullif(btrim(coalesce(p_search, '')), '');
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  select count(*) into v_total from cloud_support_tickets t
   left join auth.users u on u.id = t.user_id
   where (p_user_id is null or t.user_id = p_user_id)
     and (p_status is null
       or (p_status = 'needs_reply' and t.status <> 'closed' and t.last_from = 'user')
       or (p_status = 'active'      and t.status <> 'closed')
       or (p_status in ('open', 'pending', 'closed') and t.status = p_status))
     and (v_q is null
       or t.subject ilike '%' || v_q || '%'
       or u.email ilike '%' || v_q || '%'
       or exists (select 1 from cloud_support_messages ms where ms.ticket_id = t.id and ms.body ilike '%' || v_q || '%'));
  select count(*) into v_open from cloud_support_tickets t
   where (p_user_id is null or t.user_id = p_user_id) and t.status <> 'closed';
  select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) into v_rows from (
    select t.id, t.user_id, u.email::text as email, t.subject, t.status, t.priority, t.last_from,
           t.last_message_at, t.created_at,
           (select count(*) from cloud_support_messages m where m.ticket_id = t.id) as msg_count,
           (select left(m.body, 140) from cloud_support_messages m where m.ticket_id = t.id order by m.created_at desc limit 1) as last_body
    from cloud_support_tickets t
    left join auth.users u on u.id = t.user_id
    where (p_user_id is null or t.user_id = p_user_id)
      and (p_status is null
        or (p_status = 'needs_reply' and t.status <> 'closed' and t.last_from = 'user')
        or (p_status = 'active'      and t.status <> 'closed')
        or (p_status in ('open', 'pending', 'closed') and t.status = p_status))
      and (v_q is null
        or t.subject ilike '%' || v_q || '%'
        or u.email ilike '%' || v_q || '%'
        or exists (select 1 from cloud_support_messages ms where ms.ticket_id = t.id and ms.body ilike '%' || v_q || '%'))
    order by (t.status <> 'closed' and t.last_from = 'user') desc, t.last_message_at desc
    limit greatest(1, least(200, coalesce(p_limit, 50))) offset greatest(0, coalesce(p_offset, 0))
  ) x;
  return jsonb_build_object('total', v_total, 'open_total', v_open, 'rows', v_rows);
end; $$;
revoke all on function public.admin_support_list(text, uuid, int, int, text) from public, anon;
grant execute on function public.admin_support_list(text, uuid, int, int, text) to authenticated;

-- ── (3) Priorité ─────────────────────────────────────────────────────────────────────
create or replace function public.admin_support_set_priority(p_id uuid, p_priority text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_user uuid;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_priority not in ('low', 'normal', 'high') then raise exception 'bad priority'; end if;
  update cloud_support_tickets set priority = p_priority, updated_at = now() where id = p_id
  returning user_id into v_user;
  if v_user is null then raise exception 'ticket not found' using errcode = 'P0002'; end if;
  insert into admin_events (user_id, kind, summary, actor)
  values (v_user, 'admin_action', 'Priorité ticket → ' || p_priority, nullif(auth.jwt() ->> 'email', ''));
  return jsonb_build_object('priority', p_priority);
end; $$;
revoke all on function public.admin_support_set_priority(uuid, text) from public, anon;
grant execute on function public.admin_support_set_priority(uuid, text) to authenticated;
