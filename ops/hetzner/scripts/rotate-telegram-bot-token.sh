#!/usr/bin/env bash
# Rotate the shared Norva Telegram bot token without exposing it through argv,
# the environment, shell history, logs, Git, or the non-secret receipt.
#
# Normal rotation:
#   cd ~/norva
#   ops/hetzner/scripts/rotate-telegram-bot-token.sh
#
# If the two files were committed but SSH stopped during container recreation:
#   ops/hetzner/scripts/rotate-telegram-bot-token.sh --resume
#
# If BotFather already revoked the old token but the two files were not
# committed, reuse the already-generated token through a masked prompt:
#   ops/hetzner/scripts/rotate-telegram-bot-token.sh --recover

set -Eeuo pipefail
set +x
set +v
umask 077
ulimit -c 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
HETZNER_DIR="$REPO_ROOT/ops/hetzner"
ENV_FILE="$HETZNER_DIR/.env"
SUPABASE_COMPOSE="$HETZNER_DIR/docker-compose.supabase.yml"
MONITORING_COMPOSE="$HETZNER_DIR/docker-compose.monitoring.yml"
NETDATA_NOTIFY_FILE="/etc/norva-netdata/health_alarm_notify.conf"
RECEIPT_DIR="$HOME/.norva"
RECEIPT_FILE="$RECEIPT_DIR/telegram-token-rotation.json"
RECOVERY_FILE="$RECEIPT_DIR/telegram-token-rotation.recovery.json"
LOCK_FILE="$RECEIPT_DIR/telegram-token-rotation.lock"

MODE="rotate"
case "${1:-}" in
  "")
    [[ "$#" -eq 0 ]] || exit 2
    ;;
  --resume)
    [[ "$#" -eq 1 ]] || exit 2
    MODE="resume"
    ;;
  --recover)
    [[ "$#" -eq 1 ]] || exit 2
    MODE="recover"
    ;;
  *)
    printf 'Usage: %s [--resume|--recover]\n' "$0" >&2
    exit 2
    ;;
esac

OLD_TOKEN=""
NEW_TOKEN=""
CONFIRM_TOKEN=""
CHAT_ID=""
OLD_BOT_ID=""
EXPECTED_BOT_ID=""
EXPECTED_BOT_USERNAME=""
PROBE_STATE=""
PROBE_BOT_ID=""
PROBE_BOT_USERNAME=""
BOT_USERNAME=""
FILES_COMMITTED=0
RECOVERY_READY=0
OLD_TOKEN_REJECTED_JSON="true"
RECEIPT_TMP=""

say() {
  printf '%s\n' "$*"
}

fail() {
  printf 'ERREUR: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  local exit_code=$?
  trap - EXIT
  set +e
  OLD_TOKEN=""
  NEW_TOKEN=""
  CONFIRM_TOKEN=""
  CHAT_ID=""
  OLD_BOT_ID=""
  EXPECTED_BOT_ID=""
  EXPECTED_BOT_USERNAME=""
  PROBE_STATE=""
  PROBE_BOT_ID=""
  PROBE_BOT_USERNAME=""
  BOT_USERNAME=""
  if [[ -n "$RECEIPT_TMP" && -e "$RECEIPT_TMP" ]]; then
    rm -f -- "$RECEIPT_TMP"
  fi
  if [[ "$exit_code" -ne 0 ]]; then
    rm -f -- "$RECEIPT_FILE"
    say "Rotation interrompue. Aucun secret n'a été affiché."
    if [[ "$FILES_COMMITTED" == "1" ]]; then
      say "Le nouveau token reste dans les deux fichiers."
      say "Relance ce script avec --resume pour terminer la recréation."
    elif [[ "$RECOVERY_READY" == "1" || -f "$RECOVERY_FILE" ]]; then
      say "L'ancien token peut déjà être révoqué."
      say "Relance avec --recover et saisis le token déjà généré."
    else
      say "Aucun changement de configuration n'a été conservé."
    fi
  fi
  return "$exit_code"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 131' QUIT
trap 'exit 143' TERM

read_env_value() {
  local key="$1"
  local line value
  line="$(grep -m1 -E "^${key}=" "$ENV_FILE" || true)"
  value="${line#*=}"
  value="${value%$'\r'}"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

write_recovery_state() {
  local bot_id="$1"
  local bot_username="$2"
  printf '%s\n%s\n' "$bot_id" "$bot_username" |
    python3 -c '
import json
import os
import pathlib
import re
import stat
import sys
import tempfile

bot_id = sys.stdin.readline().strip()
bot_username = sys.stdin.readline().strip()
path = pathlib.Path(sys.argv[1])
if not re.fullmatch(r"[0-9]{5,20}", bot_id):
    raise SystemExit("invalid bot id")
if not re.fullmatch(r"[A-Za-z0-9_]{5,64}", bot_username):
    raise SystemExit("invalid bot username")
if path.exists():
    current = os.lstat(path)
    if stat.S_ISLNK(current.st_mode) or not stat.S_ISREG(current.st_mode):
        raise SystemExit("unsafe recovery file")

payload = {
    "bot_id": bot_id,
    "bot_username": bot_username,
}
descriptor, temp_path = tempfile.mkstemp(
    prefix=f".{path.name}.",
    dir=path.parent,
)
try:
    os.fchmod(descriptor, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8", closefd=True) as handle:
        json.dump(payload, handle, separators=(",", ":"))
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp_path, path)
    directory_fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
finally:
    try:
        os.close(descriptor)
    except OSError:
        pass
    try:
        os.unlink(temp_path)
    except OSError:
        pass
' "$RECOVERY_FILE"
  chmod 600 -- "$RECOVERY_FILE"
  RECOVERY_READY=1
}

load_recovery_state() {
  local recovery_output
  [[ -f "$RECOVERY_FILE" && ! -L "$RECOVERY_FILE" ]] ||
    fail "aucun état de récupération sûr n'est disponible"
  [[ "$(stat -c '%a' "$RECOVERY_FILE")" == "600" ]] ||
    fail "${RECOVERY_FILE} doit rester en mode 600"
  [[ "$(stat -c '%U:%G' "$RECOVERY_FILE")" == "$(id -un):$(id -gn)" ]] ||
    fail "${RECOVERY_FILE} n'appartient pas à l'opérateur courant"

  recovery_output="$(
    python3 -c '
import json
import pathlib
import re
import sys

payload = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
bot_id = payload.get("bot_id")
bot_username = payload.get("bot_username")
if not isinstance(bot_id, str) or not re.fullmatch(r"[0-9]{5,20}", bot_id):
    raise SystemExit("invalid bot id")
if not isinstance(bot_username, str) or not re.fullmatch(r"[A-Za-z0-9_]{5,64}", bot_username):
    raise SystemExit("invalid bot username")
print(bot_id)
print(bot_username)
' "$RECOVERY_FILE"
  )" || fail "état de récupération invalide"

  EXPECTED_BOT_ID="${recovery_output%%$'\n'*}"
  EXPECTED_BOT_USERNAME="${recovery_output#*$'\n'}"
  [[ "$EXPECTED_BOT_ID" != "$EXPECTED_BOT_USERNAME" ]] ||
    fail "état de récupération incomplet"
  RECOVERY_READY=1
  recovery_output=""
}

read_new_token_twice() {
  local prompt_label="${1:-Nouveau token Telegram}"
  IFS= read -r -s -p "${prompt_label} (saisie masquée): " NEW_TOKEN </dev/tty
  printf '\n'
  IFS= read -r -s -p "Confirme le nouveau token: " CONFIRM_TOKEN </dev/tty
  printf '\n'

  [[ "$NEW_TOKEN" == "$CONFIRM_TOKEN" ]] ||
    fail "les deux saisies ne correspondent pas"
  CONFIRM_TOKEN=""
  [[ "$NEW_TOKEN" =~ ^[0-9]{6,15}:[A-Za-z0-9_-]{30,200}$ ]] ||
    fail "format de token Telegram invalide"
}

telegram_get_me() {
  local token="$1"
  local output exit_code
  PROBE_STATE="transport_error"
  PROBE_BOT_ID=""
  PROBE_BOT_USERNAME=""

  if output="$(
    printf '%s\n' "$token" |
      python3 -c '
import http.client
import json
import re
import sys

token = sys.stdin.readline().strip()
try:
    conn = http.client.HTTPSConnection("api.telegram.org", timeout=20)
    conn.request("POST", f"/bot{token}/getMe")
    response = conn.getresponse()
    raw = response.read(65536)
    payload = json.loads(raw)
except Exception:
    print("transport_error")
    raise SystemExit(2)

if response.status == 200 and payload.get("ok") is True:
    result = payload.get("result")
    if not isinstance(result, dict) or result.get("is_bot") is not True:
        print("unexpected_response")
        raise SystemExit(2)
    bot_id = result.get("id")
    username = result.get("username", "")
    if not isinstance(bot_id, int) or not re.fullmatch(r"[A-Za-z0-9_]{5,64}", username):
        print("unexpected_response")
        raise SystemExit(2)
    print(f"valid\t{bot_id}\t{username}")
    raise SystemExit(0)

if response.status in (401, 404) and payload.get("ok") is False:
    print("rejected")
    raise SystemExit(1)

print("unexpected_response")
raise SystemExit(2)
'
  )"; then
    exit_code=0
  else
    exit_code=$?
  fi

  IFS=$'\t' read -r PROBE_STATE PROBE_BOT_ID PROBE_BOT_USERNAME <<< "$output"
  return "$exit_code"
}

telegram_get_chat() {
  local token="$1"
  local chat_id="$2"
  local output exit_code

  if output="$(
    printf '%s\n%s\n' "$token" "$chat_id" |
      python3 -c '
import http.client
import json
import sys

token = sys.stdin.readline().strip()
chat_id = sys.stdin.readline().strip()
try:
    expected_id = int(chat_id)
    body = json.dumps({"chat_id": expected_id}).encode()
    conn = http.client.HTTPSConnection("api.telegram.org", timeout=20)
    conn.request(
        "POST",
        f"/bot{token}/getChat",
        body=body,
        headers={"Content-Type": "application/json"},
    )
    response = conn.getresponse()
    raw = response.read(65536)
    payload = json.loads(raw)
except Exception:
    print("transport_error")
    raise SystemExit(2)

result = payload.get("result")
if (
    response.status == 200
    and payload.get("ok") is True
    and isinstance(result, dict)
    and result.get("id") == expected_id
):
    print("reachable")
    raise SystemExit(0)

print("unreachable")
raise SystemExit(1)
'
  )"; then
    exit_code=0
  else
    exit_code=$?
  fi

  [[ "$output" == "reachable" ]] || return "$exit_code"
  return 0
}

wait_for_service() {
  local compose_file="$1"
  local service="$2"
  local deadline=$((SECONDS + 90))
  local container_id status

  container_id="$(
    docker compose --env-file "$ENV_FILE" -f "$compose_file" ps -q "$service"
  )"
  [[ -n "$container_id" ]] || fail "conteneur introuvable pour ${service}"

  while true; do
    status="$(
      docker inspect --format \
        '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
        "$container_id"
    )"
    if [[ "$status" == "healthy" || "$status" == "running" ]]; then
      return 0
    fi
    if ((SECONDS >= deadline)); then
      fail "${service} n'est pas sain après 90 secondes (${status})"
    fi
    sleep 1
  done
}

verify_root_config_matches() {
  local expected_token="$1"
  local expected_chat_id="$2"
  printf '%s\n%s\n' "$expected_token" "$expected_chat_id" |
    sudo -n python3 -c '
import pathlib
import sys

expected_token = sys.stdin.readline().strip()
expected_chat_id = sys.stdin.readline().strip()
path = pathlib.Path(sys.argv[1])
lines = path.read_text(encoding="utf-8").splitlines()

def one(key):
    values = [line.split("=", 1)[1].strip() for line in lines if line.startswith(key + "=")]
    if len(values) != 1:
        raise SystemExit(2)
    value = values[0]
    if len(value) >= 2 and value[0] == value[-1] == "\"":
        value = value[1:-1]
    return value

if (
    one("TELEGRAM_BOT_TOKEN") != expected_token
    or one("DEFAULT_RECIPIENT_TELEGRAM") != expected_chat_id
    or one("SEND_TELEGRAM").upper() != "YES"
):
    raise SystemExit(1)
' "$NETDATA_NOTIFY_FILE"
}

commit_token_files() {
  local token="$1"
  printf '%s\n' "$token" |
    sudo -n python3 -c '
import os
import signal
import stat
import sys
import tempfile

token = sys.stdin.readline().rstrip("\n")
env_path, netdata_path = sys.argv[1:3]
paths = [env_path, netdata_path]
old = {}
metadata = {}
rendered = {}
temps = {}

for path in paths:
    current_stat = os.lstat(path)
    if stat.S_ISLNK(current_stat.st_mode) or not stat.S_ISREG(current_stat.st_mode):
        raise SystemExit(f"unsafe file type: {path}")
    with open(path, "rb") as handle:
        data = handle.read()
    text = data.decode("utf-8")
    lines = text.splitlines(keepends=True)
    matches = sum(line.startswith("TELEGRAM_BOT_TOKEN=") for line in lines)
    if matches != 1:
        raise SystemExit(f"invalid TELEGRAM_BOT_TOKEN count: {path}")
    replacement = (
        f"TELEGRAM_BOT_TOKEN={token}\n"
        if path == env_path
        else f"TELEGRAM_BOT_TOKEN=\"{token}\"\n"
    )
    new_lines = [
        replacement if line.startswith("TELEGRAM_BOT_TOKEN=") else line
        for line in lines
    ]
    old[path] = data
    metadata[path] = current_stat
    rendered[path] = "".join(new_lines).encode("utf-8")

def make_temp(path, content, current_stat):
    directory = os.path.dirname(path)
    descriptor, temp_path = tempfile.mkstemp(
        prefix=f".{os.path.basename(path)}.rotate-",
        dir=directory,
    )
    try:
        os.fchmod(descriptor, stat.S_IMODE(current_stat.st_mode))
        os.fchown(descriptor, current_stat.st_uid, current_stat.st_gid)
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        try:
            os.close(descriptor)
        except OSError:
            pass
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise
    return temp_path

blocked = {signal.SIGINT, signal.SIGQUIT, signal.SIGTERM, signal.SIGHUP}
signal.pthread_sigmask(signal.SIG_BLOCK, blocked)
replaced = []
try:
    for path in paths:
        temps[path] = make_temp(path, rendered[path], metadata[path])
    for path in paths:
        os.replace(temps[path], path)
        temps[path] = ""
        replaced.append(path)
        directory_fd = os.open(os.path.dirname(path), os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
except Exception:
    for path in reversed(replaced):
        rollback = make_temp(path, old[path], metadata[path])
        os.replace(rollback, path)
        directory_fd = os.open(os.path.dirname(path), os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    raise
finally:
    for temp_path in temps.values():
        if temp_path:
            try:
                os.unlink(temp_path)
            except OSError:
                pass
    token = ""
' "$ENV_FILE" "$NETDATA_NOTIFY_FILE"
}

commit_token_files_safely() {
  local token="$1"
  local commit_status

  # Ignore interactive termination for the millisecond-scale two-file commit.
  # The Python helper also keeps those signals blocked until process exit.
  trap '' HUP INT QUIT TERM
  if commit_token_files "$token"; then
    FILES_COMMITTED=1
    rm -f -- "$RECOVERY_FILE"
    RECOVERY_READY=0
    commit_status=0
  else
    commit_status=$?
  fi
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 131' QUIT
  trap 'exit 143' TERM
  return "$commit_status"
}

[[ -t 0 && -t 1 ]] ||
  fail "lance ce script dans un terminal interactif (ssh -t), jamais via un pipe"

for command_name in curl docker flock python3 sudo; do
  command -v "$command_name" >/dev/null 2>&1 ||
    fail "commande requise absente: ${command_name}"
done

for required_file in \
  "$ENV_FILE" \
  "$SUPABASE_COMPOSE" \
  "$MONITORING_COMPOSE" \
  "$NETDATA_NOTIFY_FILE"; do
  [[ -f "$required_file" && ! -L "$required_file" ]] ||
    fail "fichier absent, non régulier ou lien symbolique: ${required_file}"
done

[[ "$(stat -c '%a' "$ENV_FILE")" == "600" ]] ||
  fail "${ENV_FILE} doit rester en mode 600"
[[ "$(stat -c '%U:%G' "$ENV_FILE")" == "$(id -un):$(id -gn)" ]] ||
  fail "${ENV_FILE} n'appartient pas à l'opérateur courant"
[[ "$(stat -c '%a' "$NETDATA_NOTIFY_FILE")" == "600" ]] ||
  fail "${NETDATA_NOTIFY_FILE} doit rester en mode 600"
[[ "$(stat -c '%U:%G' "$NETDATA_NOTIFY_FILE")" == "root:root" ]] ||
  fail "${NETDATA_NOTIFY_FILE} doit appartenir à root:root"

mkdir -p -- "$RECEIPT_DIR"
chmod 700 -- "$RECEIPT_DIR"
rm -f -- "$RECEIPT_FILE"
exec 9>"$LOCK_FILE"
flock -n 9 || fail "une autre rotation Telegram est déjà en cours"

say "Rotation sécurisée du token Telegram Norva"
say "Le token ne sera ni affiché, ni transmis à Codex, ni placé dans argv."
say ""

# Authenticate and validate every mutable dependency before BotFather revokes
# the current credential.
say "Préflight sudo, fichiers, Compose et conteneurs…"
sudo -v
docker compose --env-file "$ENV_FILE" -f "$SUPABASE_COMPOSE" config --quiet
docker compose --env-file "$ENV_FILE" -f "$MONITORING_COMPOSE" config --quiet
wait_for_service "$SUPABASE_COMPOSE" functions
wait_for_service "$SUPABASE_COMPOSE" functions2
wait_for_service "$MONITORING_COMPOSE" netdata

env_token_lines="$(grep -c '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" || true)"
env_chat_lines="$(grep -c '^TELEGRAM_CHAT_ID=' "$ENV_FILE" || true)"
[[ "$env_token_lines" == "1" ]] ||
  fail "TELEGRAM_BOT_TOKEN doit apparaître exactement une fois dans .env"
[[ "$env_chat_lines" == "1" ]] ||
  fail "TELEGRAM_CHAT_ID doit apparaître exactement une fois dans .env"

OLD_TOKEN="$(read_env_value TELEGRAM_BOT_TOKEN)"
CHAT_ID="$(read_env_value TELEGRAM_CHAT_ID)"
[[ "$OLD_TOKEN" =~ ^[0-9]{6,15}:[A-Za-z0-9_-]{30,200}$ ]] ||
  fail "le token Edge actuel a un format invalide"
[[ "$CHAT_ID" =~ ^-?[0-9]{5,20}$ ]] || fail "le destinataire Telegram est invalide"
verify_root_config_matches "$OLD_TOKEN" "$CHAT_ID" ||
  fail "Edge et Netdata n'utilisent pas le même token/destinataire"

if [[ "$MODE" == "resume" ]]; then
  NEW_TOKEN="$OLD_TOKEN"
  OLD_TOKEN=""
  FILES_COMMITTED=1
  OLD_TOKEN_REJECTED_JSON="null"
  say "Mode reprise: validation du token déjà commité…"
  if ! telegram_get_me "$NEW_TOKEN"; then
    fail "le token commité n'est pas accepté par Telegram"
  fi
  BOT_USERNAME="$PROBE_BOT_USERNAME"
  telegram_get_chat "$NEW_TOKEN" "$CHAT_ID" ||
    fail "le bot ne peut plus atteindre le chat configuré"
elif [[ "$MODE" == "recover" ]]; then
  load_recovery_state
  say "Mode récupération: preuve que le token configuré est révoqué…"
  if telegram_get_me "$OLD_TOKEN"; then
    fail "le token configuré fonctionne encore; relance sans option avant /token, ou avec --resume si les fichiers sont déjà à jour"
  elif [[ "$PROBE_STATE" != "rejected" ]]; then
    fail "impossible de distinguer la révocation d'une panne réseau"
  fi

  say "Saisis le token déjà généré dans @BotFather."
  say "Ne le colle jamais dans Codex ou dans un message."
  read_new_token_twice "Token Telegram déjà généré"
  [[ "$NEW_TOKEN" != "$OLD_TOKEN" ]] ||
    fail "ce token est identique au token révoqué actuellement configuré"

  say "Validation du token de récupération et du même bot…"
  if ! telegram_get_me "$NEW_TOKEN"; then
    fail "Telegram refuse le token de récupération ou la vérification réseau a échoué"
  fi
  [[ "$PROBE_BOT_ID" == "$EXPECTED_BOT_ID" ]] ||
    fail "le token de récupération appartient à un autre bot"
  [[ "$PROBE_BOT_USERNAME" == "$EXPECTED_BOT_USERNAME" ]] ||
    fail "le nom du bot de récupération ne correspond plus à l'identité figée"
  BOT_USERNAME="$PROBE_BOT_USERNAME"
  telegram_get_chat "$NEW_TOKEN" "$CHAT_ID" ||
    fail "le token de récupération ne peut pas atteindre le chat configuré"

  say "Actualisation sudo juste avant le commit protégé…"
  sudo -v
  say "Commit atomique des deux fichiers protégés…"
  commit_token_files_safely "$NEW_TOKEN"
  OLD_TOKEN=""
else
  say "Validation de l'ancien bot et de son destinataire avant révocation…"
  if ! telegram_get_me "$OLD_TOKEN"; then
    if [[ "$PROBE_STATE" == "rejected" && -f "$RECOVERY_FILE" ]]; then
      RECOVERY_READY=1
      fail "le token configuré est déjà révoqué; relance avec --recover"
    fi
    fail "le token actuellement configuré n'est pas vérifiable; aucune rotation n'a commencé"
  fi
  OLD_BOT_ID="$PROBE_BOT_ID"
  telegram_get_chat "$OLD_TOKEN" "$CHAT_ID" ||
    fail "le bot actuel ne peut pas atteindre le chat configuré"
  write_recovery_state "$OLD_BOT_ID" "$PROBE_BOT_USERNAME"

  say ""
  say "Maintenant seulement, dans @BotFather:"
  say "  /token → sélectionne le bot @${PROBE_BOT_USERNAME} → copie le nouveau token."
  say "Ne colle jamais ce token dans Codex ou dans un message."
  read_new_token_twice
  [[ "$NEW_TOKEN" != "$OLD_TOKEN" ]] ||
    fail "ce token est identique au token actuellement configuré"

  say "Validation du nouveau token et du même bot…"
  if ! telegram_get_me "$NEW_TOKEN"; then
    fail "Telegram refuse le nouveau token ou la vérification réseau a échoué"
  fi
  [[ "$PROBE_BOT_ID" == "$OLD_BOT_ID" ]] ||
    fail "le nouveau token appartient à un autre bot"
  BOT_USERNAME="$PROBE_BOT_USERNAME"
  telegram_get_chat "$NEW_TOKEN" "$CHAT_ID" ||
    fail "le nouveau token ne peut pas atteindre le chat configuré"

  say "Preuve de révocation de l'ancien token…"
  if telegram_get_me "$OLD_TOKEN"; then
    fail "l'ancien token fonctionne encore; utilise /revoke dans @BotFather puis recommence"
  elif [[ "$PROBE_STATE" != "rejected" ]]; then
    fail "impossible de distinguer une révocation d'une panne réseau; aucune écriture effectuée"
  fi

  say "Actualisation sudo juste avant le commit protégé…"
  sudo -v
  say "Commit atomique des deux fichiers protégés…"
  commit_token_files_safely "$NEW_TOKEN"
  OLD_TOKEN=""
fi

say "Recréation progressive des Edge Functions…"
for service in functions functions2; do
  docker compose --env-file "$ENV_FILE" -f "$SUPABASE_COMPOSE" \
    up -d --no-deps --force-recreate "$service"
  wait_for_service "$SUPABASE_COMPOSE" "$service"
  say "  ${service}: sain"
done

say "Recréation de Netdata avec le fichier remounté…"
docker compose --env-file "$ENV_FILE" -f "$MONITORING_COMPOSE" \
  up -d --no-deps --force-recreate netdata
wait_for_service "$MONITORING_COMPOSE" netdata
say "  netdata: sain"

say "Contrôle des valeurs chargées sans les afficher…"
for service in functions functions2; do
  container_id="$(
    docker compose --env-file "$ENV_FILE" -f "$SUPABASE_COMPOSE" ps -q "$service"
  )"
  loaded_token="$(
    docker exec "$container_id" sh -c 'printf %s "$TELEGRAM_BOT_TOKEN"'
  )"
  loaded_chat_id="$(
    docker exec "$container_id" sh -c 'printf %s "$TELEGRAM_CHAT_ID"'
  )"
  [[ "$loaded_token" == "$NEW_TOKEN" ]] ||
    fail "${service} n'a pas chargé le nouveau token"
  [[ "$loaded_chat_id" == "$CHAT_ID" ]] ||
    fail "${service} n'a pas chargé le destinataire Telegram attendu"
  loaded_token=""
  loaded_chat_id=""
done

netdata_id="$(
  docker compose --env-file "$ENV_FILE" -f "$MONITORING_COMPOSE" ps -q netdata
)"
netdata_token="$(
  docker exec "$netdata_id" sh -c '
line="$(grep -m1 "^TELEGRAM_BOT_TOKEN=" /etc/netdata/health_alarm_notify.conf)"
value="${line#*=}"
value="${value#\"}"
value="${value%\"}"
printf %s "$value"
'
)"
[[ "$netdata_token" == "$NEW_TOKEN" ]] ||
  fail "Netdata n'a pas chargé le nouveau token"
netdata_token=""
netdata_chat_id="$(
  docker exec "$netdata_id" sh -c '
line="$(grep -m1 "^DEFAULT_RECIPIENT_TELEGRAM=" /etc/netdata/health_alarm_notify.conf)"
value="${line#*=}"
value="${value#\"}"
value="${value%\"}"
printf %s "$value"
'
)"
[[ "$netdata_chat_id" == "$CHAT_ID" ]] ||
  fail "Netdata n'a pas chargé le destinataire Telegram attendu"
netdata_chat_id=""
docker exec "$netdata_id" sh -c '
grep -q "^SEND_TELEGRAM=\"YES\"$" /etc/netdata/health_alarm_notify.conf
'
curl --silent --show-error --fail --max-time 10 \
  http://127.0.0.1:19999/api/v1/info >/dev/null

unauthorized_status="$(
  curl --silent --output /dev/null --write-out '%{http_code}' \
    --max-time 15 --request POST \
    --header 'Content-Type: application/json' \
    --data '{}' \
    https://api.norva.tv/functions/v1/norva-signup-notify/cron/drain
)"
[[ "$unauthorized_status" == "403" ]] ||
  fail "le garde cron du worker ne répond plus 403 sans secret"

completed_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
RECEIPT_TMP="$(mktemp "$RECEIPT_DIR/telegram-token-rotation.json.XXXXXX")"
cat > "$RECEIPT_TMP" <<EOF
{
  "completed_at": "${completed_at}",
  "bot_api_ok": true,
  "destination_reachable": true,
  "old_token_rejected": ${OLD_TOKEN_REJECTED_JSON},
  "files_committed": true,
  "edge_functions_recreated": true,
  "edge_tokens_match": true,
  "edge_destinations_match": true,
  "netdata_recreated": true,
  "netdata_token_matches": true,
  "netdata_destination_matches": true,
  "worker_unauthorized_guard": true
}
EOF
chmod 600 -- "$RECEIPT_TMP"
mv -f -- "$RECEIPT_TMP" "$RECEIPT_FILE"
RECEIPT_TMP=""

rm -f -- "$RECOVERY_FILE"
RECOVERY_READY=0
FILES_COMMITTED=0
say ""
say "Rotation terminée pour @${BOT_USERNAME}."
say "Edge Functions et Netdata utilisent le nouveau token."
if [[ "$MODE" == "rotate" ]]; then
  say "L'ancien token est explicitement rejeté par Telegram."
fi
say "Tu peux fermer ce terminal et revenir dans Codex."
