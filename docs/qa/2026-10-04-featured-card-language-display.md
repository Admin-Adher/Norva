# Langues des trois films mis en avant — 4 octobre 2026

## Constat et résultat réel

Contrôle ciblé sur les trois premières cartes Action du compte visible dans Codex,
avec correspondance exacte propriétaire/source/fichier. Les trois versions viennent
de MAX OTT. [Reçu agrégé sans identifiants](2026-10-04-featured-card-language-display.json).

| Film | Cause vérifiée | Résultat après correction |
| --- | --- | --- |
| Last Bullet | Métadonnée audio détenue par le serveur : `en`. La lecture de cette déclaration expirait avant son retour à l'interface. | **Anglais** visible après rechargement du navigateur. Statut API `provider_declared`, aucune certification vocale inventée. |
| EN\| Innocent Voices [SUB] | Métadonnées audio fournisseur vides ; piste AAC sans tag de langue ; six fenêtres vocales terminées mais consensus inconclusif. | Langue toujours indéterminée. |
| Proie / Prey | Métadonnées audio fournisseur vides ; piste AAC sans tag de langue ; six fenêtres vocales terminées mais consensus inconclusif. | Langue toujours indéterminée. |

La première hypothèse « MULTI-SUB considéré comme langue identifiée » a été écartée :
aucun hint de langue fournisseur n'existe sur ces trois variantes. Pour Last Bullet,
`catalog_movie_audio_identified` est correctement vrai grâce à une déclaration
audio `en` issue de la réponse fournisseur. C'était **sa transmission à la carte**
qui était défaillante. Aucun prédicat de comptage ou de sélection n'a été modifié.
Ce correctif ne compte donc pas Last Bullet comme une nouvelle langue identifiée.

## Défaut corrigé

Le helper partagé utilisait une projection SQL de tout le catalogue, suivie d'un
filtre PostgREST `.in(variant_id, …)`. La frontière `SET search_path` de la fonction
empêchait de pousser le filtre à l'intérieur. L'exception était tolérée comme un
échec d'enrichissement, laissant la carte sans déclaration.

Reproduction sur le même fichier : **HTTP 500 / SQL 57014 en 8 027 ms**. La nouvelle
RPC reçoit au plus 200 variantes et réutilise la projection exacte existante pour
chacune : **HTTP 200, `en`, en 47 ms**. Ce sont deux mesures ponctuelles de cette RPC,
pas une estimation du débit des sondes. Les rayons complets répondent ensuite en
**1 770 ms sur Edge 1 et 1 422 ms sur Edge 2**.

Le helper commun utilise cette lecture bornée pour toutes les cartes de films :
Home, rayons, fiches regroupées et grille plate. Aucun compte pilote n'est codé dans
le correctif. Le chemin des déclarations de séries est inchangé ; ses délais ne
sont pas certifiés par cet essai.

## Déploiement et vérification

- Migration `20261004130000_bound_movie_language_declaration_cards` appliquée à
  **12:16:25 UTC** ; SHA-256 `d12c95556334db64a703c35fabca3726bee32c160636f823b46449f935597ff5`.
- RPC déployée : SHA-256 `dbd9772e0bfa00e2bc5230a4392e0da70dca8d340872b574f665b0fb841e0c44`.
- Helper `_shared/owned-provider-language-declarations.mjs` : SHA-256
  `e2e4d717c990222b713c9449069a919acfa66d354df67ca7877e50aee7070637`.
- Canary réel réussi, puis deux Edge recréés successivement à **12:17:30 / 12:17:33 UTC**.
  Sources runtime conservées sous `/home/adrien/.norva/featured-three-20261004/runtime-functions`.
- Nouvelles admissions temporairement suspendues de **12:17:28 à 12:17:36 UTC**.
  Restauration vérifiée ; aucun bail forcé ni travail annulé. Gateways non redémarrés.
- **18 assertions SQL** sur schéma isolé, réseau désactivé, aucune donnée client copiée :
  borne de 200, doublons/nulls, séparation propriétaire/source, révision, priorité
  de la vraie observation, absence d'inférence depuis les sous-titres, ACL et flag.
- **30 tests JS réussis** : pipeline des déclarations, affichage des langues et rayons.
- Après rechargement réel de `https://norva.tv/app#movies`, l'arbre d'accessibilité et
  le DOM de la carte Last Bullet montrent **Anglais**. Les deux autres cartes restent
  inconnues. La capture image du navigateur était indisponible : aucun screenshot
  de réussite n'est revendiqué. Aucun composant UI ou client Android modifié.
- À **12:19:34 UTC**, deux Gateways HTTP 200/ok, deux Edge sains, dispatcher unique
  actif, cron strict actif, pause levée, 53 sources/47 propriétaires découverts.

## Priorité réelle et limites pour les deux autres films

Les indices des trois titres ont été enregistrés à **09:26:58 UTC** et expirent
le 6 octobre à la même heure. Innocent Voices a été admis à **09:32:48**, puis a
terminé ses six fenêtres à **09:45:16**. Prey a été admis à **09:56:04** et a terminé
ses six fenêtres à **10:12:24**. Ce sont deux analyses complètes indéterminées,
pas deux validations réussies ni des travaux encore en attente de première sonde.

Les diagnostics de finalisation à ces horaires indiquent `insufficient-speech`.
Deux événements partagent la seconde 09:45:16 ; leurs nombres de votes ne sont pas
attribués individuellement à Innocent Voices faute de corrélation publique univoque.
À 10:12:24, une seule fenêtre qualifiée, une faible et quatre insuffisantes sont
journalisées. Aucun conflit ou rejet pour répétition n'est rapporté à ces horaires.
Ces diagnostics ne prouvent pas une langue et n'expliquent pas à eux seuls pourquoi
chaque extrait manque de parole exploitable.

Les deux reprises conservent leurs délais : **5 octobre 09:45:16 et 10:12:24 UTC**.
Aucune relance identique forcée, aucun seuil abaissé, aucune langue originale TMDB
substituée à la langue de la version. Le prochain suivi doit distinguer une reprise
admise d'une vraie nouvelle capture et d'une identification. La collecte recherche
déjà de la parole dans une fenêtre bornée ; une amélioration de son rendement
demanderait une preuve supplémentaire, pas simplement une priorité plus élevée.

**Le défaut d'affichage de Last Bullet est résolu. Les langues des deux autres films
ne sont pas résolues. La maintenance globale reste active et n'est pas déclarée terminée.**
