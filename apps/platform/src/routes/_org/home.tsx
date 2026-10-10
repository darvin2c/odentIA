import { Badge, Button } from "@odentia/ui"
import { AgentMark, AgentSurface, ConfirmDialog, DonutChart, EmptyState, ErrorState, FunnelChart, KpiCard, LoadingState, PageHeader, PageShell, SubmitButton, TrendChart } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, createFileRoute } from "@tanstack/react-router"
import { AlertTriangle, ArrowRight, Bot, CalendarDays, CheckCircle2, CheckSquare, Hand, Inbox, Wallet } from "lucide-react"
import { useState, type ReactNode } from "react"
import { type AgentPanelTab, useAgentPanel } from "../../components/agent-panel"
import { PerformanceSummary } from "../../components/crm/performance-summary"
import { HomeStart } from "../../components/home-start"
import { ACTION_LABEL, proposalErrorMessage, type AgentProposal } from "../../lib/agent"
import { ApiError, apiFetch } from "../../lib/api"
import { channelLabel } from "../../lib/channels"
import { usePermission } from "../../lib/crm"
import { useOrgEvents } from "../../lib/org-events"
import { moneyFromCents, stateLabel, type WorkspaceHome, type WorkspacePulse } from "../../lib/workspace"

export const Route = createFileRoute("/_org/home")({ component: HomePage })

/** Eventos que dejan obsoleto el home o el pulso (el poll de 5 min cubre huecos). */
const HOME_EVENTS = [
  "message.created",
  "message.updated",
  "conversation.updated",
  "agent.proposal.created",
  "agent.proposal.decided",
  "agent.proposal.executed",
  "agent.handoff.created",
  "agent.run.recorded",
  "appointment.updated",
  "task.updated",
  "payment.created",
  "payment.voided",
  "opportunity.updated",
  "contact.updated",
  "stream.reconnected",
]

/** Resumen de lo que el agente dejó en manos del equipo; omite lo que está en cero. */
function agentPendingSummary(pending: number, derived: number): string {
  const parts = [
    pending > 0 ? `${pending} ${pending === 1 ? "cambio" : "cambios"} del agente` : null,
    derived > 0 ? `${derived} ${derived === 1 ? "conversación derivada" : "conversaciones derivadas"}` : null,
  ].filter((part): part is string => part !== null)
  return parts.length > 0 ? `${parts.join(" y ")}.` : "Propuestas del agente y casos que derivó al equipo."
}

/**
 * En móvil se ve una sola cosa (la primera propuesta o, si no hay, la primera
 * derivación reciente); esto dice cuánto queda oculto, cómo nombrarlo y en qué
 * pestaña del panel está, para que el enlace lleve a lo que promete.
 */
function agentPendingRest(agent: NonNullable<WorkspaceHome["agent"]>): { rest: number; label: string; tab: AgentPanelTab } {
  const shown = agent.proposals.length > 0 || agent.recentHandoffs.length > 0 ? 1 : 0
  const derived = Math.max(agent.derivedConversations, agent.recentHandoffs.length)
  const rest = Math.max(agent.pendingProposals + derived - shown, 0)
  const proposalsLeft = agent.pendingProposals - (agent.proposals.length > 0 ? 1 : 0)
  const label =
    shown === 0
      ? rest === 1 ? "Ver la pendiente" : `Ver las ${rest} pendientes`
      : rest === 1 ? "Ver la otra" : `Ver las otras ${rest}`
  return { rest, label, tab: proposalsLeft > 0 ? "decidir" : "derivadas" }
}

function HomePage() {
  const queryClient = useQueryClient()
  const canApprove = usePermission("agent.decide")
  const canReadAgent = usePermission("agent.read")
  const agentPanel = useAgentPanel()
  const [approving, setApproving] = useState<NonNullable<WorkspaceHome["agent"]>["proposals"][number] | null>(null)
  // Un 200 con `fallida`/`expirada` saca la propuesta de pendientes: el
  // resultado queda fijo en pantalla junto a la vuelta al caso.
  const [outcome, setOutcome] = useState<{ status: string; detail: string | null; conversationId: string | null } | null>(null)
  const query = useQuery({ queryKey: ["workspace-home"], queryFn: () => apiFetch<{ data: WorkspaceHome }>("/api/workspace/home"), refetchInterval: 300_000 })
  useOrgEvents(HOME_EVENTS, () => {
    void queryClient.invalidateQueries({ queryKey: ["workspace-home"] })
    void queryClient.invalidateQueries({ queryKey: ["workspace-pulse"] })
  })
  // Aprobar desde el home equivale a "Aprobar y ejecutar" de la página de aprobaciones.
  const decideMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ data: AgentProposal }>(`/api/agent/proposals/${id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "aprobada" }),
      }),
    onSuccess: (response) => {
      setApproving(null)
      const proposal = response.data
      setOutcome(
        proposal.status === "fallida" || proposal.status === "expirada"
          ? { status: proposal.status, detail: proposalErrorMessage(proposal), conversationId: proposal.conversationId }
          : null,
      )
      void queryClient.invalidateQueries({ queryKey: ["workspace-home"] })
      void queryClient.invalidateQueries({ queryKey: ["workspace-pulse"] })
    },
  })
  const data = query.data?.data
  const hasAgentPending = Boolean(data?.agent && (data.agent.pendingProposals > 0 || data.agent.derivedConversations > 0 || data.agent.recentHandoffs.length > 0))
  const agentRest = data?.agent ? agentPendingRest(data.agent) : null
  const hasPending = Boolean(data && (hasAgentPending || data.appointments.length > 0 || (data.taskCount?.open ?? 0) > 0
    || (data.conversations && (data.conversations.waiting > 0 || data.conversations.unread > 0))
    || data.budgets.length > 0 || data.debt.length > 0
    || (data.agent?.today.error ?? 0) + (data.agent?.today.sinRespuesta ?? 0) > 0))
  const hasMetrics = Boolean(data && (data.appointmentCounts.some(item => item.count > 0 && item.status !== "cancelada")
    || (data.conversations && (data.conversations.waiting > 0 || data.conversations.unread > 0))
    || (data.taskCount?.open ?? 0) > 0 || data.debt.length > 0))
  const activeAppointments = data?.appointmentCounts.filter(item => item.status !== "cancelada").reduce((sum, item) => sum + item.count, 0) ?? 0
  const confirmedAppointments = data?.appointmentCounts.find(item => item.status === "confirmada")?.count ?? 0
  const decideError =
    decideMutation.error instanceof ApiError
      ? (decideMutation.error.shape.message ?? "No pudimos aprobar la propuesta")
      : decideMutation.error
        ? "No pudimos aprobar la propuesta"
        : null
  return <PageShell className="flex flex-col gap-6">
    <PageHeader title="Inicio" subtitle={data ? `Tu jornada · ${formatLongDay(data.date, data.locale)}` : "Lo que necesita tu atención hoy"} />
    {query.isPending ? <LoadingState /> : query.isError ? <ErrorState title="No pudimos cargar tu jornada" message="Comprueba tu conexión y vuelve a intentarlo." retryLabel="Volver a intentar" onRetry={() => void query.refetch()} /> : data ? <>
      {!hasPending && <HomeStart data={data} />}
      {data.agent && (hasAgentPending || outcome || decideError) && <AgentSurface aria-label="Pendiente de ti" className="enter">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <AgentMark />
          <div className="min-w-0 flex-1 basis-48">
            <h2 className="flex flex-wrap items-center gap-2 text-[17px] font-bold tracking-tight">Pendiente de ti
              {data.agent.pendingProposals > 0 && <Badge variant="soft">{data.agent.pendingProposals} por revisar</Badge>}
            </h2>
            <p className="text-sm text-muted-foreground">{agentPendingSummary(data.agent.pendingProposals, data.agent.derivedConversations)}</p>
          </div>
          <Link to="/agent/approvals" className="inline-flex min-h-11 shrink-0 items-center gap-1 text-sm font-semibold text-primary hover:underline">Revisar<ArrowRight className="size-4" aria-hidden /></Link>
        </div>
        {decideError ? <p role="alert" className="mb-3 text-sm text-destructive">{decideError}</p> : null}
        {outcome && <div role="alert" className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-warning/30 bg-warning-soft p-3 text-sm">
          <p className="min-w-0 flex-1">La propuesta quedó {outcome.status === "expirada" ? "expirada" : "fallida"}.{outcome.detail ? ` ${outcome.detail}` : ""} Gestiona la acción desde el caso.</p>
          <Link to={outcome.conversationId ? "/inbox" : "/agent/approvals"} search={outcome.conversationId ? { conversation: outcome.conversationId } : {}} className="shrink-0 text-primary underline">Volver al caso</Link>
          <button type="button" className="shrink-0 underline" onClick={() => setOutcome(null)}>Descartar</button>
        </div>}
        {data.agent.proposals.length > 0 && <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {/* Primero lo que decide el equipo: es lo único que el móvil enseña. */}
          {[...data.agent.proposals].sort((a, b) => Number(b.mode === "aprobar_equipo") - Number(a.mode === "aprobar_equipo")).map((proposal, index) => {
            const person = proposal.context.contactName ?? "Interlocutor no disponible"
            const forTeam = proposal.mode === "aprobar_equipo"
            // En móvil, una sola tarjeta: el resto se abre en el panel del agente.
            return <li key={proposal.id} className={`lift elevated min-w-0 flex-col gap-3 rounded-lg border bg-card p-4 ${index === 0 ? "flex" : "hidden sm:flex"}`}>
              <div className="flex flex-wrap items-center gap-2.5">
                <Initials name={person} />
                <div className="min-w-0 flex-1 basis-32 leading-tight">
                  <p className="truncate font-semibold">{person}</p>
                  <p className="truncate text-xs text-muted-foreground">{proposal.context.channel ? `${channelLabel(proposal.context.channel)} · ` : ""}{formatDateTime(proposal.createdAt, data.locale, data.timezone)}</p>
                </div>
                <Badge variant={forTeam ? "soft" : "secondary"}>{forTeam ? "Espera tu aprobación" : "Espera al interlocutor"}</Badge>
              </div>
              <p className="text-[15px] font-semibold">{ACTION_LABEL[proposal.action] ?? proposal.action}</p>
              <div className="flex flex-col gap-0.5 rounded-lg bg-muted/60 px-3 py-2.5 text-sm">
                {proposal.context.patientName && <p>Paciente: {proposal.context.patientName}</p>}
                {proposal.context.beforeSummary && <p className="text-xs text-muted-foreground">Al proponer: {proposal.context.beforeSummary}</p>}
                {proposal.context.currentSummary && <p className="text-xs text-muted-foreground">Estado del caso: {proposal.context.currentSummary}</p>}
                {proposal.summary ? <p>{proposal.summary}</p> : null}
              </div>
              <div className="mt-auto flex flex-wrap gap-2">
                {canApprove && forTeam ? <SubmitButton type="button" pending={decideMutation.isPending} onClick={() => setApproving(proposal)}>
                  Revisar y aprobar
                </SubmitButton> : <Button variant="outline" nativeButton={false} render={<Link to="/agent/approvals" search={{ conversationId: proposal.conversationId ?? undefined }} />}>Revisar caso</Button>}
              </div>
            </li>
          })}
        </ul>}
        {data.agent.recentHandoffs.length > 0 && <div className={data.agent.proposals.length > 0 ? "mt-4 hidden sm:block" : undefined}>
          <p className="text-sm font-semibold">Derivaciones recientes</p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {data.agent.recentHandoffs.map((handoff, index) => {
              const high = handoff.priority === "alta"
              return <li key={handoff.id} className={index === 0 ? "max-w-full" : "hidden max-w-full sm:list-item"}>
                <Link to={handoff.conversationId ? "/inbox" : "/agent/approvals"} search={handoff.conversationId ? { conversation: handoff.conversationId } : {}} className="flex min-h-11 max-w-full items-center gap-2 rounded-3xl border bg-card px-3.5 py-1.5 text-sm transition-colors hover:bg-accent/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
                  <span aria-hidden className={high ? "size-2 shrink-0 rounded-full bg-destructive" : "size-2 shrink-0 rounded-[2px] bg-warning"} />
                  <span className="min-w-0">{handoff.contactName ? `${handoff.contactName} · ` : ""}{handoff.reason}</span>
                  <span className={high ? "shrink-0 font-semibold text-destructive" : "shrink-0 font-semibold text-warning"}>Prioridad {handoff.priority}</span>
                </Link>
              </li>
            })}
          </ul>
        </div>}
        {agentRest && agentRest.rest > 0 && <button type="button" onClick={() => agentPanel.setOpen(true, agentRest.tab)} className="mt-3 flex min-h-11 w-full items-center justify-between rounded-lg text-left text-sm font-semibold text-primary hover:underline sm:hidden">
          {agentRest.label}
          <ArrowRight className="size-4" aria-hidden />
        </button>}
      </AgentSurface>}
      {hasMetrics && <div className="enter grid grid-cols-1 gap-4 [--enter-index:1] sm:grid-cols-2 xl:grid-cols-4">
        {data.access.appointments && data.appointmentCounts.some(item => item.count > 0 && item.status !== "cancelada") && <Metric title="Citas de hoy" value={activeAppointments} meter={{ value: confirmedAppointments, total: activeAppointments }} detail={`${confirmedAppointments} confirmadas · abrir agenda`} href="/agenda" icon={<CalendarDays />} />}
        {data.conversations && (data.conversations.waiting > 0 || data.conversations.unread > 0) && <Metric title={data.conversations.waiting > 0 ? "Esperan respuesta" : "Conversaciones sin leer"} value={data.conversations.waiting || data.conversations.unread} meter={{ value: data.conversations.unread, total: Math.max(data.conversations.waiting, data.conversations.unread) }} detail={`${data.conversations.human} con atención humana · ${data.conversations.unread} sin leer`} href="/inbox" icon={<Inbox />} />}
        {data.taskCount && data.taskCount.open > 0 && <Metric title="Tareas abiertas" value={data.taskCount.open} meter={{ value: data.taskCount.overdue, total: data.taskCount.open, tone: "danger" }} detail={`${data.taskCount.overdue} vencidas${data.access.allTasks ? " en el equipo" : " asignadas a ti"}`} href="/tasks" icon={<CheckSquare />} />}
        {data.access.finance && data.debt.length > 0 && <Metric title="Cuentas con saldo" value={data.debt.reduce((sum, item) => sum + item.patients, 0)} detail="Revisar cobranza · por moneda" href="/finance" icon={<Wallet />} />}
      </div>}
      {(data.appointments.length > 0 || data.tasks.length > 0 || data.budgets.length > 0 || data.debt.length > 0) && <div className="enter grid grid-cols-1 items-start gap-4 [--enter-index:2] xl:grid-cols-2">
        {data.access.appointments && data.appointments.length > 0 && <Section title="Agenda de hoy" href="/agenda" action="Ver agenda">
          <ul className="flex flex-col gap-1.5">{data.appointments.map(item => {
            const tone = APPOINTMENT_TONE[item.status] ?? APPOINTMENT_TONE.programada
            return <li key={item.id} className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 ${tone.row}`}>
              <p className="w-[4.75rem] shrink-0 text-sm font-semibold whitespace-nowrap tabular-nums">{new Date(item.startsAt).toLocaleTimeString(data.locale, { timeZone: data.timezone, hour: "2-digit", minute: "2-digit" })}</p>
              <div className="min-w-0 flex-1 leading-tight"><Link to="/patients/$patientId" params={{ patientId: item.patientId }} className="font-semibold hover:underline">{item.patientName}</Link><p className="truncate text-xs text-muted-foreground">{item.dentistName} · {item.branchName}</p></div>
              <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-md bg-card px-2 py-0.5 text-xs font-semibold ${tone.text}`}><span aria-hidden className={`size-1.5 rounded-full ${tone.dot}`} />{stateLabel[item.status] ?? item.status}</span>
            </li>
          })}</ul>
        </Section>}
        {data.access.tasks && data.tasks.length > 0 && <Section title={data.access.allTasks ? "Pendientes del equipo" : "Mis pendientes"} href="/tasks" action="Ver tareas">
          <ul className="divide-y">{data.tasks.map(item => <li key={item.id}><Link to={item.href} className="flex justify-between gap-3 rounded-sm py-3 focus-visible:outline-2 focus-visible:outline-primary"><span className="text-sm">{item.title}</span>{item.overdue && <Badge variant="destructive">Vencida</Badge>}</Link></li>)}</ul>
        </Section>}
        {(data.access.finance || data.access.clinical) && data.budgets.length > 0 && <Section title="Presupuestos por seguir" href="/patients" action="Ver pacientes">
          <ul className="divide-y">{data.budgets.map(item => <li key={item.id} className="py-3"><Link to="/patients/$patientId" params={{ patientId: item.patientId }} search={{ tab: "plan" }} className="font-medium hover:underline">{item.patientName}</Link><p className="text-sm text-muted-foreground">{item.title}</p></li>)}</ul>
        </Section>}
        {data.access.finance && data.debt.length > 0 && <Section title="Cobranza pendiente" href="/finance" action="Revisar cuentas">
          <ul className="divide-y">{data.debt.map(item => <li key={item.currency} className="py-3"><p className="font-medium">{moneyFromCents(item.outstandingCents, item.currency, data.locale)}</p><p className="text-sm text-muted-foreground">Vencido: {moneyFromCents(item.overdueCents, item.currency, data.locale)}</p></li>)}</ul>
        </Section>}
      </div>}
      {data.agent && data.agent.today.runs > 0 && <section aria-label="El agente hoy" className="enter flex flex-col gap-4 [--enter-index:3]">
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-base font-bold tracking-tight"><AgentMark size="sm" />El agente hoy</h2>
          <Link to={canReadAgent ? "/agent" : "/agent/approvals"} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">{canReadAgent ? "Ver agente" : "Revisar decisiones"}<ArrowRight className="size-4" aria-hidden /></Link>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard title="Intervenciones de hoy" value={data.agent.today.runs} description="Veces que el agente actuó" icon={<Bot className="size-5" />} />
          <KpiCard title="Ejecuciones correctas" value={data.agent.today.ok} description="Sin fallo técnico registrado; no mide resolución" icon={<CheckCircle2 className="size-5" />} />
          <KpiCard title="Derivadas al equipo" value={data.agent.today.handoff} description="Pidió ayuda humana" icon={<Hand className="size-5" />} />
          <KpiCard title="Necesitan revisión" value={data.agent.today.error + data.agent.today.sinRespuesta} description="Con error o sin responder al interlocutor" icon={<AlertTriangle className="size-5" />} />
        </div>
      </section>}
      <PulseSection locale={data.locale} />
      {!Object.entries(data.access).some(([key, value]) => key !== "allTasks" && key !== "configure" && value) && <EmptyState title="Sin permisos operativos" description="Pide a la administración los permisos necesarios para tu trabajo." />}
    </> : null}
    <ConfirmDialog open={approving !== null} title="Aprobar y ejecutar el cambio" description={approving ? `${approving.context.contactName ?? "Interlocutor"}: ${approving.context.afterSummary}` : ""} confirmLabel="Aprobar y ejecutar" variant="default" pending={decideMutation.isPending} onClose={() => { if (!decideMutation.isPending) setApproving(null) }} onConfirm={() => approving && decideMutation.mutate(approving.id)} />
  </PageShell>
}

/** Foto de los últimos 30 días; las ejecuciones no se confunden con resultados. */
function PulseSection({ locale }: { locale: string }) {
  const pulseQuery = useQuery({ queryKey: ["workspace-pulse"], queryFn: () => apiFetch<{ data: WorkspacePulse }>("/api/workspace/pulse"), refetchInterval: 300_000 })
  const source = pulseQuery.data?.data
  // Una respuesta autorizada puede contener agregados vacíos: no son actividad.
  const pulse = source ? {
    ...source,
    funnel: source.funnel?.some(item => item.count > 0) ? source.funnel : null,
    channels: source.channels?.some(item => item.count > 0) ? source.channels : null,
    execution: source.execution?.some(item => item.ok > 0 || item.handoff > 0 || item.error > 0 || item.sinRespuesta > 0) ? source.execution : null,
    collections: source.collections?.length ? source.collections : null,
    performance: {
      responses: source.performance.responses?.conversations ? source.performance.responses : null,
      followUps: source.performance.followUps?.open ? source.performance.followUps : null,
      conversations: source.performance.conversations && (source.performance.conversations.closed > 0 || source.performance.conversations.waiting > 0) ? source.performance.conversations : null,
      bookings: source.performance.bookings?.length ? source.performance.bookings : null,
      conversion: source.performance.conversion?.length ? source.performance.conversion : null,
      proposals: source.performance.proposals && (source.performance.proposals.executed > 0 || source.performance.proposals.failed > 0 || source.performance.proposals.pending > 0) ? source.performance.proposals : null,
      handoffs: source.performance.handoffs?.cohort ? source.performance.handoffs : null,
      clinicalControls: source.performance.clinicalControls?.cohort ? source.performance.clinicalControls : null,
      taskTimeliness: source.performance.taskTimeliness?.cohort ? source.performance.taskTimeliness : null,
    },
  } : null
  if (pulseQuery.isPending) {
    return <section aria-label="Pulso" className="flex flex-col gap-4">
      <h2 className="font-semibold">Pulso</h2>
      <LoadingState />
    </section>
  }
  if (pulseQuery.isError || !pulse) {
    return <section aria-label="Pulso" className="flex flex-col gap-4">
      <h2 className="font-semibold">Pulso</h2>
      <p role="alert" className="text-sm text-muted-foreground">No pudimos cargar el pulso de tu consultorio. <button type="button" className="underline" onClick={() => void pulseQuery.refetch()}>Volver a intentar</button></p>
    </section>
  }
  if (!pulse.funnel && !pulse.channels && !pulse.execution && !pulse.collections && !Object.values(pulse.performance).some(value => value !== null)) return null
  // Con varias monedas se distingue la etapa por moneda para no mezclar importes.
  const funnelByCurrency: Record<string, true> = {}
  for (const item of pulse.funnel ?? []) funnelByCurrency[item.currency] = true
  const funnelCurrencies = Object.keys(funnelByCurrency)
  const executionPoints = pulse.execution?.map(day => ({
    label: formatDay(day.day, locale), value: day.ok,
  }))
  // 30 días con varias series se lee mejor con una línea por moneda que con barras.
  const collectionsByCurrency: Record<string, { label: string; value: number }[]> = {}
  for (const row of pulse.collections ?? []) {
    const points = collectionsByCurrency[row.currency] ?? []
    points.push({ label: formatDay(row.day, locale), value: Number(BigInt(row.amountCents)) / 100 })
    collectionsByCurrency[row.currency] = points
  }
  return <section aria-label="Pulso" className="flex flex-col gap-4">
    <div>
      <h2 className="font-semibold">Pulso</h2>
      <p className="text-sm text-muted-foreground">Cómo va tu consultorio en los últimos 30 días.</p>
    </div>
    <div className="grid items-start gap-6 xl:grid-cols-2">
      {pulse.funnel && <FunnelChart
        title="Oportunidades por etapa"
        summary={`Oportunidades abiertas por etapa del embudo: ${pulse.funnel.reduce((total, item) => total + item.count, 0)} oportunidades con su importe estimado.`}
        stages={pulse.funnel.map(item => ({
          label: funnelCurrencies.length > 1 ? `${item.stage} · ${item.currency}` : item.stage,
          value: item.count,
          detail: moneyFromCents(item.amountCents, item.currency, locale),
        }))}
      />}
      {pulse.channels && <DonutChart
        title="Conversaciones abiertas por canal"
        summary={`Conversaciones abiertas por canal: ${pulse.channels.map(item => `${channelLabel(item.channel)} ${item.count}`).join(", ")}.`}
        segments={pulse.channels.map(item => ({ label: channelLabel(item.channel), value: item.count }))}
      />}
      {executionPoints && (executionPoints.some(point => point.value > 0) ? <TrendChart
        title="Ejecuciones correctas del agente"
        summary="Cantidad de ejecuciones sin fallo técnico registrado por día. No representa casos resueltos ni calidad de respuesta."
        points={executionPoints}
      /> : <EmptyState title="Sin ejecuciones correctas" description="No hay ejecuciones correctas registradas en el período. Sin actividad no equivale a éxito." />)}
      {Object.entries(collectionsByCurrency).map(([currency, points]) => <TrendChart
        key={currency}
        title={`Cobros por día · ${currency}`}
        summary={`Dinero cobrado por día en ${currency} durante los últimos 30 días.`}
        points={points}
      />)}
    </div>
    <PerformanceSummary data={pulse.performance} />
  </section>
}

function Metric({ title, value, detail, href, icon, meter }: { title: string; value: number; detail: string; href: string; icon: ReactNode; meter?: { value: number; total: number; tone?: "primary" | "danger" } }) {
  return <Link to={href} className="rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"><KpiCard title={title} value={value} description={detail} icon={icon} meter={meter} className="lift" /></Link>
}
function Section({ title, href, action, children }: { title: string; href: string; action: string; children: ReactNode }) {
  return <section className="elevated rounded-xl border bg-card p-5"><div className="mb-3 flex items-center justify-between gap-3"><h2 className="text-base font-bold tracking-tight">{title}</h2><Link to={href} className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">{action}<ArrowRight className="size-4" aria-hidden /></Link></div>{children}</section>
}
/** Fondo, punto y texto por estado de cita; el estado siempre va también escrito. */
const APPOINTMENT_TONE: Record<string, { row: string; dot: string; text: string }> = {
  confirmada: { row: "border-agent-border bg-primary-soft/50", dot: "bg-primary", text: "text-primary-soft-foreground" },
  programada: { row: "border-border bg-muted", dot: "border border-muted-foreground", text: "text-muted-foreground" },
  atendida: { row: "border-success/20 bg-success-soft", dot: "bg-success", text: "text-success" },
  no_asistio: { row: "border-warning/25 bg-warning-soft", dot: "bg-warning", text: "text-warning" },
  cancelada: { row: "border-destructive/20 bg-danger-soft", dot: "bg-destructive", text: "text-destructive" },
}
/** Iniciales de la persona: ancla visual de la tarjeta, sin foto ni color propio. */
function Initials({ name }: { name: string }) {
  const letters = name.trim().split(/\s+/).slice(0, 2).map(part => part.charAt(0).toUpperCase()).join("")
  return <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-[13px] font-semibold">{letters || "?"}</span>
}
/** Fecha ISO → texto corto en el idioma y zona de la organización. */
function formatDateTime(value: string, locale: string, timezone: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(locale, { timeZone: timezone, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
}
/** Día `YYYY-MM-DD` (ya en zona de la org) → «miércoles, 7 de octubre» sin desplazar por zona. */
function formatLongDay(day: string, locale: string) {
  const date = new Date(`${day}T12:00:00`)
  if (Number.isNaN(date.getTime())) return day
  return date.toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long" })
}
/** Día `YYYY-MM-DD` (ya en zona de la org) → etiqueta corta sin desplazar por zona. */
function formatDay(day: string, locale: string) {
  const date = new Date(`${day}T12:00:00`)
  if (Number.isNaN(date.getTime())) return day
  return date.toLocaleDateString(locale, { day: "2-digit", month: "short" })
}
