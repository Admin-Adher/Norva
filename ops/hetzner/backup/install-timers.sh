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
TimeoutStartSec=30min
MemoryMax=1G
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
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
Description=Norva daily physical base backup to R2
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
Description=Daily Norva base backup (04:10 UTC)
[Timer]
OnCalendar=*-*-* 04:10:00 UTC
RandomizedDelaySec=600
Persistent=true
[Install]
WantedBy=timers.target
EOF

write_unit norva-wal-prune-r2.service <<EOF
[Unit]
Description=Norva prune old WAL segments from R2
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/bin/bash $HERE/wal-prune-r2.sh
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
EOF

write_unit norva-wal-prune-r2.timer <<'EOF'
[Unit]
Description=Daily Norva R2 WAL retention prune
[Timer]
OnCalendar=*-*-* 02:20:00 UTC
RandomizedDelaySec=600
Persistent=true
[Install]
WantedBy=timers.target
EOF

write_unit norva-capacity-check.service <<EOF
[Unit]
Description=Norva capacity + WAL rate watchdog
After=docker.service network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/bin/bash $HERE/capacity-check.sh
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
EOF

write_unit norva-capacity-check.timer <<'EOF'
[Unit]
Description=Daily Norva capacity + WAL rate check (06:40 UTC)
[Timer]
OnCalendar=*-*-* 06:40:00 UTC
RandomizedDelaySec=300
Persistent=true
[Install]
WantedBy=timers.target
EOF

write_unit norva-reindex.service <<EOF
[Unit]
Description=Norva monthly index bloat reclaim
After=docker.service
[Service]
Type=oneshot
ExecStart=/usr/bin/bash $HERE/reindex-monthly.sh
Nice=15
IOSchedulingClass=idle
EOF

write_unit norva-reindex.timer <<'EOF'
[Unit]
Description=Monthly Norva REINDEX (1st, 01:00 UTC)
[Timer]
OnCalendar=*-*-01 01:00:00 UTC
RandomizedDelaySec=900
Persistent=true
[Install]
WantedBy=timers.target
EOF

echo ">> enabling timers"
systemctl daemon-reload
systemctl enable --now norva-backup-nightly.timer norva-wal-sync.timer norva-basebackup.timer norva-wal-prune-r2.timer norva-capacity-check.timer norva-reindex.timer
systemctl list-timers 'norva-*' --no-pager
echo ">> done. Manual runs: systemctl start norva-backup-nightly.service (etc.)"
