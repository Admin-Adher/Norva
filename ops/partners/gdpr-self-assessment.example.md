# Norva Partners — auto-évaluation RGPD interne du pilote France

> Modèle à copier et compléter hors Git. Le document final reste dans le
> stockage privé immuable des preuves. Il ne doit contenir aucun secret,
> document d'identité, identifiant Didit, UUID utilisateur, IBAN ni donnée
> bancaire. Ce document n'emporte aucune désignation officielle de DPO.

## 1. Identité et portée de la décision

- Version de l'évaluation : `<version immuable>`
- Paquet d'approbation : `partners-france-invite-pilot-v3`
- Commit candidat : `<SHA Git 40 caractères>`
- Déploiement : `<identifiant opaque immuable>`
- Date UTC de décision : `<YYYY-MM-DDTHH:MM:SSZ>`
- Dossier pseudonymisé du responsable : `<référence aléatoire privée>`
- Rôle : `privacy_accountable_owner`
- Méthode : `documented_internal_gdpr_self_assessment_with_mandatory_dpia`
- Accès : `invite_only`
- Pays : `FR`
- Plafond : `50` participants
- Ouverture publique autorisée par cette décision : `non`
- DPO officiellement désigné par cette décision : `non`

## 2. Screening de l'obligation de désigner un DPO

Documenter les faits, la source et la conclusion pour chacun des critères
applicables. Une réponse incertaine reste une action ouverte et empêche de
viser l'évaluation.

| Critère examiné | Faits observés | Conclusion | Preuve/référence |
| --- | --- | --- | --- |
| Organisme ou autorité publique | `<à compléter>` | `<oui/non/incertain>` | `<référence>` |
| Suivi régulier et systématique à grande échelle au cœur de l'activité | `<à compléter>` | `<oui/non/incertain>` | `<référence>` |
| Traitement à grande échelle de données sensibles ou pénales au cœur de l'activité | `<à compléter>` | `<oui/non/incertain>` | `<référence>` |

Conclusion motivée : `<à compléter>`

Conclusion de cadrage pour ce seul pilote : Norva n'est pas un organisme
public et le traitement biométrique du pilote est borné à 50 personnes sur
invitation ; il n'est donc pas traité « à grande échelle » dans ce périmètre.
Ce pilote ne déclenche pas, à lui seul, une désignation obligatoire de DPO.
Cette conclusion doit être confirmée par les faits consignés ci-dessus et ne
préjuge pas des autres activités de Norva. La CNIL rappelle que le DPO devient
notamment obligatoire lorsque les activités de base conduisent à traiter à
grande échelle des données sensibles :
https://www.cnil.fr/fr/le-delegue-la-protection-des-donnees-dpo/devenir-delegue-la-protection-des-donnees

Déclencheurs de réévaluation : ouverture publique, dépassement de 50 pilotes,
nouveau pays, nouveau type de personne, nouveau traitement de données
sensibles, nouvelle finalité de profilage/surveillance, incident majeur ou
évolution réglementaire pertinente.

## 3. AIPD/DPIA obligatoire du KYC Didit

L'AIPD est obligatoire **avant** toute collecte d'identité en production pour
ce pilote. Le KYC Didit remplit au moins deux critères CNIL :

1. données sensibles ou hautement personnelles, puisque le parcours traite des
   données biométriques aux fins d'identifier une personne ;
2. exclusion du bénéfice d'un droit ou d'un contrat, puisque le résultat KYC
   conditionne l'accès au programme Partners et aux versements.

La CNIL indique qu'une AIPD est requise lorsqu'au moins deux des neuf critères
sont remplis. Elle doit comprendre une description détaillée du traitement,
l'évaluation de sa nécessité et de sa proportionnalité, l'évaluation des risques
pour les droits et libertés et les mesures prévues pour les traiter. Sources :

- https://www.cnil.fr/fr/ce-quil-faut-savoir-sur-lanalyse-dimpact-relative-la-protection-des-donnees-aipd
- https://www.cnil.fr/fr/gerer-les-risques
- https://www.cnil.fr/fr/securite-analyse-de-risques

Le plafond de 50 participants limite l'échelle ; il ne supprime pas l'obligation
d'AIPD. Une simple « évaluation préliminaire », une case cochée ou une preuve de
configuration Didit ne remplace pas l'AIPD.

### 3.1 Description systématique du traitement

- Responsable de traitement et responsable interne de la décision : `<à compléter>`
- Sous-traitant, workflow et environnement Didit exacts : `<à compléter>`
- Personnes concernées et plafond effectivement appliqué : `<à compléter>`
- Finalités précises et usages explicitement exclus : `<à compléter>`
- Opérations et flux de bout en bout, y compris capture, transfert, résultat,
  reprise manuelle, suppression et audit : `<à compléter>`
- Catégories de données, dont données biométriques, document d'identité,
  liveness, âge, pays et résultat de vérification : `<à compléter>`
- Destinataires, lieux de traitement, transferts et garanties : `<à compléter>`
- Bases légales par opération et condition de l'article 9 RGPD retenue pour les
  données biométriques : `<à faire confirmer ; référence juridique>`
- Durées de conservation chez Norva et Didit, suppression et preuve de
  paramétrage : `<à compléter>`
- Décision automatisée ou humaine, effets d'un refus, recours et procédure de
  reprise manuelle : `<à compléter>`
- Interfaces, APIs, webhooks, logs, Admin et sauvegardes concernés : `<à compléter>`

### 3.2 Nécessité et proportionnalité

| Contrôle | Analyse factuelle | Mesure/preuve | Conclusion |
| --- | --- | --- | --- |
| Finalité déterminée, explicite et légitime | `<à compléter>` | `<référence>` | `<adéquat/non adéquat>` |
| Donnée strictement nécessaire à chaque finalité | `<à compléter>` | `<référence>` | `<adéquat/non adéquat>` |
| Alternative moins intrusive étudiée | `<à compléter>` | `<référence>` | `<adéquat/non adéquat>` |
| Base légale article 6 et condition article 9 | `<à compléter>` | `<référence>` | `<adéquat/non adéquat>` |
| Information préalable claire et consentements éventuels distincts | `<à compléter>` | `<référence>` | `<adéquat/non adéquat>` |
| Exactitude, recours humain et non-discrimination | `<à compléter>` | `<référence>` | `<adéquat/non adéquat>` |
| Durées, suppression et limitation des accès | `<à compléter>` | `<référence>` | `<adéquat/non adéquat>` |
| Droits des personnes et procédure de contestation | `<à compléter>` | `<référence>` | `<adéquat/non adéquat>` |
| Encadrement Didit et transferts internationaux | `<à compléter>` | `<référence>` | `<adéquat/non adéquat>` |

Toute conclusion `non adéquat`, incertaine ou non prouvée empêche le visa
Privacy et la collecte live.

### 3.3 Risques pour les droits et libertés

Définir avant l'analyse les échelles de gravité et de vraisemblance. Évaluer les
impacts sur les personnes, et non seulement l'impact commercial pour Norva.

| Scénario de risque | Source/menace | Impact pour la personne | Gravité initiale | Vraisemblance initiale | Mesures existantes/prévues | Gravité résiduelle | Vraisemblance résiduelle | Propriétaire et échéance |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Usurpation ou fuite du document/biométrie | `<à compléter>` | `<à compléter>` | `<échelle>` | `<échelle>` | `<à compléter>` | `<échelle>` | `<échelle>` | `<à compléter>` |
| Faux rejet et exclusion injustifiée | `<à compléter>` | `<à compléter>` | `<échelle>` | `<échelle>` | `<à compléter>` | `<échelle>` | `<échelle>` | `<à compléter>` |
| Faux positif ou contournement | `<à compléter>` | `<à compléter>` | `<échelle>` | `<échelle>` | `<à compléter>` | `<échelle>` | `<échelle>` | `<à compléter>` |
| Accès Admin ou journalisation excessive | `<à compléter>` | `<à compléter>` | `<échelle>` | `<échelle>` | `<à compléter>` | `<échelle>` | `<échelle>` | `<à compléter>` |
| Réutilisation ou conservation excessive | `<à compléter>` | `<à compléter>` | `<échelle>` | `<échelle>` | `<à compléter>` | `<échelle>` | `<échelle>` | `<à compléter>` |
| Transfert international non maîtrisé | `<à compléter>` | `<à compléter>` | `<échelle>` | `<échelle>` | `<à compléter>` | `<échelle>` | `<échelle>` | `<à compléter>` |
| Indisponibilité empêchant recours/suppression | `<à compléter>` | `<à compléter>` | `<échelle>` | `<échelle>` | `<à compléter>` | `<échelle>` | `<échelle>` | `<à compléter>` |

Ajouter tout scénario propre au workflow effectivement configuré. Chaque mesure
doit avoir une preuve, un propriétaire, une échéance et un état vérifiable.

### 3.4 Décision résiduelle et consultation préalable

- Risque résiduel global : `<faible/modéré/élevé/non évalué>`
- Mesures ouvertes : `<liste bloquante ou aucune>`
- Consultation préalable de la CNIL requise : `<oui/non/non déterminé>`
- Motivation : `<à compléter>`
- Date de validation par le responsable de traitement : `<UTC ou non validé>`
- Référence pseudonymisée du responsable : `<hash de dossier privé ou null>`
- Preuve AIPD immuable : `<URL, run ID, SHA-256, verified_at ou null>`

Si le risque résiduel demeure élevé, ou si la consultation préalable est
requise ou indéterminée, `privacy_approved` reste faux et le traitement ne
démarre pas. Le responsable de traitement valide l'AIPD et le plan d'action ;
ce modèle ne fabrique ni sa décision, ni sa signature. La CNIL doit être
consultée avant le traitement lorsque les mesures envisagées ne réduisent pas
suffisamment le risque élevé.

## 4. Registre des traitements du pilote

| Traitement | Personnes | Données minimales | Finalité | Base légale | Destinataires/sous-traitants | Transfert | Conservation/suppression | Contrôles |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Demande d'accès | `<à compléter>` | `<à compléter>` | `<à compléter>` | `<à compléter>` | `<à compléter>` | `<à compléter>` | `<à compléter>` | `<à compléter>` |
| KYC Didit | `<à compléter>` | `<à compléter>` | `<à compléter>` | `<à compléter>` | `Didit` | `<à compléter>` | `<à compléter>` | `<à compléter>` |
| Attribution/commission | `<à compléter>` | `<à compléter>` | `<à compléter>` | `<à compléter>` | `Hetzner, Cloudflare, Google, RevenueCat` | `<à compléter>` | `<à compléter>` | `<à compléter>` |
| Versement manuel | `<à compléter>` | `<à compléter>` | `<à compléter>` | `<à compléter>` | `Revolut` | `<à compléter>` | `<à compléter>` | `<à compléter>` |
| Communications/alertes | `<à compléter>` | `<à compléter>` | `<à compléter>` | `<à compléter>` | `Resend, Telegram` | `<à compléter>` | `<à compléter>` | `<à compléter>` |

## 5. Transparence et exercice des droits

- Versions et SHA-256 de Privacy, Partners Terms et disclosure : `<références>`
- Notice KYC avant redirection Didit : `<preuve>`
- Notice de confidentialité Didit : `https://didit.me/terms/verification-privacy-notice/`
- Conditions Didit de vérification : `https://didit.me/terms/identity-verification/`
- Qualification Didit : sous-traitant pour les contrôles configurés par Norva ; responsable
  indépendant pour ses finalités limitées de sécurité, prévention des abus, conformité légale,
  audit et défense de droits. Vérifier la DPA et reporter la preuve : `<référence immuable>`
- Transferts Didit : pays de traitement, décision d'adéquation, clauses contractuelles types ou
  autre mécanisme effectivement applicable : `<analyse + référence immuable>`
- Version du disclosure Norva liant ces notices : `<version + SHA-256>`
- Rétention Didit du pilote : `1 mois maximum avant toute collecte live`, complétée par la
  suppression API des sessions terminales après stockage du résultat normalisé minimal ; preuve
  de configuration live et preuve du test de suppression : `<références immuables>`
- Notice payout et qualification de la localisation réseau : `<preuve>`
- Canal d'exercice des droits : contrôle authentifié dans la page Partners pour le retrait de tout
  nouveau consentement biométrique et la contestation d'un résultat ; Support comme solution de
  repli. Preuve de test bout en bout : `<référence immuable>`
- Recours humain : file Admin sanitisée, capacité Risque, JWT AAL2 frais, confirmation typée,
  justification auditée et preuve locale hachée ; aucun document ni payload provider dans
  l'interface Norva. Preuve de test : `<référence immuable>`
- Vérification d'identité proportionnée : `<processus>`
- Délais, recherche, export, rectification, opposition et suppression : `<processus>`
- Limites légales de suppression et information de la personne : `<processus>`

## 6. Sécurité, minimisation et incidents

- Données interdites dans UI/logs/Telegram/preuves : `<contrôles>`
- RLS, capacités Admin, TOTP et AAL2 : `<preuves>`
- Chiffrement, sauvegarde, restauration et rétention : `<preuves>`
- Webhooks signés Didit/RevenueCat et protection anti-rejeu : `<preuves>`
- Procédure de qualification, confinement et notification d'incident : `<preuve>`
- Risques résiduels acceptés et actions datées : `<registre>`

## 7. Checklist autoritative

Chaque ligne doit être vraie dans
`ops/partners/approval-evidence.example.json` avant la décision :

- [ ] `gdpr_self_assessment_documented`
- [ ] `records_of_processing_documented`
- [ ] `data_inventory_and_purposes_approved`
- [ ] `lawful_bases_approved`
- [ ] `subprocessor_disclosures_approved`
- [ ] `international_transfers_approved`
- [ ] `retention_and_deletion_schedule_approved`
- [ ] `data_subject_rights_flow_approved`
- [ ] `data_minimization_and_redaction_approved`
- [ ] `kyc_and_payout_notices_approved`
- [ ] `public_privacy_notice_approved`
- [ ] `security_incident_notification_flow_approved`
- [ ] `dpo_mandatoriness_assessed`
- [ ] `dpia_processing_and_purposes_documented`
- [ ] `dpia_necessity_and_proportionality_assessed`
- [ ] `dpia_risks_to_rights_and_freedoms_assessed`
- [ ] `dpia_safeguards_and_residual_risk_assessed`
- [ ] `dpia_controller_validation_recorded`
- [ ] `dpia_prior_consultation_determined`
- [ ] `pilot_scope_and_reassessment_triggers_approved`

## 8. Visa interne et preuve immuable

Décision : `<approuvée/refusée>`

Réserves/actions ouvertes : `<aucune ou liste bloquante>`

Date de réévaluation maximale : `<YYYY-MM-DDTHH:MM:SSZ ou null motivé>`

Après visa, exporter un artefact figé, calculer son SHA-256, le publier dans le
stockage privé immuable, retélécharger l'objet et revérifier le hash. Reporter
uniquement l'URL HTTPS sans query/fragment, le run ID opaque, le SHA-256 et
`verified_at` de l'auto-évaluation dans `decisions.privacy.evidence`, et ceux de
l'AIPD distincte dans `decisions.privacy.dpia_evidence`. La mutation
`privacy_approved=true` reste une action Risk/Admin distincte sous TOTP et JWT
AAL2 frais ; ce document ne l'exécute pas.
