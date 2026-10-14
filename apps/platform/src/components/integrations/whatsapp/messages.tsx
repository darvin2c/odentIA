import { Badge, Button, cn, Skeleton } from "@odentia/ui"
import { EmptyState, ErrorState } from "@odentia/ui-patterns"
import { ChevronRight, MessageSquareText, Plus, RefreshCw } from "lucide-react"
import { type RefObject, useId } from "react"
import { type ClinicMessage, messageGroups, messageRow, messagesSummary, type StatusTone } from "../../../lib/whatsapp"

const STATUS_BADGE = { ok: "soft", waiting: "warning", danger: "destructive", off: "secondary" } as const
const STATUS_WORD: Record<StatusTone, string> = {
  ok: "text-primary-soft-foreground",
  waiting: "text-warning",
  danger: "text-destructive",
  off: "text-muted-foreground",
}
const NOTE_TONE = { muted: "text-muted-foreground", waiting: "text-warning", danger: "font-semibold text-destructive" } as const

function MessageRow({
  item,
  open,
  since,
  onOpen,
}: {
  item: ClinicMessage
  open: boolean
  since: (iso: string) => string
  onOpen: () => void
}) {
  const row = messageRow(item, since)
  return (
    <li className="border-t">
      <Button
        type="button"
        variant="ghost"
        aria-current={open ? "true" : undefined}
        className={cn(
          "h-auto min-h-14 w-full justify-start gap-3 rounded-none px-4 py-2.5 text-left font-normal whitespace-normal aria-[current]:bg-primary-soft/40 sm:px-5",
          row.tone === "danger" && "bg-danger-soft/50",
        )}
        onClick={onOpen}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-semibold [overflow-wrap:anywhere]">{item.title}</span>
          <span className="hidden truncate text-sm text-muted-foreground @2xl:block">{row.preview}</span>
          {/* En corto, una sola línea bajo el título: lo que hay que saber o, si no hay nada, de dónde sale. */}
          <span className={cn("line-clamp-2 text-sm @2xl:hidden", NOTE_TONE[row.note?.tone ?? "muted"])}>
            {row.note?.text ?? row.source}
          </span>
        </span>
        <span className="hidden w-32 shrink-0 text-sm text-muted-foreground @2xl:block">{row.source}</span>
        <span className="hidden w-56 shrink-0 flex-col items-start gap-1 @2xl:flex">
          <Badge variant={STATUS_BADGE[row.tone]} className="h-auto min-h-5 text-left whitespace-normal">
            {row.status}
          </Badge>
          {row.note ? <span className={cn("line-clamp-2 text-xs", NOTE_TONE[row.note.tone])}>{row.note.text}</span> : null}
        </span>
        <span className={cn("max-w-28 shrink-0 text-right text-sm font-semibold @2xl:hidden", STATUS_WORD[row.tone])}>
          {item.current.statusLabel}
        </span>
        <ChevronRight aria-hidden className="text-muted-foreground" />
      </Button>
    </li>
  )
}

function Group({
  title,
  note,
  items,
  openId,
  since,
  onOpen,
}: {
  title: string
  note: string
  items: ClinicMessage[]
  openId: string | null
  since: (iso: string) => string
  onOpen: (item: ClinicMessage) => void
}) {
  const id = useId()
  if (items.length === 0) return null
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col">
      <div className="flex flex-col gap-x-2.5 gap-y-0.5 border-t bg-canvas px-4 py-2.5 sm:px-5 @2xl:flex-row @2xl:items-baseline">
        <h3 id={id} className="shrink-0 text-xs font-bold tracking-wider text-muted-foreground uppercase">
          {title}
        </h3>
        {/* En corto queda solo el nombre del grupo: la lista manda. */}
        <p className="hidden text-sm text-muted-foreground @2xl:block">{note}</p>
      </div>
      <ul className="flex flex-col">
        {items.map((item) => (
          <MessageRow key={item.id} item={item} open={openId === item.id} since={since} onOpen={() => onOpen(item)} />
        ))}
      </ul>
    </div>
  )
}

/**
 * Los mensajes de WhatsApp de la clínica en una conexión, en dos grupos: los que
 * envía el agente y los que envía el equipo desde la Bandeja. Una fila por
 * mensaje, con su estado en palabras; abrirla muestra el mensaje al lado.
 */
export function WhatsAppMessages({
  items,
  isPending,
  isError,
  account,
  canWrite,
  openId,
  syncing,
  syncError,
  fixedCreate,
  headingRef,
  since,
  onRetry,
  onSync,
  onOpen,
  onCreate,
}: {
  /** `undefined` mientras no llega la primera respuesta. */
  items: ClinicMessage[] | undefined
  isPending: boolean
  isError: boolean
  /** De qué número son, si la clínica tiene más de uno. */
  account: string | null
  /** Hace cuánto pasó algo, con palabras y en la zona de la clínica. */
  since: (iso: string) => string
  canWrite: boolean
  /** Mensaje abierto al lado. */
  openId: string | null
  syncing: boolean
  syncError: string | null
  /** En teléfono «Nuevo mensaje» queda fijo al pie de la página. */
  fixedCreate: boolean
  headingRef?: RefObject<HTMLHeadingElement | null>
  onRetry: () => void
  onSync: () => void
  onOpen: (item: ClinicMessage) => void
  onCreate: () => void
}) {
  const headingId = useId()
  const groups = items ? messageGroups(items) : null
  const summary = items ? messagesSummary(items) : ""

  return (
    <section aria-labelledby={headingId} className="@container elevated flex min-w-0 flex-col rounded-xl border bg-card">
      <div className="flex flex-wrap items-center gap-2.5 px-4 pt-4 pb-3.5 sm:px-5 @2xl:pb-1.5">
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
          <h2 id={headingId} ref={headingRef} tabIndex={-1} className="font-heading text-base font-semibold outline-none">
            Mensajes{account ? ` de ${account}` : ""}
          </h2>
          {summary ? <p className="text-sm text-muted-foreground">{summary}</p> : null}
        </div>
        {canWrite ? (
          <>
            <Button type="button" variant="outline" className="min-h-11 sm:min-h-9" disabled={syncing} onClick={onSync}>
              <RefreshCw aria-hidden className={cn(syncing && "animate-spin motion-reduce:animate-none")} />
              {syncing ? "Actualizando…" : "Actualizar"}
            </Button>
            <Button type="button" className={cn("min-h-11 sm:min-h-9", fixedCreate && "hidden sm:inline-flex")} onClick={onCreate}>
              <Plus aria-hidden />
              Nuevo mensaje
            </Button>
          </>
        ) : null}
      </div>
      <p className="hidden px-4 pb-3.5 text-sm text-muted-foreground sm:px-5 @2xl:block">
        A quien escribió en las últimas 24 horas se le responde con libertad. Pasado ese tiempo, WhatsApp solo deja enviar un
        mensaje que ya aprobó.
      </p>
      {syncError ? (
        <p role="alert" className="mx-4 mb-3.5 rounded-xl bg-danger-soft px-3.5 py-3 text-sm text-destructive sm:mx-5">
          {syncError}
        </p>
      ) : null}

      {isPending ? (
        <>
          <p role="status" className="sr-only">
            Cargando los mensajes…
          </p>
          <ul aria-hidden className="flex flex-col">
            {Array.from({ length: 6 }, (_, index) => (
              <li key={index} className="flex items-center gap-3 border-t px-4 py-3 sm:px-5">
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <Skeleton className="h-4 w-44" />
                  <Skeleton className="h-3.5 w-4/5" />
                </div>
                <Skeleton className="h-5 w-24 shrink-0 rounded-md" />
              </li>
            ))}
          </ul>
        </>
      ) : isError && !items ? (
        <div className="px-4 pb-4 sm:px-5">
          <ErrorState title="No pudimos cargar los mensajes" message="Comprueba tu conexión y vuelve a intentarlo." onRetry={onRetry} />
        </div>
      ) : groups && items && items.length > 0 ? (
        <>
          <Group
            title="Los envía el agente"
            note="Vienen escritos y puedes cambiarles el texto. Salen solos cuando su línea del Administrador está prendida."
            items={groups.agent}
            openId={openId}
            since={since}
            onOpen={onOpen}
          />
          <Group
            title="Los envía tu equipo desde la Bandeja"
            note="Para escribirle a alguien cuando ya pasaron las 24 horas. También se editan."
            items={groups.team}
            openId={openId}
            since={since}
            onOpen={onOpen}
          />
          <p className="border-t px-4 pt-3 pb-3.5 text-sm text-muted-foreground sm:px-5">
            Todos se le piden a WhatsApp al conectar. WhatsApp revisa cada mensaje y cada cambio de texto, decide si es de
            utilidad o de marketing y cobra según eso. Cuando aprueba, rechaza o pausa alguno, quien administra la clínica
            recibe un aviso.
          </p>
        </>
      ) : (
        <div className="px-4 pb-4 sm:px-5">
          <EmptyState
            icon={MessageSquareText}
            title="Todavía no hay mensajes"
            description="«Actualizar» los lee de tu cuenta de WhatsApp y pide los que falten."
            {...(canWrite ? { actionLabel: "Actualizar", onAction: onSync } : {})}
          />
        </div>
      )}
    </section>
  )
}
