#!/usr/bin/env bash
set -Eeuo pipefail

# Publishes only the token-gated HLS read surface. Session creation, debug,
# health and every mutating Gateway endpoint stay private on localhost/Docker.

readonly EXPECTED_MEDIA_HOST='media.norva.tv'
readonly EXPECTED_ORIGIN_IP='157.180.96.159'
readonly GATEWAY_CONTAINER='norva-media-gateway'
readonly CADDYFILE='/etc/caddy/Caddyfile'
readonly MARKER_BEGIN='# NORVA_MEDIA_HLS_BEGIN'
readonly MARKER_END='# NORVA_MEDIA_HLS_END'

candidate=''
headers=''
backup=''
changed=0

die() {
  printf 'NORVA_MEDIA_HLS_EXPOSE_FAIL:%s\n' "$1" >&2
  exit 1
}

cleanup() {
  local rc=$?
  [[ -z "${candidate}" ]] || rm -f -- "${candidate}"
  [[ -z "${headers}" ]] || rm -f -- "${headers}"
  if (( rc != 0 && changed == 1 )) && [[ -n "${backup}" ]]; then
    echo '===NORVA_MEDIA_HLS_AUTOMATIC_ROLLBACK==='
    sudo install -o root -g root -m 0644 -- "${backup}" "${CADDYFILE}" || true
    sudo systemctl reload caddy || true
  fi
  exit "${rc}"
}
trap cleanup EXIT

command -v getent >/dev/null 2>&1 || die 'getent-missing'
command -v curl >/dev/null 2>&1 || die 'curl-missing'
command -v caddy >/dev/null 2>&1 || die 'caddy-missing'
command -v docker >/dev/null 2>&1 || die 'docker-missing'
[[ -f "${CADDYFILE}" ]] || die 'caddyfile-missing'

resolved_ips="$(getent ahostsv4 "${EXPECTED_MEDIA_HOST}" | awk '{print $1}' | sort -u)"
grep -Fxq "${EXPECTED_ORIGIN_IP}" <<<"${resolved_ips}" || {
  printf 'Observed IPv4 values for %s: %s\n' "${EXPECTED_MEDIA_HOST}" "${resolved_ips:-none}" >&2
  die 'dns-a-record-not-ready'
}

docker inspect "${GATEWAY_CONTAINER}" --format '{{.State.Status}}|{{.State.Health.Status}}|{{.RestartCount}}|{{.State.OOMKilled}}' \
  | grep -qx 'running|healthy|0|false' || die 'gateway-not-clean-healthy'

docker exec -i "${GATEWAY_CONTAINER}" node <<'NODE' || die 'gateway-health-contract'
fetch('http://127.0.0.1:8080/health')
  .then(async (response) => {
    const h = await response.json();
    const ok = response.ok && h.ok === true
      && h.version === 105
      && h.videoEncoder?.backend === 'vaapi'
      && h.videoEncoder?.ready === true
      && h.activeSessions === 0
      && h.videoEncoderCapacity?.active === 0
      && h.vodInputPump?.active === 0
      && h.rawPumpCount === 0;
    process.exit(ok ? 0 : 1);
  })
  .catch(() => process.exit(1));
NODE

sudo -v

candidate="$(mktemp)"
headers="$(mktemp)"
cp -- "${CADDYFILE}" "${candidate}"

if grep -Fqx "${MARKER_BEGIN}" "${CADDYFILE}"; then
  grep -Fqx "${MARKER_END}" "${CADDYFILE}" || die 'partial-managed-caddy-block'
  [[ "$(grep -Fc "${MARKER_BEGIN}" "${CADDYFILE}")" == '1' ]] || die 'duplicate-managed-caddy-block'
  echo 'Managed media route already present; validating it idempotently.'
else
  grep -Eq '(^|[[:space:]])media[.]norva[.]tv([[:space:]]|\{|$)' "${CADDYFILE}" \
    && die 'unmanaged-media-host-already-present'
  backup="/etc/caddy/Caddyfile.rollback-before-norva-media-$(date -u +%Y%m%dT%H%M%SZ)"
  sudo install -o root -g root -m 0644 -- "${CADDYFILE}" "${backup}"
  cat >>"${candidate}" <<'CADDY'

# NORVA_MEDIA_HLS_BEGIN
media.norva.tv {
    route {
        @playback {
            method GET HEAD OPTIONS
            path /sessions/*
        }
        reverse_proxy @playback 127.0.0.1:8081
        respond 404
    }
}
# NORVA_MEDIA_HLS_END
CADDY
  sudo caddy validate --config "${candidate}" --adapter caddyfile >/dev/null
  sudo install -o root -g root -m 0644 -- "${candidate}" "${CADDYFILE}"
  changed=1
  sudo systemctl reload caddy
fi

sudo caddy validate --config "${CADDYFILE}" --adapter caddyfile >/dev/null
systemctl is-active --quiet caddy || die 'caddy-not-active'

ready=0
for _attempt in $(seq 1 45); do
  : >"${headers}"
  status="$(curl --silent --show-error --max-time 8 \
    --dump-header "${headers}" --output /dev/null --write-out '%{http_code}' \
    --header 'Origin: https://norva.tv' \
    "https://${EXPECTED_MEDIA_HOST}/sessions/00000000-0000-4000-8000-000000000000/playlist.m3u8?token=invalid" \
    || true)"
  if [[ "${status}" == '404' ]] \
      && grep -Eqi '^access-control-allow-origin:[[:space:]]*https://norva[.]tv[[:space:]]*$' "${headers}"; then
    ready=1
    break
  fi
  sleep 2
done
(( ready == 1 )) || die 'public-tls-or-cors-not-ready'

health_status="$(curl --silent --show-error --max-time 8 --output /dev/null --write-out '%{http_code}' \
  "https://${EXPECTED_MEDIA_HOST}/health" || true)"
[[ "${health_status}" == '404' ]] || die 'public-health-route-not-denied'

post_status="$(curl --silent --show-error --max-time 8 --output /dev/null --write-out '%{http_code}' \
  --request POST --header 'Content-Type: application/json' --data '{}' \
  "https://${EXPECTED_MEDIA_HOST}/sessions" || true)"
[[ "${post_status}" == '404' ]] || die 'public-session-create-not-denied'

trap - EXIT
[[ -z "${candidate}" ]] || rm -f -- "${candidate}"
[[ -z "${headers}" ]] || rm -f -- "${headers}"

echo '===NORVA_PUBLIC_MEDIA_HLS_READY_OK==='
printf 'host=%s dns=%s tls=ok cors=https://norva.tv public_surface=GET_HEAD_OPTIONS_sessions_only gateway=private-localhost\n' \
  "${EXPECTED_MEDIA_HOST}" "${EXPECTED_ORIGIN_IP}"
if [[ -n "${backup}" ]]; then
  printf 'ROLLBACK_CADDYFILE=%s\n' "${backup}"
fi

