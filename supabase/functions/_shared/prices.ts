// Tarifs web (rail Revolut) — lecture de la source unique `billing_prices` avec
// cache en mémoire d'isolate (60 s) et repli sur les tarifs historiques : un
// problème de lecture de tarifs ne doit JAMAIS casser un checkout ou un webhook.
//
// Promotions : le prix EFFECTIF est promo_amount_cents quand il est rempli et que
// promo_ends_at (optionnel) n'est pas passé — sinon le prix de base. getPrices()
// rend directement la table des prix effectifs (tous les lecteurs edge héritent
// des promos sans changement) ; getCatalog() y ajoute le détail des promos
// actives (base barrée + événement → badge) pour l'endpoint public /prices.
//
// Périmètre : prix CATALOGUE courant (nouveaux checkouts, changements de plan,
// MRR de repli). Ce qui est réellement facturé aux abonnés existants reste
// cloud_revolut_customers.amount_cents — le prix verrouillé à la souscription,
// que le cron de renouvellement lit directement. Une promo ne s'applique donc
// qu'aux souscriptions/bascules confirmées pendant qu'elle est active.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type PriceTable = Record<string, Record<string, number>>;
// label : libellé de badge personnalisé (prioritaire sur le libellé standard de
// l'événement côté front — pensé pour event='other', un événement propre à Norva).
// cycles : durée de la promo en périodes facturées (null = à vie / early-bird).
// ref_cents : ancre marketing « 12 × mensuel » (annuel + promo_ref_monthly
// seulement, émise uniquement si elle DÉPASSE base_cents) — le front doit
// toujours l'afficher avec le qualificatif « billed monthly / vs monthly
// billing », jamais en prix barré nu (L112-1-1). Affichage pur : les montants
// facturés/stampés ne changent pas.
export interface PromoInfo { base_cents: number; event: string; label: string | null; ends_at: string | null; cycles: number | null; ref_cents: number | null }
export type PromoTable = Record<string, Record<string, PromoInfo>>;
// campaign.bg_path : CHEMIN de l'image de campagne dans le bucket public
// promo-assets (null = thème par défaut de l'événement côté front). On renvoie
// un chemin, jamais une URL : sur la box self-host, SUPABASE_URL vu par l'edge
// est l'hôte Docker INTERNE (http://kong:8000) — une URL construite ici serait
// irrésolvable par le navigateur. C'est billing.js qui assemble l'URL publique.
export interface Catalog { prices: PriceTable; promos: PromoTable; campaign: { bg_path: string | null } }

// Repli historique (cents, USD) — utilisé si la table est vide ou inaccessible
// (migration pas encore appliquée, DB en incident). Ne PAS s'en servir comme
// « endroit à modifier » : les prix vivent dans billing_prices.
export const DEFAULT_PRICES: PriceTable = {
  plus:   { monthly: 499, annual: 4199 },
  family: { monthly: 899, annual: 7599 },
};

let cache: { at: number; catalog: Catalog } | null = null;
const TTL_MS = 60_000;

export async function getCatalog(db: SupabaseClient): Promise<Catalog> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.catalog;
  try {
    const { data } = await db.from("billing_prices")
      .select("plan,period,amount_cents,promo_amount_cents,promo_event,promo_label,promo_ends_at,promo_cycles,promo_ref_monthly");
    const rows = (data ?? []) as {
      plan: string; period: string; amount_cents: number;
      promo_amount_cents: number | null; promo_event: string | null;
      promo_label: string | null; promo_ends_at: string | null; promo_cycles: number | null;
      promo_ref_monthly: boolean | null;
    }[];
    if (rows.length) {
      // Les valeurs par défaut restent le socle : une ligne manquante en base
      // (jamais le cas en pratique — seed de la migration) garde un prix sain.
      const prices: PriceTable = { plus: { ...DEFAULT_PRICES.plus }, family: { ...DEFAULT_PRICES.family } };
      const promos: PromoTable = {};
      const baseBy: Record<string, Record<string, number>> = {};
      const wantsRef: Record<string, boolean> = {};
      for (const r of rows) {
        if (!prices[r.plan] || !Number.isFinite(r.amount_cents) || r.amount_cents <= 0) continue;
        const base = Math.round(r.amount_cents);
        (baseBy[r.plan] ??= {})[r.period] = base;
        const promoLive = Number.isFinite(r.promo_amount_cents as number) && (r.promo_amount_cents as number) > 0
          && (!r.promo_ends_at || new Date(r.promo_ends_at).getTime() > Date.now());
        prices[r.plan][r.period] = promoLive ? Math.round(r.promo_amount_cents as number) : base;
        if (promoLive) {
          (promos[r.plan] ??= {})[r.period] = {
            base_cents: base, event: r.promo_event ?? "other",
            label: (typeof r.promo_label === "string" && r.promo_label.trim()) ? r.promo_label.trim() : null,
            ends_at: r.promo_ends_at ?? null,
            cycles: (Number.isFinite(r.promo_cycles as number) && (r.promo_cycles as number) > 0) ? Math.round(r.promo_cycles as number) : null,
            ref_cents: null,
          };
          if (r.period === "annual" && r.promo_ref_monthly === true) wantsRef[r.plan] = true;
        }
      }
      // Ancre « 12 × mensuel » des promos annuelles : calculée ici (source
      // unique), émise seulement si elle amplifie réellement (> base annuelle).
      for (const plan of Object.keys(wantsRef)) {
        const p = promos[plan]?.annual;
        const baseM = baseBy[plan]?.monthly;
        if (p && Number.isFinite(baseM) && (baseM as number) * 12 > p.base_cents) {
          p.ref_cents = Math.round((baseM as number) * 12);
        }
      }
      // Visuel de campagne (best-effort : table absente avant la migration
      // 20260718190000 → simplement pas de campagne).
      let bgPath: string | null = null;
      try {
        const { data: camp } = await db.from("billing_promo_campaign").select("bg_path").eq("id", 1).maybeSingle();
        const raw = (camp as { bg_path?: string | null } | null)?.bg_path ?? null;
        bgPath = (typeof raw === "string" && raw.trim()) ? raw.trim() : null;
      } catch (_) { /* pas de campagne */ }
      // NB : le TTL de 60 s borne aussi la fenêtre autour de promo_ends_at — une
      // promo expire au pire une minute « en retard » côté edge, jamais plus.
      cache = { at: Date.now(), catalog: { prices, promos, campaign: { bg_path: bgPath } } };
      return cache.catalog;
    }
  } catch (_) { /* repli ci-dessous */ }
  return cache?.catalog ?? { prices: DEFAULT_PRICES, promos: {}, campaign: { bg_path: null } };
}

// Table des prix EFFECTIFS (promo active sinon base) — l'API qu'utilisent tous
// les lecteurs edge (checkout, confirm, webhooks).
export async function getPrices(db: SupabaseClient): Promise<PriceTable> {
  return (await getCatalog(db)).prices;
}
