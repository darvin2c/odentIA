import { Button, cn, ScrollArea, Spinner } from "@odentia/ui"
import {
  ConfirmDialog,
  DetailDrawer,
  EmptyState,
  internationalText,
  LoadingState,
  submitErrorMessage,
  useAppForm,
  useFormSubmit,
  useFormSubmitError,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useBlocker } from "@tanstack/react-router"
import { ChevronLeft, ChevronRight, Plus, RefreshCw, X } from "lucide-react"
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useRef, useState } from "react"
import { z } from "zod"
import { useReceptionName, withReceptionName } from "../../lib/agent-names"
import { ApiError, apiFetch } from "../../lib/api"
import { channelLabel } from "../../lib/channels"
import { type OpportunityListItem, type TaskItem, timeAgo, useCan } from "../../lib/crm"
import {
  activityKindLabel,
  type CrmActivityItem,
  type CrmNextAppointment,
  createCrmNote,
  crmActivityQueryKey,
  crmContextQueryKey,
  fetchCrmActivityPage,
  fetchCrmContext,
  messagePermissionsSaid,
  nextAppointmentSaid,
} from "../../lib/crm-workspace"
import { activeOrgLocale } from "../../lib/locale"
import { isReceiptOnly, useOrgEvents } from "../../lib/org-events"
import type { PatientFull } from "../../lib/patients"
import { usePerson } from "../../lib/people"
import { amountFromCents } from "../../lib/workspace"
import { productUi } from "../../product/product-ui"
import { PersonMemoryDrawer } from "../agent/person-memory"
import { CitasPanel } from "../patient/citas-panel"
import { PersonData } from "../person/person-data"
import { dueWords, isOverdue } from "./crm-helpers"
import { OpportunityDrawer } from "./opportunity-drawer"
import { OpportunityPanel } from "./opportunity-panel"
import { PhoneMatchPrompt } from "./phone-match"
import { useCompleteTask } from "./resolve-preview"
import { TaskDrawer } from "./task-drawer"

const AccountTab = lazy(() => import("../patient/account-tab").then((m) => ({ default: m.AccountTab })))
const AntecedentesTab = lazy(() => import("../patient/antecedentes-tab").then((m) => ({ default: m.AntecedentesTab })))
const DocumentosSection = lazy(() => import("../patient/documentos-panel").then((m) => ({ default: m.DocumentosSection })))
const HistoriaTab = lazy(() => import("../patient/historia-tab").then((m) => ({ default: m.HistoriaTab })))
const PlanTab = lazy(() => import("../patient/plan-tab").then((m) => ({ default: m.PlanTab })))

export type ContextSection = "citas" | "plan" | "clinica" | "alertas" | "cobros" | "ventas" | "datos" | "notas"

/** Lo que entrega el servidor: quién es y una línea por cada sección que este rol puede abrir. */
interface ConversationContext {
  contactId: string
  patientId: string | null
  name: string
  phone: string | null
  email: string | null
  nextAppointment: CrmNextAppointment | null
  lines: Partial<Record<"plan" | "alertas" | "cobros" | "ventas" | "datos" | "recuerda", string>>
  attention: Array<"alertas" | "cobros" | "datos">
}

export const conversationContextKey = (conversationId: string) => ["conversation-context", conversationId] as const

/**
 * Importe de una oportunidad con su moneda. Llega en la unidad menor de esa
 * moneda: los decimales los pone ella (ISO 4217), no una división fija.
 */
function money(amountCents: number | null, currency: string): string {
  if (amountCents === null) return "Sin monto"
  try {
    return amountFromCents(String(amountCents), currency).toLocaleString(activeOrgLocale(), { style: "currency", currency })
  } catch {
    // Moneda que este navegador no reconoce: no se inventa cuántos decimales tiene.
    return "Monto no disponible"
  }
}

const ACTIVITY_STATUS_LABEL: Record<string, string> = {
  propuesta: "Pendiente", aprobada: "Aprobada",
  ejecutada: "Ejecutada", fallida: "Fallida", expirada: "Expirada",
  open: "Abierta", done: "Completada", cancelled: "Cancelada",
  received: "Recibido", queued: "En cola", sent: "Enviado",
  delivered: "Entregado", read: "Leído", failed: "Fallido",
  normal: "Prioridad normal", urgent: "Prioridad urgente",
}

export interface ContactWorkspaceProps {
  conversationId: string
  /** La sección abierta: la pide también una tarjeta del hilo. */
  section: ContextSection | null
  onSectionChange: (section: ContextSection | null) => void
  onRefresh?: () => void
  onClose?: () => void
  /** Informa a la bandeja si hay borrador sin guardar (para guardar el cierre del panel). */
  onDraftChange?: (dirty: boolean) => void
  /** Dentro del cajón estándar: sin su propia tarjeta ni su botón de cerrar, que los pone el cajón. */
  bare?: boolean
}

/**
 * «Contexto» de la Bandeja: una fila por sección, con lo que hay dentro en una
 * línea. Tocar una fila entra a esa sección en el mismo panel, con los mismos
 * componentes de la página de la persona y sus permisos; lo que necesita ancho
 * (historia, odontograma, documentos) se abre grande. Sin salir de la Bandeja.
 */
export function ContactWorkspace({ conversationId, section, onSectionChange, onRefresh, onClose, onDraftChange, bare = false }: ContactWorkspaceProps) {
  const queryClient = useQueryClient()
  const receptionName = useReceptionName()
  const can = useCan()
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [wide, setWide] = useState<{ id: string; label: string } | null>(null)
  const [noteDirty, setNoteDirty] = useState(false)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  // Al entrar a una sección el foco va a su título; al volver, a la fila de la que salió. Sin esto, se pierde.
  const lastSection = useRef(section)
  useEffect(() => {
    const previous = lastSection.current
    if (previous === section) return
    lastSection.current = section
    if (section) headingRef.current?.focus()
    else rootRef.current?.querySelector<HTMLElement>(`[data-context-row="${previous}"]`)?.focus()
  }, [section])
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh
  const noteDirtyRef = useRef(noteDirty)
  noteDirtyRef.current = noteDirty
  const convRef = useRef(conversationId)
  convRef.current = conversationId

  // Borrador local sin storage: cambiar de hilo, cerrar el contexto móvil o
  // salir de la bandeja con borrador bloquea la navegación del router y pide
  // confirmación real. Drawers y secciones son estado local y nunca navegan.
  const draftBlocker = useBlocker({
    disabled: !noteDirty,
    enableBeforeUnload: false,
    withResolver: true,
    shouldBlockFn: ({ current, next }) => {
      if (!noteDirtyRef.current) return false
      if (next.routeId !== "/_org/inbox") return true
      const nextSearch = next.search as Record<string, unknown>
      const nextConv = typeof nextSearch.conversation === "string" ? nextSearch.conversation : undefined
      if (nextConv !== (convRef.current ?? undefined)) return true
      // Cerrar el contexto en móvil (contexto=true → ausente) desmonta el
      // workspace en el mismo hilo: también pide confirmación.
      const currentSearch = current.search as Record<string, unknown>
      return currentSearch.contexto === true && nextSearch.contexto !== true
    },
  })
  useEffect(() => {
    onDraftChange?.(noteDirty)
  }, [noteDirty, onDraftChange])
  // Recargar o cerrar la pestaña con borrador pide confirmación del navegador.
  useEffect(() => {
    if (!noteDirty) return
    const handler = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener("beforeunload", handler)
    return () => window.removeEventListener("beforeunload", handler)
  }, [noteDirty])

  const query = useQuery({
    queryKey: conversationContextKey(conversationId),
    queryFn: () => apiFetch<{ data: ConversationContext }>(`/api/conversations/${conversationId}/context`),
  })
  const context = query.data?.data ?? null
  const contactId = context?.contactId ?? null

  const handleOrgEvent = useCallback(
    (kind: string, data: unknown) => {
      // El acuse de un mensaje no cambia el contexto de la persona.
      if (isReceiptOnly(kind, data)) return
      for (const key of ["conversation-context", "crm-context", "crm-activity", "crm-opportunities"]) {
        void queryClient.invalidateQueries({ queryKey: [key] })
      }
      if (kind === "stream.reconnected") onRefreshRef.current?.()
    },
    [queryClient],
  )
  useOrgEvents(
    [
      "message.created",
      "message.updated",
      "conversation.updated",
      "contact.updated",
      "opportunity.updated",
      "task.updated",
      "agent.proposal.executed",
      "agent.handoff.created",
      // La próxima cita cambia con la Agenda, el agente o el enlace de reserva.
      "appointment.updated",
      "stream.reconnected",
    ],
    handleOrgEvent,
  )

  if (query.isLoading) return <LoadingState className="min-h-0 flex-1" message="Cargando contexto…" />
  if (query.isError || !context || !contactId) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <p className="text-sm text-destructive" role="alert">
          {query.error instanceof ApiError ? (query.error.shape.message ?? "No se pudo cargar el contexto") : "No se pudo cargar el contexto de la persona."}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" className="w-fit" onClick={() => void query.refetch()}>
            <RefreshCw className="size-3.5" />
            Reintentar
          </Button>
          {onClose ? (
            <Button variant="ghost" size="sm" className="w-fit" onClick={onClose}>
              Volver a la conversación
            </Button>
          ) : null}
        </div>
      </div>
    )
  }

  const { lines, patientId } = context
  const warn = (id: "alertas" | "cobros" | "datos") => context.attention.includes(id)
  const next = context.nextAppointment
  // Cada fila, solo para quien puede abrirla: la misma regla que la página de la persona. Lo que el servidor no dice, no se escribe.
  const rows: Array<{ id: ContextSection | "recuerda"; label: string; line: string; warn?: boolean }> = [
    ...(can("appointments.read")
      ? [{ id: "citas" as const, label: "Citas", line: next ? `Próxima: ${nextAppointmentSaid(next, activeOrgLocale(), context.name)}` : "Sin próxima cita" }]
      : []),
    ...(patientId && lines.plan ? [{ id: "plan" as const, label: "Plan y presupuesto", line: lines.plan }] : []),
    ...(patientId && lines.alertas
      ? [can("clinical.read")
          ? { id: "clinica" as const, label: "Clínica", line: lines.alertas, warn: warn("alertas") }
          : { id: "alertas" as const, label: "Alergias y alertas", line: lines.alertas, warn: warn("alertas") }]
      : []),
    ...(patientId && lines.cobros ? [{ id: "cobros" as const, label: "Cobros", line: lines.cobros, warn: warn("cobros") }] : []),
    ...(lines.ventas ? [{ id: "ventas" as const, label: "Oportunidades y tareas", line: lines.ventas }] : []),
    ...(lines.datos ? [{ id: "datos" as const, label: "Datos", line: lines.datos, warn: warn("datos") }] : []),
    ...(lines.recuerda ? [{ id: "recuerda" as const, label: `Lo que recuerda ${receptionName}`, line: lines.recuerda }] : []),
    ...(can("crm.read") ? [{ id: "notas" as const, label: "Notas y actividad", line: "Lo que anotó el equipo y lo que pasó" }] : []),
  ]
  const current = rows.find((row) => row.id === section) ?? null

  return (
    // El desplazamiento de la columna es el de la aplicación (ScrollArea), no la barra nativa.
    <div ref={rootRef} className={bare ? "flex min-h-0 flex-1 flex-col" : "elevated flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card"}>
      <section aria-label="Contexto del contacto" className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-1.5 border-b px-3 py-2.5">
          {current ? (
            <Button variant="ghost" size="icon-sm" aria-label="Volver al contexto" className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8" onClick={() => onSectionChange(null)}>
              <ChevronLeft className="size-4" />
            </Button>
          ) : null}
          <div className="min-w-0 flex-1">
            <h2 ref={headingRef} tabIndex={-1} className="truncate text-[15px] font-bold outline-none">
              {current ? current.label : context.name}
            </h2>
            <p className="truncate text-xs text-muted-foreground">
              {current ? context.name : [context.phone ? internationalText(context.phone) : null, context.email].filter(Boolean).join(" · ") || "Sin datos de contacto"}
            </p>
          </div>
          {can("patients.read") && (can("crm.read") || patientId) ? (
            <Link to="/people/$personId" params={{ personId: contactId }} className="shrink-0 px-1 text-[13px] font-medium text-primary hover:underline">
              Su página
            </Link>
          ) : null}
          {onClose ? (
            <Button variant="ghost" size="icon-sm" className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8" aria-label="Cerrar contexto" onClick={onClose}>
              <X className="size-4" />
            </Button>
          ) : null}
        </div>
        <ScrollArea className="min-h-0 flex-1">
          {!current ? (
            <>
              <PhoneMatchPrompt conversationId={conversationId} />
              <ul className="flex flex-col divide-y border-b">
                {rows.map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      data-context-row={row.id}
                      className="flex min-h-11 w-full items-center gap-2 px-3.5 py-2.5 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                      onClick={() => (row.id === "recuerda" ? setMemoryOpen(true) : onSectionChange(row.id))}
                    >
                      <span className="flex min-w-0 flex-1 flex-col gap-px">
                        <span className="text-sm font-semibold">{row.label}</span>
                        <span className={cn("truncate text-[13px]", row.warn ? "text-warning" : "text-muted-foreground")}>{row.line}</span>
                      </span>
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="flex flex-col gap-3 p-3.5 [&_[class*=grid-cols]]:!grid-cols-1">
              <Suspense fallback={<LoadingState message="Cargando…" />}>
                {current.id === "citas" ? <CitasSection context={context} conversationId={conversationId} /> : null}
                {current.id === "plan" && patientId ? <PlanTab patientId={patientId} patientName={context.name} /> : null}
                {current.id === "alertas" ? <p className={cn("text-sm", warn("alertas") ? "text-warning" : "text-muted-foreground")}>{lines.alertas}</p> : null}
                {current.id === "clinica" ? <ClinicaSection line={lines.alertas ?? ""} warn={warn("alertas")} onOpen={setWide} /> : null}
                {current.id === "cobros" && patientId ? <AccountTab patientId={patientId} part="cuenta" /> : null}
                {current.id === "ventas" ? <VentasSection contactId={contactId} conversationId={conversationId} /> : null}
                {current.id === "datos" ? <DatosSection contactId={contactId} patientId={patientId} /> : null}
                {current.id === "notas" ? <NotasSection contactId={contactId} conversationId={conversationId} onDirtyChange={setNoteDirty} /> : null}
              </Suspense>
            </div>
          )}
        </ScrollArea>
      </section>
      <PersonMemoryDrawer
        contactId={memoryOpen ? contactId : null}
        name={context.name}
        canWrite={can("crm.write") || can("conversations.write")}
        onClose={() => setMemoryOpen(false)}
      />
      {patientId ? <WideSection open={wide} patientId={patientId} name={context.name} onClose={() => setWide(null)} /> : null}
      <ConfirmDialog
        open={draftBlocker.status === "blocked"}
        title="Salir sin guardar la nota"
        description="La nota operativa no se guardó y se perderá al cambiar de hilo o salir. ¿Continuar?"
        confirmLabel="Salir sin guardar"
        variant="default"
        onClose={() => {
          if (draftBlocker.status === "blocked") draftBlocker.reset()
        }}
        onConfirm={() => {
          if (draftBlocker.status === "blocked") draftBlocker.proceed()
        }}
      />
    </div>
  )
}

/** Sus citas y «Reservar cita»: quien aún no es paciente se reserva con su ficha mínima (la crea la Agenda). */
function CitasSection({ context, conversationId }: { context: ConversationContext; conversationId: string }) {
  const can = useCan()
  const { patientId, contactId, name } = context
  return (
    <>
      {can("appointments.write") ? (
        <Link
          to="/agenda"
          search={{ ...(patientId ? { patientId } : {}), contactId, conversationId }}
          className="w-fit rounded-full bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Reservar cita
        </Link>
      ) : null}
      {patientId ? (
        <CitasPanel patientId={patientId} patientName={name} />
      ) : (
        <p className="text-xs text-muted-foreground">
          {name.split(/\s+/)[0]} todavía no es paciente: al reservar se crea su ficha con nombre y teléfono, y lo que falte queda pendiente en su página.
        </p>
      )}
    </>
  )
}

/** Lo clínico: lo que entra en el panel y, en grande, lo que necesita ancho. Abrirlo deja su traza, como en su página. */
function ClinicaSection({ line, warn, onOpen }: { line: string; warn: boolean; onOpen: (section: { id: string; label: string }) => void }) {
  const own = productUi().record.sections.filter((item) => !item.parent)
  const sections = [
    { id: "antecedentes", label: "Antecedentes" },
    ...own.map((item) => ({ id: item.id, label: item.label })),
    { id: "historia", label: "Historia" },
    { id: "documentos", label: "Documentos" },
  ]
  return (
    <>
      <p className={cn("text-sm", warn ? "text-warning" : "text-muted-foreground")}>{line}</p>
      <ul className="flex flex-col divide-y rounded-lg border">
        {sections.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              onClick={() => onOpen(item)}
            >
              {item.label}
              <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}

/** Historia, odontograma y documentos, grandes y encima de la Bandeja: cerrarlos vuelve a la conversación. */
function WideSection({ open, patientId, name, onClose }: { open: { id: string; label: string } | null; patientId: string; name: string; onClose: () => void }) {
  const own = open ? productUi().record.sections.find((item) => item.id === open.id) : undefined
  const record = useQuery({
    queryKey: ["patient", patientId],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${patientId}`),
    enabled: Boolean(own),
    retry: false,
  })
  const content = (): ReactNode => {
    if (!open) return null
    if (open.id === "antecedentes") return <AntecedentesTab patientId={patientId} />
    if (open.id === "historia") return <HistoriaTab patientId={patientId} onOdontogramSelect={() => undefined} />
    if (open.id === "documentos") return <DocumentosSection patientId={patientId} />
    if (!own) return null
    return own.render({ patientId, record: record.data?.data ?? null, place: undefined, opened: undefined, openSection: () => undefined })
  }
  return (
    <DetailDrawer
      open={open !== null}
      onClose={onClose}
      size="xl"
      className="data-[swipe-axis=x]:sm:[--drawer-content-width:min(60rem,calc(100vw-2rem))]"
      title={open ? `${open.label} de ${name}` : ""}
      closeLabel="Volver a la conversación"
    >
      <Suspense fallback={<LoadingState message="Cargando…" />}>{content()}</Suspense>
    </DetailDrawer>
  )
}

function DatosSection({ contactId, patientId }: { contactId: string; patientId: string | null }) {
  const can = useCan()
  const person = usePerson(contactId, can("patients.read"))
  const detail = useQuery({
    queryKey: ["patient", patientId],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${patientId}`),
    enabled: Boolean(patientId),
    retry: false,
  })
  const crm = useQuery({
    queryKey: crmContextQueryKey(contactId, undefined),
    queryFn: () => fetchCrmContext(contactId),
    enabled: can("crm.read"),
  })
  const page = person.data?.data
  if (person.isLoading) return <LoadingState message="Cargando datos…" />
  return (
    <>
      {crm.data ? <p className="text-[13px] text-muted-foreground">Mensajes: {messagePermissionsSaid(crm.data.data.messages)}</p> : null}
      {page ? <PersonData person={page} detail={detail.data?.data} /> : null}
    </>
  )
}

/** Oportunidades y tareas de la persona: abrir, crear y completar sin salir del caso. */
function VentasSection({ contactId, conversationId }: { contactId: string; conversationId: string }) {
  const can = useCan()
  const queryClient = useQueryClient()
  const canReadTasks = can("tasks.read")
  const canWriteTasks = can("tasks.write")
  const [oppPanel, setOppPanel] = useState<string | null>(null)
  const [oppDrawer, setOppDrawer] = useState(false)
  const [taskDrawer, setTaskDrawer] = useState(false)
  const refresh = () => {
    for (const key of ["crm-context", "crm-opportunities", "conversation-context", "tasks", "conversations"]) {
      void queryClient.invalidateQueries({ queryKey: [key] })
    }
  }
  const context = useQuery({
    queryKey: crmContextQueryKey(contactId, conversationId),
    queryFn: () => fetchCrmContext(contactId, conversationId),
  })
  const oppsQuery = useInfiniteQuery({
    queryKey: ["crm-opportunities", contactId],
    queryFn: ({ pageParam }) =>
      apiFetch<{ data: OpportunityListItem[]; nextCursor: string | null }>(
        `/api/opportunities?contactId=${encodeURIComponent(contactId)}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
      ),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor,
  })
  const taskMutation = useMutation({
    mutationFn: (input: { id: string; status: string }) =>
      apiFetch(`/api/tasks/${input.id}`, { method: "PATCH", body: JSON.stringify({ status: input.status }) }),
    onSuccess: refresh,
  })
  const completion = useCompleteTask(refresh)
  const opps = oppsQuery.data?.pages.flatMap((page) => page.data) ?? []
  const tasks: TaskItem[] = canReadTasks ? (context.data?.data.tasks ?? []) : []
  // Las acciones sueltas de la tarea dicen su fallo arriba, también sin red.
  const error = taskMutation.error ? submitErrorMessage(taskMutation.error) : completion.error
  return (
    <>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {completion.dialog}
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Oportunidades</h3>
        <Button variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => setOppDrawer(true)}>
          <Plus className="size-3.5" />
          Nueva
        </Button>
      </div>
      {oppsQuery.isLoading ? (
        <p className="text-xs text-muted-foreground">Cargando oportunidades…</p>
      ) : oppsQuery.isError ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-destructive" role="alert">
            No se pudieron cargar las oportunidades.
          </p>
          <Button variant="ghost" size="sm" onClick={() => void oppsQuery.refetch()}>
            Reintentar
          </Button>
        </div>
      ) : opps.length === 0 ? (
        <p className="text-xs text-muted-foreground">Sin oportunidades para este contacto.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {opps.map((opp) => (
            <li key={opp.id} className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm">
              <span className="min-w-0">
                <span className="block truncate font-medium">{opp.title}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {opp.status === "won" ? "Ganada" : opp.status === "lost" ? "Perdida" : opp.stageName} · {money(opp.amountCents, opp.currency)}
                  {opp.nextTask ? ` · ${opp.nextTask.title}${opp.nextTask.dueAt ? ` · ${dueWords(opp.nextTask.dueAt)}` : ""}` : ""}
                </span>
                {opp.why ? <span className="block truncate text-xs text-muted-foreground">{opp.why}</span> : null}
              </span>
              <Button variant="ghost" size="sm" className="min-h-11 shrink-0 sm:min-h-8" onClick={() => setOppPanel(opp.id)}>
                Abrir
              </Button>
            </li>
          ))}
        </ul>
      )}
      {oppsQuery.hasNextPage ? (
        <Button variant="ghost" size="sm" className="self-center" disabled={oppsQuery.isFetchingNextPage} onClick={() => void oppsQuery.fetchNextPage()}>
          {oppsQuery.isFetchingNextPage ? <Spinner className="size-4" aria-hidden /> : null}
          Cargar más
        </Button>
      ) : null}
      <div className="flex items-center justify-between gap-2 border-t pt-3">
        <h3 className="text-sm font-semibold">Tareas</h3>
        {canWriteTasks ? (
          <Button variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => setTaskDrawer(true)}>
            <Plus className="size-3.5" />
            Nueva tarea
          </Button>
        ) : null}
      </div>
      {!canReadTasks ? (
        <p className="text-xs text-muted-foreground">Sin permiso de lectura de tareas.</p>
      ) : tasks.length === 0 ? (
        <p className="text-xs text-muted-foreground">Sin tareas abiertas para este contacto.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {tasks.map((task) => {
            const done = task.status === "done"
            const overdue = !done && isOverdue(task.dueAt)
            return (
              <li key={task.id} className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm">
                <span className="min-w-0">
                  <span className={`block truncate ${done ? "line-through" : ""}`}>{task.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {[task.opportunityTitle, task.dueAt ? `vence ${dueWords(task.dueAt)}` : null].filter(Boolean).join(" · ") || "Sin vencimiento"}
                    {overdue ? " · vencida" : ""}
                  </span>
                </span>
                {canWriteTasks ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="min-h-11 shrink-0 sm:min-h-8"
                    disabled={taskMutation.isPending || completion.pendingId !== null}
                    onClick={() =>
                      // Completar la de un caso del agente muestra antes lo mismo que «Resolver».
                      done ? taskMutation.mutate({ id: task.id, status: "open" }) : void completion.complete(task.id)
                    }
                  >
                    {done ? "Reabrir" : "Completar"}
                  </Button>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      <OpportunityDrawer
        open={oppDrawer}
        contactId={contactId}
        conversationId={conversationId}
        onClose={() => setOppDrawer(false)}
        onSaved={() => {
          setOppDrawer(false)
          refresh()
        }}
      />
      <OpportunityPanel opportunityId={oppPanel} onClose={() => setOppPanel(null)} />
      <TaskDrawer
        open={taskDrawer}
        contactId={contactId}
        conversationId={conversationId}
        onClose={() => setTaskDrawer(false)}
        onSaved={() => {
          setTaskDrawer(false)
          refresh()
        }}
      />
    </>
  )
}

/** El mismo límite que `POST /api/crm/contacts/:id/notes`. */
const NOTE_MAX_LENGTH = 2000

const noteSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, "Escribe la nota.")
    .max(NOTE_MAX_LENGTH, `La nota admite hasta ${NOTE_MAX_LENGTH} caracteres.`),
})

/** Nota operativa y bitácora: lo demás que pasó con la persona. Lo que hizo el agente ya está en el hilo. */
function NotasSection({ contactId, conversationId, onDirtyChange }: { contactId: string; conversationId: string; onDirtyChange: (dirty: boolean) => void }) {
  const can = useCan()
  const queryClient = useQueryClient()
  const [noteOk, setNoteOk] = useState(false)
  // El error de la nota lo dice su campo (o, si no es del campo, junto al botón).
  const noteMutation = useMutation({
    mutationFn: (body: string) => createCrmNote(contactId, { body, conversationId }),
  })
  const noteForm = useAppForm({
    defaultValues: { body: "" },
    validators: { onSubmit: noteSchema },
    onSubmit: async ({ value }) => {
      await noteMutation.mutateAsync(value.body.trim())
      noteForm.reset({ body: "" })
      setNoteOk(true)
      void queryClient.invalidateQueries({ queryKey: ["crm-activity", contactId] })
    },
  })
  const submitNote = useFormSubmit(noteForm)
  const noteError = useFormSubmitError(noteForm)
  const notePending = useStore(noteForm.store, (state) => state.isSubmitting)
  const dirty = useStore(noteForm.store, (state) => state.values.body.trim().length > 0)
  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])
  const activityQuery = useInfiniteQuery({
    queryKey: crmActivityQueryKey(contactId),
    queryFn: ({ pageParam }) => fetchCrmActivityPage(contactId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  })
  const activity = activityQuery.data?.pages.flatMap((page) => page.data) ?? []
  return (
    <>
      {can("crm.write") ? (
        <form noValidate onSubmit={submitNote} className="flex flex-col gap-2">
          <noteForm.AppField name="body" listeners={{ onChange: () => setNoteOk(false) }}>
            {(field) => (
              <field.TextareaField
                label="Nota operativa"
                hideLabel
                rows={2}
                maxLength={NOTE_MAX_LENGTH}
                placeholder="Registra un dato operativo del caso…"
              />
            )}
          </noteForm.AppField>
          {noteOk ? (
            <p className="text-xs text-success" role="status">
              Nota guardada en la bitácora.
            </p>
          ) : null}
          {noteError ? (
            <p className="text-sm text-destructive" role="alert">
              {noteError}
            </p>
          ) : null}
          {dirty && !notePending ? (
            <p className="text-xs text-warning" role="status">
              Borrador sin guardar: cambiar de hilo o salir pedirá confirmación. Guárdalo o descártalo.
            </p>
          ) : null}
          <span className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" className="min-h-11 w-fit sm:min-h-8" disabled={notePending}>
              {notePending ? <Spinner className="size-4" aria-hidden /> : null}
              Guardar nota
            </Button>
            {dirty && !notePending ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="min-h-11 w-fit sm:min-h-8"
                onClick={() => {
                  noteForm.reset({ body: "" })
                  setNoteOk(false)
                }}
              >
                Descartar
              </Button>
            ) : null}
          </span>
        </form>
      ) : null}
      {activityQuery.isLoading && activity.length === 0 ? (
        <p className="text-xs text-muted-foreground">Cargando actividad…</p>
      ) : activityQuery.isError && activity.length === 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-destructive" role="alert">
            No se pudo cargar la bitácora.
          </p>
          <Button variant="ghost" size="sm" onClick={() => void activityQuery.refetch()}>
            Reintentar
          </Button>
        </div>
      ) : activity.length === 0 ? (
        <EmptyState title="Sin actividad" description="Mensajes, notas, tareas y movimientos del caso aparecen aquí." />
      ) : (
        <ol className="flex flex-col gap-2 border-t pt-3">
          {activity.map((item) => (
            <ActivityRow key={item.id} item={item} />
          ))}
        </ol>
      )}
      {activityQuery.hasNextPage ? (
        <Button variant="ghost" size="sm" className="self-center" disabled={activityQuery.isFetchingNextPage} onClick={() => void activityQuery.fetchNextPage()}>
          {activityQuery.isFetchingNextPage ? <Spinner className="size-4" aria-hidden /> : null}
          Cargar anteriores
        </Button>
      ) : null}
    </>
  )
}

function ActivityRow({ item }: { item: CrmActivityItem }) {
  const receptionName = useReceptionName()
  return (
    <li className="flex flex-col gap-0.5 rounded-md border p-2.5">
      <p className="text-sm font-medium">{withReceptionName(item.title, receptionName)}</p>
      {item.body ? <p className="whitespace-pre-wrap text-sm text-muted-foreground">{withReceptionName(item.body, receptionName)}</p> : null}
      <p className="text-xs text-muted-foreground">
        {[
          activityKindLabel(item.kind, receptionName),
          timeAgo(item.at),
          item.channel ? channelLabel(item.channel) : null,
          item.actorName,
          item.status && !item.status.startsWith("opportunity.") ? (ACTIVITY_STATUS_LABEL[item.status] ?? "Estado registrado") : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
    </li>
  )
}
