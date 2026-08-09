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
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"

backup="$backup_dir/hetzner.env.pre-google-play-$(date -u +%Y%m%dT%H%M%SZ)"
cp -p -- "$env_file" "$backup"
chmod 600 "$backup"
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

cleanup_and_rollback() {
  local rc=$?
  unset credential_b64
  rm -rf -- "$work"
  if [[ $rc -ne 0 ]]; then
    if [[ "$env_changed" == true && -f "$backup" ]]; then
      cp -p -- "$backup" "$env_file"
      recreate_edge functions norva-edge-functions >/dev/null 2>&1 || true
      recreate_edge functions2 norva-edge-functions-2 >/dev/null 2>&1 || true
    fi
    printf 'Google Play installation failed; the previous Edge environment was restored.\n' >&2
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

node - "$work/service-account.json" <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');

const credential = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const base64url = (value) => Buffer.from(value).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
const claims = base64url(JSON.stringify({
  iss: credential.client_email,
  scope: 'https://www.googleapis.com/auth/androidpublisher',
  aud: 'https://oauth2.googleapis.com/token',
  iat: now,
  exp: now + 600,
}));
const signingInput = `${header}.${claims}`;
const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), credential.private_key).toString('base64url');

(async () => {
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${signingInput}.${signature}`,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const tokenText = await tokenResponse.text();
  if (tokenText.length > 65536) throw new Error('oversized Google OAuth response');
  let token;
  try { token = JSON.parse(tokenText); } catch { token = null; }
  if (tokenResponse.status !== 200 || typeof token?.access_token !== 'string' || token.access_token.length < 32) {
    throw new Error(`Google OAuth smoke failed (HTTP ${tokenResponse.status})`);
  }
  console.log('GOOGLE_PLAY_OAUTH_OK');

  const orderId = encodeURIComponent('GPA.0000-0000-0000-00000');
  const orderResponse = await fetch(
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/tv.norva.phone/orders/${orderId}`,
    {
      headers: { authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(15000),
    },
  );
  await orderResponse.body?.cancel();
  if (orderResponse.status !== 404) {
    throw new Error(`Google Play Orders permission smoke failed (HTTP ${orderResponse.status})`);
  }
  console.log('GOOGLE_PLAY_ORDERS_PERMISSION_OK');
})().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Google Play smoke failed');
  process.exitCode = 1;
});
NODE

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
