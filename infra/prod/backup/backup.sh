#!/usr/bin/env bash
# Backup diario de PostgreSQL a un bucket S3-compatible (R2) con retención.
# Cada volcado se restaura antes en una base temporal de este contenedor (nunca
# en la de producción) y solo se sube si se restauró con sus migraciones. Cada
# vuelta queda anotada en admin.platform_backup: con ella el worker avisa a
# Soporte («Backup sin verificar») si falla o deja de correr.
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
# El bucket se provisiona fuera del runtime; el token solo necesita acceso a objetos.
export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
export RCLONE_CONFIG_R2_ENDPOINT="$BACKUP_S3_ENDPOINT"
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_KEY"

# Anota la vuelta. Si la base no responde no se puede anotar: el worker lo nota
# porque pasan 26 horas sin un backup verificado.
record() {
  local status=$1 step=$2 object=$3 size=$4 migrations=$5 organizations=$6 patients=$7 detail=$8
  psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 \
    -v started="$started" -v status="$status" -v step="$step" -v object="$object" -v size="$size" \
    -v migrations="$migrations" -v organizations="$organizations" -v patients="$patients" -v detail="$detail" <<'SQL' \
    || echo "[backup] no se pudo anotar la vuelta en admin.platform_backup" >&2
insert into admin.platform_backup
  (started_at, status, step, object, size_bytes, migrations, organizations, patients, detail)
values
  (:'started', :'status', nullif(:'step', ''), nullif(:'object', ''), nullif(:'size', '')::bigint,
   nullif(:'migrations', '')::int, nullif(:'organizations', '')::int, nullif(:'patients', '')::int, nullif(:'detail', ''));
SQL
}

fail() {
  local step=$1 log=$2
  local detail
  detail=$(tail -c 1000 "$log" 2>/dev/null || true)
  echo "[backup] $ts: FALLO en $step: $detail" >&2
  record fallido "$step" "" "" "" "" "" "$detail"
}

# Restaura el volcado en un PostgreSQL temporal (mismas extensiones que
# producción) y deja en $restored_* lo que tiene. Los roles de producción se
# crean sin login: las políticas de RLS los nombran.
verify() {
  local dump=$1 work=$2 log=$3
  local data="$work/data" conn="host=$work port=5499 user=postgres"
  gosu postgres initdb -D "$data" -U postgres --auth=trust >"$log" 2>&1 || return 1
  gosu postgres pg_ctl -D "$data" -w -l "$work/postgres.log" \
    -o "-c listen_addresses='' -c unix_socket_directories=$work -c port=5499 -c shared_preload_libraries=pg_cron -c cron.database_name=verificar" \
    start >>"$log" 2>&1 || return 1
  psql "$DATABASE_URL" -X -At -c "select format('create role %I nologin;', rolname) from pg_roles where rolname !~ '^pg_' and rolname <> 'postgres'" \
    | psql "$conn dbname=postgres" -X -q -v ON_ERROR_STOP=1 >>"$log" 2>&1 || return 1
  psql "$conn dbname=postgres" -X -q -c "create database verificar" >>"$log" 2>&1 || return 1
  pg_restore --exit-on-error --no-owner --no-acl --dbname="$conn dbname=verificar" "$dump" >>"$log" 2>&1 || return 1
}

stop_verify() {
  local work=$1
  [ -f "$work/data/postmaster.pid" ] && gosu postgres pg_ctl -D "$work/data" -m fast -w stop >/dev/null 2>&1 || true
}

while true; do
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  object="pg-$ts.dump"
  work=$(mktemp -d /tmp/backup.XXXXXX)
  chown postgres "$work"
  log="$work/log"
  echo "[backup] $ts: iniciando volcado"
  if ! pg_dump --format=custom --no-owner --file="$work/$object" "$DATABASE_URL" 2>"$log"; then
    fail volcado "$log"
  elif ! verify "$work/$object" "$work" "$log"; then
    fail restauracion "$log"
  else
    conn="host=$work port=5499 user=postgres dbname=verificar"
    migrations=$(psql "$conn" -X -At -c "select count(*) from drizzle.__drizzle_migrations" 2>>"$log" || true)
    organizations=$(psql "$conn" -X -At -c "select count(*) from public.organization" 2>>"$log" || true)
    patients=$(psql "$conn" -X -At -c "select count(*) from public.patient" 2>>"$log" || true)
    expected=$(psql "$DATABASE_URL" -X -At -c "select count(*) from drizzle.__drizzle_migrations" 2>>"$log" || true)
    stop_verify "$work"
    if [ -z "$migrations" ] || [ "$migrations" = 0 ] || [ "$migrations" != "$expected" ] || [ -z "$organizations" ]; then
      echo "Restaurado: $migrations migraciones (producción: $expected), $organizations organizaciones" >>"$log"
      fail comprobacion "$log"
    elif ! rclone copyto "$work/$object" "r2:$BACKUP_BUCKET/$object" 2>"$log"; then
      fail subida "$log"
    else
      size=$(stat -c %s "$work/$object")
      echo "[backup] $ts: verificado y subido ($size bytes, $migrations migraciones, $organizations organizaciones, $patients pacientes)"
      record verificado "" "$object" "$size" "$migrations" "$organizations" "$patients" ""
      # Retención: borra los dumps que superen los últimos RETAIN.
      rclone lsf "r2:$BACKUP_BUCKET" --files-only 2>/dev/null | grep -E '^pg-.*\.dump$' | sort -r \
        | tail -n "+$((RETAIN + 1))" \
        | while read -r f; do
            echo "[backup] purgando $f"
            rclone deletefile "r2:$BACKUP_BUCKET/$f" >/dev/null
          done
    fi
  fi
  stop_verify "$work"
  rm -rf "$work"
  sleep "$INTERVAL"
done
