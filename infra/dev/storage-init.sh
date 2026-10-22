#!/bin/sh
# Buckets del almacenamiento local, como en producción: privados, `avatars/`
# del público se lee sin firma, el público guarda versiones y el de adjuntos
# acepta CORS desde los dominios locales con la regla de R2 (docs/deployment.md).
# Lo ejecuta `storage-init` en infra/dev/compose.yaml; repetirlo no cambia nada.
set -eu

: "${S3_BUCKET:=dentalagent-dev}"
: "${S3_ATTACHMENTS_BUCKET:=dentalagent-attachments}"

for bucket in "$S3_BUCKET" "$S3_ATTACHMENTS_BUCKET"; do
  aws s3api head-bucket --bucket "$bucket" 2>/dev/null || aws s3api create-bucket --bucket "$bucket" >/dev/null
done

aws s3api put-bucket-versioning --bucket "$S3_BUCKET" --versioning-configuration Status=Enabled

aws s3api put-bucket-policy --bucket "$S3_BUCKET" --policy "$(cat <<JSON
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":["*"]},"Action":["s3:GetObject"],"Resource":["arn:aws:s3:::$S3_BUCKET/avatars/*"]}]}
JSON
)"

aws s3api put-bucket-cors --bucket "$S3_ATTACHMENTS_BUCKET" --cors-configuration '{
  "CORSRules": [{
    "AllowedOrigins": ["https://*.localhost"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["content-type", "range"],
    "ExposeHeaders": ["content-length", "content-range", "etag"],
    "MaxAgeSeconds": 3600
  }]
}'

echo "Buckets listos: $S3_BUCKET y $S3_ATTACHMENTS_BUCKET"
