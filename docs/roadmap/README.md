# `docs/roadmap/` — Travaux différés (à faire au bon moment)

Ce dossier regroupe les **runbooks de travaux planifiés mais volontairement
différés**. Chaque fichier dit **quoi faire**, **quand** (le déclencheur) et
**où** — pour **reprendre sans rien re-découvrir** le jour où le trigger arrive.

> Règle commune : tout ce qui est ici est **soit dormant/gardé, soit additif**.
> Rien n'impacte Norva en production tant que le déclencheur n'est pas atteint.

| Sujet | Déclencheur | Fichiers |
|---|---|---|
| 💳 **Paiements / abonnements** | Entreprise validée → comptes externes (Play Console, Stripe, RevenueCat) | [`billing-status.md`](./billing-status.md) (état & reprise) · [`billing-setup.md`](./billing-setup.md) (runbook détaillé) |
| 📈 **Scalabilité & cache de titres global** | Beaucoup d'users multi-pays (recoupement réel des catalogues) | [`scaling-status.md`](./scaling-status.md) (état & reprise) · [`global-title-cache-design.md`](./global-title-cache-design.md) (design détaillé) |

**Convention :** `*-status.md` = où on en est + comment reprendre (à lire en
premier) ; l'autre fichier du sujet = le design/runbook détaillé.
