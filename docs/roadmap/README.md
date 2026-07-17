# `docs/roadmap/` — Travaux différés (à faire au bon moment)

Ce dossier regroupe les **runbooks de travaux planifiés mais volontairement
différés**. Chaque fichier dit **quoi faire**, **quand** (le déclencheur) et
**où** — pour **reprendre sans rien re-découvrir** le jour où le trigger arrive.

> Règle commune : tout ce qui est ici est **soit dormant/gardé, soit additif**.
> Rien n'impacte Norva en production tant que le déclencheur n'est pas atteint.

| Sujet | Déclencheur | Fichiers |
|---|---|---|
| 💳 **Paiements / abonnements** | Entreprise validée → comptes externes (Play Console, Stripe, RevenueCat) | [`billing-status.md`](./billing-status.md) (état & reprise) · [`billing-setup.md`](./billing-setup.md) (runbook détaillé) |
| 📈 **Scalabilité produit** | Beaucoup d'users multi-pays (recoupement réel des catalogues) | [`scaling-playbook.md`](./scaling-playbook.md) (**vue d'ensemble + séquence Jour J — à lire en premier**) · [`scaling-status.md`](./scaling-status.md) (état détaillé & reprise) · [`global-title-cache-design.md`](./global-title-cache-design.md) (design) |
| ⚡ **Performance & charge DB** | En continu (le boot est fait ; le goulot restant = charge DB de fond) | [`performance-status.md`](./performance-status.md) (**optim démarrage faite + backlog honnête + 🚑 runbook anti-saturation DB**) |
| 📓 **Journal d'incident** | Référence ponctuelle | [`2026-06-28-session-log.md`](./2026-06-28-session-log.md) (panne login 504 + refresh lent 616 s→1,71 s + onboarding « utilisable » + upgrade SMALL — le fil complet) |
| 📺 **Session nav TV + synchro cloud** | Référence ponctuelle | [`2026-07-13-session-log.md`](./2026-07-13-session-log.md) (refonte nav D-pad page Live 3 colonnes + parité `device` synchro cross-appareils favoris/historique/notes/récentes + optim octets — ⚠️ 1 re-deploy edge en attente) |
| 🌍 **Pays client & TVA/OSS** | Croissance UE → seuil 10 k€ / déclarations | [`2026-07-17-session-log.md`](./2026-07-17-session-log.md) (capture pays 2 rails + panneau TVA — ⚠️ branche non mergée, migration + edge à déployer) · [`../CLIENT-COUNTRY.md`](../CLIENT-COUNTRY.md) (runbook capture/déploiement) · [`../TVA-OSS.md`](../TVA-OSS.md) (droit vérifié + guichet OSS) |
| 🛡️ **Durcissement multi-users** | Avant commercialisation | [`2026-06-28-scale-hardening.md`](./2026-06-28-scale-hardening.md) (admission control « 10 imports simultanés » + amplification d'écriture + dédup prête/auto-gatée + `catalog_flip_readiness()`) |
| 🔁 **Couches partagées (mutualisées)** | Référence (déjà actif) — pas différé | [`shared-cache-layers.md`](./shared-cache-layers.md) (pistes/titres/sous-titres IA partagés par tous les users d'un provider + caveat mode-dépendant, audit code 2026-07-08) · [`phase2-dedup-activation-runbook.md`](./phase2-dedup-activation-runbook.md) (couche B dormante) |

**Convention :** `*-status.md` = où on en est + comment reprendre (à lire en
premier) ; l'autre fichier du sujet = le design/runbook détaillé.
