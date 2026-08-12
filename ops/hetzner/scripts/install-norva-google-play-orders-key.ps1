[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$CredentialPath,
  [string]$SshTarget = 'adrien@157.180.96.159'
)

$ErrorActionPreference = 'Stop'

$partnersResolvedPath = [IO.Path]::GetFullPath($CredentialPath)
if (-not (Test-Path -LiteralPath $partnersResolvedPath -PathType Leaf)) {
  throw 'Le fichier JSON du compte de service Google Play est introuvable.'
}
$partnersRepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$partnersRepositoryPrefix = $partnersRepositoryRoot.TrimEnd(
  [IO.Path]::DirectorySeparatorChar,
  [IO.Path]::AltDirectorySeparatorChar
) + [IO.Path]::DirectorySeparatorChar
if ($partnersResolvedPath.StartsWith(
    $partnersRepositoryPrefix,
    [StringComparison]::OrdinalIgnoreCase
  )) {
  throw 'La clé Google Play doit rester hors du dépôt Git.'
}
$partnersFile = Get-Item -LiteralPath $partnersResolvedPath
if ($partnersFile.Length -lt 512 -or $partnersFile.Length -gt 65536) {
  throw 'Le fichier du compte de service a une taille inattendue.'
}

$partnersRawJson = [IO.File]::ReadAllText($partnersResolvedPath, [Text.Encoding]::UTF8)
try {
  $partnersCredential = $partnersRawJson | ConvertFrom-Json
}
catch {
  throw 'Le fichier fourni n’est pas un JSON Google valide.'
}

if ($partnersCredential.type -ne 'service_account' `
    -or [string]::IsNullOrWhiteSpace([string]$partnersCredential.project_id) `
    -or [string]::IsNullOrWhiteSpace([string]$partnersCredential.client_email) `
    -or ([string]$partnersCredential.client_email) -notmatch '@.+\.iam\.gserviceaccount\.com$' `
    -or ([string]$partnersCredential.private_key) -notmatch '^-----BEGIN PRIVATE KEY-----' `
    -or $partnersCredential.token_uri -ne 'https://oauth2.googleapis.com/token') {
  throw 'Le JSON n’est pas une clé de compte de service Google compatible.'
}

$partnersCompactJson = $partnersCredential | ConvertTo-Json -Compress -Depth 20
$partnersCredentialBytes = [Text.Encoding]::UTF8.GetBytes($partnersCompactJson)
$partnersCredentialB64 = [Convert]::ToBase64String($partnersCredentialBytes)

try {
  $partnersRemoteScript = @'
#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

env_file=/home/adrien/norva/ops/hetzner/.env
compose_file=/home/adrien/norva/ops/hetzner/docker-compose.supabase.yml
compose_dir=/home/adrien/norva/ops/hetzner
backup_dir=/home/adrien/norva-deploy-backups/env-snapshots
credential_b64='__NORVA_GOOGLE_PLAY_CREDENTIAL_B64__'

test "$(readlink -f "$env_file")" = /home/adrien/norva/ops/hetzner/.env
test -f "$env_file"
test "$(stat -c %U:%G:%a "$env_file")" = adrien:adrien:600
test -f "$compose_file"
command -v python3 >/dev/null 2>&1 || {
  printf 'python3 is required for Google Play credential validation.\n' >&2
  exit 1
}
if ! python3 -c 'from cryptography.hazmat.primitives import hashes, serialization; from cryptography.hazmat.primitives.asymmetric import padding' >/dev/null 2>&1; then
  printf 'Python package "cryptography" is required for the Google Play Orders permission smoke. Install it before retrying; the Edge environment was not changed.\n' >&2
  exit 1
fi
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"

backup="$backup_dir/hetzner.env.pre-google-play-$(date -u +%Y%m%dT%H%M%SZ)"
work="$(mktemp -d /home/adrien/norva-deploy-backups/google-play-key.XXXXXX)"
chmod 700 "$work"
env_changed=false

wait_healthy() {
  local container="$1" attempt health
  for attempt in $(seq 1 60); do
    health="$(docker inspect "$container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || true)"
    if [[ "$health" == healthy || "$health" == running ]]; then
      return 0
    fi
    sleep 1
  done
  printf '%s did not become healthy.\n' "$container" >&2
  return 1
}

recreate_edge() {
  local service="$1" container="$2"
  docker compose --env-file "$env_file" -f "$compose_file" \
    up -d --no-deps --force-recreate "$service" >/dev/null
  wait_healthy "$container"
}

verify_google_play_orders_permission() {
  python3 - "$work/service-account.json" <<'PY'
import base64
import json
import time
import urllib.error
import urllib.parse
import urllib.request

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding


def base64url(value):
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


credential = json.loads(open(__import__("sys").argv[1], encoding="utf-8").read())
now = int(time.time())
header = base64url(json.dumps(
    {"alg": "RS256", "typ": "JWT"}, separators=(",", ":")
).encode("utf-8"))
claims = base64url(json.dumps({
    "iss": credential["client_email"],
    "scope": "https://www.googleapis.com/auth/androidpublisher",
    "aud": "https://oauth2.googleapis.com/token",
    "iat": now,
    "exp": now + 600,
}, separators=(",", ":")).encode("utf-8"))
signing_input = f"{header}.{claims}".encode("ascii")
private_key = serialization.load_pem_private_key(
    credential["private_key"].encode("utf-8"), password=None
)
signature = private_key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
assertion = f"{signing_input.decode('ascii')}.{base64url(signature)}"
token_body = urllib.parse.urlencode({
    "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
    "assertion": assertion,
}).encode("ascii")
token_request = urllib.request.Request(
    "https://oauth2.googleapis.com/token",
    data=token_body,
    headers={"content-type": "application/x-www-form-urlencoded"},
    method="POST",
)
try:
    with urllib.request.urlopen(token_request, timeout=15) as response:
        token_status = response.status
        token_text = response.read(65537)
except urllib.error.HTTPError as error:
    token_status = error.code
    token_text = error.read(65537)
except (urllib.error.URLError, TimeoutError):
    raise SystemExit(
        "Google OAuth smoke was inconclusive (network or provider error); "
        "the Edge environment was not changed"
    )
if len(token_text) > 65536:
    raise SystemExit("oversized Google OAuth response")
try:
    token = json.loads(token_text)
except Exception:
    token = None
access_token = token.get("access_token") if isinstance(token, dict) else None
if token_status != 200 or not isinstance(access_token, str) or len(access_token) < 32:
    raise SystemExit(f"Google OAuth smoke failed (HTTP {token_status}); the Edge environment was not changed")
print("GOOGLE_PLAY_OAUTH_OK")

order_id = urllib.parse.quote("GPA.0000-0000-0000-00000", safe="")
order_request = urllib.request.Request(
    "https://androidpublisher.googleapis.com/androidpublisher/v3/"
    f"applications/tv.norva.phone/orders/{order_id}",
    headers={"authorization": f"Bearer {access_token}"},
)
try:
    with urllib.request.urlopen(order_request, timeout=15) as response:
        order_status = response.status
        response.read(1)
except urllib.error.HTTPError as error:
    order_status = error.code
    error.read(1)
except (urllib.error.URLError, TimeoutError):
    raise SystemExit(
        "Google Play Orders permission smoke was inconclusive "
        "(network or provider error); the Edge environment was not changed"
    )
if order_status in (401, 403):
    raise SystemExit(
        f"Google Play Orders permission denied (HTTP {order_status}); "
        "the Edge environment was not changed"
    )
if order_status != 404:
    raise SystemExit(
        f"Google Play Orders permission smoke was inconclusive (HTTP {order_status}); "
        "the Edge environment was not changed"
    )
print("GOOGLE_PLAY_ORDERS_PERMISSION_OK")
PY
}

cleanup_and_rollback() {
  local rc=$? rollback_ok=true
  unset credential_b64
  rm -rf -- "$work"
  if [[ $rc -ne 0 ]]; then
    if [[ "$env_changed" == true && -f "$backup" ]]; then
      if ! cp -p -- "$backup" "$env_file"; then
        rollback_ok=false
      else
        if ! recreate_edge functions norva-edge-functions >/dev/null 2>&1; then
          rollback_ok=false
        fi
        if ! recreate_edge functions2 norva-edge-functions-2 >/dev/null 2>&1; then
          rollback_ok=false
        fi
        if ! python3 - "$backup" <<'PY'
import json
import subprocess
import sys

keys = (
    "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON",
    "GOOGLE_PLAY_PACKAGE_NAME",
)
expected = {}
for line in open(sys.argv[1], encoding="utf-8"):
    if "=" not in line or line.lstrip().startswith("#"):
        continue
    key, value = line.rstrip("\n").split("=", 1)
    if key in keys:
        expected[key] = value
for name in ("norva-edge-functions", "norva-edge-functions-2"):
    inspected = json.loads(subprocess.check_output(
        ["docker", "inspect", name], text=True
    ))[0]
    runtime = dict(
        item.split("=", 1)
        for item in inspected["Config"]["Env"]
        if "=" in item
    )
    for key in keys:
        if runtime.get(key, "") != expected.get(key, ""):
            raise SystemExit("Google Play rollback parity failed")
PY
        then
          rollback_ok=false
        fi
      fi
      if [[ "$rollback_ok" == true ]]; then
        printf 'Google Play installation failed; the previous Edge environment was restored and verified.\n' >&2
      else
        printf 'Google Play installation failed; rollback is incomplete. Keep the protected snapshot and repair both Edge replicas before retrying.\n' >&2
      fi
    else
      printf 'Google Play installation failed before the Edge environment changed.\n' >&2
    fi
  else
    rm -f -- "$backup"
  fi
  exit "$rc"
}
trap cleanup_and_rollback EXIT

printf '%s' "$credential_b64" | base64 -d > "$work/service-account.json"
unset credential_b64
chmod 600 "$work/service-account.json"

python3 - "$work/service-account.json" "$env_file" "$work/env" <<'PY'
import json
import os
import pathlib
import re
import sys

credential_path = pathlib.Path(sys.argv[1])
env_path = pathlib.Path(sys.argv[2])
output_path = pathlib.Path(sys.argv[3])
credential = json.loads(credential_path.read_text(encoding="utf-8"))
if credential.get("type") != "service_account":
    raise SystemExit("invalid Google service-account type")
if not re.fullmatch(r"[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com", str(credential.get("client_email", ""))):
    raise SystemExit("invalid Google service-account email")
if not str(credential.get("private_key", "")).startswith("-----BEGIN PRIVATE KEY-----"):
    raise SystemExit("invalid Google service-account private key")
if credential.get("token_uri") != "https://oauth2.googleapis.com/token":
    raise SystemExit("unexpected Google OAuth token endpoint")

compact = json.dumps(credential, ensure_ascii=False, separators=(",", ":"))
lines = env_path.read_text(encoding="utf-8").splitlines()
replacements = {
    "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON": compact,
    "GOOGLE_PLAY_PACKAGE_NAME": "tv.norva.phone",
}
seen = set()
result = []
for line in lines:
    key = line.split("=", 1)[0] if "=" in line else ""
    if key in replacements:
        if key not in seen:
            result.append(f"{key}={replacements[key]}")
            seen.add(key)
        continue
    result.append(line)
for key, value in replacements.items():
    if key not in seen:
        result.append(f"{key}={value}")
output_path.write_text("\n".join(result) + "\n", encoding="utf-8", newline="\n")
os.chmod(output_path, 0o600)
PY

verify_google_play_orders_permission

cp -p -- "$env_file" "$backup"
chmod 600 "$backup"
mv -- "$work/env" "$env_file"
env_changed=true
cd "$compose_dir"
recreate_edge functions norva-edge-functions
recreate_edge functions2 norva-edge-functions-2

python3 - "$work/service-account.json" <<'PY'
import json
import subprocess
import sys

expected = json.loads(open(sys.argv[1], encoding="utf-8").read())
for name in ("norva-edge-functions", "norva-edge-functions-2"):
    inspected = json.loads(subprocess.check_output(["docker", "inspect", name], text=True))[0]
    env = dict(item.split("=", 1) for item in inspected["Config"]["Env"] if "=" in item)
    runtime = json.loads(env.get("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON", "null"))
    if runtime != expected:
        raise SystemExit(f"Google Play credential parity failed for {name}")
    if env.get("GOOGLE_PLAY_PACKAGE_NAME") != "tv.norva.phone":
        raise SystemExit(f"Google Play package parity failed for {name}")
print("GOOGLE_PLAY_EDGE_PARITY_OK")
PY

echo 'GOOGLE_PLAY_ORDERS_CONFIGURATION_OK'
'@

  $partnersRemoteScript = $partnersRemoteScript.Replace(
    '__NORVA_GOOGLE_PLAY_CREDENTIAL_B64__',
    $partnersCredentialB64
  )
  $partnersRemoteScript | ssh -T $SshTarget 'tr -d ''\r'' | bash -s'
  if ($LASTEXITCODE -ne 0) {
    throw "La configuration distante a échoué avec le code $LASTEXITCODE."
  }
}
finally {
  $partnersRawJson = $null
  $partnersCompactJson = $null
  $partnersCredential = $null
  Remove-Variable partnersCredentialB64 -ErrorAction SilentlyContinue
  Remove-Variable partnersCredentialBytes -ErrorAction SilentlyContinue
  Remove-Variable partnersRemoteScript -ErrorAction SilentlyContinue
  Remove-Variable partnersRepositoryRoot -ErrorAction SilentlyContinue
  Remove-Variable partnersRepositoryPrefix -ErrorAction SilentlyContinue
}
