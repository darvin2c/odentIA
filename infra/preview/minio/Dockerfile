# MinIO publica esta versión corregida como fuente, no como imagen comunitaria.
# https://github.com/minio/minio/releases/tag/RELEASE.2025-10-15T17-29-55Z
FROM golang:1.24.8 AS build
ENV CGO_ENABLED=0 GOBIN=/out GOMAXPROCS=2
RUN git clone --depth 1 --branch RELEASE.2025-10-15T17-29-55Z https://github.com/minio/minio /src/minio \
    && cd /src/minio && go build -trimpath -ldflags="-s -w" -o /out/minio . \
    && go install github.com/minio/mc@RELEASE.2025-08-13T08-35-41Z

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /out/minio /out/mc /usr/local/bin/
ENTRYPOINT ["minio"]
