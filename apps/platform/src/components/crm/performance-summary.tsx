import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@odentia/ui"
import { KpiCard } from "@odentia/ui-patterns"
import { channelLabel } from "../../lib/channels"
import type { CrmPerformance } from "../../lib/workspace"

const sources: Record<string, string> = { manual: "Manual", conversacion: "Conversación", recepcion: "Recepción", agente: "Agente", agent: "Agente", portal: "Portal", web: "Web" }

/** Las duraciones usan aceptación del proveedor, no la hora de encolado. */
export function PerformanceSummary({ data }: { data: CrmPerformance }) {
  if (!Object.values(data).some(value => value !== null)) return null
  const responses = data.responses
  return <section aria-label="Resultados operativos" className="flex min-w-0 flex-col gap-4">
    <div><h2 className="font-semibold">Resultados operativos</h2><p className="text-sm text-muted-foreground">Resultados registrados del período. Los pendientes son el estado actual, no un saldo histórico.</p></div>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {responses && <KpiCard title="Primera respuesta media" value={responses.avgFirstResponseSeconds === null ? "Sin datos" : `${(responses.avgFirstResponseSeconds / 60).toLocaleString("es-PE", { maximumFractionDigits: 1 })} min`} description={`${responses.responded} de ${responses.conversations} conversaciones iniciadas recibieron respuesta enviada. Duración disponible en ${responses.timedResponses}; se excluyen envíos simulados.`} />}
      {data.followUps && <KpiCard title="Seguimientos vencidos" value={data.followUps.overdue} description={`${data.followUps.open} pendientes; ${data.followUps.unassigned} sin responsable.`} />}
      {data.conversations && <KpiCard title="Cierres registrados" value={data.conversations.closed} description={`${data.conversations.waiting} conversaciones abiertas esperan respuesta. Cerrar no acredita resolución satisfactoria.`} />}
      {data.proposals && <KpiCard title="Cambios del agente ejecutados" value={data.proposals.executed} description={`${data.proposals.failed} fallidos en el período; ${data.proposals.pending} por confirmar o aprobar ahora. No mide calidad de respuesta.`} />}
    </div>
    {data.bookings && <div className="rounded-md border bg-card p-4"><h3 className="font-medium">Reservas creadas</h3><p className="mb-2 text-xs text-muted-foreground">Reservas reales de agenda creadas en el período; vigentes incluye programadas, confirmadas y atendidas.</p>{data.bookings.length === 0 ? <p className="text-sm text-muted-foreground">Sin reservas registradas.</p> : <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm">{data.bookings.map(item => <li key={item.source}>{sources[item.source] ?? item.source}: <strong>{item.count}</strong> creadas, {item.active} vigentes</li>)}</ul>}</div>}
    {data.conversion && <div className="min-w-0 rounded-md border bg-card p-4"><h3 className="font-medium">Conversión por origen y responsable</h3><p className="mb-2 text-xs text-muted-foreground">Estado actual de oportunidades creadas en el período. Conversión = ganadas / creadas; no equivale a cobros ni atribuye causalidad al canal.</p>{data.conversion.length === 0 ? <p className="text-sm text-muted-foreground">Sin oportunidades registradas.</p> : <Table><TableHeader><TableRow>{["Origen", "Responsable", "Creadas", "Abiertas", "Ganadas", "Perdidas", "Conversión"].map(label => <TableHead scope="col" key={label}>{label}</TableHead>)}</TableRow></TableHeader><TableBody>{data.conversion.map(item => <TableRow key={`${item.channel ?? "manual"}:${item.assigneeUserId ?? "sin-asignar"}`}><TableCell>{item.channel ? channelLabel(item.channel) : "Sin origen de conversación"}</TableCell><TableCell>{item.assigneeName ?? "Sin asignar"}</TableCell><TableCell>{item.created}</TableCell><TableCell>{item.open}</TableCell><TableCell>{item.won}</TableCell><TableCell>{item.lost}</TableCell><TableCell>{item.wonRate === null ? "Sin datos" : `${item.wonRate.toLocaleString("es-PE", { maximumFractionDigits: 1 })}%`}</TableCell></TableRow>)}</TableBody></Table>}</div>}
  </section>
}
