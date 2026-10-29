FROM rclone/rclone:1.75.1 AS rclone
FROM postgres:18.6-bookworm

# Las extensiones de la base (las de infra/dev/postgres, mismas versiones): cada
# volcado se restaura aquí antes de subirse. `infra-images.test.ts` las compara.
ARG PGMQ_REF=v1.13.0
ARG PG_CRON_REF=v1.6.8
ARG PGVECTOR_REF=v0.8.1
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential git postgresql-server-dev-18 ca-certificates bash \
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

# Binario oficial actual: rclone 1.60 de Bookworm falla con el versionado de R2.
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone

COPY backup.sh /backup.sh
RUN chmod +x /backup.sh

CMD ["/backup.sh"]
