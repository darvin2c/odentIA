import { useSyncExternalStore } from "react"
import { ApiError, apiFetch } from "./api"
import { API_URL } from "./auth-client"
import { occlusalSample } from "./cbct-arch"
import type { WindowLevel } from "./cbct-volume"
import { decodeDicom, openDicom, renderDicom } from "./dicom"
import { orgSlugFromHostname, requestHostname } from "./host"
import type { ScannedDicom, StudyCandidate } from "./imaging-scan"

/**
 * Cola de subida de tomografías (ADR 0055). Vive fuera de la pantalla: cerrar
 * la ventana de subida o cambiar de página no la detiene, y si se corta
 * internet espera a que vuelva y sigue donde quedó. Cada archivo va directo
 * al almacenamiento con su URL firmada; la API comprueba lo recibido por
 * tandas y da la tomografía por completa cuando llegaron todos.
 */

export type UploadStatus = "subiendo" | "sin_conexion" | "error" | "lista" | "cancelada"

export interface UploadJob {
  documentId: string
  patientId: string
  label: string
  fileCount: number
  uploadedCount: number
  totalBytes: number
  sentBytes: number
  status: UploadStatus
  /** Qué pasó, en palabras, cuando no pudo seguir. */
  error: string | null
  /** Archivos que la ficha espera y no estaban en lo elegido. */
  missing: number
}

export interface StartUploadInput {
  patientId: string
  candidate: StudyCandidate
  label: string
  capturedAt: string | null
  source: string | null
  toothNumbers: number[]
  /** Se llama cuando la ficha debe volver a leer sus documentos. */
  onChange?: () => void
}

export type StartUploadResult =
  | { state: "exists"; documentId: string }
  | { state: "new" | "resumed"; documentId: string }

interface StartResponse {
  data: {
    state: "new" | "resumed" | "exists"
    document: { id: string }
    files: { index: number; sopInstanceUid: string }[]
    pending: number[]
    targets: { index: number; url: string }[]
  }
}

interface ConfirmResponse {
  data: {
    fileCount: number
    uploadedCount: number
    completedAt: string | null
    rejected: { index: number; problem: "missing" | "size" | "not_dicom" }[]
  }
}

const CONCURRENCY = 4
const CONFIRM_EVERY = 25
const MAX_ATTEMPTS = 5

const jobs = new Map<string, UploadJob>()
const controllers = new Map<string, AbortController>()
const listeners = new Set<() => void>()
let snapshot: UploadJob[] = []

function emit() {
  snapshot = [...jobs.values()]
  for (const listener of listeners) listener()
  syncUnloadGuard()
}

function patch(documentId: string, change: Partial<UploadJob>) {
  const job = jobs.get(documentId)
  if (!job) return
  jobs.set(documentId, { ...job, ...change })
  emit()
}

function onBeforeUnload(event: BeforeUnloadEvent) {
  event.preventDefault()
}
let guarding = false
function syncUnloadGuard() {
  if (typeof window === "undefined") return
  const active = [...jobs.values()].some((job) => job.status === "subiendo" || job.status === "sin_conexion")
  if (active && !guarding) window.addEventListener("beforeunload", onBeforeUnload)
  if (!active && guarding) window.removeEventListener("beforeunload", onBeforeUnload)
  guarding = active
}

/** Las subidas en curso (de un paciente o de todos). */
export function useImagingUploads(patientId?: string): UploadJob[] {
  const all = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => snapshot,
    () => snapshot,
  )
  return patientId ? all.filter((job) => job.patientId === patientId) : all
}

export function uploadJob(documentId: string): UploadJob | undefined {
  return jobs.get(documentId)
}

function waitForOnline(signal: AbortSignal): Promise<void> {
  if (navigator.onLine) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      window.removeEventListener("online", done)
      signal.removeEventListener("abort", done)
      resolve()
    }
    window.addEventListener("online", done)
    signal.addEventListener("abort", done)
  })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** PUT directo al bucket; informa los bytes enviados. Rechaza con el estado HTTP (0 = red). */
function put(url: string, file: Blob, signal: AbortSignal, onBytes: (sent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("PUT", url)
    xhr.setRequestHeader("Content-Type", "application/dicom")
    xhr.upload.onprogress = (event) => onBytes(event.loaded)
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(xhr.status))
    xhr.onerror = () => reject(0)
    xhr.onabort = () => reject(-1)
    signal.addEventListener("abort", () => xhr.abort(), { once: true })
    xhr.send(file)
  })
}

/** Enlace de descarga del ZIP; `?org=` porque un enlace no envía la cabecera de la clínica. */
export function tomographyDownloadUrl(patientId: string, documentId: string): string {
  const slug = orgSlugFromHostname(requestHostname()) ?? ""
  return `${API_URL}/api/patients/${patientId}/imaging/studies/${documentId}/download?org=${encodeURIComponent(slug)}`
}

const base = (patientId: string, documentId: string) =>
  `/api/patients/${patientId}/imaging/uploads/${documentId}`

async function run(
  job: UploadJob,
  files: Map<number, ScannedDicom>,
  urls: Map<number, string>,
  pending: number[],
  candidate: StudyCandidate,
  onChange?: () => void,
) {
  const { documentId, patientId } = job
  const controller = new AbortController()
  controllers.set(documentId, controller)
  const { signal } = controller
  const queue = pending.filter((index) => files.has(index))
  const missing = pending.length - queue.length
  const sentByIndex = new Map<number, number>()
  let sentDone = 0
  const toConfirm: number[] = []
  const retried = new Set<number>()
  let failure: string | null = null
  // Lee archivos locales, así que no espera a la subida.
  const thumbnail = thumbnailBlob(candidate)

  const updateBytes = () => {
    let partial = 0
    for (const sent of sentByIndex.values()) partial += sent
    patch(documentId, { sentBytes: Math.min(job.totalBytes, sentDone + partial) })
  }

  const confirm = async (force = false) => {
    if (!toConfirm.length || (!force && toConfirm.length < CONFIRM_EVERY)) return
    const indexes = toConfirm.splice(0, 500)
    const { data } = await apiFetch<ConfirmResponse>(`${base(patientId, documentId)}/confirm`, {
      method: "POST",
      body: JSON.stringify({ indexes }),
    })
    patch(documentId, { uploadedCount: data.uploadedCount })
    for (const { index } of data.rejected) {
      // Lo que no llegó bien se vuelve a subir una vez; si se repite, se avisa.
      if (retried.has(index)) failure = "Algunos archivos no llegaron completos al almacenamiento."
      else {
        retried.add(index)
        queue.push(index)
      }
    }
    if (data.completedAt) {
      // La miniatura se armó mientras subían los archivos y se guarda antes de
      // decir «lista»: quien cierra la ventana en ese momento no la pierde.
      await saveThumbnail(patientId, documentId, await thumbnail)
      patch(documentId, { status: "lista", uploadedCount: data.fileCount, sentBytes: job.totalBytes })
      onChange?.()
    }
  }

  const sign = async (index: number) => {
    const wanted = [index, ...queue.filter((i) => !urls.has(i))].slice(0, 500)
    const { data } = await apiFetch<{ data: { index: number; url: string }[] }>(
      `${base(patientId, documentId)}/sign`,
      { method: "POST", body: JSON.stringify({ indexes: wanted }) },
    )
    for (const target of data) urls.set(target.index, target.url)
  }

  const worker = async () => {
    while (queue.length && !signal.aborted && !failure) {
      const index = queue.shift()!
      const file = files.get(index)!
      for (let attempt = 1; ; attempt++) {
        if (signal.aborted) return
        try {
          if (!urls.has(index)) await sign(index)
          await put(urls.get(index)!, file.file, signal, (sent) => {
            sentByIndex.set(index, sent)
            updateBytes()
          })
          sentByIndex.delete(index)
          sentDone += file.size
          toConfirm.push(index)
          await confirm()
          break
        } catch (error) {
          sentByIndex.delete(index)
          if (error === -1 || signal.aborted) return
          if (error === 403) urls.delete(index) // la firma venció: se pide otra
          if (!navigator.onLine) {
            patch(documentId, { status: "sin_conexion" })
            await waitForOnline(signal)
            patch(documentId, { status: "subiendo" })
            attempt = 0
            continue
          }
          if (attempt >= MAX_ATTEMPTS) {
            failure =
              error instanceof ApiError
                ? (error.shape.message ?? "La ficha no aceptó la subida.")
                : "El almacenamiento no aceptó el archivo. Revisa la conexión y vuelve a intentarlo."
            return
          }
          await sleep(500 * 2 ** attempt)
        }
      }
    }
  }

  try {
    // Lo que se reintenta entra de nuevo a la cola: los trabajadores siguen mientras quede.
    while (queue.length && !signal.aborted && !failure) {
      await Promise.all(Array.from({ length: CONCURRENCY }, worker))
      await confirm(true)
    }
    if (!signal.aborted && !failure) await confirm(true)
  } catch (error) {
    failure = error instanceof ApiError ? (error.shape.message ?? "La ficha no aceptó la subida.") : "Se perdió la conexión con la ficha."
  } finally {
    controllers.delete(documentId)
  }
  const current = jobs.get(documentId)
  if (!current || current.status === "lista" || current.status === "cancelada") return
  if (failure) patch(documentId, { status: "error", error: failure })
  else if (missing > 0)
    patch(documentId, {
      status: "error",
      missing,
      error: `Faltan ${missing} ${missing === 1 ? "archivo" : "archivos"} que no estaban en lo elegido.`,
    })
  onChange?.()
}

/**
 * Empieza o retoma la subida de una tomografía. Si el mismo estudio ya está
 * completo en la ficha, no sube nada y devuelve ese documento.
 */
export async function startStudyUpload(input: StartUploadInput): Promise<StartUploadResult> {
  const { patientId, candidate } = input
  const { data } = await apiFetch<StartResponse>(`/api/patients/${patientId}/imaging/uploads`, {
    method: "POST",
    body: JSON.stringify({
      label: input.label,
      studyInstanceUid: candidate.studyInstanceUid,
      dicomPatientName: candidate.patientName,
      modality: candidate.modality,
      capturedAt: input.capturedAt,
      source: input.source,
      toothNumbers: input.toothNumbers,
      sliceCount: candidate.sliceCount,
      voxelMm: candidate.voxelMm,
      files: candidate.files.map((file) => ({
        sopInstanceUid: file.sopInstanceUid,
        seriesInstanceUid: file.seriesInstanceUid,
        sizeBytes: file.size,
      })),
    }),
  })
  const documentId = data.document.id
  if (data.state === "exists") return { state: "exists", documentId }
  if (controllers.has(documentId)) return { state: data.state, documentId }
  const bySop = new Map(candidate.files.map((file) => [file.sopInstanceUid, file]))
  const files = new Map<number, ScannedDicom>()
  for (const stored of data.files) {
    const file = bySop.get(stored.sopInstanceUid)
    if (file) files.set(stored.index, file)
  }
  const pendingSet = new Set(data.pending)
  const job: UploadJob = {
    documentId,
    patientId,
    label: input.label,
    fileCount: data.files.length,
    uploadedCount: data.files.length - data.pending.length,
    totalBytes: [...files.values()].reduce((n, f) => n + f.size, 0),
    sentBytes: [...files.entries()].reduce((n, [i, f]) => n + (pendingSet.has(i) ? 0 : f.size), 0),
    status: "subiendo",
    error: null,
    missing: 0,
  }
  jobs.set(documentId, job)
  emit()
  const urls = new Map(data.targets.map((target) => [target.index, target.url]))
  void run(job, files, urls, data.pending, candidate, input.onChange)
  return { state: data.state, documentId }
}

/** Cancela la subida: el documento se retira con su motivo y la cola se detiene. */
export async function cancelStudyUpload(patientId: string, documentId: string): Promise<void> {
  controllers.get(documentId)?.abort()
  await apiFetch(`${base(patientId, documentId)}/cancel`, { method: "POST", body: "{}" })
  patch(documentId, { status: "cancelada" })
  jobs.delete(documentId)
  emit()
}

/** Quita de la lista una subida que ya terminó o falló. */
export function dismissUploadJob(documentId: string) {
  if (controllers.has(documentId)) return
  jobs.delete(documentId)
  emit()
}

/** Cortes que se leen para elegir la miniatura. */
const THUMBNAIL_SAMPLES = 24

/**
 * Miniatura de la galería: entre 24 cortes repartidos en la serie mayor, el
 * que cruza los dientes, con el brillo «Hueso» del estudio (el que abre el
 * visor), en WebP de hasta 320 px. En color queda el corte del medio. Si el
 * navegador no puede leerlo, la tarjeta queda sin miniatura (null).
 */
async function thumbnailBlob(candidate: StudyCandidate): Promise<Blob | null> {
  try {
    const series = candidate.mainSeries
    if (!series.length) return null
    // Un archivo con todos los cuadros o un archivo por corte.
    const multiframe = series.length === 1 ? openDicom(await series[0]!.file.arrayBuffer()) : null
    const count = multiframe ? Math.max(1, series[0]!.frames) : series.length
    const n = Math.min(THUMBNAIL_SAMPLES, count)
    const picks = [...new Set(Array.from({ length: n }, (_, k) => Math.floor(((k + 0.5) * count) / n)))]
    const decode = async (at: number) =>
      multiframe ? multiframe.decode(at) : decodeDicom(await series[at]!.file.arrayBuffer())
    let chosen = picks[Math.floor(picks.length / 2)]!
    let brightness: WindowLevel | null = null
    const samples: Int16Array[] = []
    for (const at of picks) {
      const values = (await decode(at)).values
      if (!values) break
      samples.push(Int16Array.from(values, (v) => Math.max(-32768, Math.min(32767, Math.round(v)))))
    }
    const occlusal = samples.length === picks.length ? occlusalSample(samples) : null
    if (occlusal) {
      chosen = picks[occlusal.index]!
      brightness = occlusal.window
    }
    const image = await decode(chosen)
    const scale = Math.min(1, 320 / Math.max(image.width, image.height))
    const full = document.createElement("canvas")
    full.width = image.width
    full.height = image.height
    full.getContext("2d")?.putImageData(
      new ImageData(
        new Uint8ClampedArray(renderDicom(image, { ...(brightness ?? image.window), invert: false })),
        image.width,
        image.height,
      ),
      0,
      0,
    )
    const small = document.createElement("canvas")
    small.width = Math.max(1, Math.round(image.width * scale))
    small.height = Math.max(1, Math.round(image.height * scale))
    small.getContext("2d")?.drawImage(full, 0, 0, small.width, small.height)
    return await new Promise<Blob | null>((resolve) => small.toBlob(resolve, "image/webp", 0.82))
  } catch {
    return null
  }
}

async function saveThumbnail(patientId: string, documentId: string, blob: Blob | null) {
  if (!blob) return
  try {
    const form = new FormData()
    form.append("file", blob, "miniatura.webp")
    const slug = orgSlugFromHostname(window.location.hostname)
    await fetch(`${API_URL}${base(patientId, documentId)}/thumbnail`, {
      method: "PUT",
      credentials: "include",
      headers: slug ? { "x-odentia-org": slug } : {},
      body: form,
    })
  } catch {
    // Sin miniatura la tarjeta muestra el ícono de la tomografía.
  }
}
