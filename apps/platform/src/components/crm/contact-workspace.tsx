import { Badge, Button, buttonVariants, cn, Separator, Spinner, Tabs, TabsContent, TabsList, TabsTrigger, Textarea } from "@odentia/ui"
import { ConfirmDialog, EmptyState, internationalText } from "@odentia/ui-patterns"
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useBlocker } from "@tanstack/react-router"
import {
  Bot,
  CheckCircle2,
  Copy,
  Plus,
  RefreshCw,
  UserPlus,
  X,
} from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { ACTION_LABEL, permissionForAction, proposalErrorMessage, type AgentProposal } from "../../lib/agent"
import { channelIcon, channelLabel, identityText } from "../../lib/channels"
import { timeAgo, usePermission, type OpportunityListItem, type TaskItem } from "../../lib/crm"
import {
  activityKindLabel,
  agentNextSteps,
  agentStateDescription,
  agentStateLabel,
  crmActivityQueryKey,
  crmContextQueryKey,
  createCrmNote,
  fetchCrmActivityPage,
  fetchCrmContext,
  messagePermissionsSaid,
  nextAppointmentSaid,
  type CrmActivityItem,
} from "../../lib/crm-workspace"
import { useOrgEvents } from "../../lib/org-events"
import { createRegistrationLink } from "../../lib/patient-registration"
import { dueWords, isOverdue } from "./crm-helpers"
import { PersonMemoryDrawer } from "../agent/person-memory"
import { useCompleteTask } from "./resolve-preview"
import { OpportunityDrawer } from "./opportunity-drawer"
import { OpportunityPanel } from "./opportunity-panel"
import { TaskDrawer } from "./task-drawer"
import { PersonLink } from "../person-link"
import { activeOrgLocale } from "../../lib/locale"
import { amountFromCents } from "../../lib/workspace"

export interface ContactWorkspaceProps {
  contactId: string
  conversationId?: string
  onRefresh?: () => void
  onClose?: () => void
  /** Informa a la bandeja si hay borrador sin guardar (para guardar el cierre del panel). */
  onDraftChange?: (dirty: boolean) => void
}



const RELATIONSHIP_LABEL: Record<string, string> = {
  self: "Es el paciente",
  guardian: "Tutor",
  family: "Familiar",
  other: "Otro vínculo",
}

const ACTIVITY_STATUS_LABEL: Record<string, string> = {
  propuesta: "Pendiente", aprobada: "Aprobada",
  ejecutada: "Ejecutada", fallida: "Fallida", expirada: "Expirada",
  open: "Abierta", done: "Completada", cancelled: "Cancelada",
  received: "Recibido", queued: "En cola", sent: "Enviado",
  delivered: "Entregado", read: "Leído", failed: "Fallido",
  normal: "Prioridad normal", urgent: "Prioridad urgente",
}

/**
 * Importe de una oportunidad con su moneda. Llega en la unidad menor de esa
 * moneda: los decimales los pone ella (ISO 4217), no una división fija.
 */
function money(amountCents: number | null, currency: string): string {
  if (amountCents === null) return "Sin monto"
  try {
    return amountFromCents(String(amountCents), currency).toLocaleString(activeOrgLocale(), {
      style: "currency",
      currency,
    })
  } catch {
    // Moneda que este navegador no reconoce: no se inventa cuántos decimales tiene.
    return "Monto no disponible"
  }
}

/**
 * Panel contextual del contacto para la bandeja (Diseño 1-4/6/9 y D03):
 * persona, estado de atención del agente, pacientes, oportunidades,
 * seguimientos y bitácora unificada. Toda acción llama a la API real con
 * permisos del servidor; jamás muestra datos clínicos ni contactos falsos.
 */
export function ContactWorkspace({
  contactId,
  conversationId,
  onRefresh,
  onClose,
  onDraftChange,
}: ContactWorkspaceProps) {
  const queryClient = useQueryClient()
  const canRead = usePermission("crm.read")
  const canWriteNote = usePermission("crm.write")
  const canWriteConv = usePermission("conversations.write")
  const canReadTasks = usePermission("tasks.read")
  const canWriteTasks = usePermission("tasks.write")
  // Puerta de decisiones del agente: agent.decide (recepción lo tiene; sin
  // agent.read ni agent.write). El dominio por acción se exige aparte.
  const canDecide = usePermission("agent.decide")
  const canReadAgent = usePermission("agent.read")
  const canWriteAppointments = usePermission("appointments.write")
  const canReadAppointments = usePermission("appointments.read")
  const canRegister = usePermission("patients.write")

  const [tab, setTab] = useState("resumen")
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [note, setNote] = useState("")
  const [noteOk, setNoteOk] = useState(false)
  // Resultado persistente de la última confirmación registrada: la lista solo
  // trae propuestas pendientes, así que un outcome fallido/expirado se muestra
  // aquí, hasta cambiar de contacto o registrar otra.
  const [outcome, setOutcome] = useState<AgentProposal | null>(null)
  // La oportunidad se abre al lado, sin salir del caso (ADR 0028).
  const [oppPanel, setOppPanel] = useState<string | null>(null)
  const [oppDrawer, setOppDrawer] = useState<{ open: boolean; opportunityId?: string }>({
    open: false,
  })
  const [taskDrawer, setTaskDrawer] = useState<{ open: boolean; opportunityId?: string }>({
    open: false,
  })
  const [regLink, setRegLink] = useState<{ url: string; expiresAt: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const idsRef = useRef({ contactId, conversationId: conversationId ?? null })
  idsRef.current = { contactId, conversationId: conversationId ?? null }
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh
  const onDraftChangeRef = useRef(onDraftChange)
  onDraftChangeRef.current = onDraftChange
  const noteDirty = note.trim().length > 0
  const noteDirtyRef = useRef(noteDirty)
  noteDirtyRef.current = noteDirty
  const convRef = useRef(conversationId ?? null)
  convRef.current = conversationId ?? null

  // Borrador local sin storage: cambiar de hilo, cerrar el contexto móvil o
  // salir de la bandeja con borrador bloquea la navegación del router y pide
  // confirmación real. Drawers y tabs son estado local y nunca navegan.
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
  const navBlocked = draftBlocker.status === "blocked"

  // La bandeja centraliza el guard del cierre del panel en escritorio (estado
  // local que no navega y el bloqueador no puede interceptar).
  useEffect(() => {
    onDraftChangeRef.current?.(noteDirty)
  }, [noteDirty])

  // Al cambiar de contacto se vuelve a Resumen y se limpia el borrador (solo
  // ocurre tras confirmar el bloqueo o al entrar al caso); el foco cae en el
  // nombre para lectores de pantalla.
  useEffect(() => {
    setTab("resumen")
    setNote("")
    setNoteOk(false)
    setRegLink(null)
    setCopied(false)
    setOutcome(null)
    headingRef.current?.focus()
  }, [contactId])

  // Recargar o cerrar la pestaña con borrador pide confirmación del navegador.
  useEffect(() => {
    if (!noteDirty) return
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    window.addEventListener("beforeunload", handler)
    return () => window.removeEventListener("beforeunload", handler)
  }, [noteDirty])

  const contextQuery = useQuery({
    queryKey: crmContextQueryKey(contactId, conversationId),
    queryFn: () => fetchCrmContext(contactId, conversationId),
    enabled: canRead,
  })
  const workspace = contextQuery.data?.data ?? null

  const activityQuery = useInfiniteQuery({
    queryKey: crmActivityQueryKey(contactId),
    queryFn: ({ pageParam }) => fetchCrmActivityPage(contactId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: canRead,
  })

  const oppsQuery = useInfiniteQuery({
    queryKey: ["crm-opportunities", contactId],
    queryFn: ({ pageParam }) =>
      apiFetch<{ data: OpportunityListItem[]; nextCursor: string | null }>(
        `/api/opportunities?contactId=${encodeURIComponent(contactId)}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
      ),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor,
    enabled: canRead,
  })

  const pendingIds = workspace?.agent.pendingProposalIds ?? []
  const proposalsQuery = useQuery({
    queryKey: ["agent-proposals", "workspace", conversationId ?? "todas"],
    queryFn: () =>
      apiFetch<{ data: AgentProposal[] }>(
        `/api/agent/proposals?status=propuesta${conversationId ? `&conversationId=${encodeURIComponent(conversationId)}` : ""}`,
      ),
    enabled: (canDecide || canReadAgent) && pendingIds.length > 0,
  })

  const handleOrgEvent = useCallback(
    (kind: string) => {
      const ids = idsRef.current
      void queryClient.invalidateQueries({ queryKey: ["crm-context", ids.contactId] })
      void queryClient.invalidateQueries({ queryKey: ["crm-activity", ids.contactId] })
      void queryClient.invalidateQueries({ queryKey: ["crm-opportunities", ids.contactId] })
      void queryClient.invalidateQueries({ queryKey: ["agent-proposals"] })
      if (kind === "stream.reconnected") {
        void queryClient.invalidateQueries({ queryKey: ["conversations"] })
        if (ids.conversationId) {
          void queryClient.invalidateQueries({
            queryKey: ["conversation", ids.conversationId],
          })
        }
        void queryClient.invalidateQueries({ queryKey: ["tasks"] })
        void queryClient.invalidateQueries({ queryKey: ["agent-proposals"] })
        onRefreshRef.current?.()
      }
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
      "agent.proposal.created",
      "agent.proposal.decided",
      "agent.proposal.executed",
      "agent.handoff.created",
      // La próxima cita cambia con la Agenda, el agente o el enlace de reserva.
      "appointment.updated",
      "stream.reconnected",
    ],
    handleOrgEvent,
  )

  const invalidateWorkspace = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["crm-context", contactId] })
    void queryClient.invalidateQueries({ queryKey: ["crm-activity", contactId] })
    void queryClient.invalidateQueries({ queryKey: ["crm-opportunities", contactId] })
    void queryClient.invalidateQueries({ queryKey: ["tasks"] })
    void queryClient.invalidateQueries({ queryKey: ["agent-proposals"] })
    onRefreshRef.current?.()
  }, [queryClient, contactId])

  // «Tomar», «Devolver al agente» y «Resolver» viven solo en la cabecera del
  // hilo, con una sola regla: «Contexto» no los repite.

  // La confirmación del interlocutor registra evidencia real por /confirm. Un
  // stale llega como 200 fallida: se guarda el outcome tipado y se muestra
  // fuera de la lista, porque la lista solo trae pendientes.
  const confirmMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ data: AgentProposal }>(`/api/agent/proposals/${id}/confirm`, {
        method: "POST",
        body: JSON.stringify({ contactId }),
      }),
    onSuccess: (result) => {
      setOutcome(result.data)
      invalidateWorkspace()
    },
  })


  const taskMutation = useMutation({
    mutationFn: (input: { id: string; status: string }) =>
      apiFetch(`/api/tasks/${input.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: input.status }),
      }),
    onSuccess: () => invalidateWorkspace(),
  })
  const completion = useCompleteTask(() => invalidateWorkspace())

  const noteMutation = useMutation({
    mutationFn: (body: string) =>
      createCrmNote(contactId, { body, conversationId: conversationId ?? undefined }),
    onSuccess: () => {
      setNote("")
      setNoteOk(true)
      invalidateWorkspace()
    },
  })

  const registrationMutation = useMutation({
    mutationFn: () => createRegistrationLink(contactId, conversationId ?? ""),
    onSuccess: (result) => {
      setRegLink(result.data)
      setCopied(false)
    },
  })

  if (!canRead) {
    return (
      <EmptyState title="Sin acceso" description="Sin permiso de lectura del CRM." />
    )
  }

  if (contextQuery.isLoading) {
    return <p className="p-4 text-sm text-muted-foreground">Cargando contexto…</p>
  }

  if (contextQuery.isError || !workspace) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <p className="text-sm text-destructive" role="alert">
          {contextQuery.error instanceof ApiError
            ? (contextQuery.error.shape.message ?? "No se pudo cargar el contexto")
            : "No se pudo cargar el contexto del contacto."}
        </p>
        <Button variant="outline" size="sm" className="w-fit" onClick={() => void contextQuery.refetch()}>
          <RefreshCw className="size-3.5" />
          Reintentar
        </Button>
      </div>
    )
  }

  const agent = workspace.agent
  const contact = workspace.contact.contact
  const identities = workspace.contact.identities
  const patients = workspace.contact.patients
  // «Reservar cita» de la persona: su ficha si ya es paciente; si aún no lo es,
  // la Agenda crea su ficha mínima unida a ella. Quien solo lleva a otros
  // (un padre) reserva desde cada paciente, más abajo.
  const selfPatient = patients.find((link) => link.relationship === "self")
  const bookTarget: { patientId?: string } | null = selfPatient
    ? { patientId: selfPatient.id }
    : patients.length === 0
      ? {}
      : null
  const tasks: TaskItem[] = canReadTasks ? workspace.tasks : []
  const opps = oppsQuery.data?.pages.flatMap((page) => page.data) ?? []
  const activity = activityQuery.data?.pages.flatMap((page) => page.data) ?? []
  const proposals = (proposalsQuery.data?.data ?? []).filter((p) =>
    pendingIds.length === 0 ? true : pendingIds.includes(p.id),
  )
  const outcomeConv = outcome?.conversationId ?? conversationId ?? null
  const outcomeError = outcome ? proposalErrorMessage(outcome) : null
  // Puerta agent.decide más dominio por acción (el servidor responde 403 o
  // 409 con el motivo exacto, que se muestra tal cual).
  const hasActionPermission = (action: string): boolean => {
    const needed = permissionForAction(action)
    if (needed === "appointments.write") return canWriteAppointments
    if (needed === "conversations.write") return canWriteConv
    return canWriteNote
  }
  const mutationError =
    confirmMutation.error instanceof ApiError
          ? (confirmMutation.error.shape.message ?? "No se pudo registrar la confirmación")
          : taskMutation.error instanceof ApiError
            ? (taskMutation.error.shape.message ?? "No se pudo actualizar la tarea")
            : noteMutation.error instanceof ApiError
              ? (noteMutation.error.shape.message ?? "No se pudo guardar la nota")
              : registrationMutation.error instanceof ApiError
                ? (registrationMutation.error.shape.message ?? "No se pudo crear el enlace")
                : completion.error

  return (
    <section
      aria-label="Contexto del contacto"
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto elevated rounded-xl border bg-card p-4"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="truncate text-base font-semibold outline-none"
          >
            {contact.displayName}
          </h2>
          <p className="text-xs text-muted-foreground">
            {[contact.phone ? internationalText(contact.phone) : null, contact.email].filter(Boolean).join(" · ") ||
              "Sin datos de contacto"}
          </p>
        </div>
        <Link
          to="/people/$personId"
          params={{ personId: contactId }}
          className="shrink-0 text-xs text-primary hover:underline"
        >
          Ver su página
        </Link>
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Cerrar contexto"
          >
            <X className="size-4" />
          </Button>
        )}
      </div>

      {mutationError && (
        <p className="text-sm text-destructive" role="alert">
          {mutationError}
        </p>
      )}
      {completion.dialog}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="Secciones del contexto">
          <TabsTrigger value="resumen">Resumen</TabsTrigger>
          <TabsTrigger value="actividad">Actividad</TabsTrigger>
        </TabsList>

        <TabsContent value="resumen" className="flex flex-col gap-4">
          {/* Lo que recepción necesita para darle una cita, sin salir del hilo. */}
          <div className="flex flex-col gap-2">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
              {canReadAppointments ? (
                <>
                  <dt className="text-muted-foreground">Próxima cita</dt>
                  <dd className="font-medium">
                    {workspace.nextAppointment ? (
                      <Link
                        to="/agenda"
                        search={{ appointmentId: workspace.nextAppointment.id }}
                        className="hover:underline"
                      >
                        {nextAppointmentSaid(workspace.nextAppointment, activeOrgLocale(), contact.displayName)}
                      </Link>
                    ) : (
                      "Ninguna"
                    )}
                  </dd>
                </>
              ) : null}
              <dt className="text-muted-foreground">Mensajes</dt>
              <dd className="font-medium">{messagePermissionsSaid(workspace.messages)}</dd>
            </dl>
            {canWriteAppointments && bookTarget ? (
              <Link
                to="/agenda"
                search={{
                  ...(bookTarget.patientId ? { patientId: bookTarget.patientId } : {}),
                  contactId,
                  conversationId,
                }}
                className={cn(buttonVariants({ size: "sm" }), "min-h-11 w-fit sm:min-h-9")}
              >
                Reservar cita
              </Link>
            ) : null}
            {canWriteAppointments && patients.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {contact.displayName.split(/\s+/)[0]} todavía no es paciente: al reservar se crea su ficha con nombre y
                teléfono, y el resto lo completa con el enlace de registro.
              </p>
            ) : null}
          </div>
          {/* Resultado persistente de la última decisión: visible aunque la
              propuesta salga de pendientes o cambie el estado del agente. */}
          {outcome && (outcome.status === "fallida" || outcome.status === "expirada") && (
            <div className="flex flex-col gap-1 rounded-md border border-destructive/30 bg-danger-soft p-3" role="alert">
              <p className="text-sm font-medium">
                {ACTION_LABEL[outcome.action] ?? outcome.action}: no se pudo ejecutar
              </p>
              {outcomeError && <p className="text-xs text-destructive">{outcomeError}</p>}
              <p className="text-xs text-muted-foreground">
                Realiza la acción manualmente desde el caso.
              </p>
              <span className="flex flex-wrap gap-2">
                {outcomeConv && (
                  <Link
                    to="/inbox"
                    search={{ conversation: outcomeConv }}
                    className="text-xs text-primary hover:underline"
                  >
                    Abrir hilo
                  </Link>
                )}
                <Button variant="ghost" size="sm" className="w-fit" onClick={() => setOutcome(null)}>
                  Descartar
                </Button>
              </span>
            </div>
          )}
          {/* Estado de atención del agente */}
          <div className="flex flex-col gap-2 rounded-md border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Bot className="size-4 text-muted-foreground" aria-hidden />
              <Badge variant="secondary">{agentStateLabel(agent.state)}</Badge>
              {pendingIds.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  {pendingIds.length === 1 ? "1 cita espera el sí del paciente" : `${pendingIds.length} citas esperan el sí del paciente`}
                </span>
              )}
            </div>
            <p className="text-sm text-muted-foreground">{agentStateDescription(agent)}</p>
            <ul className="flex flex-col gap-1">
              {agentNextSteps(agent).map((step) => (
                <li key={step} className="flex items-center gap-1.5 text-sm">
                  <CheckCircle2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  {step}
                </li>
              ))}
            </ul>
            <Button variant="link" size="sm" className="h-auto min-h-11 w-fit p-0 sm:min-h-8" onClick={() => setMemoryOpen(true)}>
              Lo que recuerda el agente
            </Button>
            {/* Lo que espera el sí del interlocutor: el equipo solo registra una
                confirmación que ya dio en el chat (agent.decide más el dominio del
                acto); sin decide solo se ve el estado mínimo. */}
            {/* Se ve con cualquier estado (el orden es el de la Bandeja): la cita espera el sí aunque la lleve una persona. */}
            {agent.awaitingContact && (
              <div className="flex flex-col gap-2 border-t pt-2">
                {!canDecide ? (
                  <p className="text-xs text-muted-foreground">
                    Hay una propuesta que espera la confirmación del interlocutor.
                  </p>
                ) : proposalsQuery.isLoading && proposals.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Cargando propuestas…</p>
                ) : proposalsQuery.isError && proposals.length === 0 ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs text-destructive" role="alert">
                      {proposalsQuery.error instanceof ApiError
                        ? (proposalsQuery.error.shape.message ?? "No se pudieron cargar las propuestas")
                        : "No se pudieron cargar las propuestas."}
                    </p>
                    <Button variant="ghost" size="sm" onClick={() => void proposalsQuery.refetch()}>
                      Reintentar
                    </Button>
                  </div>
                ) : proposals.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Las propuestas ya fueron atendidas o no están visibles.
                  </p>
                ) : (
                  <>
                    {proposalsQuery.isError ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-xs text-destructive" role="alert">
                          No se pudieron actualizar las propuestas; se conservan las cargadas.
                        </p>
                        <Button variant="ghost" size="sm" onClick={() => void proposalsQuery.refetch()}>
                          Reintentar
                        </Button>
                      </div>
                    ) : null}
                  {proposals.map((p) => {
                    const allowed = canDecide && hasActionPermission(p.action)
                    const ctx = p.context
                    const ctxLine = ctx
                      ? [
                          ctx.patientName ?? ctx.contactName,
                          ctx.opportunityTitle,
                          ctx.branchName,
                          ctx.dentistName,
                        ]
                          .filter(Boolean)
                          .join(" · ")
                      : ""
                    const cardError = proposalErrorMessage(p)
                    return (
                      <div key={p.id} className="flex flex-col gap-1 rounded-md bg-muted/40 p-2">
                        <p className="text-sm font-medium">{ACTION_LABEL[p.action] ?? p.action}</p>
                        {p.reason && <p className="text-xs text-muted-foreground">{p.reason}</p>}
                        {ctxLine && <p className="text-xs text-muted-foreground">{ctxLine}</p>}
                        {ctx.beforeSummary && (
                          <p className="text-xs text-muted-foreground">
                            Al proponer: {ctx.beforeSummary}
                          </p>
                        )}
                        <p className="text-xs">
                          Estado del caso: {ctx.currentSummary ?? "No disponible"}
                        </p>
                        <p className="text-xs">Cambio previsto: {ctx.afterSummary}</p>
                        {ctx.isStale === true && p.status === "propuesta" && (
                          <p className="text-xs text-warning" role="status">
                            La situación cambió desde la propuesta: revisa el estado del caso antes de decidir.
                          </p>
                        )}
                        {cardError && (
                          <p className="text-xs text-destructive" role="alert">
                            {cardError}
                          </p>
                        )}
                        {(p.status === "fallida" || p.status === "expirada") && (
                          <p className="text-xs text-muted-foreground">
                            Esta propuesta ya no se puede ejecutar: realiza la acción manualmente desde el caso.
                          </p>
                        )}
                        {p.mode === "directo" && (
                          <p className="text-xs text-muted-foreground">
                            Se ejecuta sin intervención del equipo.
                          </p>
                        )}
                        {p.mode === "confirmar_usuario" && (
                          <p className="text-xs text-muted-foreground">
                            Requiere confirmación del interlocutor en el hilo; el equipo no la aprueba.
                          </p>
                        )}
                        {p.mode === "confirmar_usuario" && p.status === "propuesta" && !cardError && (
                          allowed ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="w-fit"
                              disabled={confirmMutation.isPending}
                              onClick={() => confirmMutation.mutate(p.id)}
                            >
                              {confirmMutation.isPending ? (
                                <>
                                  <Spinner className="size-6" aria-hidden />
                                  Registrar confirmación del interlocutor
                                </>
                              ) : (
                                "Registrar confirmación del interlocutor"
                              )}
                            </Button>
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              Tu rol no puede registrar esta confirmación. Consulta con un administrador.
                            </p>
                          )
                        )}
                      </div>
                    )
                  })}</>
                )}
              </div>
            )}
          </div>

          {/* Procedencia: identidades multicanal del contacto */}
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Canales</h3>
            {identities.length === 0 ? (
              <p className="text-xs text-muted-foreground">Sin identidades vinculadas.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {identities.map((ident) => {
                  const Icon = channelIcon(ident.channel)
                  return (
                    <li key={ident.id} className="flex items-center gap-1.5 text-sm">
                      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="font-medium">{channelLabel(ident.channel)}</span>
                      <span className="truncate text-muted-foreground">
                        {identityText(ident)}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          <Separator />

          {/* Pacientes vinculados y enlace de registro */}
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Pacientes</h3>
            {patients.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Aún no es paciente. El registro lo completa con su enlace o se crea al reservarle una cita.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {patients.map((link) => (
                  <li key={link.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0">
                      <span className="font-medium">{link.displayName}</span>{" "}
                      <span className="text-xs text-muted-foreground">
                        · {RELATIONSHIP_LABEL[link.relationship] ?? link.relationship}
                        {link.isPreferred ? " · Preferido" : ""}
                      </span>
                    </span>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {/* La propia persona se reserva arriba; aquí, quien ella lleva. */}
                      {canWriteAppointments && link.relationship !== "self" && (
                        <Link
                          to="/agenda"
                          search={{ patientId: link.id, contactId, conversationId }}
                          className="text-xs text-primary hover:underline"
                        >
                          Reservar cita
                        </Link>
                      )}
                      <PersonLink patientId={link.id} className="text-xs text-primary hover:underline">
                        Abrir su página
                      </PersonLink>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {canRegister && (
              <div className="flex flex-col gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-fit"
                  disabled={!conversationId || registrationMutation.isPending}
                  onClick={() => registrationMutation.mutate()}
                  title={
                    conversationId
                      ? "Genera un enlace para que el paciente complete sus datos"
                      : "Abre el contexto desde una conversación para generar el enlace"
                  }
                >
                  <UserPlus className="size-3.5" />
                  {registrationMutation.isPending ? "Generando…" : "Preparar registro"}
                </Button>
                {regLink && (
                  <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-2 text-xs">
                    <span className="min-w-0 flex-1 truncate" title={regLink.url}>
                      {regLink.url}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(regLink.url)
                          setCopied(true)
                        } catch {
                          // El operador copia manualmente desde el texto visible.
                        }
                      }}
                    >
                      <Copy className="size-3.5" />
                      {copied ? "Copiado" : "Copiar"}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>

          <Separator />

          {/* Oportunidades paginadas + crear/editar sin reselección */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Oportunidades</h3>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setOppDrawer({ open: true })}
              >
                <Plus className="size-3.5" />
                Nueva
              </Button>
            </div>
            {oppsQuery.isLoading && opps.length === 0 ? (
              <p className="text-xs text-muted-foreground">Cargando oportunidades…</p>
            ) : oppsQuery.isError && opps.length === 0 ? (
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
              <>
                {oppsQuery.isError ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs text-destructive" role="alert">
                      No se pudieron actualizar las oportunidades; se conservan las cargadas.
                    </p>
                    <Button variant="ghost" size="sm" onClick={() => void oppsQuery.refetch()}>
                      Reintentar
                    </Button>
                  </div>
                ) : null}
              <ul className="flex flex-col gap-1.5">
                {opps.map((opp) => (
                  <li
                    key={opp.id}
                    className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{opp.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {opp.status === "won" ? "Ganada" : opp.status === "lost" ? "Perdida" : opp.stageName} · {money(opp.amountCents, opp.currency)}
                        {opp.nextTask ? ` · ${opp.nextTask.title}${opp.nextTask.dueAt ? ` · ${dueWords(opp.nextTask.dueAt)}` : ""}` : ""}
                      </span>
                      {opp.why ? <span className="block truncate text-xs text-muted-foreground">{opp.why}</span> : null}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <Button variant="ghost" size="sm" onClick={() => setOppPanel(opp.id)}>
                        Abrir
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
              </>
            )}
            {oppsQuery.hasNextPage && (
              <Button
                variant="ghost"
                size="sm"
                className="self-center"
                disabled={oppsQuery.isFetchingNextPage}
                onClick={() => void oppsQuery.fetchNextPage()}
              >
                {oppsQuery.isFetchingNextPage ? (
                  <>
                    <Spinner className="size-6" aria-hidden />
                    Cargar más
                  </>
                ) : (
                  "Cargar más"
                )}
              </Button>
            )}
          </div>

          <Separator />

          {/* Tareas: completar sin salir del caso */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Tareas</h3>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setTaskDrawer({ open: true })}
              >
                <Plus className="size-3.5" />
                Nueva tarea
              </Button>
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
                    <li
                      key={task.id}
                      className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm"
                    >
                      <span className="min-w-0">
                        <span className={`block truncate ${done ? "line-through" : ""}`}>
                          {task.title}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {[task.opportunityTitle, task.dueAt ? `vence ${dueWords(task.dueAt)}` : null]
                            .filter(Boolean)
                            .join(" · ") || "Sin vencimiento"}
                          {overdue ? " · vencida" : ""}
                        </span>
                      </span>
                      {canWriteTasks && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={taskMutation.isPending || completion.pendingId !== null}
                          onClick={() =>
                            // Completar la de un caso del agente muestra antes lo mismo que «Resolver».
                            done ? taskMutation.mutate({ id: task.id, status: "open" }) : void completion.complete(task.id)
                          }
                        >
                          {done ? "Reabrir" : "Completar"}
                        </Button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          <Separator />

          {/* Nota operativa real */}
          {canWriteNote && (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">Nota operativa</h3>
              <Textarea
                aria-label="Nota operativa"
                rows={2}
                placeholder="Registra un dato operativo del caso…"
                value={note}
                onChange={(e) => {
                  setNote(e.target.value)
                  setNoteOk(false)
                }}
              />
              {noteOk && (
                <p className="text-xs text-success" role="status">
                  Nota guardada en la bitácora.
                </p>
              )}
              {noteDirty && !noteMutation.isPending && (
                <p className="text-xs text-warning" role="status">
                  Borrador sin guardar: cambiar de hilo o salir pedirá confirmación. Guárdalo o descártalo.
                </p>
              )}
              <span className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  className="w-fit"
                  disabled={note.trim().length === 0 || noteMutation.isPending}
                  onClick={() => noteMutation.mutate(note.trim())}
                >
                  {noteMutation.isPending ? (
                    <>
                      <Spinner className="size-6" aria-hidden />
                      Guardar nota
                    </>
                  ) : (
                    "Guardar nota"
                  )}
                </Button>
                {noteDirty && !noteMutation.isPending && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-fit"
                    onClick={() => {
                      setNote("")
                      setNoteOk(false)
                    }}
                  >
                    Descartar
                  </Button>
                )}
              </span>
            </div>
          )}
        </TabsContent>

        <TabsContent value="actividad" className="flex flex-col gap-2">
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
            <EmptyState
              title="Sin actividad"
              description="Mensajes, notas, tareas y movimientos del caso aparecen aquí."
            />
          ) : (
            <>
              {activityQuery.isError ? (
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-xs text-destructive" role="alert">
                    No se pudo actualizar la bitácora; se conserva la actividad cargada.
                  </p>
                  <Button variant="ghost" size="sm" onClick={() => void activityQuery.refetch()}>
                    Reintentar
                  </Button>
                </div>
              ) : null}
              <ol className="flex flex-col gap-2">
                {activity.map((item) => (
                  <ActivityRow key={item.id} item={item} />
                ))}
              </ol>
            </>
          )}
          {activityQuery.hasNextPage && (
            <Button
              variant="ghost"
              size="sm"
              className="self-center"
              disabled={activityQuery.isFetchingNextPage}
              onClick={() => void activityQuery.fetchNextPage()}
            >
              {activityQuery.isFetchingNextPage ? (
                <>
                  <Spinner className="size-6" aria-hidden />
                  Cargar anteriores
                </>
              ) : (
                "Cargar anteriores"
              )}
            </Button>
          )}
        </TabsContent>
      </Tabs>

      <PersonMemoryDrawer
        contactId={memoryOpen ? contactId : null}
        name={contact.displayName}
        canWrite={canWriteNote || canWriteConv}
        onClose={() => setMemoryOpen(false)}
      />
      <ConfirmDialog
        open={navBlocked}
        title="Salir sin guardar la nota"
        description="La nota operativa no se guardó y se perderá al cambiar de hilo o salir. ¿Continuar?"
        confirmLabel="Salir sin guardar"
        variant="default"
        onClose={() => { if (draftBlocker.status === "blocked") draftBlocker.reset() }}
        onConfirm={() => { if (draftBlocker.status === "blocked") draftBlocker.proceed() }}
      />
      {/* Drawers de CrmScreens con el caso ya fijado: no se reselecciona. */}
      <OpportunityDrawer
        open={oppDrawer.open}
        contactId={contactId}
        conversationId={conversationId}
        opportunityId={oppDrawer.opportunityId}
        onClose={() => setOppDrawer({ open: false })}
        onSaved={() => {
          setOppDrawer({ open: false })
          invalidateWorkspace()
        }}
      />
      <OpportunityPanel opportunityId={oppPanel} onClose={() => setOppPanel(null)} />
      <TaskDrawer
        open={taskDrawer.open}
        contactId={contactId}
        conversationId={conversationId}
        opportunityId={taskDrawer.opportunityId}
        onClose={() => setTaskDrawer({ open: false })}
        onSaved={() => {
          setTaskDrawer({ open: false })
          invalidateWorkspace()
        }}
      />
    </section>
  )
}

function ActivityRow({ item }: { item: CrmActivityItem }) {
  return (
    <li className="flex flex-col gap-1 rounded-md border p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="secondary">{activityKindLabel(item.kind)}</Badge>
        <span className="text-xs text-muted-foreground">{timeAgo(item.at)}</span>
        {item.channel && (
          <span className="text-xs text-muted-foreground">· {channelLabel(item.channel)}</span>
        )}
        {item.actorName && (
          <span className="text-xs text-muted-foreground">· {item.actorName}</span>
        )}
        {item.status && !item.status.startsWith("opportunity.") && (
          <span className="text-xs text-muted-foreground">· {ACTIVITY_STATUS_LABEL[item.status] ?? "Estado registrado"}</span>
        )}
      </div>
      <p className="text-sm font-medium">{item.title}</p>
      {item.body && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{item.body}</p>}
      <div className="flex flex-wrap gap-3">
        {item.conversationId && (
          <Link
            to="/inbox"
            search={{ conversation: item.conversationId }}
            className="text-xs text-primary hover:underline"
          >
            Ver hilo
          </Link>
        )}
        {item.opportunityId && (
          <Link
            to="/pipeline"
            search={{ oportunidad: item.opportunityId }}
            className="text-xs text-primary hover:underline"
          >
            Ver oportunidad
          </Link>
        )}
      </div>
    </li>
  )
}
