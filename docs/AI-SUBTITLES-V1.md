# « Générer des sous-titres IA » — refonte V1+V2 (2026-07-02)

Suite de l'audit adversarial (45 agents) du bouton : le calcul n'était pas le problème (~11-20 min
propres), le produit **mentait** (compte à rebours inventé, faux « failed » à 60 min, tooltip
anti-conseil, erreurs cachées) et quatre timers désalignés fauchaient/dupliquaient des jobs
vivants. Livré en 5 commits (PR #67), migration `20260702180000`, gateway v61.

## V1.1 — Quick wins UX (WatchPage + edge)

- **Sélecteur de langue au clic** : la ligne idle devient « ✨ Générer → 🎙 Original + 🌐 chaque
  cible Argos installée » (cibles fetchées à l'ouverture du menu). Le choix part en `targetLang`
  + `chain:true` au POST et est mémorisé en pending local (posé APRÈS le reset de changement de
  titre — piège vérifié).
- **Fast path** : une traduction déjà en cache dans la langue choisie s'attache directement.
- **États honnêtes** : `⏳ En file (position N)` (la position du 202 était jetée en console.log) →
  `⏸ Démarrera à l'arrêt de votre lecture (1 connexion fournisseur)` → `🎙 Extraction…` →
  `✍️ Transcription… ~N min` — pilotés par `stage`/`deferredByYou` du GET.
- **Cap de poll 60 min → 2 h** (aligné reaper) ; à expiration : « toujours en file — activez
  l'email » au lieu du faux « échec » (garanti pour tout visionnage > 1 h avant).
- **ETA recalibrée** : 0,4×durée [8-60 min] → 0,2× [4-45 min], armée UNE fois à l'entrée en
  transcription (l'ancienne garde ré-armait un compteur zombie à chaque expiration), texte stable
  « plus long que prévu » ensuite.
- **Erreurs visibles** : le GET expose `error` ; la ligne failed affiche une raison courte
  (timeout / refus fournisseur / extraction) + détail complet en tooltip.
- **Garde anti double-clic** synchrone (un check d'état ne suffit pas : l'état est encore `idle`
  pendant le premier await).

## V1.2 — Heartbeats de déferral (correctness)

`postJobHeartbeat(job, stage)` (gateway, fire-and-forget) stampe `stage`
(queued/deferred/extracting/transcribing) et **bump `updated_at`** via une branche NON-terminale
du transcribe-callback (`WHERE status='processing'` — ne ressuscite jamais une ligne terminale).
Conséquences : un job légitimement déféré des heures n'est plus fauché par le reaper 2 h ni volé
par le claim TTL 90 min en plein vol (fin des callbacks orphelins/doubles jobs). La rotation de
déferral collecte les jobs dans une liste latérale pendant le scan et les ré-insère par classe
APRÈS (le re-push inline re-visitait le job dans la même passe → budget de déferral brûlé n×).

## V1.3 — Chaînage traduction server-side

Le choix de langue survit à la fermeture d'onglet : POST `{targetLang, chain:true}` sans
transcript → ligne `kind='translation', status='pending-transcript'` (insert-if-absent, une
failed est re-flippée pending) + enqueue du transcript dans le même appel. Au callback du
transcript, `resolvePendingTranslations` : même langue → la ligne passe ready avec le transcript
(coût zéro, notification) ; traduisible → claim gardé par status (pas de double-enqueue face à un
clic concurrent) + POST direct `/translate-async` (pur CPU, ~20-45 s) ; source failed/muette ou
paire Argos non couverte → failed avec raison claire. Le reaper backstoppe les pendings orphelins
à 24 h. L'opt-in email vise la ligne TRADUCTION quand une langue a été choisie.

## V1.4 — Priorité viewer > service > pregen

`origin` tag sur l'URL d'enqueue → classes (0/1/2), insertion stable par classe dans les queues
transcribe/OCR, position du 202 = position réelle post-insertion. Aurait économisé ~20 min sur le
clic réel du 02/07 (coincé derrière un retry pregen condamné).

## V2 — Pipeline chunké + livraison progressive (gateway v61)

`runChunkedTranscription` : extraction segmentée en WAV de 300 s (`-f segment`, sample-accurate)
sous le verrou compte (connexion provider), whisper consomme les chunks EN PARALLÈLE hors verrou
(pur CPU). Chunk 0 détecte la langue, les suivants la forcent. Timestamps décalés par offset de
chunk (`shiftVttBlocks`, rollover d'heure géré, texte de cue intouché), stitch + `cleanVtt`
cross-chunk. Chaque chunk fini POSTe un callback **partial** → la ligne `processing` porte le VTT
grandissant, le GET le sert, le player l'attache : **premiers sous-titres à l'écran en ~1-3 min**
après le démarrage réel. Un hang whisper coûte UN chunk (budget 5 min/chunk, > moitié des chunks
en échec = job failed) au lieu des 43 min brûlées observées. Retry d'extraction seulement à
zéro chunk produit ; coupure mi-film = échec honnête sans re-téléchargement. Les clips de test
(dur>0) gardent le chemin mono-fichier.

## Timers, après

poll client 2 h ≤ reaper 2 h (heartbeats le neutralisent pour les jobs vivants) < defer cap 4 h ;
claim 90 min neutralisé par les heartbeats ; pendings traduction backstoppés 24 h.

## Reste connu (non traité ici)

- Trou du gate « spectateur passif » : la session VOD expire ~15 min sans interaction → un job
  peut démarrer en pleine lecture passive (collision mono-connexion possible). Fix candidat :
  renouvellement de session côté player ou heartbeat de lecture.
- Séries toujours exclues du bouton (`type !== 'movie'`) ; ligne IA cachée dès qu'une piste texte
  existe (même mauvaise).
- Benchmark `-bs 1` (greedy) avant tout investissement faster-whisper (~1,2-1,5× max en séquentiel).
