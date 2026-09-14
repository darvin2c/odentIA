import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface StorageEnv {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Bucket público de avatares (existente). */
  avatarsBucket: string;
  /** Prefijo público que sirve el bucket de avatares. */
  publicBaseUrl: string;
  /** Bucket privado de adjuntos de conversaciones (nuevo). */
  attachmentsBucket: string;
}

export interface AttachmentRef {
  objectKey: string;
  mimeType: string;
  filename: string;
  size: number;
}

export interface Storage {
  putAvatar(input: { userId: string; body: Buffer; contentType: string; ext: string }): Promise<{
    key: string;
    url: string;
  }>;
  deleteByUrl(url: string): Promise<void>;
  putAttachment(input: {
    orgId: string;
    conversationId: string;
    bytes: Uint8Array;
    contentType: string;
    ext: string;
  }): Promise<AttachmentRef>;
  /** URL firmada de lectura para un adjunto (por defecto 15 min). */
  attachmentUrl(objectKey: string, ttlSeconds?: number): Promise<string>;
}

export function createStorage(env: StorageEnv): Storage {
  const client = new S3Client({
    endpoint: env.endpoint,
    region: env.region,
    credentials: { accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey },
    forcePathStyle: true,
  });
  const publicPrefix = `${env.publicBaseUrl.replace(/\/$/, "")}/`;
  return {
    async putAvatar({ userId, body, contentType, ext }) {
      const key = `avatars/${userId}/${crypto.randomUUID()}.${ext}`;
      await client.send(
        new PutObjectCommand({
          Bucket: env.avatarsBucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          CacheControl: "public, max-age=31536000, immutable",
        }),
      );
      return { key, url: `${publicPrefix}${key}` };
    },
    async deleteByUrl(url) {
      if (!url.startsWith(publicPrefix)) return;
      await client.send(new DeleteObjectCommand({ Bucket: env.avatarsBucket, Key: url.slice(publicPrefix.length) }));
    },
    async putAttachment({ orgId, conversationId, bytes, contentType, ext }) {
      const objectKey = `${orgId}/${conversationId}/${crypto.randomUUID()}.${ext}`;
      await client.send(
        new PutObjectCommand({
          Bucket: env.attachmentsBucket,
          Key: objectKey,
          Body: bytes,
          ContentType: contentType,
        }),
      );
      return { objectKey, mimeType: contentType, filename: objectKey.split("/").at(-1) ?? objectKey, size: bytes.byteLength };
    },
    async attachmentUrl(objectKey, ttlSeconds = 900) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: env.attachmentsBucket, Key: objectKey }), {
        expiresIn: ttlSeconds,
      });
    },
  };
}
