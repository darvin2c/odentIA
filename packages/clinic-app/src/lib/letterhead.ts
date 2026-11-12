/**
 * La hoja membretada de la clínica (ADR 0182), del lado del navegador: dibujarla para
 * medir dónde va el texto y recortar sus franjas, y hablar con la API. El PDF se dibuja
 * con pdf.js, que se carga solo al abrir el cajón (y no entra al servidor:
 * `clinicAppWorkerStubs`); el servidor vuelve a leer y normaliza todo lo que recibe.
 */
import {
  clampLetterheadMargins,
  halfMm,
  type LetterheadMargins,
  letterheadImagePage,
  PT_PER_MM,
} from "@odentia/clinical"
import type { ApiErrorShape } from "@odentia/ui-patterns"
import { ApiError, apiFetch, apiFetchBytes } from "./api"
import { API_URL } from "./auth-client"
import { orgSlugFromHostname } from "./host"

const MM_PER_PT = 1 / PT_PER_MM
/** El ancho al que se dibuja para medir y recortar: unas 150 ppp en una A4. */
const RENDER_WIDTH_PX = 1240
/** Sin diseño a un lado, lo de siempre de los papeles (54 pt a los costados, 15 mm arriba, 8,5 abajo). */
const DEFAULT_MARGINS = { topMm: 15, bottomMm: 12, leftMm: 19, rightMm: 19 }
/** Lo que se deja entre su diseño y el texto. */
const GAP_MM = 7
/** Un hueco así de alto sin tinta separa su diseño del resto. */
const BLANK_RUN_MM = 10
/** Más claro que esto es marca de agua: el texto puede ir encima. */
const INK_LUMINANCE = 0.8

export type { LetterheadMargins }

export interface LetterheadSummary extends LetterheadMargins {
  id: string
  topBandUrl: string
  bottomBandUrl: string
  thumbnailUrl: string
  pageWidthPt: number
  pageHeightPt: number
  hasContact: boolean
  fileName: string
  createdAt: string
}

export interface LetterheadState {
  letterhead: LetterheadSummary | null
  /** Lo que el papel agregaría bajo su diseño, y cuántas sedes tiene la clínica. */
  contact: { line: string | null; branches: number }
}

export interface LetterheadPreview {
  pdf: string
  pages: number
  lowResolution: boolean
  paper: "A4" | "Letter" | null
  margins: LetterheadMargins
  /** Quién firma la receta de ejemplo: otro profesional del equipo, si hay. */
  signer: string | null
}

/** La hoja dibujada en el navegador: su primera página y su tamaño en puntos. */
export interface RenderedLetterhead {
  canvas: HTMLCanvasElement
  widthPt: number
  heightPt: number
}

async function pdfjs() {
  const lib = await import("pdfjs-dist")
  if (!lib.GlobalWorkerOptions.workerSrc) {
    const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url")
    lib.GlobalWorkerOptions.workerSrc = worker.default
  }
  return lib
}

/** La primera página de un PDF dibujada a ese ancho, sobre blanco. */
async function drawPdf(
  bytes: ArrayBuffer,
  widthPx: number,
): Promise<RenderedLetterhead & { pages: number }> {
  const lib = await pdfjs()
  // pdf.js 6 ya no evalúa código de las fuentes; sin XFA, solo se dibuja la página.
  const task = lib.getDocument({ data: new Uint8Array(bytes), enableXfa: false })
  const doc = await task.promise
  try {
    const page = await doc.getPage(1)
    const base = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({ scale: widthPx / base.width })
    const canvas = document.createElement("canvas")
    canvas.width = Math.round(viewport.width)
    canvas.height = Math.round(viewport.height)
    const context = canvas.getContext("2d")
    if (!context) throw new Error("Sin lienzo")
    context.fillStyle = "#ffffff"
    context.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: context, viewport, canvas }).promise
    return { canvas, widthPt: base.width, heightPt: base.height, pages: doc.numPages }
  } finally {
    void task.destroy()
  }
}

/** Una imagen como la toma el servidor: A4 o Carta si tiene su forma, si no del ancho de una A4. */
async function drawImage(file: Blob): Promise<RenderedLetterhead> {
  const bitmap = await createImageBitmap(file)
  const ratio = bitmap.height / bitmap.width
  const size = letterheadImagePage(bitmap.width, bitmap.height)
  const canvas = document.createElement("canvas")
  canvas.width = RENDER_WIDTH_PX
  canvas.height = Math.round(RENDER_WIDTH_PX * ratio)
  const context = canvas.getContext("2d")
  if (!context) throw new Error("Sin lienzo")
  context.fillStyle = "#ffffff"
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return { canvas, widthPt: size.width, heightPt: size.height }
}

/** Dibuja la hoja elegida (PDF, PNG o JPG) para medirla y recortar sus franjas. */
export async function renderLetterhead(file: Blob): Promise<RenderedLetterhead> {
  const head = new Uint8Array(await file.slice(0, 5).arrayBuffer())
  const isPdf = String.fromCharCode(...head) === "%PDF-"
  return isPdf ? drawPdf(await file.arrayBuffer(), RENDER_WIDTH_PX) : drawImage(file)
}

/** Lo que llega en base64 (la vista previa del servidor), como bytes. */
export function base64ToBytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
}

/** Un PDF (la vista previa que arma el servidor) como imagen, con su alto entre su ancho. */
export async function pdfPageImage(
  base64: string,
  widthPx: number,
): Promise<{ image: string; aspect: number; pages: number }> {
  const { canvas, pages } = await drawPdf(base64ToBytes(base64).buffer as ArrayBuffer, widthPx)
  return { image: canvas.toDataURL("image/png"), aspect: canvas.height / canvas.width, pages }
}

/**
 * Dónde va el texto, por su dibujo: arriba, el diseño termina donde aparece un hueco
 * sin tinta de 10 mm; abajo, igual desde el borde. A los costados, una franja que
 * baja por casi todo el alto. Lo claro (una marca de agua) no cuenta: el texto va encima.
 */
export function detectMargins({
  canvas,
  widthPt,
  heightPt,
}: RenderedLetterhead): LetterheadMargins {
  const context = canvas.getContext("2d")
  if (!context) return DEFAULT_MARGINS
  const { width, height } = canvas
  const data = context.getImageData(0, 0, width, height).data
  const mmPerPx = (heightPt * MM_PER_PT) / height
  const ink = (x: number, y: number) => {
    const i = (y * width + x) * 4
    return (0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) / 255 < INK_LUMINANCE
  }
  const rowHasInk = (y: number) => {
    let count = 0
    for (let x = 0; x < width; x += 2) if (ink(x, y) && ++count > 2) return true
    return false
  }
  const blankRun = Math.round(BLANK_RUN_MM / mmPerPx)
  /** Desde un borde hacia adentro, hasta `limit` filas: la última fila con tinta antes del hueco. */
  const designEdge = (rows: number[]): number | null => {
    let last: number | null = null
    let blank = 0
    for (const y of rows) {
      if (rowHasInk(y)) {
        last = y
        blank = 0
      } else if (last !== null && ++blank >= blankRun) break
    }
    return last
  }
  const topRows = Array.from({ length: Math.floor(height * 0.45) }, (_, y) => y)
  const bottomRows = Array.from({ length: Math.floor(height * 0.4) }, (_, i) => height - 1 - i)
  const topInk = designEdge(topRows)
  const bottomInk = designEdge(bottomRows)
  const topMm = topInk === null ? DEFAULT_MARGINS.topMm : (topInk + 1) * mmPerPx + GAP_MM
  const bottomMm =
    bottomInk === null ? DEFAULT_MARGINS.bottomMm : (height - bottomInk) * mmPerPx + GAP_MM
  // A los costados, solo entre su diseño de arriba y el de abajo.
  const fromY = Math.min(height - 1, Math.round(topMm / mmPerPx))
  const toY = Math.max(fromY + 1, height - Math.round(bottomMm / mmPerPx))
  const columnBand = (x: number) => {
    let count = 0
    let seen = 0
    for (let y = fromY; y < toY; y += 4) {
      seen++
      if (ink(x, y)) count++
    }
    return seen > 0 && count / seen > 0.6
  }
  const sideEdge = (columns: number[]): number | null => {
    let last: number | null = null
    for (const x of columns) if (columnBand(x)) last = x
    return last
  }
  const mmPerPxX = (widthPt * MM_PER_PT) / width
  const leftInk = sideEdge(Array.from({ length: Math.floor(width * 0.3) }, (_, x) => x))
  const rightInk = sideEdge(
    Array.from({ length: Math.floor(width * 0.3) }, (_, i) => width - 1 - i),
  )
  const leftMm = Math.max(
    DEFAULT_MARGINS.leftMm,
    leftInk === null ? 0 : (leftInk + 1) * mmPerPxX + GAP_MM,
  )
  const rightMm = Math.max(
    DEFAULT_MARGINS.rightMm,
    rightInk === null ? 0 : (width - rightInk) * mmPerPxX + GAP_MM,
  )
  const half = (value: number) => Math.round(value * 2) / 2
  return {
    topMm: half(topMm),
    bottomMm: half(bottomMm),
    leftMm: half(leftMm),
    rightMm: half(rightMm),
  }
}

/**
 * Dónde va el texto como lo guardará el servidor (`clampLetterheadMargins`): al menos
 * 5 mm desde cada borde, y tres cuartos del ancho y el 60 % del alto siempre para el texto.
 * Con esto se dibuja el recuadro y se recortan las franjas, para que coincidan con el papel.
 */
export function clampMargins(
  page: { widthPt: number; heightPt: number },
  margins: LetterheadMargins,
): LetterheadMargins {
  return clampLetterheadMargins(page, margins)
}

function toPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Sin imagen"))), "image/png"),
  )
}

function crop(
  source: HTMLCanvasElement,
  y: number,
  height: number,
  width = source.width,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas")
  const scale = width / source.width
  canvas.width = width
  canvas.height = Math.max(1, Math.round(height * scale))
  const context = canvas.getContext("2d")
  context?.drawImage(source, 0, y, source.width, height, 0, 0, canvas.width, canvas.height)
  return canvas
}

/** Su parte de arriba y la de abajo (lo que queda fuera del texto) y una miniatura, en PNG. */
export async function letterheadImages(rendered: RenderedLetterhead, margins: LetterheadMargins) {
  const { canvas, heightPt } = rendered
  const pxPerMm = canvas.height / (heightPt * MM_PER_PT)
  const topPx = Math.min(canvas.height, Math.max(1, Math.round(margins.topMm * pxPerMm)))
  const bottomPx = Math.min(canvas.height, Math.max(1, Math.round(margins.bottomMm * pxPerMm)))
  const [topBand, bottomBand, thumbnail] = await Promise.all([
    toPng(crop(canvas, 0, topPx)),
    toPng(crop(canvas, canvas.height - bottomPx, bottomPx)),
    toPng(crop(canvas, 0, canvas.height, 240)),
  ])
  return { topBand, bottomBand, thumbnail }
}

/** Lo que el servidor rechazó, con su campo, como los demás errores de la API. */
async function send<T>(path: string, init: RequestInit): Promise<T> {
  const slug = typeof window === "undefined" ? null : orgSlugFromHostname(window.location.hostname)
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: { ...(slug ? { "x-odentia-org": slug } : {}), ...init.headers },
  })
  if (!response.ok) {
    let shape: ApiErrorShape = {}
    try {
      shape = ((await response.json()) as { error?: ApiErrorShape }).error ?? {}
    } catch {
      shape = {}
    }
    throw new ApiError(response.status, shape)
  }
  return ((await response.json()) as { data: T }).data
}

function marginsForm(margins: LetterheadMargins, hasContact: boolean): FormData {
  const form = new FormData()
  for (const [key, value] of Object.entries(margins)) form.append(key, String(value))
  form.append("hasContact", String(hasContact))
  return form
}

export const LETTERHEAD_QUERY_KEY = ["org-letterhead"] as const

export function getLetterhead(): Promise<LetterheadState> {
  return apiFetch<{ data: LetterheadState }>("/api/org-profile/letterhead").then(
    (body) => body.data,
  )
}

/** El PDF de la hoja de hoy, para volver a abrirla sin subirla. */
export async function getLetterheadPdf(): Promise<Blob> {
  return new Blob([await apiFetchBytes("/api/org-profile/letterhead/pdf")], {
    type: "application/pdf",
  })
}

/**
 * La receta de ejemplo sobre la hoja: la elegida o, sin `file`, la que se abrió
 * (`current`): si otra persona la cambió o la quitó, el servidor lo dice.
 */
export function previewLetterhead(
  file: File | null,
  margins: LetterheadMargins,
  hasContact: boolean,
  current: string | null,
): Promise<LetterheadPreview> {
  const form = marginsForm(margins, hasContact)
  if (file) form.append("file", file)
  else if (current) form.append("current", current)
  return send<LetterheadPreview>("/api/org-profile/letterhead/preview", {
    method: "POST",
    body: form,
  })
}

/** Guarda la hoja: nueva (`file`) o la de hoy con otros márgenes o casilla. */
export function saveLetterhead(input: {
  file: File | null
  /** La hoja que se tenía a la vista al abrir (su id), o «none»: si otra persona la cambió, no se pisa. */
  current: string
  margins: LetterheadMargins
  hasContact: boolean
  images: { topBand: Blob; bottomBand: Blob; thumbnail: Blob }
}): Promise<{ letterhead: LetterheadSummary }> {
  const form = marginsForm(input.margins, input.hasContact)
  form.append("current", input.current)
  if (input.file) form.append("file", input.file)
  form.append("topBand", input.images.topBand, "arriba.png")
  form.append("bottomBand", input.images.bottomBand, "abajo.png")
  form.append("thumbnail", input.images.thumbnail, "miniatura.png")
  return send("/api/org-profile/letterhead", { method: "PUT", body: form })
}

/** Quita la hoja que se tiene a la vista (`current`): si otra persona la cambió, no la quita. */
export function removeLetterhead(current: string): Promise<{ removedId: string | null }> {
  return apiFetch<{ data: { removedId: string | null } }>(
    `/api/org-profile/letterhead?current=${encodeURIComponent(current)}`,
    { method: "DELETE" },
  ).then((body) => body.data)
}

export function restoreLetterhead(id: string): Promise<{ letterhead: LetterheadSummary }> {
  return apiFetch<{ data: { letterhead: LetterheadSummary } }>(
    "/api/org-profile/letterhead/restore",
    {
      method: "POST",
      body: JSON.stringify({ id }),
    },
  ).then((body) => body.data)
}
