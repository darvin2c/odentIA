#!/usr/bin/env bash
# Prepara la base de gestorIA en el PostgreSQL de las clínicas (ADR 0203). Se corre a mano, una
# vez, dentro del contenedor `postgres` de producción (o contra cualquier PostgreSQL con su
# superusuario). Se puede repetir: lo que ya existe no lo toca, salvo las contraseñas.
#
#   POSTGRES_URL=postgres://<superusuario>@/postgres \
#   GESTORIA_OWNER_PASSWORD=... GESTORIA_APP_PASSWORD=... \
#   CLINICS_DB=dentalagent bash gestoria/infra/crear-base.sh
#
# Deja:
# - `gestoria`, dueño de la base `gestoria` (migraciones, la copia de las cuentas, los avisos).
# - `gestoria_app`, el rol de la aplicación (sujeto a las reglas de cada tienda).
# - Topes por usuario: conexiones y tiempo por consulta, para que gestorIA no le quite el
#   servidor a las clínicas.
# - Que ninguno de los dos pueda conectarse a la base de las clínicas, ni los de las clínicas a
#   la de gestorIA: se quita el permiso de conectarse a todos (PUBLIC) y se da solo a los suyos.
#   Antes de quitarlo en la base de las clínicas, se le da a cada usuario que hoy entra a ella.
set -euo pipefail

: "${POSTGRES_URL:?POSTGRES_URL: la conexión del superusuario}"
: "${GESTORIA_OWNER_PASSWORD:?GESTORIA_OWNER_PASSWORD: la contraseña del dueño de la base de gestorIA}"
: "${GESTORIA_APP_PASSWORD:?GESTORIA_APP_PASSWORD: la contraseña de gestoria_app}"
CLINICS_DB="${CLINICS_DB:-dentalagent}"

psql "$POSTGRES_URL" -X -v ON_ERROR_STOP=1 \
  -v owner_pass="$GESTORIA_OWNER_PASSWORD" -v app_pass="$GESTORIA_APP_PASSWORD" -v clinics_db="$CLINICS_DB" <<'SQL'
SELECT format('CREATE ROLE gestoria LOGIN PASSWORD %L', :'owner_pass')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gestoria') \gexec
SELECT format('CREATE ROLE gestoria_app LOGIN PASSWORD %L', :'app_pass')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gestoria_app') \gexec
SELECT format('ALTER ROLE gestoria PASSWORD %L', :'owner_pass') \gexec
SELECT format('ALTER ROLE gestoria_app PASSWORD %L', :'app_pass') \gexec
ALTER ROLE gestoria NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT 10;
ALTER ROLE gestoria_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT 30;
ALTER ROLE gestoria_app SET statement_timeout = '15s';
ALTER ROLE gestoria_app SET idle_in_transaction_session_timeout = '60s';

SELECT 'CREATE DATABASE gestoria OWNER gestoria'
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'gestoria') \gexec
REVOKE ALL ON DATABASE gestoria FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE gestoria TO gestoria;
GRANT CONNECT ON DATABASE gestoria TO gestoria_app;

-- La base de las clínicas: primero, cada usuario que hoy entra a ella sigue entrando; después,
-- nadie más (gestorIA incluido). Los superusuarios no necesitan el permiso.
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'clinics_db', rolname)
  FROM pg_roles
  WHERE rolcanlogin AND NOT rolsuper AND rolname NOT IN ('gestoria', 'gestoria_app')
    AND has_database_privilege(rolname, :'clinics_db', 'CONNECT') \gexec
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', :'clinics_db') \gexec
SQL

echo "gestoria: base y usuarios listos. Sigue: migrar (gestoria-migrate) con GESTORIA_DATABASE_URL."
