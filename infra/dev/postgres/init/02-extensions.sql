CREATE EXTENSION IF NOT EXISTS pgmq;
CREATE EXTENSION IF NOT EXISTS pg_cron;

GRANT USAGE ON SCHEMA pgmq TO dentalagent_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgmq TO dentalagent_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgmq TO dentalagent_app;
-- Las colas (q_*) se crean en runtime/migraciones: heredar grants a futuro.
ALTER DEFAULT PRIVILEGES FOR ROLE dentalagent IN SCHEMA pgmq GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dentalagent_app;
