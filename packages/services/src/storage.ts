import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

export const PATIENT_DOC_MAX_BYTES = 10 * 1024 * 1024

export const PATIENT_AVATAR_MAX_BYTES = 2 * 1024 * 1024

export const PATIENT_AVATAR_MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
}

export interface StorageEnv {
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  /** Bucket público de avatares (existente). */
  avatarsBucket: string
  /** Prefijo público que sirve el bucket de avatares. */
  publicBaseUrl: string
  /** Bucket privado de adjuntos de conversaciones (nuevo). */
  attachmentsBucket: string
}

export interface AttachmentRef {
  objectKey: string
  mimeType: string
  filename: string
  size: number
}

export interface Storage {
  putAvatar(input: { userId: string; body: Buffer; contentType: string; ext: string }): Promise<{
    key: string
    url: string
  }>
  /**
   * Borra una imagen pública subida con `putAvatar`, solo si está en la
   * carpeta indicada (la del usuario o `clinica-<org>`): una dirección que
   * apunte a otra carpeta no se toca, aunque alguien la haya guardado.
   */
  deleteByUrl(url: string, folder: string): Promise<void>
  putAttachment(input: {
    orgId: string
    conversationId: string
    bytes: Uint8Array
    contentType: string
    ext: string
  }): Promise<AttachmentRef>
  /** URL firmada de lectura para un adjunto (por defecto 15 min). */
  attachmentUrl(objectKey: string, ttlSeconds?: number): Promise<string>
  /** Elimina un objeto del bucket privado por clave (best-effort huérfanos). */
  deleteAttachment(objectKey: string): Promise<void>
  /**
   * Bytes de un objeto del bucket privado, para servirlo a través de la API
   * (visor DICOM) sin depender del CORS del bucket. Opcional en dobles de prueba.
   */
  getAttachment?(objectKey: string): Promise<Uint8Array>
  /**
   * Lee del bucket público una imagen de esa carpeta (el logo de una clínica, para
   * sus papeles), por su dirección guardada. Lee del almacenamiento, nunca por HTTP;
   * null si la dirección no es de esa carpeta de este bucket.
   */
  readPublicObject?(url: string, folder: string, signal?: AbortSignal): Promise<Uint8Array | null>
  /**
   * URL firmada para que el navegador suba un objeto con PUT directo al bucket
   * privado (tomografías, ADR 0055). Exige CORS en el bucket. Opcional en dobles.
   */
  uploadUrl?(objectKey: string, contentType: string, ttlSeconds?: number): Promise<string>
  /**
   * Tamaño y primeros bytes de un objeto, para comprobar lo que subió el
   * navegador; null si no existe.
   */
  probeAttachment?(objectKey: string, firstBytes: number): Promise<{ size: number; head: Uint8Array } | null>
  /** Guarda un objeto en una clave ya reservada (la semilla de las tomografías). */
  putAttachmentAt?(objectKey: string, bytes: Uint8Array, contentType: string): Promise<void>
  /** Contenido de un objeto como flujo, para descargas largas sin cargarlo en memoria. */
  streamAttachment?(objectKey: string): Promise<ReadableStream<Uint8Array>>
  putPatientDocument(input: {
    orgId: string
    patientId: string
    bytes: Uint8Array
    contentType: string
    ext: string
  }): Promise<AttachmentRef>
  /**
   * Avatar de paciente: va al bucket PRIVADO de adjuntos (la foto del
   * paciente es dato clínico, no asset público como el avatar de usuario).
   */
  putPatientAvatar(input: {
    orgId: string
    patientId: string
    bytes: Uint8Array
    contentType: string
    ext: string
  }): Promise<AttachmentRef>
}

export function createStorage(env: StorageEnv): Storage {
  const client = new S3Client({
    endpoint: env.endpoint,
    region: env.region,
    credentials: { accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey },
    forcePathStyle: true,
  })
  const publicPrefix = `${env.publicBaseUrl.replace(/\/$/, "")}/`
  return {
    async putAvatar({ userId, body, contentType, ext }) {
      const key = `avatars/${userId}/${crypto.randomUUID()}.${ext}`
      await client.send(
        new PutObjectCommand({
          Bucket: env.avatarsBucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          CacheControl: "public, max-age=31536000, immutable",
        }),
      )
      return { key, url: `${publicPrefix}${key}` }
    },
    async deleteByUrl(url, folder) {
      if (!url.startsWith(publicPrefix)) return
      const key = url.slice(publicPrefix.length)
      if (!isInAvatarFolder(key, folder)) return
      await client.send(new DeleteObjectCommand({ Bucket: env.avatarsBucket, Key: key }))
    },
    async putAttachment({ orgId, conversationId, bytes, contentType, ext }) {
      const objectKey = `${orgId}/${conversationId}/${crypto.randomUUID()}.${ext}`
      await client.send(
        new PutObjectCommand({
          Bucket: env.attachmentsBucket,
          Key: objectKey,
          Body: bytes,
          ContentType: contentType,
        }),
      )
      return {
        objectKey,
        mimeType: contentType,
        filename: objectKey.split("/").at(-1) ?? objectKey,
        size: bytes.byteLength,
      }
    },
    async attachmentUrl(objectKey, ttlSeconds = 900) {
      return getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: env.attachmentsBucket, Key: objectKey }),
        {
          expiresIn: ttlSeconds,
        },
      )
    },
    async readPublicObject(url, folder, signal) {
      if (!url.startsWith(publicPrefix)) return null
      const key = url.slice(publicPrefix.length)
      if (!isInAvatarFolder(key, folder)) return null
      const out = await client.send(new GetObjectCommand({ Bucket: env.avatarsBucket, Key: key }), { abortSignal: signal })
      return out.Body ? out.Body.transformToByteArray() : null
    },
    async getAttachment(objectKey) {
      const out = await client.send(
        new GetObjectCommand({ Bucket: env.attachmentsBucket, Key: objectKey }),
      )
      if (!out.Body) throw new Error("Objeto vacío")
      return out.Body.transformToByteArray()
    },
    async uploadUrl(objectKey, contentType, ttlSeconds = 900) {
      return getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: env.attachmentsBucket, Key: objectKey, ContentType: contentType }),
        { expiresIn: ttlSeconds },
      )
    },
    async probeAttachment(objectKey, firstBytes) {
      try {
        const out = await client.send(
          new GetObjectCommand({
            Bucket: env.attachmentsBucket,
            Key: objectKey,
            Range: `bytes=0-${Math.max(0, firstBytes - 1)}`,
          }),
        )
        const head = out.Body ? await out.Body.transformToByteArray() : new Uint8Array()
        // «bytes 0-131/245760»: el total va después de la barra.
        const total = Number(out.ContentRange?.split("/")[1] ?? out.ContentLength ?? head.byteLength)
        return { size: Number.isFinite(total) ? total : head.byteLength, head }
      } catch (error) {
        const name = (error as { name?: string }).name
        if (name === "NoSuchKey" || name === "NotFound" || name === "InvalidRange") return null
        throw error
      }
    },
    async putAttachmentAt(objectKey, bytes, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: env.attachmentsBucket,
          Key: objectKey,
          Body: bytes,
          ContentType: contentType,
        }),
      )
    },
    async streamAttachment(objectKey) {
      const out = await client.send(
        new GetObjectCommand({ Bucket: env.attachmentsBucket, Key: objectKey }),
      )
      if (!out.Body) throw new Error("Objeto vacío")
      return out.Body.transformToWebStream() as ReadableStream<Uint8Array>
    },
    async deleteAttachment(objectKey) {
      await client.send(new DeleteObjectCommand({ Bucket: env.attachmentsBucket, Key: objectKey }))
    },
    async putPatientDocument({ orgId, patientId, bytes, contentType, ext }) {
      const objectKey = `patients/${orgId}/${patientId}/${crypto.randomUUID()}.${ext}`
      await client.send(
        new PutObjectCommand({
          Bucket: env.attachmentsBucket,
          Key: objectKey,
          Body: bytes,
          ContentType: contentType,
        }),
      )
      return {
        objectKey,
        mimeType: contentType,
        filename: objectKey.split("/").at(-1) ?? objectKey,
        size: bytes.byteLength,
      }
    },
    async putPatientAvatar({ orgId, patientId, bytes, contentType, ext }) {
      const objectKey = `patients/${orgId}/${patientId}/avatar/${crypto.randomUUID()}.${ext}`
      await client.send(
        new PutObjectCommand({
          Bucket: env.attachmentsBucket,
          Key: objectKey,
          Body: bytes,
          ContentType: contentType,
        }),
      )
      return {
        objectKey,
        mimeType: contentType,
        filename: objectKey.split("/").at(-1) ?? objectKey,
        size: bytes.byteLength,
      }
    },
  }
}

/**
 * La clave está dentro de `avatars/<carpeta>/` y no sale de ella: lo único
 * que `deleteByUrl` puede borrar.
 */
export function isInAvatarFolder(key: string, folder: string): boolean {
  if (!folder || folder.includes("/") || folder.includes("..")) return false
  const prefix = `avatars/${folder}/`
  return key.startsWith(prefix) && !key.slice(prefix.length).includes("/") && !key.includes("..")
}

/** La carpeta del logo de una clínica en el bucket público. */
export function clinicLogoFolder(orgId: string): string {
  return `clinica-${orgId}`
}
