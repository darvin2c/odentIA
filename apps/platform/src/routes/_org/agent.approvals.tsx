import { Badge, Button, Field, FieldLabel, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@odentia/ui"
import { ConfirmDialog, EmptyState, LoadingState, PageHeader, PageShell, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useState } from "react"
import { AgentTabs } from "../../components/agent-tabs"
import { ApiError, apiFetch } from "../../lib/api"
import { ACTION_LABEL, permissionForAction, proposalErrorMessage, type AgentHandoff, type AgentProposal } from "../../lib/agent"
import { channelLabel } from "../../lib/channels"
import { usePermission } from "../../lib/crm"
import { useOrgEvents } from "../../lib/org-events"
import { activeOrgLocale } from "../../lib/locale"

export const Route = createFileRoute("/_org/agent/approvals")({
  validateSearch: (search: Record<string, unknown>): { conversationId?: string; status?: string } => ({
    conversationId: typeof search.conversationId === "string" ? search.conversationId : undefined,
    status: typeof search.status === "string" ? search.status : undefined,
  }),
  component: AgentApprovalsPage,
})

const EVENTS = [
  "agent.proposal.created", "agent.proposal.decided", "agent.proposal.executed",
  "agent.handoff.created", "opportunity.updated", "appointment.updated",
]

const STATUS_LABEL: Record<string, string> = {
  propuesta: "Pendiente", aprobada: "Aprobada", rechazada: "Rechazada",
  ejecutada: "Ejecutada", fallida: "Fallida", expirada: "Expirada",
}
/** Resultado terminal que ya no figura en la lista filtrada: se muestra, no se silencia. */
interface DecisionOutcome {
  status: string
  detail: string | null
  conversationId: string | null
}
function AgentApprovalsPage() {
  const queryClient = useQueryClient()
  // Lectura operativa (supervisar o decidir) y decisión operativa por dominio;
  // administrar el agente (configuración, conocimiento) sigue en `agent.write`.
  // Hooks siempre evaluados; el OR va después (reglas de hooks).
  const canSupervise = usePermission("agent.read")
  const canDecide = usePermission("agent.decide")
  const canRead = canSupervise || canDecide
  const canCrm = usePermission("crm.write")
  const canConversations = usePermission("conversations.write")
  const canAgenda = usePermission("appointments.write")
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const status = search.status ?? "propuesta"
  const [rejectReason, setRejectReason] = useState<Record<string, string>>({})
  const [confirm, setConfirm] = useState<AgentProposal | null>(null)
  const [outcome, setOutcome] = useState<DecisionOutcome | null>(null)
  const proposalsQuery = useQuery({
    queryKey: ["agent-proposals", status, search.conversationId],
    queryFn: () => {
      const params = new URLSearchParams({ limit: "100" })
      if (status) params.set("status", status)
      if (search.conversationId) params.set("conversationId", search.conversationId)
      return apiFetch<{ data: AgentProposal[] }>(`/api/agent/proposals?${params}`)
    },
    enabled: canRead,
  })
  const handoffsQuery = useQuery({
    queryKey: ["agent-handoffs", search.conversationId],
    queryFn: () => apiFetch<{ data: AgentHandoff[] }>(`/api/agent/handoffs?limit=30${search.conversationId ? `&conversationId=${encodeURIComponent(search.conversationId)}` : ""}`),
    enabled: canRead,
  })
  const invalidate = () => {
    for (const key of ["agent-proposals", "agent-handoffs", "workspace-home", "workspace-pulse", "crm-context", "crm-activity", "opportunities", "opportunity-summary", "conversations", "conversation", "tasks"]) {
      void queryClient.invalidateQueries({ queryKey: [key] })
    }
  }
  useOrgEvents(EVENTS, invalidate)
  // Decidir/confirmar/ejecutar puede devolver 200 con `fallida`/`expirada`
  // (obsoleta o expirada sin rollback): la lista filtrada ya no la muestra,
  // así que el resultado queda fijo en pantalla junto a la vuelta al caso.
  const settleProposal = (response: { data: AgentProposal }) => {
    const proposal = response.data
    if (proposal.status === "fallida" || proposal.status === "expirada") {
      setOutcome({ status: proposal.status, detail: proposalErrorMessage(proposal), conversationId: proposal.conversationId })
    } else {
      setOutcome(null)
    }
    setConfirm(null)
    invalidate()
  }
  const decideMutation = useMutation({
    mutationFn: (input: { id: string; decision: "aprobada" | "rechazada"; reason?: string }) =>
      apiFetch<{ data: AgentProposal }>(`/api/agent/proposals/${input.id}/decision`, { method: "POST", body: JSON.stringify(input) }),
    onSuccess: settleProposal,
  })
  const executeMutation = useMutation({
    mutationFn: (id: string) => apiFetch<{ data: AgentProposal }>(`/api/agent/proposals/${id}/execute`, { method: "POST" }),
    onSuccess: settleProposal,
  })
  // Registra la confirmación explícita del interlocutor en la conversación;
  // el equipo no sustituye su consentimiento, solo deja constancia de que existe.
  const confirmMutation = useMutation({
    mutationFn: (proposal: AgentProposal) => {
      if (!proposal.contactId) throw new Error("Esta propuesta no tiene interlocutor vinculado")
      return apiFetch<{ data: AgentProposal }>(`/api/agent/proposals/${proposal.id}/confirm`, { method: "POST", body: JSON.stringify({ contactId: proposal.contactId }) })
    },
    onSuccess: settleProposal,
  })
  const claimMutation = useMutation({
    mutationFn: (handoffId: string) =>
      apiFetch<{ data: AgentHandoff }>(`/api/agent/handoffs/${handoffId}/claim`, { method: "POST" }),
    onSuccess: invalidate,
  })
  const mutationError = decideMutation.error ?? executeMutation.error ?? confirmMutation.error ?? claimMutation.error
  const proposals = proposalsQuery.data?.data ?? []
  const handoffs = handoffsQuery.data?.data ?? []

  return <PageShell className="flex flex-col gap-6">
    <PageHeader title="Agente" subtitle="Revisa a quién afecta, el cambio previsto y el resultado antes de volver al caso." />
    <AgentTabs />
    {!canRead ? <EmptyState title="Sin acceso" description="No tienes acceso a las decisiones del agente." /> : <>
      <div className="flex flex-wrap items-end gap-3">
        <Field className="w-56"><FieldLabel htmlFor="filtro-estado">Estado</FieldLabel>
          <Select value={status || "todos"} onValueChange={value => void navigate({ search: { ...search, status: value === "todos" ? "" : value ?? "propuesta" }, replace: true })}>
            <SelectTrigger id="filtro-estado"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="todos">Todos</SelectItem>{Object.entries(STATUS_LABEL).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        {search.conversationId && <><Link to="/inbox" search={{ conversation: search.conversationId }} className="text-sm text-primary underline">Volver a la conversación</Link><Button variant="outline" onClick={() => void navigate({ search: { status }, replace: true })}>Ver todos los casos</Button></>}
      </div>
      {mutationError && <p role="alert" className="text-sm text-destructive">{mutationError instanceof ApiError ? mutationError.shape.message : "No pudimos procesar la decisión. No se muestra como ejecutada."}</p>}
      {outcome && <div role="alert" className="flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm">
        <p className="min-w-0 flex-1">La propuesta quedó {(STATUS_LABEL[outcome.status] ?? outcome.status).toLowerCase()}.{outcome.detail ? ` ${outcome.detail}` : ""} Gestiona la acción desde el caso.</p>
        {outcome.conversationId && <Link to="/inbox" search={{ conversation: outcome.conversationId }} className="shrink-0 text-primary underline">Volver al caso</Link>}
        <Button variant="outline" size="sm" onClick={() => setOutcome(null)}>Descartar</Button>
      </div>}
      {proposalsQuery.isPending ? <LoadingState /> : proposalsQuery.isError ? <div role="alert"><p>No pudimos cargar las propuestas.</p><Button variant="outline" onClick={() => void proposalsQuery.refetch()}>Volver a intentar</Button></div> : proposals.length === 0 ? <EmptyState title="Sin propuestas" description="No hay propuestas en este estado para los casos seleccionados." /> : <>
        <p className="text-xs text-muted-foreground">Hasta 100 propuestas recientes. Abre un caso para revisar sus decisiones.</p>
        <ul className="flex flex-col gap-3">{proposals.map(proposal => {
          const needed = permissionForAction(proposal.action)
          const authorized = canDecide && (needed === "conversations.write" ? canConversations : needed === "appointments.write" ? canAgenda : canCrm)
          return <li key={proposal.id} className="flex min-w-0 flex-col gap-3 elevated rounded-xl border bg-card p-5">
            <div className="flex flex-wrap items-center gap-2"><Badge variant={proposal.status === "propuesta" ? "default" : "secondary"}>{STATUS_LABEL[proposal.status] ?? proposal.status}</Badge><h2 className="font-medium">{ACTION_LABEL[proposal.action] ?? proposal.action}</h2><span className="text-xs text-muted-foreground">{new Date(proposal.createdAt).toLocaleString(activeOrgLocale())}</span></div>
            <p className="font-medium">{proposal.context.contactName ?? "Interlocutor no disponible"}{proposal.context.channel ? ` · ${channelLabel(proposal.context.channel)}` : ""}</p>
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              {proposal.context.patientName && <div><dt className="text-muted-foreground">Paciente</dt><dd>{proposal.context.patientName}</dd></div>}
              {proposal.context.opportunityTitle && <div><dt className="text-muted-foreground">Oportunidad</dt><dd>{proposal.context.opportunityTitle}</dd></div>}
              {proposal.context.branchName && <div><dt className="text-muted-foreground">Sede</dt><dd>{proposal.context.branchName}</dd></div>}
              {proposal.context.dentistName && <div><dt className="text-muted-foreground">Profesional</dt><dd>{proposal.context.dentistName}</dd></div>}
              {proposal.context.beforeSummary && <div><dt className="text-muted-foreground">Al proponer</dt><dd className="whitespace-pre-wrap break-words">{proposal.context.beforeSummary}</dd></div>}
              <div><dt className="text-muted-foreground">Cambio previsto</dt><dd className="whitespace-pre-wrap break-words">{proposal.context.afterSummary}</dd></div>
              {proposal.context.currentSummary && <div><dt className="text-muted-foreground">Estado del caso</dt><dd className="whitespace-pre-wrap break-words">{proposal.context.currentSummary}</dd></div>}
            </dl>
            {proposal.context.isStale === true && proposal.status === "propuesta" && <p role="alert" className="text-sm text-destructive">La situación cambió desde que se propuso; revisa el estado del caso antes de decidir.</p>}
            {proposal.conversationId && <Link to="/inbox" search={{ conversation: proposal.conversationId }} className="text-sm text-primary underline">Abrir conversación y evidencia</Link>}
            {!proposal.conversationId && typeof proposal.payload.opportunityId === "string" && <Link to="/opportunities/$opportunityId" params={{ opportunityId: proposal.payload.opportunityId }} className="text-sm text-primary underline">Abrir oportunidad</Link>}
            {proposalErrorMessage(proposal) && <p role="alert" className="text-sm text-destructive">{proposalErrorMessage(proposal)}</p>}
            {proposal.status === "ejecutada" && <p role="status" className="text-sm">Cambio ejecutado{proposal.executedAt ? ` · ${new Date(proposal.executedAt).toLocaleString(activeOrgLocale())}` : ""}. {typeof proposal.result?.messageId === "string" ? "Mensaje encolado; consulta su estado de entrega en el hilo." : "Consulta el estado actualizado en el caso."}</p>}
            {(proposal.status === "fallida" || proposal.status === "expirada") && <p role="alert" className="text-sm">Esta propuesta no se ejecutó ({STATUS_LABEL[proposal.status] ?? proposal.status}). Gestiona la acción manualmente desde el caso y su conversación; aquí no hay reintento.</p>}
            {authorized && canConversations && proposal.status === "propuesta" && proposal.mode === "confirmar_usuario" && <div className="flex flex-wrap gap-2">
              <SubmitButton size="sm" pending={confirmMutation.isPending} disabled={!proposal.contactId} onClick={() => { confirmMutation.reset(); confirmMutation.mutate(proposal) }}>Registrar confirmación del interlocutor</SubmitButton>
            </div>}
            {authorized && proposal.status === "propuesta" && proposal.mode === "aprobar_equipo" && <div className="flex flex-col gap-2">
              <Field><FieldLabel htmlFor={`rechazo-${proposal.id}`}>Motivo para rechazar</FieldLabel><Input id={`rechazo-${proposal.id}`} value={rejectReason[proposal.id] ?? ""} onChange={event => setRejectReason({ ...rejectReason, [proposal.id]: event.target.value })} maxLength={2000} /></Field>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={decideMutation.isPending} onClick={() => { decideMutation.reset(); setConfirm(proposal) }}>Revisar y aprobar</Button>
                <SubmitButton size="sm" variant="outline" pending={decideMutation.isPending} disabled={!(rejectReason[proposal.id] ?? "").trim()} onClick={() => decideMutation.mutate({ id: proposal.id, decision: "rechazada", reason: rejectReason[proposal.id] })}>Rechazar</SubmitButton>
              </div>
            </div>}
            {authorized && proposal.status === "aprobada" && <SubmitButton size="sm" variant="outline" pending={executeMutation.isPending} onClick={() => executeMutation.mutate(proposal.id)}>Ejecutar cambio aprobado</SubmitButton>}
          </li>
        })}</ul>
      </>}
      <section className="elevated rounded-xl border bg-card p-5">
        <h2 className="font-medium">Derivaciones recientes</h2>
        {handoffsQuery.isPending ? (
          <LoadingState />
        ) : handoffsQuery.isError ? (
          <div role="alert">
            <p>No pudimos cargar las derivaciones.</p>
            <Button variant="outline" onClick={() => void handoffsQuery.refetch()}>
              Volver a intentar
            </Button>
          </div>
        ) : handoffs.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Sin derivaciones para estos casos.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-4">
            {handoffs.map((handoff) => (
              <li key={handoff.id} className="flex flex-col gap-1 text-sm">
                <div className="flex flex-wrap gap-2">
                  <Badge variant={handoff.priority === "alta" ? "destructive" : "secondary"}>
                    {handoff.priority}
                  </Badge>
                  <strong>
                    {handoff.contactName ?? "Interlocutor no disponible"}
                    {handoff.channel ? ` · ${channelLabel(handoff.channel)}` : ""}
                  </strong>
                </div>
                <p>{handoff.reason}</p>
                <p className="whitespace-pre-wrap text-muted-foreground">{handoff.summary}</p>
                <p className="text-muted-foreground">
                  {handoff.assigneeUserId ? "Responsable asignado" : "En cola por recoger"}
                  {handoff.dueAt ? ` · vence ${new Date(handoff.dueAt).toLocaleString(activeOrgLocale())}` : ""}
                </p>
                <div className="flex flex-wrap items-center gap-3">
                  {handoff.conversationId ? (
                    <Link
                      to="/inbox"
                      search={{ conversation: handoff.conversationId }}
                      className="text-primary underline"
                    >
                      Atender conversación
                    </Link>
                  ) : null}
                  {handoff.taskId ? (
                    <Link to="/tasks" search={{ task: handoff.taskId }} className="text-primary underline">
                      Abrir pendiente
                    </Link>
                  ) : null}
                  {!handoff.assigneeUserId ? (
                    <SubmitButton
                      size="sm"
                      variant="outline"
                      pending={claimMutation.isPending}
                      onClick={() => claimMutation.mutate(handoff.id)}
                    >
                      Tomar caso
                    </SubmitButton>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <ConfirmDialog open={confirm !== null} title="Aprobar y ejecutar el cambio" description={confirm ? `${confirm.context.contactName ?? "Interlocutor"}: ${confirm.context.afterSummary}` : ""} confirmLabel="Aprobar y ejecutar" variant="default" pending={decideMutation.isPending} onClose={() => { if (!decideMutation.isPending) setConfirm(null) }} onConfirm={() => confirm && decideMutation.mutate({ id: confirm.id, decision: "aprobada" })} />
    </>}
  </PageShell>
}
