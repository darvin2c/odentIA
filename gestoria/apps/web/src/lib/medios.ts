import { useQuery } from "@tanstack/react-query"
import { api } from "./api"

/**
 * Las fotos y los videos del producto en la pantalla (ADR 0236). El servidor da enlaces firmados
 * que vencen a los 10 minutos: la lista se vuelve a pedir antes. Aquí también se prepara lo que se
 * sube: la foto se achica en el navegador y el video se pasa a lo que acepta WhatsApp (MP4 con
 * H.264 Main sin cuadros B, AAC y el índice al principio), con Mediabunny sobre WebCodecs.
 */

export interface MediaPhoto {
  id: string
  position: number
  colorId: string | null
  colorMain: boolean
  width: number | null
  height: number | null
  cutout: "propuesta" | "usada" | null
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

export interface ProductMedia {
  photos: MediaPhoto[]
  videos: MediaVideo[]
  expiresAt: string
}

export const MEDIA_KEY = (storeId: string, productId: string) => ["medios", storeId, productId]

/** Las fotos y los videos con sus enlaces; se renuevan antes de que venzan. */
export function useProductMedia(storeId: string, productId: string) {
  return useQuery({
    queryKey: MEDIA_KEY(storeId, productId),
    queryFn: () => api<ProductMedia>(`/api/tiendas/${storeId}/productos/${productId}/medios`),
    staleTime: 4 * 60_000,
    refetchInterval: 8 * 60_000,
  })
}

/** Lo que el servidor dice cuando no hay dónde guardar fotos ni videos. */
export const MEDIA_OFF = "MEDIA_OFF"

/** Lo más que se sube: lo mismo que acepta el servidor. */
export const MAX_PHOTOS = 8
export const MAX_VIDEO_BYTES = 16_000_000
export const MAX_VIDEO_SECONDS = 30

export const isVideoFile = (file: File) =>
  file.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|3gp)$/i.test(file.name)
export const isImageFile = (file: File) =>
  file.type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)

/**
 * Achica una foto antes de subirla: hasta 2400 px por lado y en JPEG (la original que guarda la
 * tienda; el servidor arma las copias). La foto que ya es chica y JPEG se sube como está.
 */
export async function preparePhoto(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error(
      "No pudimos abrir esa foto. Prueba con una en JPG, PNG o WebP (las del iPhone: en «Más compatible»).",
    )
  })
  const longest = Math.max(bitmap.width, bitmap.height)
  if (longest <= 2400 && file.size <= 3_000_000 && /image\/(jpeg|png|webp)/.test(file.type)) {
    bitmap.close()
    return file
  }
  const scale = Math.min(1, 2400 / longest)
  const canvas = document.createElement("canvas")
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.88),
  )
  if (!blob) throw new Error("No se pudo preparar la foto. Prueba con otra.")
  return blob
}

export interface PreparedVideo {
  video: Blob
  poster: Blob
  durationMs: number
}

/** Un mensaje para la persona: el video no se pudo preparar, y qué hacer. */
export class VideoProblem extends Error {}

/**
 * Pasa un video a lo que acepta WhatsApp: hasta 720 px por lado, H.264 Main (sin cuadros B),
 * AAC y el índice al principio, por debajo de 16 MB. Devuelve también el póster (el primer
 * cuadro). Sin WebCodecs no se puede: se dice y se deja seguir con las fotos.
 */
export async function prepareVideo(
  file: File,
  onProgress?: (part: number) => void,
): Promise<PreparedVideo> {
  if (typeof VideoEncoder === "undefined")
    throw new VideoProblem(
      "Este navegador no puede preparar videos. Prueba desde Chrome, Edge o Safari al día.",
    )
  const mb = await import("mediabunny")
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new VideoProblem("No encontramos el video en ese archivo.")
    const seconds = await input.computeDuration()
    if (seconds > MAX_VIDEO_SECONDS + 0.5)
      throw new VideoProblem(
        `El video dura ${Math.round(seconds)} segundos: hasta ${MAX_VIDEO_SECONDS}. Recórtalo en el celular y vuelve a subirlo.`,
      )
    const scale = Math.min(1, 720 / Math.max(track.displayWidth, track.displayHeight))
    const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2)
    const width = even(track.displayWidth)
    const height = even(track.displayHeight)
    if (!(await mb.canEncodeVideo("avc", { width, height })))
      throw new VideoProblem(
        "Este navegador no puede preparar videos para WhatsApp. Prueba desde Chrome o Edge.",
      )
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext("2d")
    if (!context) throw new VideoProblem("No se pudo preparar el video. Prueba con otro.")
    const output = new mb.Output({
      format: new mb.Mp4OutputFormat({ fastStart: "in-memory" }),
      target: new mb.BufferTarget(),
    })
    // H.264 Main 3.1 (`avc1.4d401f`): lo que WhatsApp muestra también en Android.
    const videoSource = new mb.CanvasSource(canvas, {
      codec: "avc",
      fullCodecString: "avc1.4d401f",
      bitrate: 1_600_000,
      keyFrameInterval: 2,
    })
    output.addVideoTrack(videoSource, { frameRate: 30 })
    const audioTrack = await input.getPrimaryAudioTrack()
    const withAudio = audioTrack !== null && (await mb.canEncodeAudio("aac"))
    const audioSource = withAudio
      ? new mb.AudioSampleSource({ codec: "aac", bitrate: 96_000 })
      : null
    if (audioSource) output.addAudioTrack(audioSource)
    await output.start()

    let poster: Blob | null = null
    const video = (async () => {
      for await (const sample of new mb.VideoSampleSink(track).samples()) {
        context.fillStyle = "#000"
        context.fillRect(0, 0, width, height)
        sample.drawWithFit(context, { fit: "contain" })
        if (!poster)
          poster = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob(resolve, "image/jpeg", 0.85),
          )
        await videoSource.add(sample.timestamp, sample.duration)
        onProgress?.(Math.min(0.99, sample.timestamp / Math.max(0.1, seconds)))
        sample.close()
      }
      videoSource.close()
    })()
    const audio = (async () => {
      if (!audioTrack || !audioSource) return
      for await (const sample of new mb.AudioSampleSink(audioTrack).samples()) {
        await audioSource.add(sample)
        sample.close()
      }
      audioSource.close()
    })()
    await Promise.all([video, audio])
    await output.finalize()
    const buffer = (output.target as InstanceType<typeof mb.BufferTarget>).buffer
    if (!buffer || !poster) throw new VideoProblem("No se pudo preparar el video. Prueba con otro.")
    if (buffer.byteLength > MAX_VIDEO_BYTES)
      throw new VideoProblem(
        "Aun achicado, el video pesa más de 16 MB, lo que acepta WhatsApp. Prueba con uno más corto.",
      )
    onProgress?.(1)
    return {
      video: new Blob([buffer], { type: "video/mp4" }),
      poster,
      durationMs: Math.round(seconds * 1000),
    }
  } catch (error) {
    if (error instanceof VideoProblem) throw error
    throw new VideoProblem(
      "No pudimos leer ese video. Prueba con uno grabado con la cámara del celular.",
    )
  } finally {
    input.dispose?.()
  }
}

/** «0:12»: cuánto dura un video. */
export function duration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

/** Mueve un elemento de una lista a otra posición. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item as T)
  return next
}
