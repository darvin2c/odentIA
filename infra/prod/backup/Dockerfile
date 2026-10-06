FROM postgres:18-bookworm

# pg_dump 18 (misma major que el servidor) + rclone para subir a S3/R2.
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash curl ca-certificates rclone \
 && rm -rf /var/lib/apt/lists/*

COPY backup.sh /backup.sh
RUN chmod +x /backup.sh

CMD ["/backup.sh"]
