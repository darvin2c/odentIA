#!/usr/bin/env bash
# Backup diario de PostgreSQL a un bucket S3-compatible (R2) con retención.
set -euo pipefail

if [ -z "${BACKUP_BUCKET:-}" ]; then
  echo "[backup] BACKUP_BUCKET vacío: backups desactivados (entorno efímero)"
  sleep infinity
fi
: "${DATABASE_URL:?}"
: "${BACKUP_S3_ENDPOINT:?}"
: "${BACKUP_S3_ACCESS_KEY:?}"
: "${BACKUP_S3_SECRET_KEY:?}"
: "${BACKUP_BUCKET:?}"
RETAIN="${BACKUP_RETAIN:-14}"
INTERVAL="${BACKUP_INTERVAL:-86400}"

export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ENDPOINT="$BACKUP_S3_ENDPOINT"
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_KEY"

rclone mkdir "r2:$BACKUP_BUCKET" 2>/dev/null || true

while true; do
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  echo "[backup] $ts: iniciando volcado"
  if pg_dump --format=custom --no-owner "$DATABASE_URL" | rclone rcat "r2:$BACKUP_BUCKET/pg-$ts.dump"; then
    echo "[backup] $ts: volcado subido"
    # Retención: borra los dumps que superen los últimos RETAIN.
    rclone lsf "r2:$BACKUP_BUCKET" --files-only 2>/dev/null | grep -E '^pg-.*\.dump$' | sort -r \
      | tail -n "+$((RETAIN + 1))" \
      | while read -r f; do
          echo "[backup] purgando $f"
          rclone deletefile "r2:$BACKUP_BUCKET/$f" >/dev/null
        done
  else
    echo "[backup] $ts: FALLO el volcado" >&2
  fi
  sleep "$INTERVAL"
done
