import { Badge } from "@odentia/ui"
import { EmptyState, KpiCard, LoadingState, PageHeader, PageShell } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { ArrowRight, CalendarDays, CheckSquare, Inbox, Wallet } from "lucide-react"
import type { ReactNode } from "react"
import { apiFetch } from "../../lib/api"
import { type WorkspaceHome, moneyFromCents, stateLabel } from "../../lib/workspace"

export const Route = createFileRoute("/_org/home")({ component: HomePage })

function HomePage() {
  const query = useQuery({ queryKey: ["workspace-home"], queryFn: () => apiFetch<{ data: WorkspaceHome }>("/api/workspace/home"), refetchInterval: 60_000 })
  const data = query.data?.data
  return <PageShell className="flex flex-col gap-6">
    <PageHeader title="Inicio" subtitle={data ? `Tu jornada · ${data.date} · ${data.timezone}` : "Lo que necesita tu atención hoy"} />
    {query.isPending ? <LoadingState /> : query.isError ? <p role="alert">No pudimos cargar tu jornada. <button type="button" className="underline" onClick={() => void query.refetch()}>Volver a intentar</button></p> : data ? <>
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
      {!Object.entries(data.access).some(([key, value]) => key !== "allTasks" && value) && <EmptyState title="Tu espacio está listo" description="Pide a la administración los permisos necesarios para tu trabajo." />}
    </> : null}
  </PageShell>
}
function Metric({ title, value, detail, href, icon }: { title: string; value: number; detail: string; href: string; icon: ReactNode }) {
  return <Link to={href} className="rounded-md focus-visible:outline-2 focus-visible:outline-primary"><KpiCard title={title} value={value} description={detail} icon={icon} className="hover:bg-muted/40 transition-colors" /></Link>
}
function Section({ title, href, action, children }: { title: string; href: string; action: string; children: ReactNode }) {
  return <section className="rounded-md border bg-card p-5"><div className="mb-4 flex items-center justify-between gap-3"><h2 className="font-semibold">{title}</h2><a href={href} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">{action}<ArrowRight className="size-4" aria-hidden /></a></div>{children}</section>
}
