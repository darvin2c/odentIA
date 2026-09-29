import { Badge } from "@odentia/ui"
import { DonutChart, EmptyState, FunnelChart, KpiCard, LoadingState, PageHeader, PageShell, SubmitButton, TrendChart } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { AlertTriangle, ArrowRight, Bot, CalendarDays, CheckCircle2, CheckSquare, Hand, Inbox, Wallet } from "lucide-react"
import type { ReactNode } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { ACTION_LABEL } from "../../lib/agent"
import { usePermission } from "../../lib/crm"
import { useOrgEvents } from "../../lib/org-events"
import { type WorkspaceHome, type WorkspacePulse, moneyFromCents, stateLabel } from "../../lib/workspace"

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
]

function HomePage() {
  const queryClient = useQueryClient()
  const canApprove = usePermission("agent.write")
  const query = useQuery({ queryKey: ["workspace-home"], queryFn: () => apiFetch<{ data: WorkspaceHome }>("/api/workspace/home"), refetchInterval: 300_000 })
  useOrgEvents(HOME_EVENTS, () => {
    void queryClient.invalidateQueries({ queryKey: ["workspace-home"] })
    void queryClient.invalidateQueries({ queryKey: ["workspace-pulse"] })
  })
  // Aprobar desde el home equivale a "Aprobar y ejecutar" de la página de aprobaciones.
  const decideMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/agent/proposals/${id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "aprobada" }),
      }),
    onSuccess: () => {
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
        {data.agent.proposals.length > 0 && <ul className="flex flex-col gap-3">
          {data.agent.proposals.map(proposal => <li key={proposal.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
            <div className="min-w-0">
              <p className="font-medium">{ACTION_LABEL[proposal.action] ?? proposal.action}</p>
              {proposal.summary ? <p className="text-sm text-muted-foreground">{proposal.summary}</p> : null}
              <p className="text-xs text-muted-foreground">{formatDateTime(proposal.createdAt, data.locale, data.timezone)}</p>
            </div>
            {canApprove && <SubmitButton type="button" size="sm" pending={decideMutation.isPending} onClick={() => decideMutation.mutate(proposal.id)}>
              Aprobar y ejecutar
            </SubmitButton>}
          </li>)}
        </ul>}
        {data.agent.recentHandoffs.length > 0 && <div className={data.agent.proposals.length > 0 ? "mt-4" : undefined}>
          <p className="text-sm font-medium">Derivaciones al equipo ({data.agent.recentHandoffs.length})</p>
          <ul className="mt-2 flex flex-col gap-2">
            {data.agent.recentHandoffs.map(handoff => <li key={handoff.id}>
              <Link to="/agent/approvals" className="flex flex-wrap items-center gap-2 rounded-md border p-3 hover:bg-muted/40">
                <Badge variant={handoff.priority === "alta" ? "destructive" : "secondary"}>{handoff.priority}</Badge>
                <span className="text-sm font-medium">{handoff.reason}</span>
                <span className="text-xs text-muted-foreground">{formatDateTime(handoff.createdAt, data.locale, data.timezone)}</span>
              </Link>
            </li>)}
          </ul>
        </div>}
        {data.agent.proposals.length === 0 && data.agent.recentHandoffs.length === 0 &&
          <p className="text-sm text-muted-foreground">El agente tiene todo bajo control. No hay propuestas ni derivaciones esperando tu revisión.</p>}
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
          {data.tasks.length === 0 ? <p className="text-sm text-muted-foreground">No tienes tareas pendientes.</p> : <ul className="divide-y">{data.tasks.map(item => <li key={item.id} className="flex justify-between gap-3 py-3"><span className="text-sm">{item.title}</span>{item.overdue && <Badge variant="destructive">Vencida</Badge>}</li>)}</ul>}
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
          <KpiCard title="Resueltas sin ayuda" value={data.agent.today.ok} description="El agente lo resolvió solo" icon={<CheckCircle2 className="size-5" />} />
          <KpiCard title="Derivadas al equipo" value={data.agent.today.handoff} description="Pidió ayuda humana" icon={<Hand className="size-5" />} />
          <KpiCard title="Con error" value={data.agent.today.error} description="Necesitan revisión" icon={<AlertTriangle className="size-5" />} />
        </div>
      </section>}
      <PulseSection locale={data.locale} />
      {!Object.entries(data.access).some(([key, value]) => key !== "allTasks" && value) && <EmptyState title="Tu espacio está listo" description="Pide a la administración los permisos necesarios para tu trabajo." />}
    </> : null}
  </PageShell>
}

/** Foto de los últimos 30 días: embudo, canales, autonomía del agente y cobros. */
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
  if (!pulse.funnel && !pulse.channels && !pulse.autonomy && !pulse.collections) return null
  // Con varias monedas se distingue la etapa por moneda para no mezclar importes.
  const funnelByCurrency: Record<string, true> = {}
  for (const item of pulse.funnel ?? []) funnelByCurrency[item.currency] = true
  const funnelCurrencies = Object.keys(funnelByCurrency)
  const autonomyPoints = pulse.autonomy?.map(day => {
    const total = day.ok + day.handoff
    return { label: formatDay(day.day, locale), value: total === 0 ? 100 : Math.round((day.ok / total) * 100) }
  })
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
        summary={`Oportunidades abiertas por etapa del embudo: ${pulse.funnel.length} registros con su importe estimado.`}
        stages={pulse.funnel.map(item => ({
          label: funnelCurrencies.length > 1 ? `${item.stage} · ${item.currency}` : item.stage,
          value: item.count,
          detail: moneyFromCents(item.amountCents, item.currency, locale),
        }))}
      />}
      {pulse.channels && <DonutChart
        title="Conversaciones abiertas por canal"
        summary={`De dónde llegan las conversaciones que siguen abiertas: ${pulse.channels.map(item => `${item.channel} ${item.count}`).join(", ")}.`}
        segments={pulse.channels.map(item => ({ label: item.channel, value: item.count }))}
      />}
      {autonomyPoints && <TrendChart
        title="El agente resolviendo solo"
        summary="Porcentaje de casos que el agente resolvió sin pedir ayuda, por día. Los días sin casos cuentan como 100."
        points={autonomyPoints}
      />}
      {Object.entries(collectionsByCurrency).map(([currency, points]) => <TrendChart
        key={currency}
        title={`Cobros por día · ${currency}`}
        summary={`Dinero cobrado por día en ${currency} durante los últimos 30 días.`}
        points={points}
      />)}
    </div>
  </section>
}

function Metric({ title, value, detail, href, icon }: { title: string; value: number; detail: string; href: string; icon: ReactNode }) {
  return <Link to={href} className="rounded-md focus-visible:outline-2 focus-visible:outline-primary"><KpiCard title={title} value={value} description={detail} icon={icon} className="hover:bg-muted/40 transition-colors" /></Link>
}
function Section({ title, href, action, children }: { title: string; href: string; action: string; children: ReactNode }) {
  return <section className="rounded-md border bg-card p-5"><div className="mb-4 flex items-center justify-between gap-3"><h2 className="font-semibold">{title}</h2><a href={href} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">{action}<ArrowRight className="size-4" aria-hidden /></a></div>{children}</section>
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
