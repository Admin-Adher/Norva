// Tarifs web (rail Revolut) — lecture de la source unique `billing_prices` avec
// cache en mémoire d'isolate (60 s) et repli sur les tarifs historiques : un
// problème de lecture de tarifs ne doit JAMAIS casser un checkout ou un webhook.
//
// Périmètre : ce module donne le prix CATALOGUE courant (nouveaux checkouts,
// changements de plan, MRR de repli). Ce qui est réellement facturé aux abonnés
// existants reste cloud_revolut_customers.amount_cents — le prix verrouillé à la
// souscription, que le cron de renouvellement lit directement. Une promo ne
// s'applique donc qu'aux souscriptions/bascules confirmées après le changement.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type PriceTable = Record<string, Record<string, number>>;

// Repli historique (cents, USD) — utilisé si la table est vide ou inaccessible
// (migration pas encore appliquée, DB en incident). Ne PAS s'en servir comme
// « endroit à modifier » : les prix vivent dans billing_prices.
export const DEFAULT_PRICES: PriceTable = {
  plus:   { monthly: 499, annual: 4199 },
  family: { monthly: 899, annual: 7599 },
};

let cache: { at: number; table: PriceTable } | null = null;
const TTL_MS = 60_000;

export async function getPrices(db: SupabaseClient): Promise<PriceTable> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.table;
  try {
    const { data } = await db.from("billing_prices").select("plan,period,amount_cents");
    const rows = (data ?? []) as { plan: string; period: string; amount_cents: number }[];
    if (rows.length) {
      // Les valeurs par défaut restent le socle : une ligne manquante en base
      // (jamais le cas en pratique — seed de la migration) garde un prix sain.
      const table: PriceTable = { plus: { ...DEFAULT_PRICES.plus }, family: { ...DEFAULT_PRICES.family } };
      for (const r of rows) {
        if (table[r.plan] && Number.isFinite(r.amount_cents) && r.amount_cents > 0) {
          table[r.plan][r.period] = Math.round(r.amount_cents);
        }
      }
      cache = { at: Date.now(), table };
      return table;
    }
  } catch (_) { /* repli ci-dessous */ }
  return cache?.table ?? DEFAULT_PRICES;
}
