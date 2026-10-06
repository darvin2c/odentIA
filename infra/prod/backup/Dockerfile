FROM rclone/rclone:1.75.1 AS rclone
FROM postgres:18.6-bookworm

# Binario oficial actual: rclone 1.60 de Bookworm falla con el versionado de R2.
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY backup.sh /backup.sh
RUN chmod +x /backup.sh

CMD ["/backup.sh"]
