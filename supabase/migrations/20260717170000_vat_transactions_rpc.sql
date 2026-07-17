-- =============================================================================
-- admin_vat_transactions : le registre transaction par transaction du trimestre.
-- =============================================================================
-- Couche de confiance du cockpit TVA (niveau 3) — deux usages :
--   1. Drill-down d'une ligne pays de la déclaration : voir CHAQUE transaction qui
--      compose la base (date, client, montant, pays, preuve de localisation) —
--      l'esprit du registre art. 63c règl. 282/2011, consultable à l'écran.
--   2. Résolution des inconnus : p_country='??' liste les transactions SANS pays
--      (celles qui bloquent l'assistant de dépôt) avec le client à ouvrir.
--
-- Preuve de localisation : sur le rail web (revolut, seul rail du périmètre OSS),
-- country_code provient PAR CONSTRUCTION du pays d'émission de la carte (BIN) —
-- item (c) de l'art. 24f, fourni par un tiers de la chaîne de paiement (Revolut).
-- Le champ `evidence` l'expose explicitement par ligne.
-- Cap 500 lignes (un trimestre web en compte bien moins à l'échelle actuelle) ;
-- `total` donne le vrai compte pour signaler une éventuelle troncature.
-- Exécuter en supabase_admin. Nouvelle fonction ⇒ reload PostgREST requis
-- (NOTIFY pgrst, 'reload schema').

create or replace function public.admin_vat_transactions(
  p_year int default null,
  p_quarter int default null,
  p_country text default null
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_year    int := coalesce(p_year, extract(year from now())::int);
  v_quarter int := coalesce(p_quarter, extract(quarter from now())::int);
  v_cc      text := nullif(upper(btrim(coalesce(p_country, ''))), '');
  v_start   timestamptz;
  v_end     timestamptz;
  v_rows    jsonb;
  v_total   bigint;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if v_quarter < 1 or v_quarter > 4 then raise exception 'invalid quarter' using errcode = '22023'; end if;
  if v_year < 2020 or v_year > 2100 then raise exception 'invalid year' using errcode = '22023'; end if;
  v_start := make_timestamptz(v_year, (v_quarter - 1) * 3 + 1, 1, 0, 0, 0, 'UTC');
  v_end   := v_start + interval '3 months';

  select count(*) into v_total
  from cloud_billing_ledger l
  where l.provider = 'revolut'
    and ((l.kind in ('first_charge', 'renewal') and l.status = 'captured') or l.kind = 'refund')
    and coalesce(l.updated_at, l.created_at) >= v_start
    and coalesce(l.updated_at, l.created_at) < v_end
    and l.user_id not in (select user_id from public.admin_internal_accounts)
    and (v_cc is null
      or (v_cc = '??' and l.country_code is null)
      or (case when l.country_code = 'MC' then 'FR' else l.country_code end) = v_cc);

  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_rows from (
    select l.pi_id, l.kind, l.amount, lower(coalesce(l.currency, 'usd')) as currency,
           case when l.country_code = 'MC' then 'FR' else l.country_code end as country_code,
           coalesce(l.updated_at, l.created_at) as at,
           l.user_id, u.email::text as email,
           -- Rail revolut ⇒ le pays est celui d'émission de la carte, par construction
           -- (cf. bannière). Null quand le pays n'a pas pu être capturé.
           case when l.country_code is not null then 'card_bin' end as evidence
    from cloud_billing_ledger l
    left join auth.users u on u.id = l.user_id
    where l.provider = 'revolut'
      and ((l.kind in ('first_charge', 'renewal') and l.status = 'captured') or l.kind = 'refund')
      and coalesce(l.updated_at, l.created_at) >= v_start
      and coalesce(l.updated_at, l.created_at) < v_end
      and l.user_id not in (select user_id from public.admin_internal_accounts)
      and (v_cc is null
        or (v_cc = '??' and l.country_code is null)
        or (case when l.country_code = 'MC' then 'FR' else l.country_code end) = v_cc)
    order by coalesce(l.updated_at, l.created_at) desc
    limit 500
  ) t;

  return jsonb_build_object('year', v_year, 'quarter', v_quarter, 'country', v_cc,
                            'total', v_total, 'rows', v_rows);
end; $$;
revoke all on function public.admin_vat_transactions(int, int, text) from public, anon, authenticated;
grant execute on function public.admin_vat_transactions(int, int, text) to authenticated, service_role;
