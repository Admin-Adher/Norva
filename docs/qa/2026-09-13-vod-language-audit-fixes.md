# Correctifs issus de l'audit des langues VOD — 13 septembre 2026

## État de livraison

Code corrigé et validé dans `codex/vod-language-audit-fixes-20260913`, sur la base
`aae27fb745b3a5ea228c1e010dc8c3b072f7de7e`. Ni publication Git, ni déploiement
de ces correctifs, ni réconciliation du catalogue de production n'ont été effectués.
Le checkout de travail initial et ses modifications sans rapport ont été préservés.

Deux relectures techniques ciblées de fichiers ont été effectuées séparément en
production, par la route ordinaire gardée : voir « Contradictions non résolues ».
Elles ne constituent pas une publication des correctifs.

## Corrections et impact rejoué

Base auditée : 6 936 versions inconnues, réparties sur 6 258 titres. L'export
contient aussi les autres versions de ces titres et des contrôles, soit 22 089 lignes.
Ces chiffres décrivent l'export du 13 septembre, pas un compteur après déploiement.

| Correction | Versions inconnues récupérées dans la cohorte |
| --- | ---: |
| DK / SE / NO précis, compatibles avec la catégorie nordique générale | 2 260 |
| MT / KU explicitement délimités, sans déduire une langue de MALTA / IRAN | 52 |
| Titres Dual, Dutch, Zulu et parenthèses contenant du texte, mal lus comme annotations | 11 |
| Total du parseur | 2 323 |

Les 2 323 gains correspondent à 33,5 % de la cohorte inconnue. Un ancien faux hint
`nl` de `EXYU | Dutch`, hors de cette cohorte inconnue mais présent dans l'export,
est supprimé : il ne faut pas ignorer cette correction défavorable au compteur.
Sur le périmètre exporté, le parseur seul donne donc 4 614 inconnues, dont 4 613
étaient déjà inconnues. Cela ne certifie pas le futur compteur global du compte.

Le nom de fichier réemballé de Cruella permet un gain supplémentaire `es`.
Le parseur de nom de fichier et une procédure de rafraîchissement à identité et
hash constants sont prêts. Ce cas existant reste inconnu tant que sa déclaration
stockée n'a pas été actualisée : une simple réconciliation des hints ne suffit pas.
Sur 2 316 entrées de manifestes comparées, Cruella est le seul changement.

Autres corrections :

- Les observations contenant uniquement `und` ne masquent plus un tag fournisseur utilisable.
- Une routine bornée et explicitement limitée à un propriétaire recalcule les hints existants,
  les corrige ou les retire ; elle ne modifie aucune piste, vérification ou métadonnée originale.
- Les libellés KU / MT disposent d'un secours localisé pour les WebViews à dictionnaire ICU réduit.
- Les nouvelles règles restent identiques entre navigateur, Edge et SQL. La provenance reste interne.
- Le fichier HTML et l'inventaire de hashes ont été actualisés pour éviter un ancien JavaScript en cache.

## Contradictions non résolues

NL signifie **Néerlandais**, jamais Allemand. La fixture de test qui présente NL
avec le libellé Allemand injecte volontairement une piste `de` : elle teste la
priorité des observations et ne prouve pas la langue parlée du fichier réel.

Après la remarque de l'utilisateur, une seule relecture de métadonnées a été faite
sur chacune des deux anciennes observations non liées au profil actuel :

- Land of Mine, version fournisseur NL : 13 septembre, 15:24:54 UTC. La piste 1
  actuelle porte toujours `de` (AAC, mono). Nouveau profil lié, **non vérifié par la parole**.
- House of Paper, version IR : 13 septembre, 15:25:30 UTC. La piste 1 actuelle porte
  toujours `en` (AAC, stéréo). Nouveau profil lié, **non vérifié par la parole**.

Résultat : 2 requêtes gardées, 2 relevés persistés, aucun job de reconnaissance
vocale créé. Ces contradictions ne sont PAS comptées comme des langues résolues.
Il faut une preuve sur l'audio parlé ou une convention fournisseur explicite pour
trancher ; ni le code du pays ni une étiquette de conteneur isolée ne suffisent.
Les trois profils `kik` déjà liés à leur version et les jobs existants sont intacts.

Restent également hors attribution automatique : catégories IRAN/AFRICA/PAKISTAN/EXYU,
conflits entre annotations, sous-titres seuls, noms de pages mixtes Castellano/Latino/Subtitulada.
Space Jam `ENG+NL ... (Retail NL Subs)` demande un vrai support des déclarations
audio multilingues ; le modèle scalaire actuel ne doit pas choisir une langue arbitraire.

## Vérification

- Suite complète : **4 705 tests, 4 684 réussis, 21 ignorés, 0 échec**, concurrence bornée à 4.
- Opérateurs : **31 tests Python réussis** (13 relectures, 18 rafraîchissement Selection).
- Parité SQL : **22 220 cas, 0 divergence**, fonctions et tables `pg_temp`, transaction annulée.
- SQL de réconciliation : pagination, limites, propriétaire, idempotence, métadonnées intactes,
  fallback `und`, vraie priorité des observations et identité du fichier validés dans la même transaction.
- Génération du parseur et i18n : contrôles `--check` réussis. Aucun changement de migration historique.
- Web : vrais `mediaUtils` et `MoviesPage.renderMovieVersions`, français, 1 440 × 900,
  huit cartes, sélection de la version Maltais, zéro erreur ni avertissement console.
- Android 15 / System WebView 124 : 12 scénarios FR/EN/AR, portrait/paysage,
  police 1,0/1,3 ; 96 contrôles de cartes, 12 sélections, zéro erreur JavaScript.
  Ce test utilise un vrai WebView instrumenté isolé, pas l'Activity complète, le lecteur,
  TalkBack, le clavier ou les modes de navigation Android. Aucun changement de disposition n'est livré.

La première suite complète avait deux échecs liés uniquement aux fins de ligne du
checkout Windows et un inventaire de hash à régénérer. Après correction des fins
de ligne locales (sans diff Git) et génération, un test Gateway a expiré sous forte
concurrence ; son rejeu isolé et la suite finale bornée passent. Aucun code Gateway
n'a été modifié pour faire passer ces tests.

## Gates de mise en ligne

1. Publier uniquement ce changement isolé selon le circuit autorisé du dépôt.
2. Déployer les deux nouvelles migrations et les modules Edge/frontend correspondants.
3. Rejouer la projection dérivée pour le propriétaire concerné avec
   `cloud_catalog_reconcile_provider_language_hints`, par pages jusqu'à `scanned=0`,
   puis vérifier un second passage sans modification et recompter les facettes.
4. Pour Cruella : valider l'opérateur avec PostgreSQL et ses vrais triggers, puis
   dry-run transactionnel obligatoire avant application explicitement autorisée.
   Les tests Python de cette procédure ne constituent pas cette validation SQL.
5. Recontrôler les compteurs et versions sur le domaine live et le cache frontend.

Les procédures refusent toute relance automatique après une issue incertaine.
