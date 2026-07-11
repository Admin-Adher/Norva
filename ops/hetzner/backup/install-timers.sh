#!/usr/bin/env bash
# =============================================================================
# install-timers.sh — install/refresh the systemd units for self-host backups
#   sudo bash ops/hetzner/backup/install-timers.sh
# Idempotent: re-run after any script/unit change (git pull) to refresh.
# =============================================================================
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo."; exit 1; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

write_unit() { echo "  /etc/systemd/system/$1"; cat > "/etc/systemd/system/$1"; }

echo ">> writing units"
write_unit norva-backup-nightly.service <<EOF
[Unit]
Description=Norva nightly logical DB backup to R2
After=docker.service network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/bin/bash $HERE/backup-nightly.sh
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
EOF

write_unit norva-backup-nightly.timer <<'EOF'
[Unit]
Description=Nightly Norva DB backup (03:40 UTC)
[Timer]
OnCalendar=*-*-* 03:40:00 UTC
RandomizedDelaySec=300
Persistent=true
[Install]
WantedBy=timers.target
EOF

write_unit norva-wal-sync.service <<EOF
[Unit]
Description=Norva WAL archive sync to R2
After=docker.service network-online.target
[Service]
Type=oneshot
ExecStart=/usr/bin/bash $HERE/wal-sync.sh
EOF

write_unit norva-wal-sync.timer <<'EOF'
[Unit]
Description=Norva WAL sync every 5 minutes
[Timer]
OnCalendar=*:0/5
RandomizedDelaySec=20
Persistent=true
[Install]
WantedBy=timers.target
EOF

write_unit norva-basebackup.service <<EOF
[Unit]
Description=Norva weekly physical base backup to R2
After=docker.service network-online.target
[Service]
Type=oneshot
ExecStart=/usr/bin/bash $HERE/basebackup-weekly.sh
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
EOF

write_unit norva-basebackup.timer <<'EOF'
[Unit]
Description=Weekly Norva base backup (Sunday 04:10 UTC)
[Timer]
OnCalendar=Sun *-*-* 04:10:00 UTC
RandomizedDelaySec=600
Persistent=true
[Install]
WantedBy=timers.target
EOF

echo ">> enabling timers"
systemctl daemon-reload
systemctl enable --now norva-backup-nightly.timer norva-wal-sync.timer norva-basebackup.timer
systemctl list-timers 'norva-*' --no-pager
echo ">> done. Manual runs: systemctl start norva-backup-nightly.service (etc.)"
