import { Badge, Button, cn } from "@odentia/ui"
import { AgentMark } from "@odentia/ui-patterns"
import { Link } from "@tanstack/react-router"
import { CheckCircle2, FileText, Lightbulb, type LucideIcon, MessageCircle, SquareCheckBig, UserRound } from "lucide-react"
import { type ReactElement, type ReactNode, useEffect, useId, useRef, useState } from "react"
import { type HomeTextContext, PHONE_ROWS, waitingKey, waitingText } from "../../lib/home"
import type { WaitingRow } from "../../lib/workspace"
import { HandoffUrgency } from "../agent/handoff-badges"

type RowOf<K extends WaitingRow["kind"]> = Extract<WaitingRow, { kind: K }>

export interface WaitingHandlers {
  /** Puede decidir lo que propone el agente (`agent.decide`); si no, la fila lleva a Aprobaciones. */
  canApprove: boolean
  onReview: (row: RowOf<"proposal">) => void
  onCase: (row: RowOf<"case">) => void
  onAdvice: (row: RowOf<"advice">) => void
  onBudgets: (row: RowOf<"budgets">) => void
}

/** Toda la fila es el control: mismo alto, mismo orden y la acción a la derecha. */
const ROW =
  "h-auto min-h-[60px] w-full justify-start gap-3 rounded-lg px-2 py-2 text-left text-sm font-normal whitespace-normal"

function TypeIcon({ icon: Icon, urgent }: { icon: LucideIcon; urgent?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-full",
        urgent ? "bg-danger-soft text-destructive" : "bg-muted text-muted-foreground",
      )}
    >
      <Icon className="size-[18px]" />
    </span>
  )
}

function iconOf(row: WaitingRow): ReactNode {
  if (row.kind === "proposal" || (row.kind === "more" && row.of === "proposals")) return <AgentMark className="rounded-full" />
  if (row.kind === "case") return <TypeIcon icon={UserRound} urgent={row.priority === "alta"} />
  if (row.kind === "more" && row.of === "cases") return <TypeIcon icon={UserRound} />
  if (row.kind === "conversations") return <TypeIcon icon={MessageCircle} />
  if (row.kind === "advice") return <TypeIcon icon={Lightbulb} />
  if (row.kind === "budgets") return <TypeIcon icon={FileText} />
  return <TypeIcon icon={SquareCheckBig} />
}

/** La insignia que acompaña al título: la urgencia de un caso o una tarea vencida. */
function badgeOf(row: WaitingRow): ReactNode {
  if (row.kind === "case") return <HandoffUrgency priority={row.priority} />
  if (row.kind === "task" && row.due === "overdue") return <Badge variant="destructive">Vencida</Badge>
  return null
}

/** A dónde lleva la fila cuando se resuelve navegando; null si abre algo en esta pantalla. */
function linkOf(row: WaitingRow, handlers: WaitingHandlers): ReactElement | null {
  switch (row.kind) {
    case "case":
      return row.conversationId ? null : <Link to="/agent/approvals" search={{ conversationId: undefined, status: undefined }} />
    case "proposal":
      return handlers.canApprove ? null : <Link to="/agent/approvals" search={{ conversationId: row.conversationId ?? undefined, status: undefined }} />
    case "conversations":
      return <Link to="/inbox" search={{ conversation: undefined, view: "unanswered" }} />
    case "task":
      return row.more > 0 ? <Link to="/tasks" search={{ task: undefined }} /> : <Link to={row.href} />
    case "more":
      return row.of === "tasks" ? <Link to="/tasks" search={{ task: undefined }} /> : <Link to="/agent/approvals" search={{ conversationId: undefined, status: undefined }} />
    default:
      return null
  }
}

function open(row: WaitingRow, handlers: WaitingHandlers) {
  if (row.kind === "case") handlers.onCase(row)
  else if (row.kind === "proposal") handlers.onReview(row)
  else if (row.kind === "advice") handlers.onAdvice(row)
  else if (row.kind === "budgets") handlers.onBudgets(row)
}

function WaitingRowItem({ row, context, handlers, className }: { row: WaitingRow; context: HomeTextContext; handlers: WaitingHandlers; className?: string }) {
  const text = waitingText(row, context)
  const badge = badgeOf(row)
  const link = linkOf(row, handlers)
  const content = (
    <>
      {iconOf(row)}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 font-bold">
          {/* En escritorio la insignia abre el título; en teléfono baja al detalle. */}
          {badge ? <span className="hidden sm:inline-flex">{badge}</span> : null}
          <span className="min-w-0">{text.title}</span>
        </span>
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-muted-foreground">
          {badge ? <span className="inline-flex sm:hidden">{badge}</span> : null}
          <span className="min-w-0">{text.detail}</span>
        </span>
      </span>
      {/* En teléfono la acción no ocupa sitio, pero sigue nombrando la fila. */}
      <span className="sr-only shrink-0 font-semibold text-primary sm:not-sr-only">{text.action}</span>
    </>
  )
  return (
    <li className={className}>
      {link ? (
        <Button variant="ghost" nativeButton={false} render={link} className={ROW}>
          {content}
        </Button>
      ) : (
        <Button type="button" variant="ghost" className={ROW} onClick={() => open(row, handlers)}>
          {content}
        </Button>
      )}
    </li>
  )
}

/**
 * «Te espera»: todo lo que necesita a una persona en una sola lista, en el
 * orden que entrega el servidor. Cada fila abre lo que ya existe (aprobar, el
 * resumen del caso, la lista del asesor) o lleva a donde se resuelve.
 */
export function WaitingList({
  rows,
  context,
  handlers,
  notice,
}: {
  rows: WaitingRow[]
  context: HomeTextContext
  handlers: WaitingHandlers
  /** Aviso sobre lo último que se decidió aquí (una propuesta que falló o caducó). */
  notice?: ReactNode
}) {
  const headingId = useId()
  const [expanded, setExpanded] = useState(false)
  const hidden = rows.length - PHONE_ROWS
  // Al abrir el resto en teléfono, el foco pasa a la primera fila que aparece.
  const list = useRef<HTMLUListElement>(null)
  useEffect(() => {
    if (expanded) list.current?.querySelector<HTMLElement>(`li:nth-child(${PHONE_ROWS + 1}) :is(a, button)`)?.focus()
  }, [expanded])
  return (
    <section aria-labelledby={headingId} className="enter elevated flex min-w-0 flex-col rounded-xl border bg-card p-3 sm:p-4">
      <div className="flex flex-wrap items-baseline gap-x-2 px-2 pb-1.5">
        <h2 id={headingId} className="text-[17px] font-bold tracking-tight">
          Te espera
        </h2>
        {rows.length > 0 ? <p className="text-sm text-muted-foreground">Por orden de urgencia</p> : null}
      </div>
      {notice ? <div className="px-2 pb-2">{notice}</div> : null}
      {rows.length === 0 ? (
        <p className="flex items-center gap-2 px-2 py-3 font-semibold">
          <CheckCircle2 className="size-5 shrink-0 text-success" aria-hidden />
          Nada te espera por ahora
        </p>
      ) : (
        <ul ref={list} className="flex flex-col divide-y">
          {rows.map((row, index) => (
            <WaitingRowItem
              key={waitingKey(row)}
              row={row}
              context={context}
              handlers={handlers}
              className={index >= PHONE_ROWS && !expanded ? "hidden sm:block" : undefined}
            />
          ))}
        </ul>
      )}
      {hidden > 0 && !expanded ? (
        <Button type="button" variant="ghost" className="mt-1 min-h-11 w-full justify-center font-semibold text-primary sm:hidden" onClick={() => setExpanded(true)}>
          {hidden === 1 ? "Ver la otra" : `Ver las otras ${hidden}`}
        </Button>
      ) : null}
    </section>
  )
}
