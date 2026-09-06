#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$EUID" == 0 && "$(hostname)" == norva-postal-offline && "$(systemd-detect-virt)" == kvm && "$#" == 1 && "$1" == --offline-proof ]] || exit 77
[[ "$(pwd -P)" == /home/postaladmin/norva-postal-full-service-proof-20260906 && -z "${DOCKER_HOST:-}${DOCKER_CONTEXT:-}" ]] || exit 78
image=sha256:fe0737ba566a2c5b2a28f34433c0a423261900ec17b9bf7ad115e1aae7e57f1b
[[ "$(docker image inspect --format '{{.Id}}' norva-postal-offline/postgres:proof)" == "$image" ]] || exit 79
proof="$(mktemp -d /var/lib/norva-postal-full-service-proof.XXXXXXXX)"
container="norva-postal-full-service-proof-${proof##*.}"
docker ps --format '{{.Names}} {{.ID}}' | sort > "$proof/baseline.txt"
mkdir "$proof/data"
chown 70:70 "$proof/data"
chmod 700 "$proof/data"
cleanup() {
  result=$?; trap - EXIT
  if docker inspect "$container" >/dev/null 2>&1; then
    [[ "$(docker inspect --format '{{index .Config.Labels "norva.proof"}}' "$container")" == "$proof" ]] || exit 89
    docker stop --time 10 "$container" > "$proof/stop.log" 2>&1 || result=1
  fi
  docker ps --format '{{.Names}} {{.ID}}' | sort > "$proof/after.txt"
  cmp "$proof/baseline.txt" "$proof/after.txt" || result=1
  printf 'FULL_PROOF_FINISHED status=%s proof=%s customerEmails=0 existingContainersPreserved=true\n' "$result" "$proof"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker run --detach --name "$container" --label "norva.proof=$proof" --user 70:70 \
  --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --memory 384m --cpus .5 --pids-limit 96 --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --mount "type=bind,src=$proof/data,dst=/var/lib/postgresql/data" \
  --mount "type=bind,src=$PWD,dst=/proof,readonly" \
  --entrypoint sh "$image" -c '
    if [ ! -f /var/lib/postgresql/data/PG_VERSION ]; then
      initdb -D /var/lib/postgresql/data --auth-local=trust --auth-host=reject --no-locale >/tmp/init.log || exit 1
    fi
    exec postgres -D /var/lib/postgresql/data -c listen_addresses= -c unix_socket_directories=/tmp' > "$proof/container.txt"
ready() {
  for i in $(seq 1 40); do
    if docker exec "$container" pg_isready -h /tmp -U postgres >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}
ready
psql=(docker exec "$container" psql -X -h /tmp -U postgres -v ON_ERROR_STOP=1)
"${psql[@]}" -f /proof/proof.sql > "$proof/sql.log" 2>&1 || { tail -n 24 "$proof/sql.log"; exit 1; }
grep 'PASS:' "$proof/sql.log"
docker exec "$container" pg_dump -h /tmp -U postgres --no-owner postgres > "$proof/backup.sql"
docker restart --time 10 "$container" > "$proof/restart.log"
ready
"${psql[@]}" -f /proof/restart-check.sql > "$proof/restart-check.log" 2>&1
"${psql[@]}" -c 'create database restore_proof' > "$proof/create-restore.log"
docker exec -i "$container" psql -X -h /tmp -U postgres -v ON_ERROR_STOP=1 -d restore_proof < "$proof/backup.sql" > "$proof/restore.log" 2>&1
"${psql[@]}" -d restore_proof -f /proof/restart-check.sql > "$proof/restore-check.log" 2>&1
printf 'FULL_SQL_CHECKS=%s RESTART=pass RESTORE=pass network=none smtp=absent\n' "$(grep -c 'PASS:' "$proof/sql.log")"
