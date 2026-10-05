#!/usr/bin/env bash
# Backup diario de PostgreSQL a un bucket S3-compatible (R2) con retención.
set -euo pipefail

: "${DATABASE_URL:?}"
: "${BACKUP_S3_ENDPOINT:?}"
: "${BACKUP_S3_ACCESS_KEY:?}"
: "${BACKUP_S3_SECRET_KEY:?}"
: "${BACKUP_BUCKET:?}"
RETAIN="${BACKUP_RETAIN:-14}"
INTERVAL="${BACKUP_INTERVAL:-86400}"

mc alias set r2 "$BACKUP_S3_ENDPOINT" "$BACKUP_S3_ACCESS_KEY" "$BACKUP_S3_SECRET_KEY" >/dev/null
mc mb -p "r2/$BACKUP_BUCKET" 2>/dev/null || true

while true; do
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  echo "[backup] $ts: iniciando volcado"
  if pg_dump --format=custom --no-owner "$DATABASE_URL" | mc pipe "r2/$BACKUP_BUCKET/pg-$ts.dump"; then
    echo "[backup] $ts: volcado subido"
    # Retención: borra los dumps que superen los últimos RETAIN.
    mc ls "r2/$BACKUP_BUCKET" | awk '{print $NF}' | grep -E '^pg-.*\.dump$' | sort -r \
      | tail -n "+$((RETAIN + 1))" \
      | while read -r f; do
          echo "[backup] purgando $f"
          mc rm "r2/$BACKUP_BUCKET/$f" >/dev/null
        done
  else
    echo "[backup] $ts: FALLO el volcado" >&2
  fi
  sleep "$INTERVAL"
done
