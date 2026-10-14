FROM postgres:18.6-bookworm
ARG PGMQ_REF=v1.13.0
ARG PG_CRON_REF=v1.6.8
# Vectores para la búsqueda por significado del agente (ADR 0021).
ARG PGVECTOR_REF=v0.8.1
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential git postgresql-server-dev-18 ca-certificates \
 && git clone --depth 1 --branch "$PGMQ_REF" https://github.com/pgmq/pgmq /tmp/pgmq \
 && make -C /tmp/pgmq/pgmq-extension \
 && make -C /tmp/pgmq/pgmq-extension install \
 && git clone --depth 1 --branch "$PG_CRON_REF" https://github.com/citusdata/pg_cron /tmp/pg_cron \
 && make -C /tmp/pg_cron install \
 && git clone --depth 1 --branch "$PGVECTOR_REF" https://github.com/pgvector/pgvector /tmp/pgvector \
 && make -C /tmp/pgvector OPTFLAGS="" \
 && make -C /tmp/pgvector install \
 && rm -rf /tmp/pgmq /tmp/pg_cron /tmp/pgvector \
 && apt-get purge -y build-essential git && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*
COPY init/ /docker-entrypoint-initdb.d/
