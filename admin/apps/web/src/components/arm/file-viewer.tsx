/**
 * Ver un documento del cliente sin descargarlo (ADR 0196): la imagen entera, el PDF dibujado
 * página por página con pdf.js y, lo demás, su ícono y su nombre. Nunca lo abre como página dentro
 * de la administración (ni iframe, ni embed, ni object). Dentro del visor, «Descargar», «Es la
 * carga de datos» (Administración, en lo que llegó por correo o por un chat) y «Borrar»
 * (Administración). Es un visor ancho: va siempre en cajón, nunca en la columna lateral.
 */
import { Button, cn, Skeleton, toast } from "@odentia/ui"
import { ConfirmDialog, DetailDrawer, submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  ChevronLeft,
  ChevronRight,
  Download,
  File,
  FileImage,
  FileSpreadsheet,
  FileText,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { api } from "../../lib/api"
import { supportDay } from "../../lib/support-words"
import {
  type ClientFile,
  clientFileContentPath,
  clientFileHref,
  clientFilePreviewHref,
  deleteOnWords,
  FILE_KIND_WORDS,
  fileDay,
  previewKindOf,
  sizeWords,
  useClientFiles,
  useMarkCarga,
  whoWords,
} from "./client-file-model"
import { invalidateClient } from "./client-model"
import {
  fetchPdfBytes,
  openPdf,
  type PdfDocument,
  PdfUnavailable,
  pdfThumbnail,
} from "./pdf-preview"

/** El visor mide más que la columna lateral: hasta 56rem en el escritorio. */
const VIEWER_WIDTH = "data-[swipe-axis=x]:sm:[--drawer-content-width:min(56rem,calc(100vw-2rem))]"

/** El ícono de un archivo sin vista, por su tipo. */
export function FileTypeIcon({
  contentType,
  className,
}: {
  contentType: string
  className?: string
}) {
  const type = contentType.toLowerCase()
  const Icon =
    type === "application/pdf" || type.includes("word")
      ? FileText
      : type.startsWith("image/")
        ? FileImage
        : type.includes("sheet") || type.includes("csv") || type.includes("excel")
          ? FileSpreadsheet
          : File
  return <Icon aria-hidden className={cn("size-8 text-muted-foreground", className)} />
}

/** pdf.js avisa así que una página dejó de dibujarse porque se pidió otra: no es un error. */
const isCancelled = (failure: unknown) =>
  (failure as { name?: string } | null)?.name === "RenderingCancelledException"

/**
 * Un PDF de la API dibujado página por página, al ancho de su caja, con «Página anterior» y
 * «Página siguiente». Lo usan el visor de Documentos y el cajón de un informe.
 */
export function PdfPages({ path, title }: { path: string; title: string }) {
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [doc, setDoc] = useState<PdfDocument | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [drawing, setDrawing] = useState(false)

  useEffect(() => {
    const abort = new AbortController()
    let opened: PdfDocument | null = null
    setDoc(null)
    setError(null)
    setPage(1)
    fetchPdfBytes(path, abort.signal)
      .then(openPdf)
      .then((next) => {
        if (abort.signal.aborted) next.destroy()
        else {
          opened = next
          setDoc(next)
        }
      })
      .catch((failure: unknown) => {
        if (abort.signal.aborted) return
        setError(
          failure instanceof PdfUnavailable
            ? failure.message
            : "No se pudo dibujar el PDF: descárgalo para verlo",
        )
      })
    return () => {
      abort.abort()
      opened?.destroy()
    }
  }, [path])

  useEffect(() => {
    const target = canvas.current
    if (!doc || !target) return
    let live = true
    setDrawing(true)
    doc
      .render(page, target, box.current?.clientWidth || 600)
      .catch((failure: unknown) => {
        if (live && !isCancelled(failure)) setError("No se pudo dibujar esta página")
      })
      .finally(() => {
        if (live) setDrawing(false)
      })
    return () => {
      live = false
    }
  }, [doc, page])

  if (error)
    return (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    )
  const pages = doc?.pages ?? 0
  return (
    <div className="flex flex-col gap-3">
      <div
        ref={box}
        className="relative min-h-40 overflow-hidden rounded-md border bg-white"
        aria-busy={!doc || drawing}
      >
        {doc ? null : <Skeleton className="absolute inset-0 rounded-none" />}
        <canvas
          ref={canvas}
          role="img"
          aria-label={doc ? `${title}, página ${page} de ${pages}` : `${title}, cargando`}
          className="block h-auto w-full"
        />
      </div>
      {pages > 1 ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            <ChevronLeft aria-hidden />
            Página anterior
          </Button>
          <span className="text-sm text-muted-foreground tabular-nums" aria-live="polite">
            Página {page} de {pages}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page >= pages}
            onClick={() => setPage((current) => Math.min(pages, current + 1))}
          >
            Página siguiente
            <ChevronRight aria-hidden />
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/** La primera página de un PDF como miniatura, cuando se acerca a la vista. */
export function PdfThumb({ path, contentType }: { path: string; contentType: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    let live = true
    const start = () =>
      pdfThumbnail(path).then(
        (url) => live && setSrc(url),
        () => live && setFailed(true),
      )
    if (typeof IntersectionObserver === "undefined") {
      void start()
      return () => {
        live = false
      }
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        observer.disconnect()
        void start()
      },
      { rootMargin: "200px" },
    )
    observer.observe(node)
    return () => {
      live = false
      observer.disconnect()
    }
  }, [path])
  return (
    <div ref={ref} className="flex size-full items-center justify-center">
      {src ? (
        <img src={src} alt="" className="size-full object-cover object-top" />
      ) : failed ? (
        <FileTypeIcon contentType={contentType} />
      ) : (
        <Skeleton className="size-full rounded-none" />
      )}
    </div>
  )
}

/** La miniatura de un documento: la imagen, la primera página del PDF o su ícono. */
export function FileThumb({ file }: { file: ClientFile }) {
  const [broken, setBroken] = useState(false)
  const kind = previewKindOf(file)
  if (kind === "imagen" && !broken)
    return (
      <img
        src={clientFilePreviewHref(file.id)}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setBroken(true)}
        className="size-full object-cover"
      />
    )
  if (kind === "pdf")
    return <PdfThumb path={clientFileContentPath(file.id)} contentType={file.contentType} />
  return (
    <div className="flex size-full items-center justify-center">
      <FileTypeIcon contentType={file.contentType} />
    </div>
  )
}

/** Lo que se ve dentro del visor: la imagen entera, el PDF o, si no tiene vista, su ícono. */
function FileBody({ file }: { file: ClientFile }) {
  const kind = previewKindOf(file)
  const [broken, setBroken] = useState(false)
  if (kind === "imagen" && !broken)
    return (
      // scroll-nativo: una imagen más alta que el cajón se recorre entera, como un visor.
      <div className="overflow-auto rounded-md border bg-muted/30">
        <img
          src={clientFilePreviewHref(file.id)}
          alt={file.filename}
          onError={() => setBroken(true)}
          className="mx-auto block h-auto max-w-full"
        />
      </div>
    )
  if (kind === "pdf")
    return <PdfPages path={clientFileContentPath(file.id)} title={file.filename} />
  return (
    <div className="flex flex-col items-center gap-3 rounded-md border bg-muted/30 px-4 py-10 text-center">
      <FileTypeIcon contentType={file.contentType} className="size-12" />
      <p className="text-sm font-medium [overflow-wrap:anywhere]">{file.filename}</p>
      <p className="text-sm text-muted-foreground">
        {broken
          ? "No se pudo mostrar la imagen: descárgala para verla."
          : file.contentType === "application/pdf"
            ? "Este PDF pasa de 10 MB: descárgalo para verlo entero."
            : "Este tipo de archivo no se ve aquí: descárgalo para abrirlo."}
      </p>
    </div>
  )
}

export interface FileViewerProps {
  clientId: string
  open: boolean
  onClose: () => void
  isAdmin: boolean
}

/** El visor de un documento que ya se tiene a mano (Documentos). */
export function FileViewer({
  clientId,
  file,
  open,
  onClose,
  isAdmin,
}: FileViewerProps & { file: ClientFile | null }) {
  const queryClient = useQueryClient()
  const [deleting, setDeleting] = useState(false)
  const carga = useMarkCarga(clientId, onClose)
  const remove = useMutation({
    mutationFn: (target: ClientFile) =>
      api(`/api/admin/clients/files/${encodeURIComponent(target.id)}`, { method: "DELETE" }),
    onSuccess: (_, target) => {
      toast.success(`Se borró ${target.filename}`)
      setDeleting(false)
      invalidateClient(queryClient, clientId)
      onClose()
    },
  })
  if (!open || !file) return null
  const facts = [
    FILE_KIND_WORDS[file.kind],
    `${whoWords(file)} el ${supportDay(fileDay(file))}`,
    sizeWords(file.sizeBytes),
    file.kind === "archivo_clinica" && file.deleteAfter ? deleteOnWords(file.deleteAfter) : null,
  ]
    .filter(Boolean)
    .join(" · ")
  return (
    <>
      <DetailDrawer
        open
        onClose={onClose}
        dock={false}
        size="xl"
        className={VIEWER_WIDTH}
        title={file.filename}
        description={facts}
        actions={
          <>
            {isAdmin ? (
              <Button type="button" variant="ghost" onClick={() => setDeleting(true)}>
                Borrar
              </Button>
            ) : null}
            {isAdmin && file.kind === "correo" ? (
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  carga.ask({
                    fileId: file.id,
                    filename: file.filename,
                    cargaDeleteAfter: file.cargaDeleteAfter,
                    cargaDueNow: file.cargaDueNow,
                  })
                }
              >
                Es la carga de datos
              </Button>
            ) : null}
            <Button render={<a href={clientFileHref(file.id)} target="_blank" rel="noreferrer" />}>
              <Download aria-hidden />
              Descargar
            </Button>
          </>
        }
      >
        <FileBody file={file} />
      </DetailDrawer>
      {carga.dialog}
      <ConfirmDialog
        open={deleting}
        title={`Borrar ${file.filename}`}
        description="Deja de verse en la ficha y se borra del almacenamiento. Queda anotado quién lo borró. No se puede deshacer."
        confirmLabel="Borrar"
        pending={remove.isPending}
        error={remove.isError ? submitErrorMessage(remove.error) : null}
        onConfirm={() => remove.mutate(file)}
        onClose={() => {
          remove.reset()
          setDeleting(false)
        }}
      />
    </>
  )
}

/**
 * El visor de un documento por su id (el historial): lo busca entre los del cliente; uno borrado
 * o que quien mira no puede ver lo dice, sin decir qué era.
 */
export function FileViewerById({ fileId, ...props }: FileViewerProps & { fileId: string | null }) {
  const files = useClientFiles(props.clientId, props.open && fileId !== null)
  if (!props.open || !fileId) return null
  const file = files.data?.items.find((item) => item.id === fileId) ?? null
  if (file) return <FileViewer {...props} file={file} />
  return (
    <DetailDrawer
      open
      onClose={props.onClose}
      dock={false}
      title="Documento"
      isLoading={files.isPending}
      error={files.isError ? submitErrorMessage(files.error) : null}
    >
      <p className="text-sm text-muted-foreground">
        Ese documento ya no está: se borró, o no es de los que puedes ver.
      </p>
    </DetailDrawer>
  )
}
