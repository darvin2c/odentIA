import { Badge } from "@odentia/ui"
import { ConfirmDialog, DonutChart, EmptyState, FunnelChart, KpiCard, LoadingState, PageHeader, PageShell, SubmitButton, TrendChart } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, createFileRoute } from "@tanstack/react-router"
import { AlertTriangle, ArrowRight, Bot, CalendarDays, CheckCircle2, CheckSquare, Hand, Inbox, Wallet } from "lucide-react"
import { useState, type ReactNode } from "react"
import { PerformanceSummary } from "../../components/crm/performance-summary"
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
  "appointment.updated",
  "task.updated",
  "payment.created",
  "payment.voided",
  "opportunity.updated",
  "contact.updated",
  "stream.reconnected",
]

function HomePage() {
  const queryClient = useQueryClient()
  const canApprove = usePermission("agent.decide")
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
  const decideError =
    decideMutation.error instanceof ApiError
      ? (decideMutation.error.shape.message ?? "No pudimos aprobar la propuesta")
      : decideMutation.error
        ? "No pudimos aprobar la propuesta"
        : null
  return <PageShell className="flex flex-col gap-6">
    <PageHeader title="Inicio" subtitle={data ? `Tu jornada · ${data.date} · ${data.timezone}` : "Lo que necesita tu atención hoy"} />
    {query.isPending ? <LoadingState /> : query.isError ? <p role="alert">No pudimos cargar tu jornada. <button type="button" className="underline" onClick={() => void query.refetch()}>Volver a intentar</button></p> : data ? <>
      {data.agent && <section aria-label="Pendiente de ti" className="rounded-md border bg-card p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 font-semibold">Pendiente de ti
            {data.agent.pendingProposals > 0 && <Badge>{data.agent.pendingProposals} por revisar</Badge>}
          </h2>
          <Link to="/agent/approvals" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">Revisar<ArrowRight className="size-4" aria-hidden /></Link>
        </div>
        {decideError ? <p role="alert" className="mb-3 text-sm text-destructive">{decideError}</p> : null}
        {outcome && <div role="alert" className="mb-3 flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm">
          <p className="min-w-0 flex-1">La propuesta quedó {outcome.status === "expirada" ? "expirada" : "fallida"}.{outcome.detail ? ` ${outcome.detail}` : ""} Gestiona la acción desde el caso.</p>
          <Link to={outcome.conversationId ? "/inbox" : "/agent/approvals"} search={outcome.conversationId ? { conversation: outcome.conversationId } : {}} className="shrink-0 text-primary underline">Volver al caso</Link>
          <button type="button" className="shrink-0 underline" onClick={() => setOutcome(null)}>Descartar</button>
        </div>}
        {data.agent.proposals.length > 0 && <ul className="flex flex-col gap-3">
          {data.agent.proposals.map(proposal => <li key={proposal.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
            <div className="min-w-0">
              <p className="font-medium">{ACTION_LABEL[proposal.action] ?? proposal.action}</p>
              <p className="text-sm">{proposal.context.contactName ?? "Interlocutor no disponible"}{proposal.context.patientName ? ` · Paciente: ${proposal.context.patientName}` : ""}</p>
              {proposal.context.beforeSummary && <p className="text-xs text-muted-foreground">Al proponer: {proposal.context.beforeSummary}</p>}
              {proposal.context.currentSummary && <p className="text-xs text-muted-foreground">Estado del caso: {proposal.context.currentSummary}</p>}
              {proposal.summary ? <p className="text-sm text-muted-foreground">{proposal.summary}</p> : null}
              <p className="text-xs text-muted-foreground">{formatDateTime(proposal.createdAt, data.locale, data.timezone)}</p>
            </div>
            {canApprove && proposal.mode === "aprobar_equipo" ? <SubmitButton type="button" size="sm" pending={decideMutation.isPending} onClick={() => setApproving(proposal)}>
              Revisar y aprobar
            </SubmitButton> : <Link to="/agent/approvals" search={{ conversationId: proposal.conversationId ?? undefined }} className="text-sm text-primary underline">Revisar caso</Link>}
          </li>)}
        </ul>}
        {data.agent.recentHandoffs.length > 0 && <div className={data.agent.proposals.length > 0 ? "mt-4" : undefined}>
          <p className="text-sm font-medium">Derivaciones al equipo ({data.agent.recentHandoffs.length})</p>
          <ul className="mt-2 flex flex-col gap-2">
            {data.agent.recentHandoffs.map(handoff => <li key={handoff.id}>
              <Link to={handoff.conversationId ? "/inbox" : "/agent/approvals"} search={handoff.conversationId ? { conversation: handoff.conversationId } : {}} className="flex flex-wrap items-center gap-2 rounded-md border p-3 hover:bg-muted/40">
                <Badge variant={handoff.priority === "alta" ? "destructive" : "secondary"}>{handoff.priority}</Badge>
                {handoff.contactName && <span className="text-sm">{handoff.contactName}{handoff.channel ? ` · ${channelLabel(handoff.channel)}` : ""}</span>}
                <span className="text-sm font-medium">{handoff.reason}</span>
                <span className="text-xs text-muted-foreground">{formatDateTime(handoff.createdAt, data.locale, data.timezone)}</span>
              </Link>
            </li>)}
          </ul>
        </div>}
        {data.agent.proposals.length === 0 && data.agent.recentHandoffs.length === 0 &&
          <p className="text-sm text-muted-foreground">No hay propuestas pendientes ni derivaciones recientes. Esto no acredita que todos los casos estén resueltos.</p>}
      </section>}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {data.access.appointments && <Metric title="Citas de hoy" value={data.appointmentCounts.filter(item => item.status !== "cancelada").reduce((sum, item) => sum + item.count, 0)} detail="Abrir agenda" href="/agenda" icon={<CalendarDays className="size-5" />} />}
        {data.conversations && <Metric title="Esperan respuesta" value={data.conversations.waiting} detail={`${data.conversations.human} pendientes con atención humana`} href="/inbox" icon={<Inbox className="size-5" />} />}
        {data.taskCount && <Metric title="Tareas vencidas" value={data.taskCount.overdue} detail={`${data.taskCount.open} tareas abiertas${data.access.allTasks ? " en el equipo" : " asignadas a ti"}`} href="/tasks" icon={<CheckSquare className="size-5" />} />}
        {data.access.finance && <Metric title="Cuentas con saldo" value={data.debt.reduce((sum, item) => sum + item.patients, 0)} detail="Revisar cobranza · por moneda" href="/finance" icon={<Wallet className="size-5" />} />}
      </div>
      <div className="grid items-start gap-6 xl:grid-cols-2">
        {data.access.appointments && <Section title="Agenda de hoy" href="/agenda" action="Ver agenda">
          {data.appointments.length === 0 ? <p className="text-sm text-muted-foreground">No hay citas pendientes para hoy.</p> : <ul className="divide-y">{data.appointments.map(item => <li key={item.id} className="flex items-center justify-between gap-4 py-3">
            <div className="min-w-0"><Link to="/patients/$patientId" params={{ patientId: item.patientId }} className="font-medium hover:underline">{item.patientName}</Link><p className="text-sm text-muted-foreground">{item.dentistName} · {item.branchName}</p></div>
            <div className="shrink-0 text-right"><p className="text-sm font-medium">{new Date(item.startsAt).toLocaleTimeString(data.locale, { timeZone: data.timezone, hour: "2-digit", minute: "2-digit" })}</p><Badge variant="secondary">{stateLabel[item.status] ?? item.status}</Badge></div>
          </li>)}</ul>}
        </Section>}
        {data.access.tasks && <Section title={data.access.allTasks ? "Pendientes del equipo" : "Mis pendientes"} href="/tasks" action="Ver tareas">
          {data.tasks.length === 0 ? <p className="text-sm text-muted-foreground">No tienes tareas pendientes.</p> : <ul className="divide-y">{data.tasks.map(item => <li key={item.id}><Link to={item.href} className="flex justify-between gap-3 rounded-sm py-3 focus-visible:outline-2 focus-visible:outline-primary"><span className="text-sm">{item.title}</span>{item.overdue && <Badge variant="destructive">Vencida</Badge>}</Link></li>)}</ul>}
        </Section>}
        {(data.access.finance || data.access.clinical) && <Section title="Presupuestos por seguir" href="/patients" action="Ver pacientes">
          {data.budgets.length === 0 ? <p className="text-sm text-muted-foreground">No hay presupuestos presentados o pospuestos por revisar.</p> : <ul className="divide-y">{data.budgets.map(item => <li key={item.id} className="py-3"><Link to="/patients/$patientId" params={{ patientId: item.patientId }} search={{ tab: "plan" }} className="font-medium hover:underline">{item.patientName}</Link><p className="text-sm text-muted-foreground">{item.title}</p></li>)}</ul>}
        </Section>}
        {data.access.finance && <Section title="Cobranza pendiente" href="/finance" action="Revisar cuentas">
          {data.debt.length === 0 ? <p className="text-sm text-muted-foreground">No hay cargos con saldo pendiente.</p> : <ul className="divide-y">{data.debt.map(item => <li key={item.currency} className="py-3"><p className="font-medium">{moneyFromCents(item.outstandingCents, item.currency, data.locale)}</p><p className="text-sm text-muted-foreground">Vencido: {moneyFromCents(item.overdueCents, item.currency, data.locale)}</p></li>)}</ul>}
        </Section>}
      </div>
      {data.agent && <section aria-label="El agente hoy" className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-semibold">El agente hoy</h2>
          <Link to="/agent" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">Ver agente<ArrowRight className="size-4" aria-hidden /></Link>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard title="Intervenciones de hoy" value={data.agent.today.runs} description="Veces que el agente actuó" icon={<Bot className="size-5" />} />
          <KpiCard title="Ejecuciones correctas" value={data.agent.today.ok} description="Sin fallo técnico registrado; no mide resolución" icon={<CheckCircle2 className="size-5" />} />
          <KpiCard title="Derivadas al equipo" value={data.agent.today.handoff} description="Pidió ayuda humana" icon={<Hand className="size-5" />} />
          <KpiCard title="Con error" value={data.agent.today.error} description="Necesitan revisión" icon={<AlertTriangle className="size-5" />} />
        </div>
      </section>}
      <PulseSection locale={data.locale} />
      {!Object.entries(data.access).some(([key, value]) => key !== "allTasks" && value) && <EmptyState title="Tu espacio está listo" description="Pide a la administración los permisos necesarios para tu trabajo." />}
    </> : null}
    <ConfirmDialog open={approving !== null} title="Aprobar y ejecutar el cambio" description={approving ? `${approving.context.contactName ?? "Interlocutor"}: ${approving.context.afterSummary}` : ""} confirmLabel="Aprobar y ejecutar" variant="default" pending={decideMutation.isPending} onClose={() => { if (!decideMutation.isPending) setApproving(null) }} onConfirm={() => approving && decideMutation.mutate(approving.id)} />
  </PageShell>
}

/** Foto de los últimos 30 días; las ejecuciones no se confunden con resultados. */
function PulseSection({ locale }: { locale: string }) {
  const pulseQuery = useQuery({ queryKey: ["workspace-pulse"], queryFn: () => apiFetch<{ data: WorkspacePulse }>("/api/workspace/pulse"), refetchInterval: 300_000 })
  const pulse = pulseQuery.data?.data
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

function Metric({ title, value, detail, href, icon }: { title: string; value: number; detail: string; href: string; icon: ReactNode }) {
  return <Link to={href} className="rounded-md focus-visible:outline-2 focus-visible:outline-primary"><KpiCard title={title} value={value} description={detail} icon={icon} className="hover:bg-muted/40 transition-colors" /></Link>
}
function Section({ title, href, action, children }: { title: string; href: string; action: string; children: ReactNode }) {
  return <section className="rounded-md border bg-card p-5"><div className="mb-4 flex items-center justify-between gap-3"><h2 className="font-semibold">{title}</h2><Link to={href} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">{action}<ArrowRight className="size-4" aria-hidden /></Link></div>{children}</section>
}
/** Fecha ISO → texto corto en el idioma y zona de la organización. */
function formatDateTime(value: string, locale: string, timezone: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(locale, { timeZone: timezone, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
}
/** Día `YYYY-MM-DD` (ya en zona de la org) → etiqueta corta sin desplazar por zona. */
function formatDay(day: string, locale: string) {
  const date = new Date(`${day}T12:00:00`)
  if (Number.isNaN(date.getTime())) return day
  return date.toLocaleDateString(locale, { day: "2-digit", month: "short" })
}
