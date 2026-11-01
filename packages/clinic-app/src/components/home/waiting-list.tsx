import { Button, buttonVariants, cn } from "@odentia/ui"
import { AgentMark, PersonAvatar } from "@odentia/ui-patterns"
import { Link } from "@tanstack/react-router"
import { CalendarClock, CalendarX2, CheckCircle2, ChevronDown, FileText, Lightbulb, type LucideIcon, MessageCircle, MessagesSquare, Package, SquareCheckBig, UserRound } from "lucide-react"
import { type ReactElement, type ReactNode, useEffect, useId, useRef, useState } from "react"
import { dayKeyOf } from "../../lib/finance-cash"
import { alsoWords, type HomeTextContext, PHONE_ROWS, waitingKey, waitingText } from "../../lib/home"
import type { WaitingBand, WaitingEntry, WaitingRow } from "../../lib/workspace"

type RowOf<K extends WaitingRow["kind"]> = Extract<WaitingRow, { kind: K }>

export interface WaitingHandlers {
  /** Abre al lado lo que la fila pide resolver: el panel de la persona, la cita, la tarea, la lista. */
  onOpen: (row: WaitingRow) => void
  /** Filas que abrir al lado le toca a quien mira; las demás llevan a donde se resuelven. */
  opensBeside: (row: WaitingRow) => boolean
  /** «Llegó»: quien terminó su registro entra a la clínica. Se hace en la fila. */
  onArrived?: (row: RowOf<"registrationDone">) => void
  /** «Hecha» en una tarea. Se hace en la fila; sin esto (sin permiso) la fila solo la abre. */
  onDone?: (row: RowOf<"task">) => void
  /** La fila cuya acción está en curso: su botón dice que trabaja. */
  busyKey?: string | null
  /** ¿Quien mira dejó algo escrito a medias para esa conversación? */
  hasDraft?: (conversationId: string) => boolean
}

function TypeIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
      <Icon className="size-[18px]" />
    </span>
  )
}

/** De una persona, su inicial; de lo demás, de qué se trata. */
function iconOf(row: WaitingRow, title: string): ReactNode {
  switch (row.kind) {
    case "case":
    case "person":
    case "staleEncounter":
    case "unconfirmed":
    case "unclosed":
    case "unsentBudget":
    case "registrationDone":
    case "possibleDuplicate":
    case "portalReentry":
    case "dataRequest":
      return <PersonAvatar name={title} className="size-9 shrink-0" />
    case "unreached":
      return <AgentMark className="rounded-full" />
    case "more":
      if (row.of === "cases" || row.of === "conversations") return <TypeIcon icon={UserRound} />
      if (row.of === "unconfirmed") return <TypeIcon icon={CalendarClock} />
      if (row.of === "unclosed") return <TypeIcon icon={CalendarX2} />
      if (row.of === "unsentBudgets") return <TypeIcon icon={FileText} />
      return <TypeIcon icon={SquareCheckBig} />
    case "acceptedUnbooked":
    case "budgets":
    case "consentToPublish":
      return <TypeIcon icon={FileText} />
    case "stillOpen":
      return <TypeIcon icon={MessagesSquare} />
    case "advice":
      return <TypeIcon icon={Lightbulb} />
    case "promotions":
      return <TypeIcon icon={MessageCircle} />
    case "inventory":
      return <TypeIcon icon={Package} />
    default:
      return <TypeIcon icon={SquareCheckBig} />
  }
}


/**
 * A dónde lleva la fila cuando se resuelve navegando. Lo que navega es un
 * enlace, no un botón: así lo anuncia el lector de pantalla.
 */
function linkOf(row: WaitingRow, context: HomeTextContext, props: { className: string; "aria-label": string; children: ReactNode }): ReactElement | null {
  // «y N tareas más» abre Tareas en la vista de quien mira: la del equipo para quien dirige, las suyas para los demás.
  const tasksView = context.allTasks ? "todas" : "mias"
  switch (row.kind) {
    case "case":
      return <Link to="/tasks" search={{ task: undefined, vista: tasksView }} {...props} />
    case "staleEncounter":
      return <Link to="/patients/$patientId/encounters/$encounterId" params={{ patientId: row.patientId, encounterId: row.id }} {...props} />
    case "unsentBudget":
      return <Link to="/patients/$patientId" params={{ patientId: row.patientId }} search={{ tab: "plan", budgetId: row.id }} {...props} />
    case "possibleDuplicate":
      // Comparar pide la ficha entera; decidir son los botones del panel.
      if (row.patientId) return <Link to="/patients/$patientId" params={{ patientId: row.patientId }} search={{ tab: "filiacion" }} {...props} />
      // Quien tenía el documento aún no es paciente: su página de persona.
      return row.personId ? <Link to="/people/$personId" params={{ personId: row.personId }} {...props} /> : null
    case "dataRequest":
      // Quien no atiende los pedidos ve Datos › Pedidos sobre sus datos.
      return <Link to="/patients/$patientId" params={{ patientId: row.patientId }} search={{ tab: "pedidos" }} {...props} />
    case "portalReentry":
      return <Link to="/patients/$patientId" params={{ patientId: row.patientId }} search={{ tab: "portal" }} {...props} />
    case "consentToPublish":
      return <Link to="/settings/forms" search={{ tab: "consentimientos" }} {...props} />
    case "inventory":
      // Inventario de esa sede con su filtro: lo que hace falta o, si solo hay vencidos, lo que vence.
      return <Link to="/inventory" search={{ branch: row.branchId, ver: row.needed > 0 ? "hacen_falta" : "por_vencer" }} {...props} />
    case "promotions":
      return <Link to="/settings/integrations/whatsapp" search={{ mensaje: row.items[0]?.messageId }} {...props} />
    case "stillOpen":
      return row.conversationId
        ? <Link to="/inbox" search={{ conversation: row.conversationId }} {...props} />
        : <Link to="/inbox" search={{ conversation: undefined, view: undefined }} {...props} />
    case "task":
      return row.more > 0 ? <Link to="/tasks" search={{ task: undefined, vista: tasksView }} {...props} /> : <Link to={row.href} {...props} />
    case "more":
      if (row.of === "conversations") return <Link to="/inbox" search={{ conversation: undefined, view: undefined }} {...props} />
      if (row.of === "tasks") return <Link to="/tasks" search={{ task: undefined, vista: tasksView }} {...props} />
      if (row.of === "unconfirmed") return <Link to="/agenda" search={{}} {...props} />
      // La Agenda muestra «Ya pasaron · sin cerrar» del día que se mira: abre en el de la primera que no cupo.
      if (row.of === "unclosed") return <Link to="/agenda" search={row.startsAt ? { date: dayKeyOf(row.startsAt, context.timezone) } : {}} {...props} />
      if (row.of === "unsentBudgets") return <Link to="/people" search={{}} {...props} />
      // «y N casos más»: cada caso es una tarea de Recepción («Te lo pasó Sofi»).
      return <Link to="/tasks" search={{ task: undefined, vista: tasksView }} {...props} />
    default:
      return null
  }
}

/** Filas que se resuelven en la propia fila, con la fila abriendo su detalle aparte. */
function directAction(row: WaitingRow, handlers: WaitingHandlers): { label: string; run: () => void } | null {
  if (row.kind === "registrationDone" && handlers.onArrived) {
    const arrived = handlers.onArrived
    return { label: "Llegó", run: () => arrived(row) }
  }
  if (row.kind === "task" && row.more === 0 && handlers.onDone) {
    const done = handlers.onDone
    return { label: "Hecha", run: () => done(row) }
  }
  return null
}

/**
 * El mismo botón en todas las filas: pequeño y siempre a la vista, también en el
 * teléfono. Turquesa solo en «Ahora», claro en lo demás: el color dice por dónde
 * empezar, y las palabras del grupo dicen por qué.
 */
const SMALL = "relative z-10 min-h-11 shrink-0 sm:min-h-8"

function WaitingRowItem({ row, context, handlers, className }: { row: WaitingEntry; context: HomeTextContext; handlers: WaitingHandlers; className?: string }) {
  const text = waitingText(row, context)
  const key = waitingKey(row)
  const busy = handlers.busyKey === key
  const primary = row.band === "ahora"
  const variant = primary ? "default" : "secondary"
  const also = row.also ?? []
  const conversationId = row.kind === "case" || row.kind === "person" ? row.conversationId : null
  const body = (
    <>
      {iconOf(row, text.title)}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
        <span className="font-bold">{text.title}</span>
        {text.ask ? <span className="line-clamp-2 text-foreground">{text.ask}</span> : null}
        <span className="text-[13px] text-muted-foreground">
          {[text.detail, ...also.slice(0, 1).map((item) => `también ${alsoWords(item)}`), conversationId && handlers.hasDraft?.(conversationId) ? "tienes un borrador sin enviar" : null]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>
    </>
  )
  const aria = `${text.action}: ${text.title}`
  const direct = directAction(row, handlers)
  // La fila entera abre lo mismo que su botón: una sola parada del teclado.
  const stretched = "after:absolute after:inset-0 after:rounded-lg"
  let control: ReactNode
  if (direct) {
    control = (
      <>
        <button
          type="button"
          aria-label={`Abrir: ${text.title}`}
          className={cn("absolute inset-0 rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none", !handlers.opensBeside(row) && "hidden")}
          onClick={() => handlers.onOpen(row)}
        />
        <Button type="button" size="sm" variant={variant} className={SMALL} disabled={busy} aria-label={`${direct.label}: ${text.title}`} onClick={direct.run}>
          {busy ? "Guardando…" : direct.label}
        </Button>
      </>
    )
  } else if (!text.action) {
    // Lo tiene otra persona: sin botón, pero se abre para mirarlo y, si hace falta, «Responder yo».
    control = (
      <button
        type="button"
        aria-label={`Ver el caso: ${text.title}`}
        className="absolute inset-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        onClick={() => handlers.onOpen(row)}
      />
    )
  } else if (handlers.opensBeside(row)) {
    control = (
      <Button type="button" size="sm" variant={variant} className={cn(SMALL, "static", stretched)} disabled={busy} aria-label={aria} onClick={() => handlers.onOpen(row)}>
        {busy ? "Guardando…" : text.action}
      </Button>
    )
  } else {
    control = linkOf(row, context, { className: cn(buttonVariants({ size: "sm", variant }), SMALL, "static", stretched), "aria-label": aria, children: text.action })
  }
  return (
    <li className={cn("relative flex items-center gap-3 px-2 py-2 text-sm hover:bg-muted/50", className)}>
      {body}
      {control}
    </li>
  )
}

const BAND_TITLE: Record<WaitingBand, string> = { ahora: "Ahora", hoy: "Hoy", sin_apuro: "Sin apuro" }
const BAND_COLOR: Record<WaitingBand, string> = { ahora: "text-destructive", hoy: "text-warning", sin_apuro: "text-muted-foreground" }

function bandCount(band: WaitingBand, rows: WaitingEntry[]): string {
  const count = rows.length
  if (band === "ahora") return count === 1 ? "1 persona espera" : `${count} personas esperan`
  return count === 1 ? "1 asunto" : `${count} asuntos`
}

/**
 * «Te espera»: la única lista de lo que hay que hacer, una fila por persona, en
 * tres grupos que entrega el servidor. Lo más urgente arriba y lo que puede
 * esperar, plegado. Cada fila abre lo que pide resolver al lado, y lleva a otra
 * pantalla solo si el trabajo vive allí. Lo que está aquí no llega a la campana.
 */
export function WaitingList({
  rows,
  context,
  handlers,
  error,
}: {
  rows: WaitingEntry[]
  context: HomeTextContext
  handlers: WaitingHandlers
  /** Lo que no se pudo hacer en la fila. */
  error?: string | null
}) {
  const headingId = useId()
  const [calmOpen, setCalmOpen] = useState(false)
  const [todayOpen, setTodayOpen] = useState(false)
  const now = rows.filter((row) => row.band === "ahora")
  const today = rows.filter((row) => row.band === "hoy")
  const calm = rows.filter((row) => row.band === "sin_apuro")
  const hiddenToday = today.length - PHONE_ROWS
  // Al abrir el resto en teléfono, el foco pasa a la primera fila que aparece.
  const todayList = useRef<HTMLUListElement>(null)
  useEffect(() => {
    if (todayOpen) todayList.current?.querySelector<HTMLElement>(`li:nth-child(${PHONE_ROWS + 1}) :is(a, button)`)?.focus()
  }, [todayOpen])
  const group = (band: WaitingBand, items: WaitingEntry[], list?: React.RefObject<HTMLUListElement | null>) => (
    <div className="flex flex-col">
      <h3 className={cn("flex items-baseline gap-2 px-2 pt-3 pb-1 text-[13px] font-bold", BAND_COLOR[band])}>
        {BAND_TITLE[band]}
        <span className="font-medium text-muted-foreground">{bandCount(band, items)}</span>
      </h3>
      <ul ref={list} className="flex flex-col divide-y">
        {items.map((row, index) => (
          <WaitingRowItem
            key={waitingKey(row)}
            row={row}
            context={context}
            handlers={handlers}
            className={band === "hoy" && index >= PHONE_ROWS && !todayOpen ? "hidden sm:flex" : undefined}
          />
        ))}
      </ul>
    </div>
  )
  return (
    <section aria-labelledby={headingId} className="enter elevated flex min-w-0 flex-col rounded-xl border bg-card p-3 sm:p-4">
      <h2 id={headingId} className="px-2 text-[17px] font-bold tracking-tight">
        Te espera
      </h2>
      {error ? (
        <p role="alert" className="px-2 pt-1 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {now.length === 0 && today.length === 0 ? (
        <p className="flex items-center gap-2 px-2 py-3 font-semibold">
          <CheckCircle2 className="size-5 shrink-0 text-success" aria-hidden />
          Nada te espera por ahora
        </p>
      ) : null}
      {now.length > 0 ? group("ahora", now) : null}
      {today.length > 0 ? group("hoy", today, todayList) : null}
      {hiddenToday > 0 && !todayOpen ? (
        <Button type="button" variant="ghost" className="mt-1 min-h-11 w-full justify-center font-semibold text-primary sm:hidden" onClick={() => setTodayOpen(true)}>
          {hiddenToday === 1 ? "Ver el otro de hoy" : `Ver los otros ${hiddenToday} de hoy`}
        </Button>
      ) : null}
      {calm.length > 0 ? (
        <div className="mt-1 flex flex-col">
          <Button
            type="button"
            variant="ghost"
            className="min-h-11 w-full justify-between px-2 text-[13px] font-bold text-muted-foreground"
            aria-expanded={calmOpen}
            onClick={() => setCalmOpen(!calmOpen)}
          >
            Sin apuro · {calm.length}
            <ChevronDown aria-hidden className={cn("size-4 transition-transform", calmOpen && "rotate-180")} />
          </Button>
          {calmOpen ? (
            <ul className="flex flex-col divide-y">
              {calm.map((row) => (
                <WaitingRowItem key={waitingKey(row)} row={row} context={context} handlers={handlers} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
