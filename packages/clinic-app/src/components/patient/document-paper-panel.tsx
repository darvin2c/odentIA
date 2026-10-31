import { Button, buttonVariants, cn, useIsMobile } from "@odentia/ui"
import {
  DetailDrawer,
  ErrorState,
  LoadingState,
  PageHeader,
  PageShell,
  type RowActionItem,
  RowActions,
} from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { FileText } from "lucide-react"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { ApiError, apiFetchBytes } from "../../lib/api"
import { budgetPdfUrl } from "../../lib/budgets"
import type { HealthDocumentType } from "../../lib/encounter-documents"

export type PaperType = HealthDocumentType | "budget"

/** El PDF de un papel: el mismo que se envía y se imprime. */
export function paperPdfPath(patientId: string, type: PaperType, id: string): string {
  if (type === "budget") return budgetPdfUrl(patientId, id)
  return `/api/patients/${patientId}/health-document-pdf?documentType=${type}&documentId=${id}`
}

/** Los bytes de un PDF en una dirección `blob:`, que se retira al cerrar. */
export function usePdfUrl(bytes: ArrayBuffer | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!bytes) {
      setUrl(null)
      return
    }
    const made = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }))
    setUrl(made)
    return () => URL.revokeObjectURL(made)
  }, [bytes])
  return url
}

/**
 * El PDF en una dirección `blob:`: la API pide la sesión y un `iframe` no manda
 * sus cabeceras. `revision` cambia con el estado del papel, para volver a pedirlo
 * tras anularlo o firmarlo (lleva sello o el firmado).
 */
function usePaperPdf(path: string, revision: string) {
  const query = useQuery({
    queryKey: ["paper-pdf", path, revision],
    queryFn: () => apiFetchBytes(path),
    enabled: typeof window !== "undefined",
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    refetchOnWindowFocus: false,
  })
  const url = usePdfUrl(query.data)
  return {
    url,
    failed: query.isError,
    message: query.error instanceof ApiError ? query.error.shape.message : null,
    retry: () => void query.refetch(),
  }
}

/** «Enviar» del papel: abre su envío, o dice por qué no se puede. */
export type PaperSend =
  | { kind: "open"; label?: string; onOpen: () => void }
  /** El botón lo pone quien ya lo tiene armado (el envío de un documento económico). */
  | { kind: "node"; node: ReactNode }
  | { kind: "blocked"; reason: string }

export interface DocumentPaperPanelProps {
  patientId: string
  type: PaperType
  documentId: string
  title: string
  /** La línea bajo el título: «Emitida · 30 oct 2026». */
  status: string
  /** `null`: quien mira no envía, y el botón no se ofrece. */
  send: PaperSend | null
  /** Lo que ya se puede hacer con el papel: anular, revocar, subir el resultado… */
  menu?: RowActionItem[]
  /** Lo que el PDF no dice y hace falta saber: el motivo de anular, el resultado. */
  notice?: ReactNode
  /** Cambia con el estado del papel: el PDF se vuelve a pedir. */
  revision: string
  /** Los cajones de sus acciones. */
  children?: ReactNode
  /** Abierto en su propia dirección, sin superficie lateral (los enlaces guardados). */
  page?: boolean
  onClose?: () => void
}

/**
 * Ver un papel (ADR 0115): el PDF, que es la única hoja, con «Enviar» como acción
 * principal, «Descargar PDF», «Imprimir» y «…». Se abre al lado. En el teléfono
 * un PDF dentro de la página no es de fiar: las acciones quedan fijas al pie y
 * «Abrir PDF» lo abre aparte.
 */
export function DocumentPaperPanel({
  patientId,
  type,
  documentId,
  title,
  status,
  send,
  menu = [],
  notice,
  revision,
  children,
  page = false,
  onClose,
}: DocumentPaperPanelProps) {
  const mobile = useIsMobile() === true
  const pdf = usePaperPdf(paperPdfPath(patientId, type, documentId), revision)
  const frame = useRef<HTMLIFrameElement | null>(null)
  const filename = `${title.replace(/[\\/:*?"<>|]+/g, " ").trim()}.pdf`

  const print = () => {
    const target = frame.current?.contentWindow
    try {
      if (!target) throw new Error("Sin hoja")
      target.focus()
      target.print()
    } catch {
      // Un navegador que no imprime un PDF incrustado: se abre aparte, con su propia impresión.
      if (pdf.url) window.open(pdf.url, "_blank", "noopener")
    }
  }

  const sendAction =
    send?.kind === "open" ? (
      <Button type="button" className={cn(mobile && "min-h-11")} onClick={send.onOpen}>
        {send.label ?? "Enviar"}
      </Button>
    ) : send?.kind === "node" ? (
      send.node
    ) : send?.kind === "blocked" ? (
      <Button type="button" disabled className={cn(mobile && "min-h-11")}>
        Enviar
      </Button>
    ) : null
  const download = pdf.url ? (
    <a
      href={pdf.url}
      download={filename}
      className={buttonVariants({ variant: "outline", className: mobile ? "min-h-11" : undefined })}
    >
      Descargar PDF
    </a>
  ) : (
    <Button type="button" variant="outline" disabled className={cn(mobile && "min-h-11")}>
      Descargar PDF
    </Button>
  )
  const more =
    menu.length > 0 ? <RowActions label={`Más acciones de ${title}`} items={menu} /> : null
  const blockedWhy =
    send?.kind === "blocked" ? (
      <p role="status" className="text-xs text-muted-foreground">
        {send.reason}
      </p>
    ) : null
  const actions = (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        {sendAction}
        {download}
        {mobile ? null : (
          <Button type="button" variant="outline" disabled={!pdf.url} onClick={print}>
            Imprimir
          </Button>
        )}
        {more}
      </div>
      {blockedWhy}
    </div>
  )

  const body = (
    <div className="flex flex-col gap-3">
      {notice ? <div className="flex flex-col gap-2 text-sm">{notice}</div> : null}
      {pdf.failed ? (
        <ErrorState
          title="No pudimos abrir el PDF"
          message={pdf.message ?? "Comprueba tu conexión y vuelve a intentarlo."}
          onRetry={pdf.retry}
        />
      ) : !pdf.url ? (
        <LoadingState kind="indeterminate" message="Preparando el PDF…" />
      ) : mobile ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border bg-muted/30 p-6 text-center">
          <FileText aria-hidden className="size-10 text-muted-foreground" />
          <p className="text-sm font-medium break-words">{title}</p>
          <a
            href={pdf.url}
            target="_blank"
            rel="noopener"
            className={buttonVariants({ className: "min-h-11 w-full" })}
          >
            Abrir PDF
          </a>
        </div>
      ) : (
        <iframe
          ref={frame}
          title={title}
          src={pdf.url}
          className={cn(
            "w-full rounded-lg border bg-muted/30",
            page ? "h-[calc(100dvh-14rem)] min-h-[32rem]" : "h-[calc(100dvh-14rem)] min-h-96",
          )}
        />
      )}
    </div>
  )

  if (page) {
    return (
      <PageShell className={cn("flex flex-col gap-4", mobile && "pb-24")}>
        <PageHeader title={title} subtitle={status} />
        {mobile ? null : actions}
        {body}
        {mobile ? (
          <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-surface px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
            {actions}
          </div>
        ) : null}
        {children}
      </PageShell>
    )
  }
  return (
    <DetailDrawer
      open
      size="xl"
      title={title}
      description={status}
      headerContent={mobile ? undefined : actions}
      footer={mobile ? actions : undefined}
      onClose={() => onClose?.()}
    >
      {body}
      {children}
    </DetailDrawer>
  )
}
