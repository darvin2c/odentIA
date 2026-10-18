import { Badge, Button, buttonVariants, cn, Skeleton } from "@odentia/ui"
import { Link } from "@tanstack/react-router"
import { ChevronRight } from "lucide-react"
import type { ReactNode } from "react"
import { type IntegrationRowModel, rowShortWord } from "../../lib/integrations"

/** Pantallas propias a las que lleva una fila. */
export type IntegrationPath = "/settings/integrations/whatsapp" | "/settings/integrations/webchat"

/** Lo que se puede hacer con una fila: ir a su pantalla o hacer algo aquí mismo. */
export interface IntegrationAction {
  label: string
  /** El comienzo de `label` que cabe en la fila corta («Terminar» de «Terminar de conectar»). */
  short?: string
  /** Primario: lo que hace falta hacer. Secundario: abrir algo que ya funciona. */
  emphasis: "primary" | "secondary"
  to?: IntegrationPath
  onSelect?: () => void
  pending?: boolean
  disabled?: boolean
}

const STATUS_BADGE = { ok: "soft", off: "secondary", attention: "warning" } as const
const REVIEW_BADGE = { danger: "destructive", warning: "warning" } as const
const SHORT_WORD = {
  warning: "text-warning",
  danger: "text-destructive",
  ok: "text-foreground",
  muted: "text-muted-foreground",
} as const

/**
 * Bloque de integraciones: un título y una fila por integración. Mide por su
 * propio ancho (`@container`), no por la ventana: con el panel lateral abierto
 * o en un teléfono, las filas pasan a su forma corta.
 */
export function IntegrationBlock({
  title,
  note,
  children,
}: {
  title: string
  /** Aclaración del bloque, al pie. */
  note?: string
  children: ReactNode
}) {
  return (
    <section aria-label={title} className="@container elevated flex min-w-0 flex-col rounded-xl border bg-card">
      <h2 className="px-4 pt-3.5 pb-2.5 text-xs font-bold tracking-wider text-muted-foreground uppercase">{title}</h2>
      <ul className="flex flex-col">{children}</ul>
      {note ? <p className="border-t px-4 pt-2.5 pb-3.5 text-sm text-muted-foreground">{note}</p> : null}
    </section>
  )
}

/** Filas de espera con la forma de las reales: el bloque no salta al llegar los datos. */
export function IntegrationRowsSkeleton({ rows }: { rows: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, index) => (
        <li key={index} aria-hidden className="flex items-center gap-3 border-t px-4 py-3">
          <Skeleton className="hidden size-9 shrink-0 rounded-[10px] @xl:block" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3.5 w-4/5" />
            <Skeleton className="h-3.5 w-3/5" />
          </div>
          <Skeleton className="h-9 w-24 shrink-0 rounded-full" />
        </li>
      ))}
    </>
  )
}

/**
 * En la fila corta el control deja de ser una píldora: es una palabra o una
 * flecha, y ocupa toda la fila (`after`) para que se toque entera. Es el mismo
 * elemento en las dos formas, así el foco vuelve a él al cerrar su panel aunque
 * la fila haya cambiado de forma mientras tanto.
 *
 * `translate: none` al pulsar, y no un desplazamiento de cero: cualquier
 * `translate` convierte al botón en el marco de su `after`, que se encogería a
 * su tamaño justo al pulsar y el clic caería fuera.
 */
const SHORT_CONTROL =
  "@max-xl:h-auto @max-xl:min-h-11 @max-xl:gap-1 @max-xl:rounded-none @max-xl:border-0 @max-xl:bg-transparent @max-xl:p-0 @max-xl:has-data-[icon=inline-end]:pr-0 @max-xl:font-bold @max-xl:shadow-none @max-xl:hover:bg-transparent @max-xl:after:absolute @max-xl:after:inset-0 @max-xl:active:not-aria-[haspopup]:[translate:none]"

function RowControl({
  action,
  name,
  main,
}: {
  action: IntegrationAction
  name: string
  /** La acción que queda en la fila corta; las demás se ocultan ahí. */
  main: boolean
}) {
  const primary = action.emphasis === "primary"
  const className = cn(
    main ? SHORT_CONTROL : "@max-xl:hidden",
    main && (primary ? "@max-xl:text-primary" : "@max-xl:text-muted-foreground"),
  )
  // El nombre accesible dice de qué integración es el control: «Conectar Telegram».
  const label = `${action.label} ${name}`
  const content = (
    <>
      {/* En corto, lo que hay que hacer se lee; lo que solo se abre es una flecha. */}
      {action.short ? (
        // El nombre accesible (la etiqueta entera) contiene lo que se lee en cada forma.
        <>
          <span className="@xl:hidden">{action.short}</span>
          <span className="@max-xl:hidden">{action.label}</span>
        </>
      ) : (
        <span className={primary ? undefined : "@max-xl:sr-only"}>{action.label}</span>
      )}
      {primary && !action.to ? null : (
        <ChevronRight
          aria-hidden
          data-icon={action.to ? "inline-end" : undefined}
          className={cn(!action.to && "@xl:hidden", primary && "@max-xl:hidden")}
        />
      )}
    </>
  )
  const variant = primary ? "default" : "outline"
  if (action.to) {
    return (
      // Lleva a otra pantalla: es un enlace con aspecto de botón, no un botón.
      <Link to={action.to} aria-label={label} className={cn(buttonVariants({ variant }), className)}>
        {content}
      </Link>
    )
  }
  return (
    <Button
      type="button"
      variant={variant}
      aria-label={label}
      className={className}
      disabled={action.disabled || action.pending}
      onClick={action.onSelect}
    >
      {content}
    </Button>
  )
}

/**
 * Una integración en tres líneas: su nombre con el estado en palabras, para
 * qué sirve y un poco más —la cuenta y su última actividad, qué hace falta para
 * conectarla o por qué necesita atención—. El estado nunca va solo en color.
 *
 * En la fila corta (teléfono o lista estrecha) queda una sola acción, la última
 * de `actions`, y toda la fila la activa.
 */
export function IntegrationRow({
  row,
  actions,
  open = false,
}: {
  row: IntegrationRowModel
  actions: IntegrationAction[]
  /** Su panel está abierto al lado. */
  open?: boolean
}) {
  const word = rowShortWord(row)
  const connected = row.detail.kind === "account"
  const main = actions.at(-1)
  return (
    <li
      className={cn(
        "relative flex items-center gap-3 border-t px-4 py-3",
        open && "bg-primary-soft/40",
        row.tone === "attention" && !open && "@max-xl:bg-warning-soft/60",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "hidden size-9 shrink-0 items-center justify-center self-start rounded-[10px] text-xs font-bold @xl:flex",
          connected ? "bg-primary-soft text-primary-soft-foreground" : "bg-muted text-muted-foreground",
        )}
      >
        {row.mark}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="text-sm font-semibold text-foreground">{row.name}</h3>
          <span className="hidden flex-wrap items-center gap-2 @xl:flex">
            <Badge variant={STATUS_BADGE[row.tone]}>{row.status}</Badge>
            {row.review.map((review) => (
              <Badge key={review.label} variant={REVIEW_BADGE[review.tone]}>
                {review.label}
              </Badge>
            ))}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          <span className="@xl:hidden">{row.purposeShort}</span>
          <span className="hidden @xl:inline">{row.purpose}</span>
        </p>
        {row.detail.kind === "account" ? (
          <p className="truncate text-sm text-foreground/80 @xl:whitespace-normal">
            <strong className="font-semibold text-foreground">{row.detail.account}</strong>
            {row.detail.activity ? ` · ${row.detail.activity}` : null}
          </p>
        ) : row.detail.kind === "connect" ? (
          // En corto la fila ya ofrece conectarla: lo que hace falta se lee al abrirla.
          <p className="hidden text-sm text-foreground/80 @xl:block">
            <strong className="font-semibold text-foreground">Para conectar:</strong> {row.detail.needs}
          </p>
        ) : (
          <p className="text-sm text-foreground/80">{row.detail.text}</p>
        )}
        {row.problem ? <p className="text-sm font-semibold text-warning">{row.problem}</p> : null}
      </div>
      {/* Dos botones se apilan mientras la fila no dé para tenerlos al lado del texto. */}
      <div
        className={cn(
          "flex shrink-0 items-center justify-end gap-2 @max-xl:gap-1.5",
          actions.length > 1 && "@xl:flex-col @xl:items-stretch @2xl:flex-row @2xl:items-center",
        )}
      >
        {/* Con algo que hacer, el control ya lo dice; si no, la fila corta dice cómo está. */}
        {main?.emphasis === "primary" ? null : (
          <span className={cn("text-sm font-bold @xl:hidden", SHORT_WORD[word.tone])}>{word.text}</span>
        )}
        {/* Clave por posición contando desde el final: la acción de la fila corta
            es siempre el mismo elemento aunque cambie su texto o gane una vecina. */}
        {actions.map((action, index) => (
          <RowControl key={actions.length - index} action={action} name={row.name} main={action === main} />
        ))}
      </div>
    </li>
  )
}
