import { Badge, Button, buttonVariants, cn, Textarea } from "@odentia/ui"
import { AgentMark } from "@odentia/ui-patterns"
import { Link } from "@tanstack/react-router"
import { CalendarClock, CheckCircle2, FileText, KeyRound, Lightbulb, type LucideIcon, MessageCircle, MessagesSquare, Package, SquareCheckBig, Stethoscope, UserRound, UsersRound } from "lucide-react"
import { type ReactElement, type ReactNode, useEffect, useId, useRef, useState } from "react"
import { duplicateActions, type HomeTextContext, PHONE_ROWS, waitingKey, waitingOpenText, waitingText } from "../../lib/home"
import { channelLabel } from "../../lib/channels"
import type { WaitingRow } from "../../lib/workspace"
import { HandoffUrgency } from "../agent/handoff-badges"

type RowOf<K extends WaitingRow["kind"]> = Extract<WaitingRow, { kind: K }>

export interface WaitingHandlers {
  onCase: (row: RowOf<"case">) => void
  onAdvice: (row: RowOf<"advice">) => void
  onUnreached: () => void
  onBudgets: (row: RowOf<"budgets">) => void
  /** «Tomar este tema» de un caso que nadie ha tomado; sin esto (sin permiso) la fila solo abre el caso. */
  onTake?: (row: RowOf<"case">) => void
  /**
   * «Responder» un tema aquí mismo (R3 y decisión 3 del pulido de la Bandeja):
   * el odontólogo, su duda clínica; caja, un pago. Devuelve el error en palabras, o nulo.
   */
  onReply?: (row: RowOf<"case">, text: string) => Promise<string | null>
  /** Quien no abre el resumen del caso (caja): la fila de un tema que responde abre la respuesta. */
  noCaseBrief?: boolean
  /** «Hecha» en una tarea; sin esto (sin permiso) la fila solo la abre. */
  onDone?: (row: RowOf<"task">) => void
  /** «Revisada» una posible ficha repetida: cierra la tarea que la recuerda. */
  onReviewed?: (row: RowOf<"possibleDuplicate">) => void
  /** «Confirmar» el representante que nombró un registro en línea: lo vincula y cierra la tarea. */
  onConfirmRepresentative?: (row: RowOf<"possibleDuplicate">) => void
  /**
   * «No es ella» en el representante por confirmar y «Descartar» en «Alguien
   * se registró con el documento de…»: cierra la tarea con su motivo, sin
   * vincular ni cambiar a nadie.
   */
  onDiscard?: (row: RowOf<"possibleDuplicate">) => void
  /** «Llegó»: quien terminó su registro entra a la clínica. */
  onArrived?: (row: RowOf<"registrationDone">) => void
  /** «Revisar»: abre «¿Es la misma persona?» con lo que escribió quien se registró por el código QR. */
  onReviewRegistration?: (row: RowOf<"possibleDuplicate">) => void
  /** «Pedir lo que falta» del inventario de una sede: arma los borradores de compra (ADR 0067). */
  onReorder?: (row: RowOf<"inventory">) => void
  /** «Anular con motivo» una atención de otro día sin cerrar; la fila la continúa. */
  onVoidEncounter?: (row: RowOf<"staleEncounter">) => void
  /** La fila cuya acción está en curso: sus botones se desactivan y el de la acción dice que trabaja. */
  busyKey?: string | null
  /** Con dos botones, cuál está en curso (`confirmar`, `descartar`); sin esto, el primero. */
  busyAction?: string | null
}

/** Toda la fila es el control: mismo alto, mismo orden y la acción a la derecha. */
const ROW =
  "h-auto min-h-[60px] w-full min-w-0 flex-1 justify-start gap-3 rounded-lg px-2 py-2 text-left text-sm font-normal whitespace-normal"

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
  if (row.kind === "unreached") return <AgentMark className="rounded-full" />
  if (row.kind === "case") return <TypeIcon icon={UserRound} urgent={row.urgent ?? row.priority === "alta"} />
  if (row.kind === "staleEncounter") return <TypeIcon icon={Stethoscope} />
  if (row.kind === "registrationDone") return <TypeIcon icon={UsersRound} />
  if (row.kind === "more" && row.of === "cases") return <TypeIcon icon={UserRound} />
  if (row.kind === "unconfirmed" || (row.kind === "more" && row.of === "unconfirmed")) return <TypeIcon icon={CalendarClock} />
  if (row.kind === "conversations") return <TypeIcon icon={MessageCircle} />
  if (row.kind === "stillOpen") return <TypeIcon icon={MessagesSquare} />
  if (row.kind === "advice") return <TypeIcon icon={Lightbulb} />
  if (row.kind === "promotion") return <TypeIcon icon={MessageCircle} />
  if (row.kind === "inventory") return <TypeIcon icon={Package} />
  if (row.kind === "possibleDuplicate") return <TypeIcon icon={UsersRound} />
  if (row.kind === "portalReentry") return <TypeIcon icon={KeyRound} />
  if (row.kind === "budgets" || row.kind === "unsentBudget" || row.kind === "consentToPublish" || (row.kind === "more" && row.of === "unsentBudgets"))
    return <TypeIcon icon={FileText} />
  return <TypeIcon icon={SquareCheckBig} />
}

/** La insignia que acompaña al título: la urgencia de un caso o una tarea vencida. */
function badgeOf(row: WaitingRow): ReactNode {
  if (row.kind === "case") return <HandoffUrgency priority={row.priority} urgent={row.urgent} />
  if (row.kind === "task" && row.due === "overdue") return <Badge variant="destructive">Vencida</Badge>
  return null
}

/**
 * A dónde lleva la fila cuando se resuelve navegando; null si abre algo en esta pantalla.
 * Lo que navega es un enlace con aspecto de fila, no un botón: así lo anuncia el lector de pantalla.
 */
function linkOf(row: WaitingRow, context: HomeTextContext, props: { className: string; children: ReactNode }): ReactElement | null {
  // «y N tareas más» abre Tareas en la vista de quien mira: la del equipo para quien dirige, las suyas para los demás.
  const tasksView = context.allTasks ? "todas" : "mias"
  switch (row.kind) {
    case "case":
      // Los casos del agente viven aquí y en el panel lateral (decisión 21): sin conversación, su tarea en Tareas.
      return row.conversationId ? null : <Link to="/tasks" search={{ task: undefined, vista: tasksView }} {...props} />
    case "registrationDone":
      return <Link to="/patients/$patientId" params={{ patientId: row.patientId }} {...props} />
    case "staleEncounter":
      return <Link to="/patients/$patientId/encounters/$encounterId" params={{ patientId: row.patientId, encounterId: row.id }} {...props} />
    case "unconfirmed":
      return <Link to="/agenda" search={{ appointmentId: row.id }} {...props} />
    case "unsentBudget":
      // El Plan de la persona: «Qué sigue» ofrece «Enviar» y dice por dónde y a quién le llega.
      return <Link to="/patients/$patientId" params={{ patientId: row.patientId }} search={{ tab: "plan", budgetId: row.id }} {...props} />
    case "possibleDuplicate":
      // Datos personales de la persona: ahí se ve el documento y se decide si son la misma.
      if (row.patientId) return <Link to="/patients/$patientId" params={{ patientId: row.patientId }} search={{ tab: "filiacion" }} {...props} />
      // Quien tenía el documento aún no es paciente: su página de persona.
      return row.personId ? <Link to="/people/$personId" params={{ personId: row.personId }} {...props} /> : null
    case "portalReentry":
      // Datos › Acceso al portal: la fila de su acceso dice «Pidió volver a entrar» y ofrece «Enviar nuevo enlace».
      return <Link to="/patients/$patientId" params={{ patientId: row.patientId }} search={{ tab: "portal" }} {...props} />
    case "consentToPublish":
      return <Link to="/settings/forms" search={{ tab: "consentimientos" }} {...props} />
    case "inventory":
      // Inventario de esa sede con su filtro: lo que hace falta o, si solo hay vencidos, lo que vence.
      return <Link to="/inventory" search={{ branch: row.branchId, ver: row.needed > 0 ? "hacen_falta" : "por_vencer" }} {...props} />
    case "promotion":
      // El mensaje abierto, listo para cambiarle el texto.
      return <Link to="/settings/integrations/whatsapp" search={{ mensaje: row.messageId }} {...props} />
    case "conversations":
      return <Link to="/inbox" search={{ conversation: undefined, view: undefined }} {...props} />
    case "stillOpen":
      return row.conversationId
        ? <Link to="/inbox" search={{ conversation: row.conversationId }} {...props} />
        : <Link to="/inbox" search={{ conversation: undefined, view: undefined }} {...props} />
    case "task":
      return row.more > 0 ? <Link to="/tasks" search={{ task: undefined, vista: tasksView }} {...props} /> : <Link to={row.href} {...props} />
    case "more":
      if (row.of === "tasks") return <Link to="/tasks" search={{ task: undefined, vista: tasksView }} {...props} />
      if (row.of === "unconfirmed") return <Link to="/agenda" search={{}} {...props} />
      if (row.of === "unsentBudgets") return <Link to="/people" search={{}} {...props} />
      // «y N casos más»: cada caso es una tarea de Recepción («Te lo pasó Sofi»).
      return <Link to="/tasks" search={{ task: undefined, vista: tasksView }} {...props} />
    default:
      return null
  }
}

function open(row: WaitingRow, handlers: WaitingHandlers) {
  if (row.kind === "case") handlers.onCase(row)
  else if (row.kind === "advice") handlers.onAdvice(row)
  else if (row.kind === "unreached") handlers.onUnreached()
  else if (row.kind === "budgets") handlers.onBudgets(row)
}

type QuickAction = { id: string; label: string; run: () => void; primary: boolean }

/**
 * Lo que la fila hace sin salir de Inicio: «Tomar» un caso que nadie tomó,
 * «Hecha» en una tarea, «Confirmar» o «No es ella» en un representante por
 * confirmar. Son botones aparte de la fila, que sigue abriendo el caso, la
 * tarea o la persona.
 */
function quickActions(row: WaitingRow, handlers: WaitingHandlers, reply: { open: boolean; toggle: () => void }): QuickAction[] {
  // Lo que se responde aquí no se toma antes: responder ya lo toma (decisión 3 del pulido).
  if (row.kind === "case" && row.canReply && handlers.onReply) {
    return reply.open ? [] : [{ id: "responder", label: "Responder", run: reply.toggle, primary: true }]
  }
  // «Tomar este tema» toma el tema, como en la Bandeja: sin conversación la fila lleva a su tarea.
  if (row.kind === "case" && row.unclaimed && row.conversationId && handlers.onTake) {
    const take = handlers.onTake
    return [{ id: "tomar", label: "Tomar este tema", run: () => take(row), primary: true }]
  }
  if (row.kind === "registrationDone" && handlers.onArrived) {
    const arrived = handlers.onArrived
    return [{ id: "llego", label: "Llegó", run: () => arrived(row), primary: true }]
  }
  if (row.kind === "staleEncounter" && handlers.onVoidEncounter) {
    const discard = handlers.onVoidEncounter
    return [{ id: "anular", label: "Anular con motivo", run: () => discard(row), primary: false }]
  }
  // Un documento repetido: la fila lleva a la persona y los botones confirman o descartan (sin permiso, no hay botón).
  if (row.kind === "possibleDuplicate") {
    const run = { confirmar: handlers.onConfirmRepresentative, descartar: handlers.onDiscard, revisada: handlers.onReviewed, revisar: handlers.onReviewRegistration }
    return duplicateActions(row).flatMap((action) => {
      const handler = run[action.id]
      return handler ? [{ ...action, run: () => handler(row) }] : []
    })
  }
  if (row.kind === "inventory" && row.needed > 0 && handlers.onReorder) {
    const reorder = handlers.onReorder
    return [{ id: "pedir", label: "Pedir lo que falta", run: () => reorder(row), primary: true }]
  }
  if (row.kind === "task" && row.more === 0 && handlers.onDone) {
    const done = handlers.onDone
    return [{ id: "hecha", label: "Hecha", run: () => done(row), primary: false }]
  }
  return []
}

/**
 * Responder un tema sin salir de Inicio (tablero 4d del pulido de la Bandeja):
 * su pregunta, la respuesta y «Enviar y resolver». Es la misma respuesta de la
 * Bandeja: cita su pregunta y el tema queda resuelto.
 */
function TopicReply({ row, context, onReply, onClose }: { row: RowOf<"case">; context: HomeTextContext; onReply: NonNullable<WaitingHandlers["onReply"]>; onClose: () => void }) {
  const id = useId()
  const [text, setText] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const first = row.contactName?.trim().split(/\s+/)[0] || "la persona"
  return (
    <form
      className="flex basis-full flex-col gap-2 pb-3 pl-11 pr-2"
      onSubmit={async (event) => {
        event.preventDefault()
        if (!text.trim() || pending) return
        setPending(true)
        const failed = await onReply(row, text.trim())
        setPending(false)
        setError(failed)
        if (!failed) setText("")
      }}
    >
      {row.quote ? <p className="text-sm">«{row.quote}»</p> : null}
      <label htmlFor={id} className="sr-only">
        Tu respuesta para {first}
      </label>
      <Textarea id={id} rows={2} value={text} placeholder={`Escribe tu respuesta para ${first}…`} onChange={(event) => setText(event.target.value)} />
      <p className="text-xs text-muted-foreground">
        Se envía por {row.channel ? channelLabel(row.channel) : "su conversación"}, citando su pregunta. {context.receptionName} sigue con lo demás.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <span className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" className="min-h-11 sm:min-h-8" disabled={pending || !text.trim()}>
          {pending ? "Enviando…" : "Enviar y resolver"}
        </Button>
        <Button type="button" variant="ghost" size="sm" className="min-h-11 sm:min-h-8" disabled={pending} onClick={onClose}>
          Cancelar
        </Button>
      </span>
    </form>
  )
}

function WaitingRowItem({ row, context, handlers, className }: { row: WaitingRow; context: HomeTextContext; handlers: WaitingHandlers; className?: string }) {
  const text = waitingText(row, context)
  const badge = badgeOf(row)
  const [replying, setReplying] = useState(false)
  const actions = quickActions(row, handlers, { open: replying, toggle: () => setReplying(true) })
  const key = waitingKey(row)
  const busy = handlers.busyKey === key
  const busyId = busy ? (handlers.busyAction ?? actions[0]?.id) : null
  // Quien no abre el resumen del caso (caja) y ya no puede responder desde aquí
  // (Instagram o Messenger cerrados): la fila lo dice, sin un botón que no lleva a nada.
  const stuck = row.kind === "case" && !row.canReply && handlers.noCaseBrief === true
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
      {/* Con un botón propio, la fila solo abre: a la vista lo dice el botón, y la fila sigue nombrando a dónde lleva para el lector de pantalla. En teléfono la acción no ocupa sitio, pero sigue nombrando la fila. */}
      {actions.length > 0 || replying ? (
        <span className="sr-only">{waitingOpenText(row, context)}</span>
      ) : (
        <span className="sr-only shrink-0 font-semibold text-primary sm:not-sr-only">
          {stuck ? "Lo responde recepción en la Bandeja" : text.action}
        </span>
      )}
    </>
  )
  const link = linkOf(row, context, { className: cn(buttonVariants({ variant: "ghost" }), ROW), children: content })
  return (
    <li className={cn("flex flex-wrap items-center gap-2", className)}>
      {link ?? (stuck ? (
        <div className={cn(ROW, "cursor-default hover:bg-transparent")}>{content}</div>
      ) : (
        <Button
          type="button"
          variant="ghost"
          className={ROW}
          onClick={() => (row.kind === "case" && row.canReply && handlers.onReply && handlers.noCaseBrief ? setReplying(true) : open(row, handlers))}
        >
          {content}
        </Button>
      ))}
      {actions.length > 0 ? (
        <span className="flex shrink-0 flex-col gap-1.5 sm:flex-row sm:items-center">
          {actions.map((action) => (
            <Button
              key={action.id}
              type="button"
              size="sm"
              variant={action.primary ? "default" : "outline"}
              className="min-h-11 shrink-0 sm:min-h-8"
              disabled={busy}
              aria-label={`${action.label}: ${text.title}`}
              onClick={action.run}
            >
              {busyId === action.id ? "Guardando…" : action.label}
            </Button>
          ))}
        </span>
      ) : null}
      {replying && row.kind === "case" && handlers.onReply ? (
        <TopicReply row={row} context={context} onReply={handlers.onReply} onClose={() => setReplying(false)} />
      ) : null}
    </li>
  )
}

/**
 * «Te espera»: la única lista de lo que hay que hacer, una fila por asunto, en
 * el orden que entrega el servidor. Cada fila abre lo que ya existe (el
 * resumen del caso, la recomendación del administrador) o lleva a donde se
 * resuelve; «Tomar» y «Hecha» se hacen aquí mismo. Lo que está aquí no llega a
 * la campana.
 */
export function WaitingList({
  rows,
  context,
  handlers,
  error,
}: {
  rows: WaitingRow[]
  context: HomeTextContext
  handlers: WaitingHandlers
  /** Lo que no se pudo hacer con «Tomar» o «Hecha». */
  error?: string | null
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
        <h2 id={headingId} className="flex items-center gap-2 text-[17px] font-bold tracking-tight">
          Te espera
          {rows.length > 0 ? (
            <Badge variant="secondary" className="tabular-nums">
              {rows.length}
              <span className="sr-only"> {rows.length === 1 ? "asunto" : "asuntos"}</span>
            </Badge>
          ) : null}
        </h2>
        {rows.length > 0 ? <p className="text-sm text-muted-foreground">Por orden de urgencia</p> : null}
      </div>
      {error ? (
        <p role="alert" className="px-2 pb-1 text-sm text-destructive">
          {error}
        </p>
      ) : null}
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
              className={index >= PHONE_ROWS && !expanded ? "hidden sm:flex" : undefined}
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
