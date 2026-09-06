# Norva Selection : provenance des langues audio

Les badges et les filtres montrent uniquement le nom de la langue. La provenance
est conservee dans les donnees internes, sans texte technique dans le parcours.

## Sources de l'information

- Les observations du fichier et les validations audio restent prioritaires.
- En leur absence, les categories explicites de Babuperumana peuvent fournir
  une indication provisoire : Telugu, Tamil, Malayalam, Hindi, Kannada, English.
- `providerAudioLanguages` et `providerAudioLanguageStatus: provider_declared`
  transportent cette declaration separement des langues et pistes observees.
- Une declaration ne cree aucun index de piste, aucune verification audio et
  aucune langue de sous-titres. Elle ne pilote pas le choix d'une piste du lecteur.

## Filtrage

Les choix `catalog-<langue>` unissent les titres possedant une observation audio
correspondante et les fichiers Selection ayant uniquement une declaration.
Les observations connues supplantent la declaration du meme fichier. Les titres
sont comptes une seule fois, meme avec plusieurs versions ou fournisseurs.
Les anciens choix ISO conservent leur semantique d'observation exacte ; les anciens
choix `provider-<langue>` restent compatibles. La vue de visibilite, l'utilisateur
et la source selectionnee bornent toutes les recherches.

Au controle du 6 septembre 2026, 5 644 des 5 651 entrees VOD Selection disposent
de categories de langue : te 2 750, ta 1 294, ml 654, hi 552, kn 286, en 108.
Ces nombres decrivent le catalogue controle, pas une garantie de langue par film.
