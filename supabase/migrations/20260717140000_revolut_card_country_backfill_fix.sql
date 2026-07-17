-- =============================================================================
-- Fix backfill pays Revolut : le vrai champ est payment_method.card.card_country.
-- =============================================================================
-- Étape 0 exécutée sur données LIVE (2026-07-17, 12 événements provider='revolut') :
-- l'order re-fetché par le webhook porte bien le pays d'émission de la carte, mais à
--   payload->'order'->'payments'[*].payment_method.card.card_country      ("FR")
-- — aucun des 4 chemins candidats de 20260717120000 (card_country_code, …) ne
-- matche, d'où ses UPDATE 0 côté Revolut alors que la donnée existait. Cette
-- migration rejoue les 4 backfills Revolut (idempotents, where … is null) avec le
-- bon chemin EN PREMIER ; les anciens candidats restent en défense (autre version
-- d'API). La capture live est corrigée dans norva-revolut / norva-revolut-webhook
-- (même commit — à redéployer).
--
-- Constaté aussi sur les payloads : billing_address.country_code présent sur le
-- parcours hosted — NON utilisé, la décision produit reste « pays carte seul ».
-- Aucun changement de signature de fonction ⇒ pas de reload PostgREST nécessaire.
-- À exécuter en supabase_admin (postgres n'est pas owner de cloud_revolut_customers).

-- 1) Projection (pays courant), pour les clients encore sans pays.
with ev as (
  select e.user_id, e.created_at,
         upper(coalesce(
           jsonb_path_query_first(e.payload, '$.order.payments[*].payment_method.card.card_country') #>> '{}',
           jsonb_path_query_first(e.payload, '$.order.payments[*].payment_method.card_country_code') #>> '{}',
           jsonb_path_query_first(e.payload, '$.order.payments[*].payment_method.card.card_country_code') #>> '{}',
           jsonb_path_query_first(e.payload, '$.order.payments[*].payment_method.card.country_code') #>> '{}'
         )) as cc
  from public.cloud_entitlement_events e
  where e.provider = 'revolut'
), latest as (
  select distinct on (user_id) user_id, cc
  from ev
  where cc ~ '^[A-Z]{2}$'
  order by user_id, created_at desc
)
update public.cloud_entitlement_projection p
   set country_code = l.cc, country_source = 'card'
  from latest l
 where p.user_id = l.user_id
   and p.country_code is null;

-- 2) Pays de la carte sauvegardée (source du cron de renouvellement).
with ev as (
  select e.user_id, e.created_at,
         upper(coalesce(
           jsonb_path_query_first(e.payload, '$.order.payments[*].payment_method.card.card_country') #>> '{}',
           jsonb_path_query_first(e.payload, '$.order.payments[*].payment_method.card_country_code') #>> '{}',
           jsonb_path_query_first(e.payload, '$.order.payments[*].payment_method.card.card_country_code') #>> '{}',
           jsonb_path_query_first(e.payload, '$.order.payments[*].payment_method.card.country_code') #>> '{}'
         )) as cc
  from public.cloud_entitlement_events e
  where e.provider = 'revolut'
), latest as (
  select distinct on (user_id) user_id, cc
  from ev
  where cc ~ '^[A-Z]{2}$'
  order by user_id, created_at desc
)
update public.cloud_revolut_customers c
   set card_country = l.cc
  from latest l
 where c.user_id = l.user_id
   and c.card_country is null;

-- 3) Ledger, match order-précis (pays AU MOMENT de la transaction — base TVA).
with ev as (
  select e.payload->'order'->>'id' as order_id, e.created_at,
         upper(coalesce(
           jsonb_path_query_first(e.payload, '$.order.payments[*].payment_method.card.card_country') #>> '{}',
           jsonb_path_query_first(e.payload, '$.order.payments[*].payment_method.card_country_code') #>> '{}',
           jsonb_path_query_first(e.payload, '$.order.payments[*].payment_method.card.card_country_code') #>> '{}',
           jsonb_path_query_first(e.payload, '$.order.payments[*].payment_method.card.country_code') #>> '{}'
         )) as cc
  from public.cloud_entitlement_events e
  where e.provider = 'revolut'
), latest as (
  select distinct on (order_id) order_id, cc
  from ev
  where cc ~ '^[A-Z]{2}$' and order_id is not null
  order by order_id, created_at desc
)
update public.cloud_billing_ledger l
   set country_code = x.cc
  from latest x
 where l.country_code is null
   and l.provider = 'revolut'
   and l.order_id = x.order_id;

-- 4) Ledger, fallback par client via la carte sauvegardée (backfillée en 2).
update public.cloud_billing_ledger l
   set country_code = c.card_country
  from public.cloud_revolut_customers c
 where l.country_code is null
   and l.provider = 'revolut'
   and l.user_id = c.user_id
   and c.card_country ~ '^[A-Z]{2}$';
