# 2026-07-13 — Audits & correctifs navigation D-pad Android TV (menu + accueil)

Deux audits multi-agents (8 chercheurs → 3 vérificateurs adverses/trouvaille → synthèse)
de la navigation télécommande de l'app Android TV WebView, chacun suivi d'une correction
intégrale **prouvée en runtime** (vrai Chromium pilotant le vrai `tvNavigation.js` via le
protocole DevTools, pas de test théorique).

Cœur de nav : `public/js/utils/tvNavigation.js` (moteur spatial D-pad ; `tv-mode` activé
quand l'UA contient `NorvaTV-AndroidTV` ou `?tv=1`).

---

## 1. Menu (rail gauche `.navbar`) — 7 défauts corrigés · commit `19d8dfe`

Preuve runtime : **9/9** (`scratchpad/tvnav-cdp-proof.mjs`).

| Sévérité | Défaut | Correctif |
|---|---|---|
| 🔴 Critique | Back matériel/flèches ignoraient les dialogues **NorvaModal** (`.norva-modal-overlay` inconnu de `openModal()`) → Back navigue/quitte, flèches s'échappent derrière le voile | `openModal()` reconnaît `.norva-modal-overlay` ; `closeTopModal()` clique `.norva-modal-cancel`/`-confirm` (câblés en addEventListener, fermeture par suppression du nœud). `modalObserver` laisse NorvaModal gérer son focus. |
| 🟠 Élevé | **Recherche/cloche injoignables** : Bas depuis le dernier nav-link plongeait dans le contenu (score latéral) | `navbarCandidateBelow()` marche le rail par géométrie verticale |
| 🟠 Élevé | ArrowGauche **s'échappait d'un modal** ouvert vers le rail | garde `!openModal()` sur l'ouverture-menu |
| 🟡 Moyen | nav-link `.active` **masqué** empoisonnait le fallback visible | choix de l'actif conditionné à `isVisible()` |
| 🟡 Moyen | ArrowDroite **en impasse** sur page vide/chargement | garde ArrowDroite-depuis-rail symétrique au dive Bas |
| 🟡 Moyen | Dive vers Live en chargement piégeait sur `#channel-search` | `pageDefaultTarget()` → contrôle non-texte (`#source-select`) ; fallbacks d'entrée préfèrent un candidat non-texte |
| 🔵 Faible | tv-mode étroit (≤640 px) masquait le rail au profit de la bottom-nav | `.tv-mode` force le rail vertical + masque `.bottom-nav` |

## 2. Page d'accueil (hero + rails + cartes) — 5 défauts corrigés

Preuve runtime : **7/7** (`scratchpad/tvnav-home-proof.mjs`). 16 trouvailles confirmées
dédoublonnées en 5 (1 réfutée par les vérificateurs).

| Sévérité | Défaut | Correctif |
|---|---|---|
| 🔴 Critique/High | **Re-render `innerHTML` en arrière-plan** (`loadDashboardData` → `renderHero`/`renderCloudRails`/…) détruit la carte focalisée : l'anneau disparaît, Enter no-op, place perdue (rail revenu à `scrollLeft:0`). Aucun ré-ancrage `childList`. | `tvNavigation` : `MutationObserver childList` sur `.main-content` → si le focus tombe sur `<body>` sur la page qui le possédait, `ensurePageFocus()`. `relocateLastCard()` re-cible la **même** carte par `cardKey` (identité `data-*`/id, scan DOM brut → retrouve une carte hors-écran, `scrollIntoView` restaure la place). |
| 🔴 Critique/High | **✕ « Retirer » Continue Watching** : `@media(hover:none){opacity:1}` le rend candidat sur TV → Haut atterrit dessus, **Enter supprime le titre** ; sur `hover:hover` inatteignable | `.tv-mode .ch-remove{display:none}` — Haut depuis une carte CW rejoint toujours le hero (suppression à ré-exposer plus tard via une affordance télécommande dédiée) |
| 🟡 Moyen | **Puces billboard** (`.home-hero-dot`, 9 px) = arrêts parasites hero↔rail ; Enter fait tourner le carrousel | `.tv-mode .home-hero-dots{display:none}` (rotation auto conservée) |
| 🟡 Moyen | Bouton **« See all »** d'en-tête intercepte le trajet vertical des cartes | `.tv-mode .home-rail-seeall{display:none}` (catégories atteintes via le menu) |
| 🟡 Moyen | Right/Left **en vraie fin de rail** saute en diagonale dans un autre rail + recentre la page | confinement : un press horizontal dont la cible sort du `.horizontal-scroll` courant devient no-op |

**Solide (non régressé) :** rotation auto du hero sûre en focus (`showHeroSlide` ne touche que
`textContent`), focus initial déterministe (`ensurePageFocus → #home-hero-play`), filtrage des
candidats correct en nominal, Undo 5 s sur la suppression CW.

---

## Méthode de preuve runtime (réutilisable)

Le proxy sortant bloquant `npm install playwright`, les harnais pilotent le Chromium
pré-installé (`/opt/pw-browsers/chromium-1194`) **directement en CDP** via le `WebSocket`/`fetch`
natifs de Node 22 : lancement `--headless=new --user-agent=…NorvaTV-AndroidTV…`, injection du
vrai `tvNavigation.js`/`NorvaModal.js`, `Input.dispatchKeyEvent` pour de vraies touches D-pad,
assertions sur `document.activeElement`. DOM synthétique fidèle + règles CSS `tv-mode` miroir de
`main.css`. Fichiers : `scratchpad/tvnav-cdp-proof.mjs` (menu), `scratchpad/tvnav-home-proof.mjs`
(accueil). Aucune régression croisée (menu 9/9 après les correctifs accueil).

## Déploiement
Tout est **front** → auto-déployé par Cloudflare Pages (**hard-refresh** pour tester à la
télécommande). Aucun impact edge. `git pull` sur la box garde le repo en phase.
