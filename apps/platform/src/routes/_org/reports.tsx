import { Button, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@odentia/ui"
import { EmptyState, ErrorState, LoadingState, PageHeader, PageShell } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { useEffect, useState, type ReactNode } from "react"
import { apiFetch } from "../../lib/api"
import { PerformanceSummary } from "../../components/crm/performance-summary"
import { MonthlyResultPanel } from "../../components/finance/MonthlyResultPanel"
import { usePermission } from "../../lib/crm"
import { useOrgProfile } from "../../lib/org"
import { type ManagementReport, moneyFromCents, stateLabel } from "../../lib/workspace"
import { QueryErrorState } from "../../lib/query-error"

export const Route = createFileRoute("/_org/reports")({ component: ReportsPage })
function ReportsPage() {
  const allowed = usePermission("reports.read")
  const profile = useOrgProfile()
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [period, setPeriod] = useState<{ from: string; to: string } | null>(null)
  useEffect(() => {
    if (!profile.data?.timezone || period) return
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: profile.data.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date())
    const part = (name: string) => parts.find(item => item.type === name)?.value ?? ""
    const today = `${part("year")}-${part("month")}-${part("day")}`
    const first = `${today.slice(0, 7)}-01`
    setFrom(first)
    setTo(today)
    setPeriod({ from: first, to: today })
  }, [profile.data?.timezone, period])
  const query = useQuery({ queryKey: ["management-report", period], enabled: allowed && period !== null, retry: false,
    queryFn: () => apiFetch<{ data: ManagementReport }>(`/api/workspace/reports?from=${period?.from}&to=${period?.to}`) })
  const report = query.data?.data
  if (!allowed) return <PageShell><PageHeader title="Reportes" /><ErrorState title="Sin acceso" message="No tienes permiso para consultar reportes. Solicita acceso a la administración." /></PageShell>
  return <PageShell className="flex flex-col gap-6"><PageHeader title="Reportes" subtitle="Resultados de la clínica, separados por moneda y sin mezclar cobros con producción." />
    {/* Lo primero que busca quien dirige la clínica: elige su propio mes y su sede. */}
    <MonthlyResultPanel />
    <form className="flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); setPeriod({ from, to }) }}>
      <label htmlFor="report-from" className="flex flex-col gap-1 text-sm">Desde<Input id="report-from" type="date" required value={from} max={to} onChange={event => setFrom(event.target.value)} /></label>
      <label htmlFor="report-to" className="flex flex-col gap-1 text-sm">Hasta<Input id="report-to" type="date" required value={to} min={from} onChange={event => setTo(event.target.value)} /></label><Button type="submit">Consultar</Button>
    </form>
    {profile.isError && !period ? <QueryErrorState error={profile.error} onRetry={() => { void profile.refetch() }} /> : query.isPending ? <LoadingState /> : query.isError ? <QueryErrorState error={query.error} onRetry={() => { void query.refetch() }} invalid="Elige un intervalo válido de hasta un año y vuelve a consultar." /> : report ? <>
      <p className="text-sm text-muted-foreground">Del {report.from} al {report.to}, ambos incluidos. Zona horaria: {report.timezone}.</p>
      <div className="grid gap-6 xl:grid-cols-2">
        <ReportSection title="Asistencia y cancelaciones" description="Citas cuya fecha de inicio pertenece al período; estado actual."><SimpleTable headers={["Estado", "Citas"]} rows={report.appointments.map(row => [stateLabel[row.status] ?? row.status, row.count])} /></ReportSection>
        <ReportSection title="Atención por profesional" description="Citas atendidas; no equivale a procedimientos producidos ni a importe facturado."><SimpleTable headers={["Profesional", "Atendidas", "Citas totales"]} rows={report.production.map(row => [row.name, row.attended, row.total])} /></ReportSection>
        <ReportSection title="Producción clínica" description="Procedimientos de atenciones finalizadas en el período, valorados con su precio conservado. No equivale a cobros."><SimpleTable headers={["Profesional", "Moneda", "Procedimientos", "Valor"]} rows={report.clinicalProduction.map(row => [row.name, row.currency ?? "Sin precio", row.procedures, row.currency ? moneyFromCents(row.amountCents, row.currency, report.locale) : "Sin valoración"])} /></ReportSection>
        <ReportSection title="Conversión comercial" description="Estado actual de las oportunidades creadas en el período, separado por moneda."><SimpleTable headers={["Estado", "Moneda", "Oportunidades", "Valor estimado"]} rows={report.opportunities.map(row => [stateLabel[row.status] ?? row.status, row.currency, row.count, moneyFromCents(row.amountCents, row.currency, report.locale)])} /></ReportSection>
        <ReportSection title="Antigüedad de saldos" description="Deuda actual según la fecha de vencimiento de cada cargo."><SimpleTable headers={["Moneda", "Vencimiento", "Pendiente"]} rows={report.aging.map(row => [row.currency, row.bucket, moneyFromCents(row.amountCents, row.currency, report.locale)])} /></ReportSection>
        <ReportSection title="Decisiones de presupuestos" description="Estado actual de las propuestas presentadas durante el período. Las revisiones sustituidas se muestran separadas."><SimpleTable headers={["Estado", "Propuestas"]} rows={report.budgets.map(row => [stateLabel[row.status] ?? row.status, row.count])} /></ReportSection>
        <ReportSection title="Cobros y devoluciones" description="Por fecha de pago y devolución. Los pagos anulados no se incluyen."><SimpleTable headers={["Moneda", "Recibido", "Devuelto", "Neto"]} rows={report.collections.map(row => [row.currency, moneyFromCents(row.receivedCents, row.currency, report.locale), moneyFromCents(row.refundedCents, row.currency, report.locale), moneyFromCents(row.netCents, row.currency, report.locale)])} /></ReportSection>
        <ReportSection title="Deuda actual" description="Saldo de cargos vigentes menos aplicaciones vigentes a la fecha de consulta; no es un saldo histórico del período."><SimpleTable headers={["Moneda", "Pendiente", "Vencido", "Pacientes"]} rows={report.debt.map(row => [row.currency, moneyFromCents(row.outstandingCents, row.currency, report.locale), moneyFromCents(row.overdueCents, row.currency, report.locale), row.patients])} /></ReportSection>
      </div>
      <PerformanceSummary data={report.performance} />
    </> : null}
  </PageShell>
}
function ReportSection({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <section className="min-w-0 elevated rounded-xl border bg-card p-5"><h2 className="font-semibold">{title}</h2><p className="mb-4 mt-1 text-sm text-muted-foreground">{description}</p>{children}</section>
}
function SimpleTable({ headers, rows }: { headers: string[]; rows: Array<Array<string | number>> }) {
  return rows.length === 0 ? <EmptyState title="Sin registros" description="No hay registros para este criterio." /> : <Table><TableHeader><TableRow>{headers.map(header => <TableHead key={header} scope="col">{header}</TableHead>)}</TableRow></TableHeader><TableBody>{rows.map(row => <TableRow key={row.map(String).join("|")}>{row.map((cell, index) => <TableCell key={headers[index]} className="tabular-nums">{cell}</TableCell>)}</TableRow>)}</TableBody></Table>
}
