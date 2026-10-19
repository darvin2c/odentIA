import { cn } from "@odentia/ui"
import { ArrowRight, Info, OctagonX, TriangleAlert, X } from "lucide-react"
import * as React from "react"

/** `aviso` informa, `alarma` pide actuar pronto, `limite` ya detuvo algo. */
export type NoticeTone = "aviso" | "alarma" | "limite"

export interface StripNotice {
  /** Estable entre lecturas: con él se recuerda quién cerró qué. */
  id: string
  tone: NoticeTone
  /** El mensaje completo: escritorio y al abrirlo en el teléfono. */
  message: string
  /** Una línea para el teléfono; sin él, el mensaje se corta con «…». */
  short?: string
  /** La acción que lo resuelve. `to` navega; `onSelect` abre algo ahí mismo. */
  action?: { label: string; shortLabel?: string; to?: string; onSelect?: () => void }
  /** Cerrar con la X; ausente en `limite`: lo que bloquea no se esconde. */
  onDismiss?: () => void
}

export type NoticeLinkComponent = React.ComponentType<{
  to: string
  className?: string
  children: React.ReactNode
}>

export interface NoticeStripProps {
  notices: StripNotice[]
  /** Enlace de la app para las acciones con `to` (navega sin recargar). */
  LinkComponent?: NoticeLinkComponent
  /** Nombre de la región para lectores de pantalla. */
  label?: string
}

const ORDER: Record<NoticeTone, number> = { limite: 0, alarma: 1, aviso: 2 }
const LEVEL_WORDS: Record<NoticeTone, string> = { aviso: "Aviso", alarma: "Alarma", limite: "Límite" }
const ICONS: Record<NoticeTone, React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>> = {
  aviso: Info,
  alarma: TriangleAlert,
  limite: OctagonX,
}
const TONE_CLASS: Record<NoticeTone, string> = {
  aviso: "bg-primary text-primary-foreground",
  alarma: "bg-warning-strong text-warning-strong-foreground",
  limite: "bg-destructive text-destructive-foreground",
}

/** Alto de la franja, para que el resto de la ventana (barra lateral, columna, Bandeja) le deje sitio. */
const HEIGHT_VAR = "--notice-strip-h"

/** Ordena por gravedad, conservando el orden de llegada dentro del mismo nivel. */
export function sortNotices(notices: StripNotice[]): StripNotice[] {
  return notices
    .map((notice, index) => ({ notice, index }))
    .sort((a, b) => ORDER[a.notice.tone] - ORDER[b.notice.tone] || a.index - b.index)
    .map(({ notice }) => notice)
}

function ActionControl({
  action,
  short,
  LinkComponent,
}: {
  action: NonNullable<StripNotice["action"]>
  short?: boolean
  LinkComponent?: NoticeLinkComponent
}) {
  const text = short ? (action.shortLabel ?? action.label) : action.label
  const className =
    "inline-flex min-h-11 shrink-0 items-center gap-1 whitespace-nowrap font-semibold underline underline-offset-3 outline-none focus-visible:ring-2 focus-visible:ring-current sm:min-h-0 rounded-sm"
  const content = (
    <>
      {text}
      {short ? null : <ArrowRight className="size-3.5" aria-hidden />}
    </>
  )
  if (action.to && LinkComponent) {
    return (
      <LinkComponent to={action.to} className={className}>
        {content}
      </LinkComponent>
    )
  }
  if (action.to) {
    return (
      <a href={action.to} className={className}>
        {content}
      </a>
    )
  }
  return (
    <button type="button" className={className} onClick={action.onSelect}>
      {content}
    </button>
  )
}

function CloseButton({ onDismiss }: { onDismiss: () => void }) {
  return (
    <button
      type="button"
      onClick={onDismiss}
      aria-label="Cerrar aviso"
      className="grid size-11 shrink-0 place-items-center rounded-md outline-none hover:bg-black/10 focus-visible:ring-2 focus-visible:ring-current sm:size-8"
    >
      <X className="size-4" aria-hidden />
    </button>
  )
}

/** Una franja: escritorio centrada en una línea; teléfono en 44 px con el texto corto. */
function StripRow({
  notice,
  LinkComponent,
  more,
}: {
  notice: StripNotice
  LinkComponent?: NoticeLinkComponent
  more?: React.ReactNode
}) {
  const [open, setOpen] = React.useState(false)
  const detailsId = React.useId()
  const Icon = ICONS[notice.tone]
  // Lo que ya detuvo algo no se esconde, aunque quien lo pinta pase `onDismiss`.
  const dismiss = notice.tone === "limite" ? undefined : notice.onDismiss
  return (
    <div
      role={notice.tone === "aviso" ? "status" : "alert"}
      data-slot="notice-strip-item"
      data-tone={notice.tone}
      className={cn("text-sm", TONE_CLASS[notice.tone])}
    >
      {/* Escritorio: ícono, mensaje, acción y X en una línea centrada. */}
      <div className="relative hidden items-center justify-center gap-x-3 gap-y-1 px-12 py-2 text-center font-medium sm:flex sm:flex-wrap">
        <Icon className="size-4 shrink-0" aria-hidden />
        <p className="min-w-0">
          <span className="sr-only">{LEVEL_WORDS[notice.tone]}: </span>
          {notice.message}
        </p>
        {notice.action ? <ActionControl action={notice.action} LinkComponent={LinkComponent} /> : null}
        {more}
        {dismiss ? (
          <span className="absolute top-1/2 right-2 -translate-y-1/2">
            <CloseButton onDismiss={dismiss} />
          </span>
        ) : null}
      </div>
      {/* Teléfono: una sola línea; el mensaje completo se abre al tocar el texto. */}
      <div className="sm:hidden">
        <div className="flex min-h-11 items-center gap-2 pl-3 font-semibold">
          <Icon className="size-4 shrink-0" aria-hidden />
          <button
            type="button"
            className="min-h-11 min-w-0 flex-1 truncate text-left outline-none focus-visible:underline"
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpen(!open)}
          >
            <span className="sr-only">{LEVEL_WORDS[notice.tone]}: </span>
            {notice.short ?? notice.message}
          </button>
          {more}
          {notice.action ? <ActionControl action={notice.action} short LinkComponent={LinkComponent} /> : null}
          {dismiss ? <CloseButton onDismiss={dismiss} /> : <span className="w-2" aria-hidden />}
        </div>
        {/* Solo cuando se abre: así el mensaje completo no está dos veces en la página. */}
        {open ? (
          <p id={detailsId} className="px-3 pb-2.5 font-medium">
            {notice.message}
          </p>
        ) : null}
      </div>
    </div>
  )
}

/**
 * La franja de avisos de la clínica (ADR 0065): pegada arriba de la ventana,
 * de borde a borde. Muestra el aviso más grave; los demás se abren con
 * «y N avisos más». Qué avisos van y quién los ve lo decide el servidor:
 * este patrón solo los pinta. Lo que importa en una sola pantalla no va aquí,
 * sino en `PageNotice` dentro de esa pantalla.
 */
export function NoticeStrip({ notices, LinkComponent, label = "Avisos de la clínica" }: NoticeStripProps) {
  const sorted = React.useMemo(() => sortNotices(notices), [notices])
  const [expanded, setExpanded] = React.useState(false)
  const ref = React.useRef<HTMLElement>(null)

  // El resto de la ventana se corre lo que mide la franja (y vuelve a 0 sin ella).
  // biome-ignore lint/correctness/useExhaustiveDependencies: la franja aparece o cambia de alto cuando cambian los avisos.
  React.useLayoutEffect(() => {
    const element = ref.current
    const root = document.documentElement
    if (!element) {
      root.style.setProperty(HEIGHT_VAR, "0px")
      return
    }
    const update = () => root.style.setProperty(HEIGHT_VAR, `${element.offsetHeight}px`)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => {
      observer.disconnect()
      root.style.setProperty(HEIGHT_VAR, "0px")
    }
  }, [sorted.length])

  const [first, ...rest] = sorted
  if (!first) return null
  const toggle =
    rest.length > 0 ? (
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={expanded ? "Ver menos" : `y ${rest.length === 1 ? "1 aviso más" : `${rest.length} avisos más`}`}
        onClick={() => setExpanded(!expanded)}
        className="inline-flex min-h-11 shrink-0 items-center rounded-sm px-1 text-xs font-semibold underline underline-offset-3 outline-none focus-visible:ring-2 focus-visible:ring-current sm:min-h-0 sm:text-sm sm:font-medium"
      >
        <span className="sm:hidden" aria-hidden>{expanded ? "−" : `+${rest.length}`}</span>
        <span className="hidden sm:inline">
          {expanded ? "Ver menos" : `y ${rest.length === 1 ? "1 aviso más" : `${rest.length} avisos más`}`}
        </span>
      </button>
    ) : null

  return (
    <section ref={ref} aria-label={label} data-slot="notice-strip" className="sticky top-0 z-40 w-full">
      <StripRow notice={first} LinkComponent={LinkComponent} more={toggle} />
      {expanded ? rest.map((notice) => <StripRow key={notice.id} notice={notice} LinkComponent={LinkComponent} />) : null}
    </section>
  )
}
