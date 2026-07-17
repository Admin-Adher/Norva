# TVA & OSS — runbook Norva

> **Origine** : synthèse d'une recherche approfondie multi-agents (17 juillet 2026) — chaque
> affirmation chiffrée a été vérifiée contradictoirement sur sources officielles
> (impots.gouv.fr, BOFiP, Légifrance, service-public.fr, EUR-Lex, portail OSS de la
> Commission, douane.gouv.fr). Les points restés incertains sont explicitement listés en
> section 6 — à trancher avec l'expert-comptable.
>
> **Outillage dashboard** (livré avec la migration `20260717120000_customer_country_vat.sql`) :
> le panneau « 🇪🇺 TVA — préparation OSS » de la page Finance (RPC `admin_vat_report`) fournit
> la base trimestrielle par pays de consommation (rail web uniquement), le cumul annuel
> FR / UE hors FR / hors UE / inconnu, les jauges de seuils 10 000 € (UE) et 37 500 / 41 250 €
> (franchise FR), et un export CSV par trimestre. Le pays de chaque transaction web est le
> pays d'émission de la carte (BIN Revolut — élément de preuve « item c » de l'art. 24f du
> règl. 282/2011) ; il est figé sur `cloud_billing_ledger.country_code` au moment de
> l'encaissement et conservé (registres 10 ans).
>
> ⚠️ Ce document n'est pas un conseil fiscal ; il prépare le travail, il ne remplace ni
> l'expert-comptable ni le SIE.

# TVA Norva — synthèse de recherche vérifiée (état du droit au 17 juillet 2026)

Toutes les affirmations chiffrées ci-dessous ont été vérifiées de manière contradictoire sur sources officielles (impots.gouv.fr, BOFiP, service-public.fr, Légifrance, EUR-Lex, portail OSS de la Commission). Ce qui est énoncé comme un fait a le statut **CONFIRMÉ** ; les valeurs issues d'une correction du vérificateur sont signalées **[corrigé]** ; tout ce qui reste incertain est regroupé en section 6.

---

## 1. Vos obligations aujourd'hui

Situation : EI/micro-entrepreneur établi en France, sous **franchise en base de TVA** (CA de services < 37 500 €), deux canaux de vente.

**Canal Google Play — vous n'avez AUCUNE TVA consommateur à gérer.** L'article 9a du règlement d'exécution (UE) 282/2011 (validé par la CJUE, aff. C-695/20 *Fenix* ; confirmé pour les app stores par l'arrêt C-101/24 *Xyrality* du **9 octobre 2025** [corrigé — pas mars 2026]) fait de Google le « fournisseur présumé » : Google détermine, facture et reverse lui-même la TVA de chaque consommateur UE. Sa documentation le dit verbatim : « Google is responsible for determining, charging, and remitting VAT for all Google Play Store purchases… » (https://support.google.com/googleplay/android-developer/answer/138000). Votre seule opération est une **prestation B2B réputée fournie à l'entité irlandaise de Google** (Google Commerce Ltd / Google Ireland Ltd), localisée en Irlande (art. 44 directive / art. 259, 1° CGI), autoliquidée par Google (art. 196). **Attention** : cela ne vaut que pour le système de facturation Google Play — si vous activez un jour l'« alternative billing » EEE, la TVA consommateur retombe sur vous.

Cette prestation B2B déclenche néanmoins **deux formalités françaises dès aujourd'hui** :
1. **Demander (gratuitement) un numéro de TVA intracommunautaire** à votre SIE — obligatoire pour ces prestations B2B intra-UE, et cela ne fait PAS perdre la franchise (https://www.impots.gouv.fr/professionnel/questions/je-suis-micro-entrepreneur-ou-la-tete-dune-micro-entreprise-ai-je-des).
2. **Déposer une DES (Déclaration Européenne de Services)** chaque mois où Google vous verse des revenus, au plus tard le **10e jour ouvrable du mois suivant**, via douane.gouv.fr (les bénéficiaires de la franchise sont les seuls autorisés au formulaire papier CERFA 13694). Pénalité : 750 € par DES manquante (1 500 € au-delà de 30 jours après mise en demeure) (https://www.douane.gouv.fr/fiche/la-declaration-europeenne-de-services-des ; échéancier confirmé par https://www.impots.gouv.fr/pro-12022026-entreprises-soumises-la-tva-des).

**Canal web direct (Revolut Merchant, prix en USD)** — c'est vous le fournisseur B2C :
- **Clients français** : franchise en base → aucune TVA facturée, mention « TVA non applicable, art. 293 B du CGI » (à partir du 1er septembre 2026 : « art. L. 223-3 du CIBS », ancienne mention tolérée jusqu'au 31/12/2027) (https://entreprendre.service-public.gouv.fr/vosdroits/F21746).
- **Clients des autres pays UE** : un abonnement streaming/IPTV est un service électronique (TBE) taxable en principe dans le pays du client (art. 259 D CGI / art. 58 directive, BOFiP BOI-TVA-CHAMP-20-50-40-20). MAIS tant que vos ventes B2C transfrontalières UE (hors France, hors Play) restent **< 10 000 € HT sur l'année en cours ET l'année précédente**, le lieu de taxation reste la France → couvert par la franchise → **zéro TVA, zéro OSS**.
- **Clients hors UE** : hors champ de la TVA UE, mais pas forcément sans obligation locale — voir le point UK ci-dessous.

**Point de vigilance immédiat — Royaume-Uni** : pour un vendeur non établi, le seuil d'immatriculation UK est **nul** — la TVA britannique de 20 % est due dès la **première** vente B2C de service numérique à un consommateur UK, avec immatriculation HMRC et Making Tax Digital (https://www.gov.uk/guidance/the-vat-rules-if-you-supply-digital-services-to-private-consumers). Les ventes Play UK sont gérées par Google (règle marketplace UK équivalente) ; seul le canal web est exposé. Décision à prendre : bloquer les clients UK au checkout, ou s'immatriculer.

**Achats B2B étrangers** : même sous franchise, tout service taxable acheté à un prestataire UE/étranger (hébergement, SaaS, publicité…) doit être **autoliquidé** dès le premier euro via une CA3 ponctuelle, TVA non déductible (art. 283-2 CGI) (https://www.impots.gouv.fr/professionnel/questions/je-suis-micro-entrepreneur-ou-la-tete-dune-micro-entreprise-ai-je-des). Nuance : les frais d'acquiring de Revolut sont typiquement des services financiers **exonérés** (art. 135-1-d directive) → pas de TVA à autoliquider dessus si facturés comme tels.

**En résumé aujourd'hui** : pas de TVA à facturer nulle part (si < 10 000 € de ventes web UE hors France et aucun client UK), mais : numéro de TVA intracom + DES mensuelle (Google), autoliquidation des achats de services étrangers taxables, et surveillance des compteurs de seuils.

---

## 2. Les paliers qui changent la donne

| Seuil | Montant 2026 | Ce qui compte dans la base | Ce qui se passe au franchissement |
|---|---|---|---|
| **Seuil UE ventes à distance B2C** | **10 000 € HT** (année N et N-1) | UNIQUEMENT les ventes web (Revolut) B2C aux consommateurs des **autres** pays UE. Exclus : clients FR, clients hors UE, tout Google Play (B2B) | La transaction qui franchit le seuil est déjà taxée dans le pays du client. Il faut alors soit facturer la TVA de chaque pays via l'**OSS**, soit adhérer au **régime PME UE (numéro EX)** pour rester exonéré. La franchise française ne protège PAS de cette TVA étrangère (BOFiP BOI-TVA-CHAMP-20-50-40-20 ; https://sme-vat-rules.ec.europa.eu/sme-scheme/cross-border-sme-scheme_en) |
| **Franchise FR — seuil de base** | **37 500 € HT** | CA des opérations **« réalisées en France »** (art. 293 D CGI) : ventes web aux clients FR + ventes web autres-UE tant que < 10 000 €. **Google Play est EXCLU** (prestation localisée en Irlande — https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000019288097) | Dépassé en année N (sans franchir 41 250 €) → TVA française à facturer à partir du **1er janvier N+1**. L'ancienne tolérance de 2 ans est supprimée depuis 2025 (https://entreprendre.service-public.gouv.fr/vosdroits/F21746) |
| **Franchise FR — seuil majoré** | **41 250 € HT** | Même base | TVA due **dès le jour du dépassement** (plus de rétroactivité au 1er du mois) (https://www.impots.gouv.fr/professionnel/questions/en-tant-que-micro-entrepreneur-puis-je-etre-redevable-de-la-tva). NB : le seuil unique à 25 000 € de la LF 2025 n'a jamais été appliqué — abrogé par la loi n° 2025-1044 du 3 nov. 2025 ; la LF 2026 (loi n° 2026-103 du 19 fév. 2026) n'y touche pas |
| **Régime PME UE (numéro EX)** | **100 000 €** de CA annuel Union (N et N-1) | **TOUTES** les prestations localisées dans l'UE : ventes web FR + ventes web autres-UE **+ les versements Google Play** (B2B localisé en Irlande = dans l'Union). Déduction directe des notes explicatives CE, à confirmer avec l'expert-comptable (https://sme-vat-rules.ec.europa.eu/system/files/2024-10/sme-explanatory-notes_en.pdf) | Au-delà : **exclusion immédiate** du régime EX dans tous les États, déclaration de dépassement sous **15 jours**, la TVA de destination devient due (OSS ou immatriculations locales), quarantaine avant ré-entrée. Condition supplémentaire : rester sous le seuil national de franchise de chaque État visé |
| **Plafond micro-entreprise (services)** | **83 600 €** de recettes HT (2026-2028, arrêté du 27 janv. 2026) — **le chiffre de 77 700 € est obsolète depuis le 1/1/2026** [corrigé] | TOUTES les recettes encaissées, **y compris les versements Google Play** (pas de carve-out territorial) (https://entreprendre.service-public.gouv.fr/actualites/A18813) | Deux années consécutives au-dessus → sortie du régime micro (IR + social) vers un régime réel. Événement distinct de la TVA : entre 37 500 € et 83 600 €, on reste micro-entrepreneur tout en étant redevable de la TVA |
| **Seuil « preuve unique »** | **100 000 €/an** de ventes TBE (art. 24b §2, règl. 282/2011, N et N-1) | Ventes TBE relevant de la présomption générale (canal web) | En dessous : **1 seul** élément de preuve de localisation suffit (fourni par un tiers de la chaîne, items a-e de l'art. 24f — le pays BIN de la carte via Revolut est l'ancre idéale). Au-delà (effet immédiat en cours d'année) : **2 éléments non contradictoires** obligatoires (https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32017R2459) |
| **Hors UE — UK** | **0 £** | Toute vente B2C numérique à un consommateur UK (canal web) | Immatriculation + 20 % dès la 1re vente (https://www.gov.uk/guidance/the-vat-rules-if-you-supply-digital-services-to-private-consumers) |
| **Hors UE — Suisse** | **CHF 100 000 de CA MONDIAL** (de prestations de type taxable) | Tout le CA mondial d'abonnements, dès qu'il existe des clients B2C suisses | Immatriculation TVA suisse (taux 8,1 %), représentant fiscal (https://www.rsm.global/switzerland/en/news/foreign-providers-digital-services-switzerland-overview-vat-obligations) |
| **Hors UE — Norvège** | **NOK 50 000 / 12 mois glissants** (ventes norvégiennes uniquement) | Ventes B2C aux consommateurs norvégiens | Registre VOEC, déclarations trimestrielles au 20 (https://www.skatteetaten.no/en/business-and-organisation/vat-and-duties/vat/foreign/e-commerce-voec/register/) |

**Correction importante du vérificateur** : perdre la franchise française (> 37 500 / 41 250 €) ne fait **pas** perdre automatiquement l'exonération transfrontalière du régime PME UE — les deux niveaux sont indépendants. Au-dessus du seuil FR, on doit la TVA française sur les ventes françaises, mais on peut encore choisir, pour les ventes B2C autres-UE, entre l'OSS (TVA de destination) et le numéro EX (exonération), tant que le CA Union reste ≤ 100 000 € [corrigé].

---

## 3. Le guichet OSS en pratique

Le régime pertinent est l'**OSS régime de l'Union**, géré depuis la France. Tout est vérifié sur les fiches focus DGFiP (mises à jour 06/11/2025) et le portail OSS de la Commission.

**Inscription** : espace professionnel impots.gouv.fr → Mes services → Démarches → « Guichet de TVA UE » → « Je choisis le régime UE ». Gratuit. Prérequis : numéro de TVA intracom français (FR + clé 2 chiffres + SIREN). Prise d'effet normale : 1er jour du trimestre civil suivant ; **rétroactivité possible à la date de la première vente étrangère si la demande est déposée au plus tard le 10 du mois suivant cette vente** — fenêtre critique quand on franchit les 10 000 € (https://www.impots.gouv.fr/fiche-focus-mini-guichet-tva-enregistrement-operateurs-metropole). L'adhésion vaut en principe pour 3 années civiles.

**Cadence et échéances** : déclaration **trimestrielle**, due le dernier jour du mois suivant le trimestre — **30 avril, 31 juillet, 31 octobre, 31 janvier** — **sans aucun report** si l'échéance tombe un week-end ou jour férié ; dépôt impossible avant la fin du trimestre. **Déclaration « néant » obligatoire** chaque trimestre même sans ventes (une case à cocher).

**Contenu** (structure de l'annexe III du règlement 2020/194, https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32020R0194) : une ligne par État membre de consommation et par taux — type d'opération (« prestations de services »), État (menu déroulant), taux (menu déroulant pré-rempli par le portail), **base imposable en euros** ; la « TVA due (€) » est calculée automatiquement. Les ventes aux clients **français ne vont jamais dans l'OSS** (elles restent sur la déclaration nationale, ou nulle part sous franchise). Aucune TVA déductible ne passe par l'OSS.

**Règle de change (côté OSS)** : la déclaration est en euros ; les encaissements USD se convertissent au **taux BCE publié le dernier jour du trimestre** (31/03, 30/06, 30/09, 31/12), pas transaction par transaction — base légale : **art. 369h** de la directive 2006/112 pour le régime de l'Union [corrigé — pas l'art. 366, qui vise le régime non-Union] (fiche DGFiP + https://vat-one-stop-shop.ec.europa.eu/one-stop-shop/declare-and-pay-oss_en).

**Paiement** : uniquement par **virement en euros** au Pôle national TVA commerce en ligne (à ce jour — le télépaiement est annoncé mais pas actif au 06/11/2025), même échéance, avec pour **seul motif** la référence unique de la déclaration (format OSS/FR/FRxx…/Qn.YYYY, en majuscules, sans espace) — une référence absente ou fausse vaut défaillance. La date de valeur est la date de crédit du compte : virer en avance.

**Corrections, remboursements, chargebacks** : une déclaration déposée n'est plus modifiable après l'échéance ; on corrige dans une **déclaration ultérieure** (rubrique dédiée : période + État + montant ±, dans un délai de **3 ans**). Un remboursement d'abonnement vendu un trimestre antérieur = correction négative de ce trimestre-là. **Pas de compensation entre États** : un trop-payé à un État est remboursé directement par cet État ; les montants dus aux autres restent payables en totalité.

**Registres** : conservation **10 ans** à compter de la fin de l'année de l'opération, disponibles électroniquement « sans délai » sur demande de la France ou de tout État de consommation (format SAF-OSS recommandé, non obligatoire). Contenu par transaction : art. 63c du règl. 282/2011 (État de consommation, date, base et devise, augmentations/réductions ultérieures, taux, TVA, encaissements, facture éventuelle, **preuves de localisation du client**) (https://vat-one-stop-shop.ec.europa.eu/one-stop-shop/record-keeping-and-audits-oss_en).

**Sanctions** : rappel électronique français au 10e jour de retard ; rappels suivants et pénalités directement par chaque État de consommation selon son droit national. Défaillance persistante (3 périodes consécutives non régularisées sous 10 jours, minimis 100 €/période pour le paiement, ou registres non fournis sous 1 mois) → **exclusion de tous les régimes OSS/IOSS pour 2 ans**. Depuis 2024, les administrations peuvent recouper vos déclarations avec les données **CESOP** que Revolut doit transmettre trimestriellement (tout bénéficiaire de > 25 paiements transfrontaliers/trimestre).

**Facturation B2C** : aucune facture TVA n'est exigée pour les ventes B2C sous OSS (règles françaises applicables, art. 219a) — un reçu/e-mail de confirmation suffit (avec la « note » consommateur ≥ 25 € TTC du droit français de la consommation, couverte en pratique par le reçu).

---

## 4. Google Play vs vente directe

| | **Vente directe (Revolut)** | **Google Play (facturation Play)** |
|---|---|---|
| Qui est le vendeur B2C ? | **Vous** | **Google** (fournisseur présumé, art. 9a règl. 282/2011) |
| TVA consommateur UE | Vous (selon les paliers de la section 2) | **Google**, intégralement |
| Compte dans le seuil 10 000 € UE | **Oui** (ventes autres-UE seulement) | **Non** |
| Compte dans la franchise FR 37 500 € | **Oui** (ventes localisées en France) | **Non** (B2B localisé en Irlande) |
| Compte dans le plafond micro 83 600 € | Oui | **Oui** |
| Compte dans les 100 000 € du régime EX | Oui (ventes UE) | **Oui** (déduction des notes CE — à valider avec l'expert-comptable) |
| Va dans la déclaration OSS | Oui (clients autres-UE) | **Jamais** |
| Obligation déclarative | OSS trimestriel (si > 10 k€) ; rien sous les seuils | **DES mensuelle** (10e jour ouvrable du mois suivant) + numéro de TVA intracom |
| Preuves de localisation client | **À collecter et stocker par vous** | Collectées par Google |

Le revenu Play se comptabilise sur la base des versements de Google (question brut vs net de commission ouverte — section 6) ; conservez les relevés mensuels de paiement du Play Console comme pièces.

---

## 5. Ce que le dashboard doit préparer

**A. Enregistrement par transaction (canal web), conservé 10 ans** — champs calqués sur l'art. 63c :
- identifiant, date d'**encaissement**, statut (vente / remboursement / chargeback, avec lien vers la vente d'origine et son trimestre) ;
- montant USD encaissé, et **deux valorisations EUR** (voir C) ;
- **pays du client retenu** + les preuves : **pays BIN/banque émettrice fourni par Revolut** (élément-ancre, item c de l'art. 24f), **pays de l'adresse de facturation** saisie au checkout (item a), **pays IP** (item b, corroboration). Sous 100 000 € de ventes TBE, un seul élément tiers suffit ; le design conservateur en stocke trois d'emblée ;
- taux de TVA appliqué (0 sous franchise/EX ; taux du pays sous OSS), TVA correspondante ;
- canal (web / play) comme dimension de premier rang — les lignes Play (versements Google) sont un flux séparé, jamais mélangé aux bases OSS.

**B. Sortie trimestrielle OSS** (générée mais utilisée seulement une fois > 10 000 € et si l'option OSS est retenue) : pour chaque pays UE **hors France**, une ligne { code pays, taux standard, base imposable EUR, TVA due } — bases = somme des USD du trimestre par pays convertie **une seule fois au taux BCE du dernier jour du trimestre** ; plus une section corrections { trimestre passé, pays, montant ± } pour les remboursements de périodes antérieures. Les taux se rafraîchissent avant chaque dépôt depuis la base officielle **TEDB** de la Commission (https://ec.europa.eu/taxation_customs/tedb/ — web service SOAP `VatRetrievalService.wsdl`), désignée par le portail OSS lui-même. Table 2026 vérifiée (taux standards, en %) : AT 20, BE 21, BG 20, HR 25, CY 19, CZ 21, DK 25, EE 24, FI 25.5, FR 20, DE 19, EL 24, HU 27, IE 23, IT 22, LV 21, LT 21, LU 17, MT 18, NL 21, PL 23, PT 23, RO 21, SK 23, SI 22, ES 21, SE 25. Aucun changement de taux **standard** en 2026 ; un abonnement streaming prend le taux standard partout (défaut sûr).

**C. Deux régimes de conversion USD→EUR sur le même flux** :
1. **Côté français** (compteurs 37 500 / 41 250 / 10 000 €, CA URSSAF, future CA3) : règle du CGI art. 266, 1 bis — taux BdF/BCE connu au jour de l'**exigibilité = encaissement** (tolérance : un taux mensuel unique, celui de l'avant-dernier mercredi du mois précédent, appliqué toute l'année) ;
2. **Côté OSS** : taux BCE du **dernier jour du trimestre**, appliqué aux totaux.
Utiliser l'un pour l'autre serait une erreur. Si Revolut règle en EUR, l'EUR crédité est la donnée naturelle côté URSSAF.

**D. Compteurs de seuils à afficher (chacun a une base différente)** :
1. `FR_franchise` : ventes web localisées en France (clients FR + autres-UE tant que < 10 k€), HT, année civile → jauges 37 500 / 41 250 € ; alerte préparatoire vers 35 000 € ;
2. `EU_10k` : ventes web B2C aux consommateurs autres-UE, année N **et** N-1 → jauge 10 000 € ;
3. `EU_SME_100k` : ventes web UE (FR incluse) **+ versements Play**, N et N-1 → jauge 100 000 € (pertinent si option numéro EX) ;
4. `micro_83600` : toutes recettes encaissées HT (web + Play) → jauge 83 600 € ;
5. `evidence_100k` : ventes TBE canal web → bascule 1 preuve → 2 preuves ;
6. `UK / CH / NO` : revenu par juridiction (UK : toute vente = alerte immédiate ; CH : CA mondial vs CHF 100 000 dès qu'un client suisse existe ; NO : NOK 50 000 sur 12 mois glissants).
La TVA étrangère collectée via OSS est **exclue** du CA déclaré à l'URSSAF (règle du CA hors taxes — https://www.autoentrepreneur.urssaf.fr/portail/accueil/une-question/toutes-les-fiches-pratiques/determiner-mon-chiffre-daffaires.html).

**E. Calendrier intégré** : DES mensuelle (10e jour ouvrable) ; OSS 30/04, 31/07, 31/10, 31/01 (sans report, néant obligatoire) ; si régime EX : rapport trimestriel des CA dans les 27 États sous 1 mois (mêmes dates) + alerte « dépassement 100 k€ » à notifier sous 15 jours ; à partir de 2027, si redevable en France : **CA3 trimestrielle** (le régime réel simplifié / CA12 est supprimé au 1er janvier 2027 par l'art. 38 de la LF 2025 — ne rien construire autour de la CA12) (https://www.legifiscal.fr/actualites-fiscales/4052-loi-finances-2025-reforme-regime-simplifie-tva-compter-2027.html).

**F. Documents** : mention de franchise sur les reçus (bascule CGI→CIBS au 01/09/2026) ; export SAF-OSS-compatible des registres ; archivage des certificats de dépôt OSS (PDF) et des relevés Play.

---

## 6. Points encore incertains — à valider avec l'expert-comptable / le SIE

1. **Play : brut ou net ?** Comptabiliser les versements Google nets de commission ou le prix consommateur brut avec commission autoliquidée ? Dépend de l'existence de factures de frais de service séparées de Google (à vérifier dans Play Console). Impacte le montant de la DES, le CA micro et l'analyse autoliquidation. NON RÉSOLU.
2. **Entité Google exacte** (Google Commerce Ltd vs Google Ireland Ltd) et son numéro de TVA irlandais pour remplir la DES : à lire sur vos propres relevés de versement Play. NON RÉSOLU (donnée privée).
3. **Play dans les 100 000 € du régime EX** : l'inclusion des prestations B2B réputées à Google Ireland dans le « chiffre d'affaires annuel dans l'Union » est une déduction directe des notes explicatives CE, pas une position écrite nommant les app stores. À confirmer avant de compter sur la marge du numéro EX. PLAUSIBLE, non tranché.
4. **Facture unique franchissant le seuil majoré 41 250 €** : les pages officielles disent « TVA dès le jour du dépassement » ; le BOFiP consolidé n'a pas pu être vérifié sur le sort précis de la facture franchissante. Impact marginal (beaucoup de petites factures). NON RÉSOLU.
5. **IP auto-collectée comme preuve unique** (art. 24b §2 exige un tiers) : non tranché officiellement → design conservateur : ancre = pays BIN fourni par Revolut. NON RÉSOLU.
6. **Périmètre exact du seuil 100 000 € « preuve unique »** (toutes ventes TBE ou seulement transfrontalières) : le texte ne le précise pas. Sans enjeu au stade actuel. NON RÉSOLU.
7. **TVA étrangère OSS exclue du CA URSSAF** : découle de la règle générale « CA hors taxes », mais aucun texte officiel ne vise l'OSS nommément — demander une confirmation écrite (messagerie sécurisée) si les montants deviennent significatifs. NON RÉSOLU formellement.
8. **Télépaiement OSS** : la fiche du 06/11/2025 n'accepte que le virement ; vérifier la section Paiement du portail au premier dépôt. À RE-VÉRIFIER.
9. **Recodification CIBS au 01/09/2026** : renumérotation à droit constant attendue (293 B → L. 223-3 CIBS, etc.) ; mettre à jour les mentions générées. À RE-VÉRIFIER après le 01/09/2026.
10. **E-reporting 2027** : l'exclusion des opérations couvertes par l'OSS repose sur la FAQ DGFiP ; décrets d'application à re-vérifier avant le 01/09/2027 (vague micro/TPE), y compris pour les ventes B2C domestiques.
11. **Taux norvégien VOEC** (25 % attendu) et présence effective de clients UK/CH/NO : le breakdown pays du dashboard répondra. À RE-VÉRIFIER si des clients apparaissent.
12. **Veille** : PLF 2027 (troisième tentative possible de refonte des seuils de franchise — deux tentatives déjà avortées), Roumanie (hausse à 23 % évoquée puis démentie en nov. 2025 — re-vérifier TEDB avant chaque dépôt), consultation suisse sur la taxation des plateformes (pourrait déplacer la collecte suisse sur les stores).
13. **Rappel non fiscal** : toute cette analyse suppose un service IPTV détenant les droits de retransmission ; la qualification « service électronique au taux standard » est le défaut sûr (une éventuelle qualification « radiodiffusion » à taux réduit, ex. Autriche 10 %, ne vise que la retransmission linéaire simultanée et inchangée).