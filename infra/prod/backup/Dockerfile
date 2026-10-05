FROM alpine:3.21

# Cliente pg acorde al servidor (Postgres 18) + mc para subir a S3/R2.
RUN apk add --no-cache bash curl postgresql18-client \
 && curl -fsSL https://dl.min.io/client/mc/release/linux-amd64/mc -o /usr/local/bin/mc \
 && chmod +x /usr/local/bin/mc

COPY backup.sh /backup.sh
RUN chmod +x /backup.sh

CMD ["/backup.sh"]
