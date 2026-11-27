import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

/**
 * Dónde se guardan las fotos y los videos del producto (ADR 0236): un bucket privado de gestorIA
 * con la API de S3 (RustFS en local, R2 en producción). El resto de gestorIA solo ve esta
 * interfaz: no sabe del proveedor ni del SDK. Nadie lee el bucket directo: el servidor mira el
 * permiso y recién entonces da un enlace firmado que vence en minutos.
 *
 * Es propio de gestorIA y no el de las clínicas (`packages/services/src/storage.ts`): gestorIA no
 * importa nada de ellas (ADR 0203) y lo común de los dos es solo el SDK.
 */
export interface Storage {
  /** Guarda un archivo en su clave, con su tipo. */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>
  /** El contenido de un archivo; null si no está. */
  get(key: string): Promise<Uint8Array | null>
  /**
   * Un enlace de lectura que vence en `ttlSeconds`: lo usan la app, la vitrina y Sofi. Lo da
   * solo quien ya miró el permiso.
   */
  signedUrl(key: string, ttlSeconds: number): Promise<string>
  /** Borra todo lo que está bajo una carpeta (la foto con sus copias). */
  removeFolder(prefix: string): Promise<void>
}

export interface S3Config {
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
}

export function createS3Storage(config: S3Config): Storage & { ensureBucket(): Promise<void> } {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // RustFS y R2 aceptan la ruta con el bucket; así no hace falta un dominio por bucket.
    forcePathStyle: true,
  })
  const Bucket = config.bucket
  return {
    async put(key, bytes, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket,
          Key: key,
          Body: bytes,
          ContentType: contentType,
          // Una clave nunca cambia de contenido: otra foto es otra clave.
          CacheControl: "private, max-age=31536000, immutable",
        }),
      )
    },
    async get(key) {
      try {
        const out = await client.send(new GetObjectCommand({ Bucket, Key: key }))
        return out.Body ? new Uint8Array(await out.Body.transformToByteArray()) : null
      } catch (error) {
        if ((error as { name?: string }).name === "NoSuchKey") return null
        throw error
      }
    },
    signedUrl(key, ttlSeconds) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket, Key: key }), {
        expiresIn: ttlSeconds,
      })
    },
    async removeFolder(prefix) {
      const folder = prefix.endsWith("/") ? prefix : `${prefix}/`
      let token: string | undefined
      do {
        const page = await client.send(
          new ListObjectsV2Command({ Bucket, Prefix: folder, ContinuationToken: token }),
        )
        const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []))
        if (keys.length > 0) {
          const out = await client.send(
            new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys } }),
          )
          // S3 responde 200 aunque alguno no se borre: lo dice en `Errors`.
          if (out.Errors?.length)
            throw new Error(
              `no se borraron ${out.Errors.length} archivo(s): ${out.Errors[0]?.Code ?? "?"}`,
            )
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined
      } while (token)
    },
    /** Solo en desarrollo y en las pruebas: en producción el bucket lo crea el equipo, privado. */
    async ensureBucket() {
      try {
        await client.send(new HeadBucketCommand({ Bucket }))
      } catch {
        await client.send(new CreateBucketCommand({ Bucket }))
      }
    },
  }
}

/**
 * Un almacenamiento en memoria, solo para las pruebas: nunca se usa al correr el servidor. Sus
 * enlaces no abren nada; dicen qué clave firmarían y hasta cuándo.
 */
export function memoryStorage(): Storage & {
  files: Map<string, { bytes: Uint8Array; type: string }>
} {
  const files = new Map<string, { bytes: Uint8Array; type: string }>()
  return {
    files,
    async put(key, bytes, type) {
      files.set(key, { bytes, type })
    },
    async get(key) {
      return files.get(key)?.bytes ?? null
    },
    async signedUrl(key, ttlSeconds) {
      return `memoria://${key}?vence=${ttlSeconds}`
    },
    async removeFolder(prefix) {
      const folder = prefix.endsWith("/") ? prefix : `${prefix}/`
      for (const key of [...files.keys()]) if (key.startsWith(folder)) files.delete(key)
    },
  }
}
