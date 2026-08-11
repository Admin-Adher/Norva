# LP-002 — Product-first continuity

## Statut

**Garée le 10 août 2026.** Prototype autonome, non relié au trafic et non
déployé en production. La balise `noindex, nofollow` évite son indexation si le
dossier est un jour exposé accidentellement.

## Hypothèse

Une proposition de valeur concrète et centrée sur le passage d'un écran à
l'autre convertira mieux que la landing actuelle, plus atmosphérique, auprès
d'un trafic publicitaire froid.

La variante met notamment en avant :

- la continuité TV, web et mobile dès le hero ;
- les sous-titres IA et la reprise de lecture résiliente ;
- de vraies captures du produit ;
- une offre tarifaire compacte ;
- l'absence de guide flottant et de longs blocs génériques.

## Fichiers

- [`index.html`](index.html) : maquette responsive complète ;
- les images, polices et pages légales restent référencées depuis `public/` pour
  éviter de dupliquer les actifs Norva.

## Prévisualisation locale

Depuis la racine du dépôt :

```powershell
python -m http.server 8765 --directory .
```

Ouvrir ensuite :

```text
http://localhost:8765/docs/landing-experiments/lp-002-product-first-continuity/
```

## Contrat du futur test

- Baseline : `LP-001`, la landing de production au début du test.
- Variante : `LP-002`, ce prototype après branchement des vrais liens et de
  l'instrumentation.
- Conversion principale proposée : démarrage confirmé de l'essai gratuit.
- Garde-fous proposés : taux de création de compte, activation d'une source,
  conversion payante après essai et remboursements/annulations précoces.
- Attribution : conserver le même message publicitaire, la même audience, le
  même appareil et la même répartition de trafic entre les variantes.

## À revalider avant d'envoyer du trafic

- prix, devise, durée de l'essai et texte de renouvellement ;
- liens de connexion, inscription, support et pages légales ;
- événements analytics et persistance des paramètres UTM ;
- conformité des promesses produit avec la version réellement disponible ;
- rendu mobile, performance et accessibilité dans la version intégrée.

Ne pas modifier ce dossier une fois le test lancé. Créer un nouvel ID pour une
nouvelle hypothèse ou une modification substantielle.
