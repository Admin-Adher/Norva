# Norva landing experiments

Ce fichier est l'index durable des landing pages à comparer lors des futures
campagnes publicitaires. Les variantes sont des prototypes isolés : elles ne
modifient ni la landing de production ni son routage.

| ID | Variante | Statut | Fichier |
| --- | --- | --- | --- |
| LP-001 | Landing actuelle | Baseline en production | [`public/index.html`](../public/index.html) |
| LP-002 | Product-first continuity | Garée, prête pour préparation d'un test | [`index.html`](landing-experiments/lp-002-product-first-continuity/index.html) |

## Retrouver LP-002

- Nom stable : `LP-002 — Product-first continuity`
- Dossier : `docs/landing-experiments/lp-002-product-first-continuity/`
- Fiche de la variante : [`README.md`](landing-experiments/lp-002-product-first-continuity/README.md)
- Recherche rapide dans le dépôt : `rg "LP-002" docs`

## Prévisualiser une variante

Depuis la racine du dépôt :

```powershell
python -m http.server 8765 --directory .
```

Puis ouvrir :

```text
http://localhost:8765/docs/landing-experiments/lp-002-product-first-continuity/
```

## Règle de conservation

Une variante ne doit pas être remplacée après avoir reçu du trafic. Toute
évolution testée devient une nouvelle entrée (`LP-003`, `LP-004`, etc.) afin de
garder les résultats interprétables et reproductibles.
