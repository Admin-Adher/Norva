# Provisionner l'AX42 pas-à-pas (Rescue System → Ubuntu 24.04 + RAID1)

> Guide débutant. Objectif : de la commande Hetzner à un **Ubuntu 24.04 fraîchement installé,
> en RAID1 sur les 2 NVMe**, prêt pour la stack (Phase 2 du `README.md`). Compte **~30-60 min**.
> À chaque étape, si un truc coince, note le message et demande.

## 0. Ce que « Rescue System » veut dire (important)

- **Rescue System** = un mini-Linux qui démarre **en RAM** (pas installé sur le disque). Il sert
  UNIQUEMENT à **installer ou réparer** l'OS. On l'utilise pour lancer l'installeur Hetzner
  (`installimage`) qui, lui, installe le vrai OS (Ubuntu) sur les disques, **avec le RAID1**.
- Alternative plus simple mais moins de contrôle : commander directement **Ubuntu 24.04 LTS**
  (Hetzner l'auto-installe avec un RAID1 par défaut). On garde **Rescue** ici pour **maîtriser le
  RAID1 + le partitionnement** — c'est la voie robuste, et je te guide.

## 1. La commande (ce que tu as à l'écran = ✅ bon)

- AX42-1 · **64 Go DDR5** · **2×512 Go NVMe** · **1 Gbit illimité** · **Helsinki (EU/RGPD)** ·
  **Primary IPv4** · OS = **Rescue System** · **€99/mo + €49 setup**. → **Commande.**
- **Conseil sécurité** : si tu as une **clé SSH**, ajoute-la à la commande / dans Robot (bien plus
  sûr qu'un mot de passe). Pas de clé ? On peut en générer une avant (dis-le-moi).

## 2. Récupérer l'accès (après livraison — quelques min à quelques heures)

⚠️ **Deux consoles Hetzner, ne pas confondre** :
- **Hetzner Robot** → **robot.hetzner.com** → gère les **serveurs DÉDIÉS** (ton AX42). **C'est ici.**
- Hetzner Cloud → console.hetzner.cloud → gère les VPS cloud (CX/CCX). **PAS pour l'AX42.**

Le serveur **n'apparaît dans Robot qu'APRÈS l'achat + le provisioning** (pas avant). Donc :
1. Tu **commandes** l'AX42 (boutique/configurateur).
2. Tu reçois un **email de provisioning** (IP + identifiants).
3. Le serveur apparaît alors dans **robot.hetzner.com** → clique dessus → onglets Overview/IPs/Rescue/Reset.
4. Note l'**IP** du serveur.

## 3. Rescue System — déjà activé si tu as commandé avec « Rescue »

**Si tu as coché « Rescue System » dans le configurateur** (ton cas) : le serveur est **livré déjà
démarré en Rescue**. L'email / Robot te donne directement l'**IP** + le **mot de passe root du
Rescue** (ou ta clé SSH). → **Va directement à l'étape 4.**

**Sinon** (ou pour RE-rentrer en Rescue plus tard) : Robot → ton serveur → onglet **Rescue** →
Linux **64 bit** → (ajoute ta clé SSH ou copie le mot de passe affiché) → **Activate rescue system**
→ onglet **Reset** → **Execute an automatic hardware reset** → attends ~2-3 min.

## 4. Se connecter au Rescue (SSH)

Depuis ton ordi (Terminal Mac/Linux, ou PowerShell/PuTTY Windows) :
```bash
ssh root@TON_IP
```
- Première fois : tape `yes` pour accepter la clé d'hôte.
- Mot de passe = celui affiché par Robot (ou ta clé SSH si tu l'as mise). Tu es maintenant **dans le
  Rescue** (prompt du style `root@rescue ~ #`).

## 5. Installer Ubuntu 24.04 avec RAID1 (`installimage`)

1. Dans le Rescue, tape :
   ```bash
   installimage
   ```
2. Un **menu bleu** s'ouvre → choisis **Ubuntu** → **Ubuntu 24.04 LTS**.
3. Un **fichier de config** s'ouvre dans un éditeur. Vérifie / règle ces lignes (l'essentiel) :
   ```
   SWRAID 1              # active le RAID logiciel
   SWRAIDLEVEL 1         # RAID1 = miroir (les 2 disques identiques)
   HOSTNAME norva-db     # le nom de la machine (au choix)

   DRIVE1 /dev/nvme0n1   # 1er NVMe  (les noms sont pré-remplis, vérifie qu'il y a bien 2 DRIVE)
   DRIVE2 /dev/nvme1n1   # 2e NVMe

   # Partitionnement : garde le défaut (une seule partition / sur le RAID) — simple et OK pour la DB.
   # Exemple si tu veux l'écrire explicitement :
   PART /     ext4   all      # tout l'espace en racine, sur le RAID1
   ```
   → Le point clé : **SWRAID 1 + SWRAIDLEVEL 1** et **2 DRIVE**. Le reste, défaut = bien.
4. **Sauver et lancer** : selon l'éditeur, **F10** puis confirme, ou **Ctrl+O** (save) puis **Ctrl+X**
   (exit). L'install démarre : ça formate le RAID1 et installe Ubuntu (~3-5 min).
5. À la fin, il affiche « installation complete ». Tape :
   ```bash
   reboot
   ```

## 6. Se reconnecter à l'Ubuntu installé

- La clé d'hôte a changé (nouvel OS) → si SSH refuse, nettoie l'ancienne :
  ```bash
  ssh-keygen -R TON_IP
  ```
- Puis :
  ```bash
  ssh root@TON_IP
  ```
- Tu es sur un **Ubuntu 24.04 tout neuf, en RAID1**. Vérifie le RAID :
  ```bash
  cat /proc/mdstat        # doit montrer md0/md1 en RAID1 (peut être en cours de "resync", c'est normal)
  lsblk                   # voit les 2 nvme + les md (RAID)
  free -h                 # ~64 Go de RAM
  ```

## 7. Ce qui vient après (Phase 1-2 du README)

Une fois sur l'Ubuntu :
1. **Durcir** : créer un user non-root, `ufw` (ouvrir 22/80/443 seulement), `fail2ban`, `apt update && apt upgrade`.
2. **Docker** + `docker compose`.
3. **Domaine + DNS + TLS** (Caddy/nginx) devant Kong.
4. **Déployer la stack** Supabase OSS (`docker-compose.supabase.yml`) + tuning **tier 64 Go**.
5. **Migrer la DB** (`scripts/01→05`).

→ Je te guide chacune de ces étapes le moment venu (elles sont dans `ops/hetzner/README.md` et
`GO-LIVE.md`). **Ne fais pas la migration DB tant que tu n'es pas prêt à basculer** — le serveur peut
rester provisionné et durci en attendant.

## Pièges fréquents (débutant)

- **« Rescue = OS installé »** : non, c'est temporaire. Sans `installimage`, rien n'est installé sur
  disque. Tu DOIS faire l'étape 5.
- **Oublier SWRAID** : sans `SWRAID 1`, tu installes sur **un seul disque** (pas de miroir → si ce
  disque meurt, tout est perdu). Vérifie bien `SWRAID 1` + `SWRAIDLEVEL 1`.
- **SSH « host key changed »** après l'install : normal (nouvel OS), fais `ssh-keygen -R TON_IP`.
- **Mot de passe root partout** : préfère une **clé SSH** dès l'étape 3, et désactive le login par
  mot de passe au durcissement.
