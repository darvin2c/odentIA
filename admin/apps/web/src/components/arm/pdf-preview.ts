/**
 * Los PDF de la ficha (Documentos e informes de la carga, ADR 0196), del lado del navegador: se
 * piden a la API con la sesión (el almacenamiento no responde a la administración desde el
 * navegador) y pdf.js los dibuja en un lienzo, la primera página para la miniatura y cada una en
 * el visor. Nunca se abren como página: ni iframe, ni embed, ni object. pdf.js se carga solo al
 * dibujar el primero y no entra al servidor (`vite.config.ts`).
 */
import { API_URL } from "../../lib/auth-client"

type PdfLib = typeof import("pdfjs-dist")

let loading: Promise<PdfLib> | null = null

/** pdf.js con su worker, una sola vez. */
function pdfjs(): Promise<PdfLib> {
  loading ??= (async () => {
    const lib = await import("pdfjs-dist")
    if (!lib.GlobalWorkerOptions.workerSrc) {
      const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url")
      lib.GlobalWorkerOptions.workerSrc = worker.default
    }
    return lib
  })()
  loading.catch(() => {
    loading = null
  })
  return loading
}

/** Por qué no se pudo mostrar un PDF, para decirlo junto a «Descargar». */
export class PdfUnavailable extends Error {}

/** Los bytes de un PDF de la API (`/api/admin/...`), con la cookie de la sesión. */
/** Cuánto se espera un PDF antes de dejarlo: uno colgado no traba las miniaturas que siguen. */
const PDF_FETCH_TIMEOUT_MS = 20_000

export async function fetchPdfBytes(path: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const timeout = AbortSignal.timeout(PDF_FETCH_TIMEOUT_MS)
  const response = await fetch(`${API_URL}${path}`, {
    credentials: "include",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string }
    } | null
    throw new PdfUnavailable(body?.error?.message ?? "No se pudo traer el PDF")
  }
  return response.arrayBuffer()
}

/** Un PDF abierto: cuántas páginas tiene y cómo se dibuja una. */
export interface PdfDocument {
  pages: number
  /**
   * Dibuja la página (desde 1) a ese ancho en píxeles de pantalla, nítida en pantallas densas.
   * Devuelve su alto entre su ancho. Si se pide otra antes de terminar, la anterior se cancela.
   */
  render: (page: number, canvas: HTMLCanvasElement, widthPx: number) => Promise<number>
  destroy: () => void
}

/** Abre un PDF ya leído. Sin XFA: solo se dibujan sus páginas. */
export async function openPdf(bytes: ArrayBuffer): Promise<PdfDocument> {
  const lib = await pdfjs()
  const task = lib.getDocument({ data: new Uint8Array(bytes), enableXfa: false })
  const doc = await task.promise
  let current: { cancel: () => void } | null = null
  // Cada dibujo lleva su turno: si mientras esperaba su página se pidió otro, este no toca el
  // lienzo (dos dibujos a la vez sobre el mismo lienzo hacen fallar a pdf.js).
  let turn = 0
  const superseded = () => {
    const error = new Error("Se pidió otra página")
    error.name = "RenderingCancelledException"
    return error
  }
  return {
    pages: doc.numPages,
    render: async (number, canvas, widthPx) => {
      const mine = ++turn
      current?.cancel()
      const page = await doc.getPage(Math.min(Math.max(1, number), doc.numPages))
      if (mine !== turn) throw superseded()
      const base = page.getViewport({ scale: 1 })
      const ratio = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3)
      const viewport = page.getViewport({ scale: (widthPx * ratio) / base.width })
      canvas.width = Math.round(viewport.width)
      canvas.height = Math.round(viewport.height)
      const context = canvas.getContext("2d")
      if (!context) throw new PdfUnavailable("Este navegador no puede dibujar el PDF")
      context.fillStyle = "#ffffff"
      context.fillRect(0, 0, canvas.width, canvas.height)
      const rendering = page.render({ canvasContext: context, viewport, canvas })
      current = rendering
      try {
        await rendering.promise
      } finally {
        if (current === rendering) current = null
      }
      return base.height / base.width
    },
    destroy: () => {
      current?.cancel()
      void task.destroy()
    },
  }
}

/** Las miniaturas ya dibujadas en esta pestaña: volver a Documentos no vuelve a pedirlas. */
const thumbs = new Map<string, Promise<string>>()
/** Una a la vez: una ficha con muchos PDF no pide todos a la vez. */
let queue: Promise<unknown> = Promise.resolve()

/** La primera página de un PDF de la API como imagen, a ese ancho (la miniatura de Documentos). */
export function pdfThumbnail(path: string, widthPx = 320): Promise<string> {
  const key = `${path}|${widthPx}`
  const known = thumbs.get(key)
  if (known) return known
  const made = queue.then(async () => {
    const doc = await openPdf(await fetchPdfBytes(path))
    try {
      const canvas = document.createElement("canvas")
      await doc.render(1, canvas, widthPx)
      return canvas.toDataURL("image/png")
    } finally {
      doc.destroy()
    }
  })
  queue = made.catch(() => {})
  thumbs.set(key, made)
  made.catch(() => thumbs.delete(key))
  return made
}
