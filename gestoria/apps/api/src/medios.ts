import {
  type Db,
  MAX_MEDIA_PHOTO_BYTES,
  MAX_PRODUCT_PHOTOS,
  MAX_VIDEO_BYTES,
  MAX_VIDEO_MS,
  mediaTrash,
  type PhotoType,
  product,
  productColor,
  productPhoto,
  productVariant,
  productVideo,
  storeLink,
} from "@gestoria/db"
import { and, asc, eq, isNull, notInArray, or, sql } from "drizzle-orm"
import { z } from "zod"
import type { Storage } from "./archivos.js"
import { imageType, logProductEvent, productRow, uuidOr404 } from "./catalogo.js"
import type { Person } from "./cuenta.js"
import {
  COPY_TYPE,
  ImageError,
  PHOTO_COPIES,
  type PhotoCopy,
  photoCopies,
  photoFacts,
  posterCopy,
} from "./imagenes.js"
import { sameText } from "./texto.js"
import { inStore, StoreError } from "./tiendas.js"
import { checkVideo } from "./video.js"

/**
 * Las fotos y los videos del producto (ADR 0236; decisión 9 del lienzo «La ficha del producto»).
 * Están en el almacenamiento, en una carpeta por foto o video: la original como llegó y sus
 * copias (`imagenes.ts`). La base guarda dónde están y lo que se sabe de ellos.
 *
 * - Subir pasa por el servidor: mira el permiso, el tipo por sus primeros bytes y el tamaño,
 *   arma las copias y recién entonces lo guarda. Nada llega al bucket sin pasar por aquí.
 * - Ver es un enlace firmado que vence en minutos, dado después de mirar el permiso: la app
 *   (`catalogo.ver`), la vitrina pública (solo lo de un producto que se ve en la web) y Sofi.
 * - Borrar lo anota la base (`media_trash`, también en cascada) y el servidor lo borra después
 *   (`emptyMediaTrash`).
 */

/** Cuánto vale un enlace de la app y de la vitrina; el de Sofi alcanza para que WhatsApp lo lea. */
export const APP_LINK_SECONDS = 10 * 60
export const PUBLIC_LINK_SECONDS = 60 * 60

export class MediaOff extends StoreError {
  constructor() {
    super(
      503,
      "MEDIA_OFF",
      "Ahora no se pueden subir fotos ni videos. Avísale a soporte de gestorIA.",
    )
  }
}

const need = (storage: Storage | null | undefined): Storage => {
  if (!storage) throw new MediaOff()
  return storage
}

export const photoFolder = (storeId: string, productId: string, photoId: string) =>
  `tiendas/${storeId}/productos/${productId}/fotos/${photoId}`
export const videoFolder = (storeId: string, productId: string, videoId: string) =>
  `tiendas/${storeId}/productos/${productId}/videos/${videoId}`

/** Qué copia se muestra de una foto: la de fondo quitado si la tienda la eligió. */
const copyKey = (
  folder: string,
  copy: PhotoCopy | "original",
  photo: { cutout: string | null; cutoutId: string | null },
) =>
  photo.cutout === "usada" && photo.cutoutId
    ? `${cutoutFolder(folder, photo.cutoutId)}/${copy}`
    : `${folder}/${copy}`

/** Cada propuesta sin fondo, en su carpeta: una nueva nunca pisa la que se está mostrando. */
const cutoutFolder = (folder: string, cutoutId: string) => `${folder}/sin-fondo/${cutoutId}`

const typeError = () =>
  new StoreError(400, "PHOTO_TYPE", "No pudimos abrir la foto. Sube una JPG, PNG o WebP.")
const sizeError = () =>
  new StoreError(400, "PHOTO_TOO_LARGE", "La foto pesa demasiado: hasta 8 MB. Prueba con otra.")

export interface StoredPhoto {
  contentType: PhotoType
  sizeBytes: number
  width: number
  height: number
}

/**
 * Mira una foto y la guarda con sus copias en su carpeta. Falla antes de guardar nada si no es
 * una foto o si es muy grande. `transparent` pide que tenga fondo transparente (la de fondo
 * quitado).
 */
export async function storePhoto(
  storage: Storage,
  folder: string,
  bytes: Uint8Array,
  options: { transparent?: boolean } = {},
): Promise<StoredPhoto> {
  if (bytes.length === 0 || bytes.length > MAX_MEDIA_PHOTO_BYTES) throw sizeError()
  const contentType = imageType(bytes)
  if (!contentType) throw typeError()
  let facts: Awaited<ReturnType<typeof photoFacts>>
  let copies: Awaited<ReturnType<typeof photoCopies>>
  try {
    facts = await photoFacts(bytes)
    if (options.transparent && !facts.alpha)
      throw new StoreError(
        400,
        "PHOTO_TYPE",
        "La foto sin fondo va en PNG o WebP, con el fondo transparente.",
      )
    copies = await photoCopies(bytes)
  } catch (error) {
    if (error instanceof StoreError) throw error
    if (error instanceof ImageError) throw typeError()
    throw typeError()
  }
  try {
    await storage.put(`${folder}/original`, bytes, contentType)
    for (const copy of PHOTO_COPIES)
      await storage.put(`${folder}/${copy}`, copies[copy], COPY_TYPE[copy])
  } catch (error) {
    // Lo que alcanzó a guardarse no queda sin dueño.
    await undoStored(storage, folder)
    throw error
  }
  return { contentType, sizeBytes: bytes.length, width: facts.width, height: facts.height }
}

/** Si algo falla después de guardar en el almacenamiento, se borra lo guardado (sin tapar el error). */
async function undoStored(storage: Storage, folder: string) {
  try {
    await storage.removeFolder(folder)
  } catch (error) {
    console.error("gestoria-api: no se pudo borrar lo que se subió a medias", folder, error)
  }
}

async function colorOf(tx: Db, productId: string, colorId: string | null | undefined) {
  if (!colorId) return null
  uuidOr404(colorId, "Ese color ya no está en el producto")
  const [color] = await tx
    .select({ id: productColor.id })
    .from(productColor)
    .where(and(eq(productColor.id, colorId), eq(productColor.productId, productId)))
  if (!color) throw new StoreError(404, "NOT_FOUND", "Ese color ya no está en el producto")
  return color.id
}

/** Sube una foto al producto: va al final y, si se dice, ya es de un color. */
export async function addPhoto(
  appDb: Db,
  storage: Storage | null | undefined,
  person: Person,
  storeId: string,
  productId: string,
  bytes: Uint8Array,
  colorId?: string | null,
) {
  const files = need(storage)
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    await productRow(tx, storeId, productId)
    const color = await colorOf(tx, productId, colorId)
    const existing = await tx
      .select({ position: productPhoto.position })
      .from(productPhoto)
      .where(eq(productPhoto.productId, productId))
    if (existing.length >= MAX_PRODUCT_PHOTOS)
      throw new StoreError(409, "TOO_MANY_PHOTOS", `Hasta ${MAX_PRODUCT_PHOTOS} fotos por producto`)
    const id = crypto.randomUUID()
    const folder = photoFolder(storeId, productId, id)
    const stored = await storePhoto(files, folder, bytes)
    try {
      const [row] = await tx
        .insert(productPhoto)
        .values({
          id,
          storeId,
          productId,
          position: Math.max(-1, ...existing.map((p) => p.position)) + 1,
          objectKey: folder,
          colorId: color,
          ...stored,
          createdBy: person.userId,
        })
        .returning({ id: productPhoto.id, position: productPhoto.position })
      await logProductEvent(tx, storeId, productId, person.userId, "foto", [
        { field: "photos", from: null, to: id },
      ])
      return row!
    } catch (error) {
      await undoStored(files, folder)
      throw error
    }
  })
}

/** Quita una foto. La variante y el color que la usaban vuelven a la foto del producto. */
export async function removePhoto(appDb: Db, person: Person, storeId: string, photoId: string) {
  uuidOr404(photoId, "Esa foto ya no está")
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    await tx
      .update(productVariant)
      .set({ photoId: null, updatedAt: new Date() })
      .where(and(eq(productVariant.storeId, storeId), eq(productVariant.photoId, photoId)))
    await tx
      .update(productColor)
      .set({ photoId: null, updatedAt: new Date() })
      .where(and(eq(productColor.storeId, storeId), eq(productColor.photoId, photoId)))
    // La carpeta la anota la base para borrarla después (`media_trash`).
    const [row] = await tx
      .delete(productPhoto)
      .where(and(eq(productPhoto.id, photoId), eq(productPhoto.storeId, storeId)))
      .returning({ id: productPhoto.id, productId: productPhoto.productId })
    if (!row) throw new StoreError(404, "NOT_FOUND", "Esa foto ya no está")
    await logProductEvent(tx, storeId, row.productId, person.userId, "foto", [
      { field: "photos", from: photoId, to: null },
    ])
  })
}

async function photoRow(tx: Db, storeId: string, photoId: string) {
  uuidOr404(photoId, "Esa foto ya no está")
  const [row] = await tx
    .select({
      id: productPhoto.id,
      productId: productPhoto.productId,
      objectKey: productPhoto.objectKey,
      cutout: productPhoto.cutout,
      cutoutId: productPhoto.cutoutId,
    })
    .from(productPhoto)
    .where(and(eq(productPhoto.id, photoId), eq(productPhoto.storeId, storeId)))
    .for("update")
  if (!row) throw new StoreError(404, "NOT_FOUND", "Esa foto ya no está")
  if (!row.objectKey)
    throw new StoreError(
      409,
      "PHOTO_MOVING",
      "Esta foto se está pasando al almacenamiento nuevo. Prueba en un minuto.",
    )
  return { ...row, objectKey: row.objectKey }
}

/**
 * «La IA propone quitar el fondo» (decisión 9): guarda la propuesta junto a la original, que no
 * se toca. Quién la arma (la pantalla o un servicio) no lo decide el servidor: aquí solo llega
 * la foto ya sin fondo, transparente. Una propuesta nueva reemplaza a la anterior y vuelve a ser
 * solo propuesta.
 */
export async function proposeCutout(
  appDb: Db,
  storage: Storage | null | undefined,
  person: Person,
  storeId: string,
  photoId: string,
  bytes: Uint8Array,
) {
  const files = need(storage)
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const photo = await photoRow(tx, storeId, photoId)
    const cutoutId = crypto.randomUUID()
    const folder = cutoutFolder(photo.objectKey, cutoutId)
    await storePhoto(files, folder, bytes, { transparent: true })
    try {
      // La de antes, si había, la anota la base para borrarla.
      await tx
        .update(productPhoto)
        .set({ cutout: "propuesta", cutoutId })
        .where(eq(productPhoto.id, photoId))
      await logProductEvent(tx, storeId, photo.productId, person.userId, "foto", [
        { field: "cutout", from: photo.cutout, to: "propuesta" },
      ])
    } catch (error) {
      await undoStored(files, folder)
      throw error
    }
    return { id: photoId, cutout: "propuesta" as const }
  })
}

/**
 * «Usar esta» (`use`) o «Dejar la original»: la original se guarda siempre. Dejar la original
 * borra la propuesta (la anota la base).
 */
export async function chooseCutout(
  appDb: Db,
  person: Person,
  storeId: string,
  photoId: string,
  use: boolean,
) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const photo = await photoRow(tx, storeId, photoId)
    if (!photo.cutout)
      throw new StoreError(404, "NOT_FOUND", "Esa foto no tiene una propuesta sin fondo")
    const next = use ? ("usada" as const) : null
    if (next !== photo.cutout) {
      await tx
        .update(productPhoto)
        .set(next ? { cutout: next } : { cutout: null, cutoutId: null })
        .where(eq(productPhoto.id, photoId))
      await logProductEvent(tx, storeId, photo.productId, person.userId, "foto", [
        { field: "cutout", from: photo.cutout, to: next },
      ])
    }
    return { id: photoId, cutout: next }
  })
}

/** El contenido de una foto para la pantalla de antes (`/fotos/:id`): su copia de la vitrina. */
export async function photoContent(
  appDb: Db,
  storage: Storage | null | undefined,
  person: Person,
  storeId: string,
  photoId: string,
): Promise<{ contentType: string; content: Uint8Array }> {
  uuidOr404(photoId, "Esa foto ya no está")
  const row = await inStore(appDb, person, storeId, "catalogo.ver", async (tx) => {
    const [found] = await tx
      .select({
        contentType: productPhoto.contentType,
        content: productPhoto.content,
        objectKey: productPhoto.objectKey,
        cutout: productPhoto.cutout,
        cutoutId: productPhoto.cutoutId,
      })
      .from(productPhoto)
      .where(and(eq(productPhoto.id, photoId), eq(productPhoto.storeId, storeId)))
    if (!found) throw new StoreError(404, "NOT_FOUND", "Esa foto ya no está")
    return found
  })
  if (row.content) return { contentType: row.contentType, content: new Uint8Array(row.content) }
  const content = row.objectKey
    ? await need(storage).get(copyKey(row.objectKey, "vitrina", row))
    : null
  if (!content) throw new StoreError(404, "NOT_FOUND", "Esa foto ya no está")
  return { contentType: COPY_TYPE.vitrina, content }
}

export const videoInput = z.object({
  colorId: z.uuid().nullable().optional(),
  label: z.string().trim().max(60, "Máximo 60 caracteres").default(""),
})

export const videoPatch = z.object({
  colorId: z.uuid().nullable().optional(),
  label: z.string().trim().max(60, "Máximo 60 caracteres").optional(),
})

/**
 * Sube el video corto de un producto o de un color, con su póster. Llega listo para WhatsApp
 * (la pantalla lo achica): aquí se mira que lo sea (`video.ts`) y no se vuelve a armar.
 */
export async function addVideo(
  appDb: Db,
  storage: Storage | null | undefined,
  person: Person,
  storeId: string,
  productId: string,
  input: { video: Uint8Array; poster: Uint8Array; colorId?: string | null; label: string },
) {
  const files = need(storage)
  if (input.video.length === 0 || input.video.length > MAX_VIDEO_BYTES)
    throw new StoreError(
      400,
      "VIDEO_TOO_LARGE",
      "El video pesa demasiado: WhatsApp acepta hasta 16 MB. Prueba con uno más corto.",
    )
  const checked = checkVideo(input.video)
  if (!checked.ok) throw new StoreError(400, "VIDEO_TYPE", checked.message)
  if (checked.facts.durationMs > MAX_VIDEO_MS)
    throw new StoreError(
      400,
      "VIDEO_TOO_LONG",
      "El video dura más de 30 segundos. Prueba con uno más corto.",
    )
  if (!imageType(input.poster))
    throw new StoreError(400, "PHOTO_TYPE", "La imagen del video va en JPG, PNG o WebP.")
  let poster: Uint8Array
  try {
    poster = await posterCopy(input.poster)
  } catch {
    throw new StoreError(400, "PHOTO_TYPE", "No pudimos abrir la imagen del video.")
  }
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    await productRow(tx, storeId, productId)
    const color = await colorOf(tx, productId, input.colorId)
    const [taken] = await tx
      .select({ id: productVideo.id })
      .from(productVideo)
      .where(
        and(
          eq(productVideo.productId, productId),
          color ? eq(productVideo.colorId, color) : isNull(productVideo.colorId),
        ),
      )
    if (taken)
      throw new StoreError(
        409,
        "VIDEO_TAKEN",
        color
          ? "Ese color ya tiene su video. Quítalo antes de subir otro."
          : "El producto ya tiene su video. Quítalo antes de subir otro.",
      )
    const id = crypto.randomUUID()
    const folder = videoFolder(storeId, productId, id)
    try {
      await files.put(`${folder}/video`, input.video, "video/mp4")
      await files.put(`${folder}/poster`, poster, "image/jpeg")
      const [row] = await tx
        .insert(productVideo)
        .values({
          id,
          storeId,
          productId,
          colorId: color,
          label: input.label,
          objectKey: folder,
          sizeBytes: input.video.length,
          durationMs: checked.facts.durationMs,
          width: checked.facts.width,
          height: checked.facts.height,
          createdBy: person.userId,
        })
        .returning({
          id: productVideo.id,
          colorId: productVideo.colorId,
          durationMs: productVideo.durationMs,
        })
      await logProductEvent(tx, storeId, productId, person.userId, "foto", [
        { field: "video", from: null, to: id },
      ])
      return row!
    } catch (error) {
      await undoStored(files, folder)
      throw error
    }
  })
}

export async function updateVideo(
  appDb: Db,
  person: Person,
  storeId: string,
  videoId: string,
  patch: z.infer<typeof videoPatch>,
) {
  uuidOr404(videoId, "Ese video ya no está")
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const [video] = await tx
      .select()
      .from(productVideo)
      .where(and(eq(productVideo.id, videoId), eq(productVideo.storeId, storeId)))
    if (!video) throw new StoreError(404, "NOT_FOUND", "Ese video ya no está")
    const colorId =
      patch.colorId !== undefined
        ? await colorOf(tx, video.productId, patch.colorId)
        : video.colorId
    try {
      const [row] = await tx
        .update(productVideo)
        .set({ colorId, label: patch.label ?? video.label })
        .where(eq(productVideo.id, videoId))
        .returning({
          id: productVideo.id,
          colorId: productVideo.colorId,
          label: productVideo.label,
        })
      return row!
    } catch (error) {
      if ((error as { cause?: { code?: string } }).cause?.code === "23505")
        throw new StoreError(409, "VIDEO_TAKEN", "Ese color ya tiene su video.")
      throw error
    }
  })
}

export async function removeVideo(appDb: Db, person: Person, storeId: string, videoId: string) {
  uuidOr404(videoId, "Ese video ya no está")
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const [row] = await tx
      .delete(productVideo)
      .where(and(eq(productVideo.id, videoId), eq(productVideo.storeId, storeId)))
      .returning({ productId: productVideo.productId })
    if (!row) throw new StoreError(404, "NOT_FOUND", "Ese video ya no está")
    await logProductEvent(tx, storeId, row.productId, person.userId, "foto", [
      { field: "video", from: videoId, to: null },
    ])
  })
}

export interface MediaPhoto {
  id: string
  position: number
  colorId: string | null
  /** Si es la que manda Sofi cuando piden su color. */
  colorMain: boolean
  width: number | null
  height: number | null
  /** La propuesta de quitar el fondo: `propuesta`, `usada` o null. */
  cutout: "propuesta" | "usada" | null
  /**
   * Los enlaces (vencen en `expiresAt`): la que se ve (con el fondo quitado si se eligió) en
   * miniatura y grande, la original como llegó y, si hay propuesta, la propuesta. Null en una foto
   * que todavía no se pasó al almacenamiento: se ve con `/fotos/:id`.
   */
  urls: {
    miniatura: string
    vitrina: string
    original: string
    sinFondo: { miniatura: string; vitrina: string } | null
  } | null
}

export interface MediaVideo {
  id: string
  colorId: string | null
  label: string
  durationMs: number
  width: number
  height: number
  urls: { video: string; poster: string }
}

/** Las fotos y los videos de un producto, con sus enlaces firmados, para la ficha. */
export async function productMedia(
  appDb: Db,
  storage: Storage | null | undefined,
  person: Person,
  storeId: string,
  productId: string,
) {
  const rows = await inStore(appDb, person, storeId, "catalogo.ver", async (tx) => {
    await productRow(tx, storeId, productId)
    const photos = await tx
      .select({
        id: productPhoto.id,
        position: productPhoto.position,
        colorId: productPhoto.colorId,
        width: productPhoto.width,
        height: productPhoto.height,
        cutout: productPhoto.cutout,
        cutoutId: productPhoto.cutoutId,
        objectKey: productPhoto.objectKey,
      })
      .from(productPhoto)
      .where(eq(productPhoto.productId, productId))
      .orderBy(asc(productPhoto.position), asc(productPhoto.createdAt))
    const mains = await tx
      .select({ photoId: productColor.photoId })
      .from(productColor)
      .where(eq(productColor.productId, productId))
    const videos = await tx
      .select()
      .from(productVideo)
      .where(eq(productVideo.productId, productId))
      .orderBy(asc(productVideo.createdAt))
    return { photos, mains: new Set(mains.map((m) => m.photoId)), videos }
  })
  const sign = (key: string) =>
    storage ? storage.signedUrl(key, APP_LINK_SECONDS) : Promise.resolve(null)
  const expiresAt = new Date(Date.now() + APP_LINK_SECONDS * 1000).toISOString()
  const photos: MediaPhoto[] = await Promise.all(
    rows.photos.map(async (p) => {
      const key = p.objectKey
      const urls =
        key && storage
          ? {
              miniatura: (await sign(copyKey(key, "miniatura", p)))!,
              vitrina: (await sign(copyKey(key, "vitrina", p)))!,
              original: (await sign(`${key}/original`))!,
              sinFondo: p.cutoutId
                ? {
                    miniatura: (await sign(`${cutoutFolder(key, p.cutoutId!)}/miniatura`))!,
                    vitrina: (await sign(`${cutoutFolder(key, p.cutoutId!)}/vitrina`))!,
                  }
                : null,
            }
          : null
      return {
        id: p.id,
        position: p.position,
        colorId: p.colorId,
        colorMain: rows.mains.has(p.id),
        width: p.width,
        height: p.height,
        cutout: p.cutout,
        urls,
      }
    }),
  )
  const videos: MediaVideo[] = storage
    ? await Promise.all(
        rows.videos.map(async (v) => ({
          id: v.id,
          colorId: v.colorId,
          label: v.label,
          durationMs: v.durationMs,
          width: v.width,
          height: v.height,
          urls: {
            video: await storage.signedUrl(`${v.objectKey}/video`, APP_LINK_SECONDS),
            poster: await storage.signedUrl(`${v.objectKey}/poster`, APP_LINK_SECONDS),
          },
        })),
      )
    : []
  return { photos, videos, expiresAt }
}

/** Lo que Sofi manda por WhatsApp de un producto: la copia de WhatsApp y su enlace. */
export interface SofiMedia {
  kind: "foto" | "video"
  id: string
  /** Para WhatsApp: `image/jpeg` o `video/mp4`, dentro de sus límites (5 MB y 16 MB). */
  mimeType: string
  /** El enlace firmado (una hora); null sin almacenamiento configurado (`MEDIA_OFF`). */
  url: string | null
  /**
   * El color de la foto o del video, como está en la ficha; null si es para todos los colores.
   * Así Sofi dice el hecho.
   */
  color: string | null
  /** Lo que muestra el video («Puesta, caminando»). */
  label: string | null
  durationMs: number | null
}

/**
 * Qué foto y qué video manda Sofi (decisión 9): si la clienta pide un color, la foto elegida de
 * ese color (la que dice «★»), si no la primera de ese color; sin foto de ese color, la primera
 * que es para todos (sin color) o ninguna: nunca la de otro color. Sin color pedido, la primera
 * del producto. El video, el del color o, si no tiene, el del producto. Cada uno dice de qué
 * color es (`color`), para que Sofi diga el hecho. Lee con el mismo `tx` de la herramienta de
 * Sofi (`mandar_foto`), ya dentro de la tienda. Sin almacenamiento elige igual y no firma: la
 * pantalla dice que no hay dónde verlas.
 */
export async function sofiMediaIn(
  tx: Db,
  storage: Storage | null | undefined,
  storeId: string,
  productId: string,
  colorValue?: string | null,
): Promise<{ photo: SofiMedia | null; video: SofiMedia | null }> {
  const colors = await tx
    .select({ id: productColor.id, value: productColor.value, photoId: productColor.photoId })
    .from(productColor)
    .where(and(eq(productColor.productId, productId), eq(productColor.storeId, storeId)))
  const color = colorValue ? colors.find((c) => sameText(c.value, colorValue)) : undefined
  const photos = await tx
    .select({
      id: productPhoto.id,
      colorId: productPhoto.colorId,
      objectKey: productPhoto.objectKey,
      cutout: productPhoto.cutout,
      cutoutId: productPhoto.cutoutId,
    })
    .from(productPhoto)
    .where(and(eq(productPhoto.productId, productId), eq(productPhoto.storeId, storeId)))
    .orderBy(asc(productPhoto.position), asc(productPhoto.createdAt))
  const stored = photos.filter((p) => p.objectKey)
  const asked = Boolean(colorValue?.trim())
  const chosen = asked
    ? // La ★ cuenta solo si es de ese color o para todos: nunca una foto de otro color.
      (color &&
        stored.find(
          (p) => p.id === color.photoId && (p.colorId === color.id || p.colorId === null),
        )) ||
      (color && stored.find((p) => p.colorId === color.id)) ||
      stored.find((p) => p.colorId === null)
    : stored[0]
  const colorOf = (colorId: string | null) => colors.find((c) => c.id === colorId)?.value ?? null
  const videos = await tx
    .select()
    .from(productVideo)
    .where(and(eq(productVideo.productId, productId), eq(productVideo.storeId, storeId)))
  const video =
    (color && videos.find((v) => v.colorId === color.id)) || videos.find((v) => v.colorId === null)
  return {
    photo: chosen
      ? {
          kind: "foto",
          id: chosen.id,
          mimeType: COPY_TYPE.whatsapp,
          url: storage
            ? await storage.signedUrl(
                copyKey(chosen.objectKey!, "whatsapp", chosen),
                PUBLIC_LINK_SECONDS,
              )
            : null,
          // La de todos que es la ★ del color pedido es de ese color; si no, el suyo.
          color: colorOf(chosen.colorId) ?? (color?.photoId === chosen.id ? color.value : null),
          label: null,
          durationMs: null,
        }
      : null,
    video: video
      ? {
          kind: "video",
          id: video.id,
          mimeType: "video/mp4",
          url: storage
            ? await storage.signedUrl(`${video.objectKey}/video`, PUBLIC_LINK_SECONDS)
            : null,
          color: colorOf(video.colorId),
          label: video.label || null,
          durationMs: video.durationMs,
        }
      : null,
  }
}

/** La tienda y el producto de la vitrina pública: el link vigente y un producto que se ve en la web. */
export async function publicProduct(ownerDb: Db, link: string, slugOrId: string) {
  if (!/^[a-z0-9-]{3,63}$/.test(link) || !/^[a-z0-9-]{1,80}$/.test(slugOrId)) return null
  const isId = z.uuid().safeParse(slugOrId).success
  const [row] = await ownerDb
    .select({ storeId: product.storeId, productId: product.id })
    .from(product)
    .innerJoin(storeLink, and(eq(storeLink.storeId, product.storeId), eq(storeLink.current, true)))
    .where(
      and(
        eq(storeLink.name, link),
        eq(product.webVisible, true),
        or(isNull(product.status), sql`${product.status} <> 'no_se_vende'`),
        isId
          ? or(eq(product.id, slugOrId), eq(product.webSlug, slugOrId))
          : eq(product.webSlug, slugOrId),
      ),
    )
  return row ?? null
}

/**
 * Las fotos y los videos que ve la clienta de un producto, con enlaces firmados que vencen en
 * `seconds`: la copia de la vitrina y la miniatura, nunca la original ni la propuesta sin fondo.
 * La vitrina pública (con el dueño de la base, ya filtrada por su tienda) y la vista previa de la
 * ficha (dentro de la tienda) leen lo mismo.
 */
export async function shownMediaIn(
  db: Db,
  storage: Storage,
  storeId: string,
  productId: string,
  seconds: number,
) {
  const photos = await db
    .select({
      id: productPhoto.id,
      colorId: productPhoto.colorId,
      width: productPhoto.width,
      height: productPhoto.height,
      objectKey: productPhoto.objectKey,
      cutout: productPhoto.cutout,
      cutoutId: productPhoto.cutoutId,
    })
    .from(productPhoto)
    .where(and(eq(productPhoto.productId, productId), eq(productPhoto.storeId, storeId)))
    .orderBy(asc(productPhoto.position), asc(productPhoto.createdAt))
  const colors = await db
    .select({ id: productColor.id, value: productColor.value })
    .from(productColor)
    .where(and(eq(productColor.productId, productId), eq(productColor.storeId, storeId)))
  const colorName = (id: string | null) => colors.find((c) => c.id === id)?.value ?? null
  const videos = await db
    .select()
    .from(productVideo)
    .where(and(eq(productVideo.productId, productId), eq(productVideo.storeId, storeId)))
  const sign = (key: string) => storage.signedUrl(key, seconds)
  return {
    photos: await Promise.all(
      photos
        .filter((p) => p.objectKey)
        .map(async (p) => ({
          id: p.id,
          color: colorName(p.colorId),
          width: p.width,
          height: p.height,
          miniatura: await sign(copyKey(p.objectKey!, "miniatura", p)),
          vitrina: await sign(copyKey(p.objectKey!, "vitrina", p)),
        })),
    ),
    videos: await Promise.all(
      videos.map(async (v) => ({
        id: v.id,
        color: colorName(v.colorId),
        label: v.label,
        durationMs: v.durationMs,
        video: await sign(`${v.objectKey}/video`),
        poster: await sign(`${v.objectKey}/poster`),
      })),
    ),
    expiresAt: new Date(Date.now() + seconds * 1000).toISOString(),
  }
}

/**
 * Las fotos y los videos que ve la clienta en la web de la tienda (`<tienda>.gestoria24.com/<producto>`):
 * solo de un producto que se ve en la web, con enlaces firmados de una hora. Sin el permiso de
 * nadie: es lo público de la tienda, y nada más (ni la original ni la propuesta sin fondo).
 */
export async function publicMedia(
  ownerDb: Db,
  storage: Storage | null | undefined,
  link: string,
  slugOrId: string,
) {
  const found = storage ? await publicProduct(ownerDb, link, slugOrId) : null
  if (!found || !storage) return null
  return shownMediaIn(ownerDb, storage, found.storeId, found.productId, PUBLIC_LINK_SECONDS)
}

/**
 * Las fotos de antes, que están en la base, pasan al almacenamiento (ADR 0236): de a pocas, con
 * el dueño de la base. Corre al arrancar el servidor y cada tanto hasta que no queda ninguna. La
 * que no se puede abrir se deja como está (se ve igual) y se avisa en el registro.
 */
/** Las fotos de antes que no se pudieron abrir: se dejan en la base, como están. */
const unmovable = new Set<string>()

export async function moveStoredPhotos(ownerDb: Db, storage: Storage, batch = 20) {
  const rows = await ownerDb
    .select({
      id: productPhoto.id,
      storeId: productPhoto.storeId,
      productId: productPhoto.productId,
      content: productPhoto.content,
    })
    .from(productPhoto)
    .where(
      and(
        isNull(productPhoto.objectKey),
        unmovable.size ? notInArray(productPhoto.id, [...unmovable]) : undefined,
      ),
    )
    .orderBy(asc(productPhoto.createdAt))
    .limit(batch)
  let moved = 0
  let failed = 0
  for (const row of rows) {
    if (!row.content) continue
    const folder = photoFolder(row.storeId, row.productId, row.id)
    try {
      const stored = await storePhoto(storage, folder, new Uint8Array(row.content))
      const done = await ownerDb
        .update(productPhoto)
        .set({
          objectKey: folder,
          sizeBytes: stored.sizeBytes,
          width: stored.width,
          height: stored.height,
          content: null,
        })
        .where(and(eq(productPhoto.id, row.id), isNull(productPhoto.objectKey)))
        .returning({ id: productPhoto.id })
      if (done.length === 0) await undoStored(storage, folder)
      else moved++
    } catch (error) {
      failed++
      // No se vuelve a probar hasta que el servidor arranque otra vez: no tapa a las demás.
      unmovable.add(row.id)
      console.error("gestoria-api: no se pudo pasar una foto al almacenamiento", row.id, error)
    }
  }
  return { moved, failed, more: rows.length === batch }
}

/** Borra del almacenamiento lo que la base anotó (`media_trash`), de a tantas carpetas. */
export async function emptyMediaTrash(ownerDb: Db, storage: Storage, batch = 50) {
  const rows = await ownerDb
    .select({ objectKey: mediaTrash.objectKey })
    .from(mediaTrash)
    .orderBy(asc(mediaTrash.createdAt))
    .limit(batch)
  let removed = 0
  for (const row of rows) {
    // Por si otra fila volvió a usar la carpeta (no pasa: cada una es de un id nuevo).
    const [inUse] = await ownerDb.execute<{ used: boolean }>(
      sql`select exists (select 1 from product_photo where object_key = ${row.objectKey})
        or exists (select 1 from product_video where object_key = ${row.objectKey})
        or exists (select 1 from bulk_load_photo where object_key = ${row.objectKey}) as used`,
    )
    try {
      if (!inUse?.used) await storage.removeFolder(row.objectKey)
      await ownerDb.delete(mediaTrash).where(eq(mediaTrash.objectKey, row.objectKey))
      removed++
    } catch (error) {
      console.error("gestoria-api: no se pudo borrar del almacenamiento", row.objectKey, error)
    }
  }
  return { removed, more: rows.length === batch }
}
