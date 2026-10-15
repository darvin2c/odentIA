import { Badge, Button, Field, FieldLabel, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@odentia/ui"
import { EmptyState, LoadingState, PageHeader, PageShell, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useState } from "react"
import { CaseBriefDrawer } from "../../components/agent/case-brief"
import { HandoffNotice } from "../../components/agent/handoff-badges"
import { AgentTabs } from "../../components/agent-tabs"
import { canTakeCase, takeCase } from "../../components/agent-panel"
import { ApiError, apiFetch } from "../../lib/api"
import { ACTION_LABEL, AGENT_CASES_TITLE, permissionForAction, proposalErrorMessage, type AgentHandoff, type AgentProposal } from "../../lib/agent"
import { channelLabel } from "../../lib/channels"
import { usePermission } from "../../lib/crm"
import { useOrgEvents } from "../../lib/org-events"
import { activeOrgLocale } from "../../lib/locale"

export const Route = createFileRoute("/_org/agent/pendientes")({
  validateSearch: (search: Record<string, unknown>): { conversationId?: string; status?: string } => ({
    conversationId: typeof search.conversationId === "string" ? search.conversationId : undefined,
    status: typeof search.status === "string" ? search.status : undefined,
  }),
  component: AgentPendingPage,
})

const EVENTS = [
  "agent.proposal.created", "agent.proposal.decided", "agent.proposal.executed",
  "agent.handoff.created", "opportunity.updated", "appointment.updated",
]

const STATUS_LABEL: Record<string, string> = {
  propuesta: "Espera al paciente", aprobada: "Aprobada",
  ejecutada: "Ejecutada", fallida: "Fallida", expirada: "Expirada",
}
/** Resultado terminal que ya no figura en la lista filtrada: se muestra, no se silencia. */
interface DecisionOutcome {
  status: string
  detail: string | null
  conversationId: string | null
}
function AgentPendingPage() {
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
  // El caso cuyo resumen está abierto.
  const [briefFor, setBriefFor] = useState<AgentHandoff | null>(null)
  const canTasks = usePermission("tasks.write")
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
  // Solo los casos abiertos, igual que el panel: uno resuelto ya no espera a nadie.
  const handoffsQuery = useQuery({
    queryKey: ["agent-handoffs", search.conversationId],
    queryFn: () => apiFetch<{ data: AgentHandoff[] }>(`/api/agent/handoffs?open=1&limit=100${search.conversationId ? `&conversationId=${encodeURIComponent(search.conversationId)}` : ""}`),
    enabled: canRead,
  })
  const invalidate = () => {
    for (const key of ["agent-proposals", "agent-handoffs", "workspace-home", "workspace-pulse", "crm-context", "crm-activity", "opportunities", "opportunity-summary", "conversations", "conversation", "tasks"]) {
      void queryClient.invalidateQueries({ queryKey: [key] })
    }
  }
  useOrgEvents(EVENTS, invalidate)
  // Confirmar o ejecutar puede devolver 200 con `fallida`/`expirada`
  // (obsoleta o expirada sin rollback): la lista filtrada ya no la muestra,
  // así que el resultado queda fijo en pantalla junto a la vuelta al caso.
  const settleProposal = (response: { data: AgentProposal }) => {
    const proposal = response.data
    if (proposal.status === "fallida" || proposal.status === "expirada") {
      setOutcome({ status: proposal.status, detail: proposalErrorMessage(proposal), conversationId: proposal.conversationId })
    } else {
      setOutcome(null)
    }
    invalidate()
  }
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
  // «Tomar» es la misma acción que en la Bandeja: toma la conversación del caso.
  const claimMutation = useMutation({
    mutationFn: (handoff: AgentHandoff) => takeCase(handoff),
    onSuccess: invalidate,
  })
  const mutationError = executeMutation.error ?? confirmMutation.error ?? claimMutation.error
  const proposals = proposalsQuery.data?.data ?? []
  const handoffs = handoffsQuery.data?.data ?? []

  return <PageShell className="flex flex-col gap-6">
    <PageHeader title="Agente" subtitle="Lo que el agente te pasó y las citas que esperan el sí del paciente." />
    <AgentTabs />
    {!canRead ? <EmptyState title="Sin acceso" description="No tienes acceso a los pendientes del agente." /> : <>
      <section className="elevated rounded-xl border bg-card p-5">
        <h2 className="font-medium">{AGENT_CASES_TITLE}</h2>
        {handoffsQuery.isPending ? (
          <LoadingState />
        ) : handoffsQuery.isError ? (
          <div role="alert">
            <p>No pudimos cargar los casos del agente.</p>
            <Button variant="outline" onClick={() => void handoffsQuery.refetch()}>
              Volver a intentar
            </Button>
          </div>
        ) : handoffs.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Ningún caso del agente espera a tu equipo.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-4">
            {handoffs.map((handoff) => (
              <li key={handoff.id} className="border-b pb-4 last:border-b-0 last:pb-0">
                <HandoffNotice handoff={handoff} onOpenCase={setBriefFor}>
                  <span className="text-sm text-muted-foreground">
                    {handoff.status === "tomada" ? "Ya lo tomaron" : "Nadie lo ha tomado"}
                    {handoff.dueAt ? ` · vence ${new Date(handoff.dueAt).toLocaleString(activeOrgLocale())}` : ""}
                  </span>
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
                      Abrir la tarea
                    </Link>
                  ) : null}
                  {/* «Tomar» solo en un caso abierto que nadie tomó: uno resuelto no se toma. */}
                  {handoff.status === "abierta" && canTakeCase(handoff, canConversations, canTasks) ? (
                    <SubmitButton
                      size="sm"
                      variant="outline"
                      className="min-h-11 sm:min-h-8"
                      pending={claimMutation.isPending}
                      onClick={() => claimMutation.mutate(handoff)}
                    >
                      Tomar
                    </SubmitButton>
                  ) : null}
                </HandoffNotice>
              </li>
            ))}
          </ul>
        )}
      </section>
      <h2 className="font-medium">Citas que esperan el sí del paciente y lo que hizo el agente</h2>
      <div className="flex flex-wrap items-end gap-3">
        <Field className="w-56"><FieldLabel htmlFor="filtro-estado">Estado</FieldLabel>
          <Select value={status || "todos"} onValueChange={value => void navigate({ search: { ...search, status: value === "todos" ? "" : value ?? "propuesta" }, replace: true })}>
            <SelectTrigger id="filtro-estado"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="todos">Todos</SelectItem>{Object.entries(STATUS_LABEL).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        {search.conversationId && <><Link to="/inbox" search={{ conversation: search.conversationId }} className="text-sm text-primary underline">Volver a la conversación</Link><Button variant="outline" onClick={() => void navigate({ search: { status }, replace: true })}>Ver todos los casos</Button></>}
      </div>
      {mutationError && <p role="alert" className="text-sm text-destructive">{mutationError instanceof ApiError ? mutationError.shape.message : "No pudimos registrarlo. No se muestra como ejecutado."}</p>}
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
            <div className="flex flex-wrap items-center gap-2"><Badge variant={proposal.status === "propuesta" ? "default" : "secondary"}>{STATUS_LABEL[proposal.status] ?? proposal.status}</Badge><h3 className="font-medium">{ACTION_LABEL[proposal.action] ?? proposal.action}</h3><span className="text-xs text-muted-foreground">{new Date(proposal.createdAt).toLocaleString(activeOrgLocale())}</span></div>
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
            {proposal.context.isStale === true && proposal.status === "propuesta" && <p role="alert" className="text-sm text-destructive">La situación cambió desde que se propuso; revisa el estado del caso antes de registrar la confirmación.</p>}
            {proposal.conversationId && <Link to="/inbox" search={{ conversation: proposal.conversationId }} className="text-sm text-primary underline">Abrir conversación y evidencia</Link>}
            {proposalErrorMessage(proposal) && <p role="alert" className="text-sm text-destructive">{proposalErrorMessage(proposal)}</p>}
            {proposal.status === "ejecutada" && <p role="status" className="text-sm">Cambio ejecutado{proposal.executedAt ? ` · ${new Date(proposal.executedAt).toLocaleString(activeOrgLocale())}` : ""}. {typeof proposal.result?.messageId === "string" ? "Mensaje encolado; consulta su estado de entrega en el hilo." : "Consulta el estado actualizado en el caso."}</p>}
            {(proposal.status === "fallida" || proposal.status === "expirada") && <p role="alert" className="text-sm">Esta propuesta no se ejecutó ({STATUS_LABEL[proposal.status] ?? proposal.status}). Gestiona la acción manualmente desde el caso y su conversación; aquí no hay reintento.</p>}
            {authorized && canConversations && proposal.status === "propuesta" && proposal.mode === "confirmar_usuario" && <div className="flex flex-wrap gap-2">
              <SubmitButton size="sm" pending={confirmMutation.isPending} disabled={!proposal.contactId} onClick={() => { confirmMutation.reset(); confirmMutation.mutate(proposal) }}>Registrar confirmación del interlocutor</SubmitButton>
            </div>}
            {authorized && proposal.status === "aprobada" && <SubmitButton size="sm" variant="outline" pending={executeMutation.isPending} onClick={() => executeMutation.mutate(proposal.id)}>Ejecutar cambio aprobado</SubmitButton>}
          </li>
        })}</ul>
      </>}
      <CaseBriefDrawer
        conversationId={briefFor?.conversationId ?? null}
        name={briefFor?.contactName ?? "Interlocutor"}
        canTake={canConversations}
        onClose={() => setBriefFor(null)}
        onClaimed={invalidate}
      />
    </>}
  </PageShell>
}
