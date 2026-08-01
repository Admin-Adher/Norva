# Norva Partners — Spécification produit, UX et technique P0

**Statut :** socle P0 livré en mode fail-closed ; pilote non activé tant que
Didit, le rail de versement individuel, le parcours fiscal Web, les juridictions
et les preuves runtime ne sont pas configurés et validés
**Date :** 29 juillet 2026
**Marché cible :** mondial
**Modèle :** affiliation directe, 20 % récurrents, sans multiniveau
**Type de partenaire P0 :** personne physique uniquement, KYC sans KYB
**Devise commerciale et de référence :** USD
**Seuil mondial de référence :** 10,00 USD, soit 1 000 unités mineures
**Déploiement initial :** invitation, 20 à 50 partenaires dans une allowlist de
pays couverts à la fois par le prestataire KYC et le rail de versement individuel

## 1. Décision produit

Norva Partners permet à un utilisateur éligible de percevoir une commission sur
les paiements des nouveaux abonnés qu'il apporte à Norva.

> 20 % récurrents tant que vos filleuls restent abonnés.

La formulation complète à proximité de toute estimation est :

> La commission correspond à 20 % du montant hors taxes réellement payé après
> remise, à chaque paiement confirmé, avant déduction des frais Google Play,
> RevenueCat, Revolut ou bancaires. Revenus variables et non garantis.

Le programme est une affiliation directe :

- un partenaire gagne uniquement sur ses propres filleuls ;
- aucun gain n'est versé sur les filleuls d'un filleul ;
- aucun revenu minimum, rapide, facile ou « à vie » n'est promis ;
- le filleul ne paie aucun supplément lié à l'affiliation.

## 2. Objectifs P0

- Permettre à une personne physique éligible d'une juridiction prise en charge
  d'activer le programme.
- Générer un lien affilié opaque, révocable et partageable.
- Attribuer un nouveau compte depuis le Web ou Android.
- Conserver cette attribution lors d'un changement de formule, d'appareil ou de
  rail de paiement.
- Calculer chaque commission à partir du paiement financier autoritatif.
- Afficher des gains et abonnements apportés sans révéler l'identité des filleuls.
- Valider, bloquer, annuler, verser et auditer chaque commission.
- Tester l'économie, la fraude et les opérations sur deux cycles de paiement.

## 3. Non-objectifs P0

- Parrainage multiniveau.
- Attribution rétroactive à des comptes existants.
- Portefeuille transférable, monnaie virtuelle ou paiement instantané.
- Remise automatique accordée au filleul.
- Ouverture simultanée à tous les pays sans validation juridique, fiscale, KYC
  et versement propre à chaque juridiction.
- Inscription, saisie fiscale ou paiement depuis Android TV.
- Import de contacts ou envoi automatique d'e-mails/SMS.
- Classement public, challenges de gains ou taux personnalisés.
- Automatisation des obligations fiscales de pays qui ne sont pas encore
  activés dans l'allowlist.
- Comptes de personnes morales, KYB, vérification d'entreprise, dirigeants ou
  bénéficiaires effectifs. Ils feront l'objet d'une phase ultérieure lorsque
  l'économie du programme sera validée.

## 4. Éligibilité et activation

L'activation exige :

- un compte Norva avec e-mail vérifié ;
- une personne physique âgée d'au moins 18 ans et disposant de la capacité
  juridique requise dans sa juridiction de résidence ;
- une résidence fiscale dans un pays ou territoire activé ;
- une vérification hébergée de l'identité, du pays et de l'âge par le
  prestataire KYC ;
- l'acceptation horodatée de la version applicable du contrat ;
- l'acceptation des règles de communication commerciale applicables au marché ;
- l'absence de suspension, de fraude établie ou de compte interne.

Les sociétés, associations et autres personnes morales ne peuvent pas activer le
programme P0. L'interface propose une liste d'attente « comptes professionnels »
et ne lance aucun workflow KYB. Un utilisateur ne doit jamais déclarer son
entreprise comme une personne physique pour contourner cette limite.

La découverte, le simulateur et la demande d'adhésion restent accessibles avant
vérification. Le lien ne devient partageable qu'après confirmation serveur de
l'identité, de l'âge/capacité, du pays pris en charge et du contrat. Une simple
case « 18+ » n'est pas une preuve.

Norva ne collecte ni ne vérifie manuellement les photos de pièce d'identité ou
les selfies. Le prestataire héberge ce parcours et renvoie un statut signé par
webhook. Norva conserve seulement la référence provider, le résultat
d'éligibilité, le pays/juridiction, la version de politique et les horodatages
nécessaires ; pas l'image du document. Le serveur calcule l'éligibilité selon la
politique versionnée de la juridiction et ne fait jamais confiance à un résultat
fourni par le client.

Avant le premier versement, le partenaire complète les éléments complémentaires
requis par sa juridiction :

- son statut fiscal individuel ;
- son identifiant fiscal personnel ou tout formulaire local requis ;
- un moyen de versement vérifié.

Les commissions peuvent s'accumuler après la vérification initiale
d'identité/âge pendant la finalisation fiscale et bancaire, mais elles restent
bloquées. L'interface ne les présente jamais comme encaissables avant validation
complète.

Les personnes de moins de 18 ans et celles qui n'ont pas la capacité
contractuelle locale sont hors P0. Norva n'implémente pas de consentement
parental. La règle d'âge concerne le partenaire rémunéré, pas le filleul qui
utilise un lien.

### 4.1 Budget et modules de vérification

Didit est le candidat KYC prioritaire du pilote. Au 29 juillet 2026, son offre
publique annonce 500 packs KYC complets gratuits par mois :
<https://didit.me/fr/pricing/>.

Le workflow P0 autorise uniquement :

- vérification de la pièce d'identité ;
- liveness passive ;
- correspondance faciale ;
- analyse appareil/IP incluse dans le pack.

Après les 500 packs gratuits, le même pack KYC individuel continue en paiement à
l'usage au tarif contractuel en vigueur ; le 501e contrôle ne doit pas être
bloqué. Les modules additionnels payants restent désactivés par défaut. Un
contrôle AML/sanctions ponctuel, une preuve d'adresse ou une surveillance
continue peut être activé uniquement si la politique de la juridiction l'exige.
Le KYB, la vérification d'entreprise, des dirigeants et bénéficiaires effectifs
restent interdits.

Norva suit séparément consommation gratuite et dépense payante. Le serveur
affiche des alertes à 80 % et 100 % du quota gratuit, puis aux seuils de dépense
configurés par l'Admin. Une recharge automatique par petits paliers peut être
activée avec plafond journalier et mensuel anti-abus. Ce plafond de sécurité
n'est pas fixé à 500 vérifications et ne doit pas interrompre une croissance
légitime.

Seul un dépassement de dépense anormal, un échec de recharge ou un incident
provider peut ouvrir le circuit avec `kyc_billing_unavailable`. Les prix,
quotas, paliers et seuils restent de la configuration opérationnelle, pas des
valeurs codées dans les clients.

## 5. Attribution

### 5.1 Lien canonique

```text
https://norva.tv/r/{code_public_opaque}
```

Le code public :

- ne contient ni UUID ni donnée personnelle ;
- est généré aléatoirement côté serveur ;
- peut être révoqué et renouvelé ;
- résout vers le Web ou l'App Link Android approprié ;
- ne constitue jamais, à lui seul, une preuve d'attribution financière.

### 5.2 Règles métier

- Fenêtre d'attribution : 30 jours après le dernier clic valide.
- Seuls les nouveaux comptes Norva sont éligibles.
- Le dernier clic valide avant la création du compte gagne.
- L'attribution est figée à la création du compte.
- Un compte déjà créé ne peut plus être attribué.
- Android TV ne crée jamais l'attribution : son QR ouvre un relais privé sur
  téléphone.
- Une fusion de comptes ou un événement RevenueCat `TRANSFER` reste en revue
  tant que sa correspondance déterministe n'est pas résolue.

L'attribution appartient au compte Norva du filleul, pas au rail de paiement.
Elle survit :

- au changement de formule ou de périodicité ;
- au passage Web ↔ Google Play ;
- au changement de téléphone, tablette ou TV ;
- à une résiliation suivie d'une réactivation du même compte.

La commission est suspendue pendant les périodes sans paiement puis reprend au
prochain paiement éligible.

### 5.3 Claim sécurisé

1. La route `/r/{code}` valide strictement le code public.
2. Le serveur émet un claim aléatoire à usage unique.
3. Seul le hash du claim est conservé en base.
4. Le claim brut est placé dans un cookie
   `Secure; HttpOnly; SameSite=Lax`, valable 30 jours.
5. Après authentification, une fonction serveur lit le cookie et appelle une RPC
   avec le JWT de l'utilisateur.
6. La RPC dérive uniquement `auth.uid()`, verrouille le claim et crée
   l'attribution.
7. OAuth, magic link et Google natif conservent le claim ; une panne
   d'attribution ne doit jamais bloquer l'authentification.
8. Android gère `/r/` avec un App Link vérifié, en démarrage froid et chaud.

Le code financier n'est jamais copié dans `raw_user_meta_data`, et aucun jeton
brut ne reste dans l'URL après la première résolution.

## 6. Calcul financier

Pour chaque paiement capturé :

```text
montant_eligible_minor = montant_brut_minor - taxe_minor
commission_minor =
  round_half_up(montant_eligible_minor × 2000 / 10000)
```

L'assiette est le montant réellement encaissé après remise, hors taxes
indirectes. Les frais Google Play, RevenueCat, Revolut ou bancaires sont
enregistrés séparément et ne diminuent pas la commission.

USD est la devise commerciale, de comparaison et de pilotage du programme. Ce
choix ne réécrit jamais la devise autoritative d'une transaction : un paiement
Google Play encaissé en EUR, GBP ou INR reste comptabilisé dans cette devise,
avec son exposant exact. Exemple illustratif en EUR :

```text
4,99 € TTC - 0,83 € de taxe = 4,16 € éligibles
4,16 € × 20 % = 0,83 € de commission après arrondi
```

Règles complémentaires :

- essai ou période gratuite : aucune commission ;
- paiement annuel : commission créée lors de l'encaissement annuel ;
- remboursement partiel : contre-écriture proportionnelle à la part HT ;
- taxe, devise ou exposant monétaire inconnu :
  `blocked_missing_tax` ou `calculation_pending`, jamais un faux zéro ;
- tous les calculs utilisent des unités monétaires mineures ou des décimales
  exactes, jamais des flottants ;
- les événements sandbox, comptes internes, montants nuls et auto-parrainages
  sont exclus avec un motif explicite.

## 7. Cycle de vie financier

### 7.1 Commission

```text
calculation_pending
  → pending
  → available
  → allocated
  → paid
```

Branches :

```text
pending | available → held
pending | available | paid → reversed
held → pending | available | reversed
```

- `calculation_pending` : donnée fiscale ou monétaire incomplète.
- `pending` : calcul exact, fenêtre de validation en cours.
- `available` : commission éligible à un prochain lot.
- `held` : contrôle antifraude ou conformité.
- `allocated` : commission affectée à un lot de versement.
- `paid` : versement confirmé.
- `reversed` : remboursement, chargeback ou correction documentée.

### 7.2 Validation et versement

- Délai de validation : 45 jours après paiement confirmé.
- Versement : mensuel.
- Seuil mondial de référence : 10,00 USD, soit `1000` unités mineures.
- Pour chaque autre devise de règlement autorisée, Finance fige dans la version
  du programme un seuil équivalent documenté. La sélection du lot compare le
  solde et le seuil dans la même devise ; elle n'effectue aucune conversion FX
  implicite ou flottante au moment du versement.
- USD comme référence ne remplace ni la devise de transaction ni la devise de
  règlement. EUR reste notamment nécessaire aux transactions Google Play en EUR
  et aux règlements SEPA ; les soldes de devises différentes restent séparés.
- Les frais de transfert facturés à Norva par le provider ou la banque émettrice
  sont une charge de la plateforme. Ils sont enregistrés et rapprochés
  séparément, sans être déduits de la commission ni du montant de versement du
  partenaire sur un corridor pris en charge.
- Solde inférieur au seuil : reporté.
- Profil incomplet : solde conservé mais bloqué.
- Remboursement avant validation : réduction/annulation de la commission en
  attente.
- Remboursement après versement : écriture négative compensée par les gains
  futurs, sans prélèvement automatique.
- Solde négatif sans activité future : revue manuelle.

## 8. Expérience utilisateur

L'entrée se fait depuis Compte/Réglages. Norva Partners n'ajoute pas une nouvelle
destination à la navigation principale Home, Live TV, Movies ou Series.

### 8.1 Web

**État 1 — découverte et activation**

- promesse et disclosure visibles ensemble ;
- simulateur accessible avec détail du calcul ;
- trois étapes simples ;
- déclaration d'âge/capacité, parcours KYC hébergé et acceptation du contrat
  localisé ;
- activation après vérification serveur de l'identité et de l'âge, sans exiger
  immédiatement les données fiscales et bancaires complètes.
- disclosure explicite « personnes physiques uniquement » et état de liste
  d'attente si l'utilisateur souhaite inscrire une personne morale.

**État 2 — dashboard actif**

- montant disponible, en validation, payé et abonnements actifs ;
- estimation explicitement qualifiée ;
- lien personnel, copie, partage et QR ;
- disclosure commerciale incluse au partage ;
- profil de versement et prochaine échéance ;
- historique pseudonymisé et calcul détaillé ;
- filtres clavier : tous, validation, disponible, payé, annulé.

### 8.2 Android mobile et tablette

**État 1 — partage**

- lien et QR réels ;
- pré-feuille Norva avant la feuille de partage Android ;
- disclosure verrouillée et visible ;
- aucun import de contacts ;
- navigation système, barre Norva et toast non superposés ;
- cibles d'au moins 48 dp et police Android 1,3.

**État 2 — vérification de versement**

- gains visibles en arrière-plan sans surpromesse ;
- bottom sheet pleine hauteur ;
- formulaire fiscal avec IME et `adjustResize` ;
- un seul propriétaire de défilement ;
- erreur liée au champ et annoncée une fois ;
- Back ferme d'abord le clavier, puis le sheet, puis restaure le focus.

### 8.3 Android TV

TV est un relais vers le téléphone :

- aucun montant, document fiscal ou moyen de paiement affiché ;
- QR temporaire et code court de secours ;
- états chargement, prêt, expiré, régénération, hors ligne et succès ;
- géométrie stable entre les états ;
- focus D-pad visible, prévisible et restauré après Back ;
- zone sûre d'au moins 5 % et lignes de focus d'au moins 58 px.

### 8.4 Confidentialité des filleuls

Le partenaire voit seulement une référence pseudonymisée :

> A7K2 · Plus monthly · 0,83 € en validation

Il ne voit jamais le nom, l'e-mail, la localisation, le moyen de paiement ou
l'historique d'usage du filleul.

## 9. Partage et transparence

Texte prérempli :

> Je vous recommande Norva. Lien affilié : je peux recevoir une commission si
> vous vous abonnez, sans coût supplémentaire pour vous. Norva est un lecteur
> multimédia ; aucun contenu ni abonnement TV n'est inclus.

Les conditions partenaires interdisent :

- la promesse de revenu ;
- la présentation de Norva comme fournisseur de contenu ou d'IPTV ;
- le spam, les domaines trompeurs et l'usurpation de marque ;
- le cookie stuffing et les redirections invisibles ;
- l'achat du mot-clé de marque « Norva » sans autorisation ;
- toute communication commerciale sans disclosure requise.

## 10. Architecture P0

Créer un schéma non exposé, par exemple `affiliate_private`.

### 10.1 Tables

- `affiliate_program_versions` : taux en points de base, fenêtre, maturation,
  seuil USD de référence et seuil exact par devise de règlement, juridiction,
  conditions et dates d'effet.
- `affiliate_country_policies` : pays/subdivision, disponibilité, âge minimum,
  capacité requise, niveau KYC individuel, prestataire, devises de versement,
  contrat et disclosures applicables.
- `affiliate_accounts` : partenaire, pseudonyme durable, code public, statut,
  type `individual`, référence KYC, résultat âge/capacité, juridiction, contrat
  et vérifications.
- `affiliate_link_claims` : hash du claim, expiration, consommation et campagne.
- `affiliate_attributions` : filleul unique, partenaire, claim, version du
  programme, taux figé et motif de rejet.
- `affiliate_financial_facts` : brut, taxe, HT, devise transactionnelle
  autoritative, exposant, origine et snapshot immuable.
- `affiliate_commission_jobs` : outbox transactionnelle, lease, retries et dead
  letter.
- `affiliate_commission_entries` : journal append-only des accruals, reversals et
  ajustements.
- `affiliate_payout_profiles` : une destination tokenisée et masquée par
  compte/devise ; aucune conversion FX implicite.
- `affiliate_payout_cycles` et `affiliate_payout_items` : lots, lignes et clés
  d'idempotence.
- `affiliate_events` : audit sanitisé des transitions et décisions.

### 10.2 Principes

- `cloud_billing_ledger` est la source de déclenchement, jamais l'état projeté
  de l'abonnement.
- Les snapshots financiers sont immuables.
- Les remboursements sont des contre-écritures.
- Une commission appartient au plus à un versement.
- Aucun traitement de commission ne modifie les droits d'abonnement.
- Les coordonnées bancaires restent tokenisées chez le prestataire.
- La suppression Auth nullifie l'UUID et conserve uniquement les écritures
  pseudonymisées légalement nécessaires.

### 10.3 Idempotence

Clés minimales :

```text
accrual:{ledger_payment_id}
reversal:{ledger_refund_id}
payout:{period}:{affiliate_account_id}
```

- Les claims concurrents verrouillent le filleul et le claim.
- Chaque remboursement référence explicitement le paiement d'origine.
- Un retry exact retourne la ressource existante sans changer le solde.
- `TRANSFER` et `PURCHASE_REDEEMED` restent en quarantaine tant que la
  correspondance de comptes n'est pas déterministe.

## 11. Sécurité et accès

- Les tables canoniques ne sont pas exposées par PostgREST.
- Aucun droit direct à `anon` ou `authenticated`.
- Les RPC utilisateur :
  - sont `SECURITY DEFINER` ;
  - définissent `SET search_path = ''` ;
  - refusent `PUBLIC` et `anon` ;
  - dérivent `auth.uid()` ;
  - n'acceptent jamais de `user_id`.
- Les opérations Admin exigent `is_admin()`, une justification et une entrée
  d'audit.
- La service role reste limitée aux Edge Functions.
- L'émission et la consommation des claims sont rate-limitées.
- Les vues utilisateur n'exposent que des agrégats et références masquées.

## 12. Fraude et conformité

### Blocages fermes

- auto-parrainage ;
- boucle d'attribution ;
- environnement de test ou compte interne ;
- événement financier déjà traité ;
- attribution après création du compte ;
- claim invalide, expiré ou manipulé.

### Signaux de revue

- moyen de paiement ou compte boutique commun ;
- volume anormal depuis un appareil, une adresse réseau ou une campagne ;
- inscriptions rapidement remboursées ;
- taux de chargeback anormal ;
- foyer ou réseau partagé.

Un signal faible produit `held` et une revue humaine, pas une confiscation
automatique. La suspension d'un partenaire ne change jamais l'abonnement du
filleul.

Avant ouverture du pilote :

- validation juridique dans chaque juridiction initialement activée ;
- validation comptable et fiscale par pays/rail ;
- contrat électronique versionné ;
- mise à jour de la politique de confidentialité ;
- couverture réelle du prestataire KYC et du rail de versement individuel
  confirmée pour chaque pays activé ;
- conservation, accès, rectification, suppression et pseudonymisation définis ;
- aucune donnée financière privée sur TV, Telegram ou analytics.

## 13. Analytics et observabilité

Événements :

- `partners_viewed`
- `partners_activated`
- `affiliate_link_created`
- `affiliate_link_shared`
- `affiliate_link_opened`
- `affiliate_signup_attributed`
- `affiliate_first_payment`
- `affiliate_renewal`
- `affiliate_commission_pending`
- `affiliate_commission_available`
- `affiliate_commission_paid`
- `affiliate_commission_reversed`
- `affiliate_verification_completed`

Indicateurs :

- activation du programme ;
- clic → inscription → premier paiement ;
- revenu HT attribué ;
- abonnements actifs apportés et rétention ;
- coût de commission et marge par rail ;
- remboursements, chargebacks et suspicions ;
- délai jusqu'au premier versement ;
- part des soldes bloqués par vérification.

Les outils analytics ne reçoivent ni nom, ni e-mail, ni coordonnées bancaires,
ni code affilié public brut.

## 14. Back-office minimum

L'Admin permet de consulter :

- revenu TTC/HT attribué ;
- commissions en calcul, validation, disponibles, bloquées et versées ;
- marge par rail ;
- remboursements et chargebacks ;
- statut contractuel, fiscal et de versement ;
- dossiers de fraude et décision motivée ;
- lots de versement et erreurs bancaires ;
- export comptable et déclaratif.

Les rôles Support ne voient ni documents d'identité complets ni coordonnées
bancaires.

Le P0 n'affiche aucune fiche KYB, aucun bénéficiaire effectif et aucune action
de validation d'entreprise. L'Admin peut seulement consulter le nombre
d'inscriptions à la liste d'attente « comptes professionnels ».

## 15. Déploiement

1. Créer claims, attribution, RLS et pseudonymisation sous feature flag.
2. Ajouter `/r/{code}`, le claim serveur et l'App Link Android.
3. Capturer taxe, devise et exposant exacts pour RevenueCat et Revolut.
4. Exécuter l'outbox et le ledger en calcul fantôme.
5. Réconcilier 100 % des paiements : commission, exclusion ou blocage explicite.
6. Résoudre `TRANSFER`, fraude et maturation.
7. Ouvrir un pilote sur invitation à 20–50 partenaires répartis dans les
   premières juridictions validées, sans quota particulier pour la France.
8. Effectuer deux versements mensuels supervisés.
9. Généraliser uniquement après validation juridique, comptable, marge et fraude.
10. Étudier le KYB seulement après le go/no-go P0, dans un lot séparé sans
    réutiliser un KYC individuel comme preuve d'entreprise.

## 16. Critères d'acceptation

Le P0 est accepté lorsque :

1. Deux claims concurrents ne peuvent jamais attribuer deux partenaires.
2. Chaque paiement éligible produit exactement une commission ou un motif
   bloquant explicite.
3. La commission vaut 20 % du montant HT réellement payé après remise.
4. La formule est testée sur plusieurs taxes, devises et exposants monétaires.
5. Les frais du rail sont séparés, supportés par Norva pour les corridors pris
   en charge et ne réduisent ni l'assiette ni le versement partenaire.
6. Essais, sandbox, auto-parrainage, comptes internes et montants nuls rapportent
   zéro.
7. Web → Play et Play → Web conservent l'attribution.
8. Changement de plan, appareil, résiliation et réactivation restent cohérents.
9. Un remboursement complet ou partiel crée une seule contre-écriture exacte.
10. Rejouer claim, webhook, remboursement ou versement ne change pas deux fois
    le solde.
11. Une taxe, devise ou opération `TRANSFER` non résolue ne devient jamais
    payable.
12. Un utilisateur ne peut lire ni déclencher les données financières d'un
    autre.
13. `/r/` fonctionne sur Web, Android froid/chaud, OAuth et magic link.
14. Le QR TV ouvre le téléphone, expire proprement et se régénère sans doublon.
15. Le parcours mobile fonctionne avec gestes, trois boutons, IME et police 1,3.
16. Le parcours TV est entièrement utilisable au D-pad avec restauration du
    focus.
17. Aucun partenaire ne peut identifier un filleul.
18. Les disclosures commerciales et la qualification de Norva sont toujours
    présentes.
19. Une suppression de compte conserve seulement le journal pseudonymisé requis.
20. La réconciliation shadow respecte :

```text
paiements capturés admissibles
= commissions + exclusions + blocages
```

avec zéro paiement inexpliqué.

21. Un pays ou une subdivision non activé affiche un état indisponible/liste
    d'attente et ne peut pas créer de lien actif.
22. Une déclaration client d'âge, un callback navigateur ou un webhook rejoué
    ne peut jamais contourner la vérification provider et la politique serveur.
23. Norva ne conserve aucune image de pièce d'identité ou de selfie ; la
    suppression et la rétention de la référence KYC suivent le contrat provider
    et la politique de la juridiction.
24. Une personne morale ne peut ni activer un lien, ni accumuler une commission,
    ni recevoir un versement en P0 ; elle peut uniquement rejoindre la liste
    d'attente dédiée.
25. Les vérifications 499, 500 et 501 se succèdent sans rupture : le quota
    gratuit déclenche les alertes et le passage au paiement à l'usage, jamais un
    refus automatique d'un partenaire légitime.

## 17. Maquettes P0

Canvas Superdesign :

<https://superdesign.dev/teams/235f8bb0-73fd-4f0f-affc-7debc947fe7e/projects/6e5490fb-2cb5-4249-b2d9-7b63d9accc25>

Les six états à valider sont :

1. [Web — découverte et activation](https://p.superdesign.dev/draftcomponent/673acdc3-4f44-4c7c-80c2-4a43b3de758a).
2. [Web — dashboard actif et profil de versement vérifié](https://p.superdesign.dev/draftcomponent/426d61c9-e3ae-4628-849b-f80568018a4d).
3. [Android — lien prêt et feuille de partage ouverte](https://p.superdesign.dev/draftcomponent/51b5ae8f-ff79-4c2e-8702-7f877dee11fb).
4. [Android — gains avec vérification fiscale incomplète et IME visible](https://p.superdesign.dev/draftcomponent/6dd9b64d-8b14-418a-8d4b-65eae678f7a4d).
5. [Android TV — relais privé vers téléphone avec QR actif](https://p.superdesign.dev/draftcomponent/a184c24b-597c-40df-b5c5-f88f0c750606).
6. [Android TV — QR expiré et récupération au D-pad](https://p.superdesign.dev/draftcomponent/ab212f0a-017b-4bae-958c-dec52da068c6).

## 18. Backlog d'implémentation

Le découpage ordonné par dépendances, équipes et critères de sortie est décrit
dans [NORVA-PARTNERS-IMPLEMENTATION-BACKLOG.md](./NORVA-PARTNERS-IMPLEMENTATION-BACKLOG.md).
