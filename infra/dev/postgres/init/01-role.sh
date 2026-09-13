#!/bin/bash
# Crea el rol de runtime dentalagent_app (sujeto a RLS). Los .sql del init no
# interpolan env; por eso shell + psql -v.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_pass="$POSTGRES_APP_PASSWORD" <<'SQL'
CREATE ROLE dentalagent_app LOGIN PASSWORD :'app_pass';
SQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO dentalagent_app;
GRANT USAGE ON SCHEMA public TO dentalagent_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dentalagent_app;
ALTER DEFAULT PRIVILEGES FOR ROLE "$POSTGRES_USER" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dentalagent_app;
SQL
