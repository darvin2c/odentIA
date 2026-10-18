/**
 * La lista detrás de una cifra: quiénes son, cómo se calculó y a dónde ir para
 * resolverlo. Tiene tantas filas como dice la cifra (hasta 200 a la vista).
 */
import { formatMoney } from "@odentia/clinical"
import { Badge, Button, buttonVariants } from "@odentia/ui"
import { DetailDrawer, EmptyState } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { QueryErrorState } from "../../lib/query-error"
import { fetchReportList, reportKey, type ReportListKey, type ReportListRow, type ReportQuery, spanLabel } from "../../lib/reports"

/** Filas a la vista antes de «Mostrar las otras». */
const PREVIEW = 8

interface ListCopy {
  title: string
  noun: { one: string; many: string }
  /** Cómo se calcula, en una línea; recibe el periodo ya escrito. */
  how: (period: string) => string
  where: { to: "/agenda" | "/people" | "/finance" | "/inbox"; label: string }
  /** La fila lleva a la sección del paciente donde se resuelve. */
  patientTab?: "plan" | "cobros"
  /** «Ya tiene otra cita» solo importa donde alguien va a llamar. */
  showNext: boolean
}

const LISTS: Record<ReportListKey, ListCopy> = {
  no_show: {
    title: "No vinieron",
    noun: { one: "cita", many: "citas" },
    how: (period) => `Citas con fecha en ${period} que quedaron como «No vino». Las canceladas se cuentan aparte.`,
    where: { to: "/agenda", label: "Abrir la Agenda" },
    showNext: true,
  },
  cancelled: {
    title: "Cancelaron",
    noun: { one: "cita", many: "citas" },
    how: (period) => `Citas con fecha en ${period} que se cancelaron.`,
    where: { to: "/agenda", label: "Abrir la Agenda" },
    showNext: true,
  },
  unmarked: {
    title: "Sin marcar",
    noun: { one: "cita", many: "citas" },
    how: (period) => `Citas de ${period} cuya hora ya pasó y siguen por confirmar o confirmadas. En la Agenda se cierran con «Registrar la atención» o «No vino».`,
    where: { to: "/agenda", label: "Abrir la Agenda" },
    showNext: false,
  },
  controls_pending: {
    title: "Controles pendientes",
    noun: { one: "control", many: "controles" },
    how: (period) => `Controles que tocaban en ${period} y hoy siguen pendientes.`,
    where: { to: "/agenda", label: "Abrir la Agenda" },
    showNext: true,
  },
  budgets_waiting: {
    title: "Presupuestos que esperan respuesta",
    noun: { one: "presupuesto", many: "presupuestos" },
    how: (period) => `Presupuestos presentados en ${period} que hoy siguen sin respuesta o pospuestos.`,
    where: { to: "/people", label: "Ir a Pacientes" },
    patientTab: "plan",
    showNext: false,
  },
  new_patients: {
    title: "Pacientes nuevos",
    noun: { one: "persona", many: "personas" },
    how: (period) => `Personas cuya primera cita atendida fue en ${period}.`,
    where: { to: "/people", label: "Ir a Pacientes" },
    showNext: false,
  },
  debts_overdue: {
    title: "Te deben hace más de 30 días",
    noun: { one: "persona", many: "personas" },
    how: (period) =>
      `Quién debía al cerrar ${period}: lo que suman sus conceptos por cobrar menos lo que pagó y lo que tiene a favor, si su concepto sin pagar más antiguo se anotó hace más de 30 días. Es la misma regla de «Saldo vencido» del Administrador.`,
    where: { to: "/finance", label: "Ir a Finanzas" },
    patientTab: "cobros",
    showNext: false,
  },
  agent_booked: {
    title: "Citas que agendó el agente",
    noun: { one: "cita", many: "citas" },
    how: (period) =>
      `Citas que el agente reservó en ${period}, en su conversación o desde su enlace. El importe es lo que la persona pagó hasta hoy en esa cita, sin lo anulado ni lo devuelto.`,
    where: { to: "/agenda", label: "Abrir la Agenda" },
    showNext: false,
  },
  agent_handoffs: {
    title: "Pasaron al equipo",
    noun: { one: "conversación", many: "conversaciones" },
    how: (period) => `Conversaciones que el agente pasó al equipo en ${period}, con el motivo que dejó. Cada una se abre en la Bandeja.`,
    where: { to: "/inbox", label: "Abrir la Bandeja" },
    showNext: false,
  },
  ...agingLists(),
  upcoming_unbooked: {
    title: "Aceptaron y no tienen cita",
    noun: { one: "persona", many: "personas" },
    how: () =>
      "A hoy: personas con tratamientos aceptados en un presupuesto que aún no se hicieron y sin ninguna cita por venir. El importe es lo aceptado por hacer, a su precio acordado.",
    where: { to: "/agenda", label: "Abrir la Agenda" },
    patientTab: "plan",
    showNext: false,
  },
}

/** «Te deben» por antigüedad: la misma regla del saldo vencido, cada persona en el tramo de su concepto más antiguo. */
function agingLists(): Record<"debts_age_0_30" | "debts_age_31_60" | "debts_age_61_90" | "debts_age_90_plus", ListCopy> {
  const copy = (title: string, range: string): ListCopy => ({
    title: `Te deben: ${title}`,
    noun: { one: "persona", many: "personas" },
    how: (period) =>
      `Quién debía al cerrar ${period} y cuyo concepto sin pagar más antiguo se anotó ${range}. Lo que debe es lo que suman sus conceptos por cobrar menos lo que pagó y lo que tiene a favor, como en «Saldo vencido».`,
    where: { to: "/finance", label: "Ir a Finanzas" },
    patientTab: "cobros",
    showNext: false,
  })
  return {
    debts_age_0_30: copy("hasta 30 días", "hace 30 días o menos"),
    debts_age_31_60: copy("de 31 a 60 días", "hace 31 a 60 días"),
    debts_age_61_90: copy("de 61 a 90 días", "hace 61 a 90 días"),
    debts_age_90_plus: copy("más de 90 días", "hace más de 90 días"),
  }
}

function when(row: ReportListRow, list: ReportListKey, locale: string, timeZone: string): { day: string; hour: string | null } {
  const date = new Date(row.at)
  const day = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone }).format(date).replace(/\./g, "")
  // Un control, un presupuesto o una deuda tienen día, no hora.
  const timed = list === "no_show" || list === "cancelled" || list === "unmarked" || list === "new_patients" || list === "agent_booked" || list === "agent_handoffs"
  return { day, hour: timed ? new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", timeZone }).format(date) : null }
}

export function ReportListDrawer({ list, query, onClose }: { list: ReportListKey | null; query: ReportQuery; onClose: () => void }) {
  // Qué lista está desplegada entera: otra lista empieza recogida.
  const [expanded, setExpanded] = useState<ReportListKey | null>(null)
  const all = expanded !== null && expanded === list
  const report = useQuery({
    queryKey: reportKey(`list:${list}`, query),
    queryFn: () => fetchReportList(list as ReportListKey, query),
    enabled: list !== null,
    retry: false,
  })

  if (list === null) return null
  const copy = LISTS[list]
  const data = report.data?.data
  const period = data ? spanLabel(data.period, data.locale) : ""
  const rows = data ? (all ? data.rows : data.rows.slice(0, PREVIEW)) : []
  const hidden = data ? data.rows.length - rows.length : 0

  return (
    <DetailDrawer
      open
      title={copy.title}
      description={
        data
          ? `${data.total} ${data.total === 1 ? copy.noun.one : copy.noun.many} · ${period} · ${data.branch?.name ?? "todas las sedes"}`
          : undefined
      }
      onClose={onClose}
      isLoading={report.isPending}
      actions={
        copy.where.to === "/inbox" ? (
          <Link to="/inbox" search={{ conversation: undefined }} className={buttonVariants()}>
            {copy.where.label}
          </Link>
        ) : (
          <Link to={copy.where.to} className={buttonVariants()}>
            {copy.where.label}
          </Link>
        )
      }
    >
      {report.isError ? (
        <QueryErrorState error={report.error} onRetry={() => void report.refetch()} />
      ) : data ? (
        <div className="flex min-w-0 flex-col gap-4">
          {data.total === 0 ? (
            <EmptyState title="Ya no queda nadie en esta lista" description="Se resolvió desde que se abrió la pantalla." />
          ) : (
            <>
              <ul className="flex min-w-0 flex-col divide-y">
                {rows.map((row) => {
                  const at = when(row, list, data.locale, data.timezone)
                  const detail = [row.title, row.professionalName, data.branch ? null : row.branchName].filter(Boolean).join(" · ")
                  return (
                    <li key={row.id} className="flex min-h-[60px] min-w-0 items-center gap-3 py-2">
                      <span className="w-[84px] shrink-0 text-[13px] leading-tight text-muted-foreground">
                        {at.day}
                        {at.hour ? (
                          <>
                            <br />
                            {at.hour}
                          </>
                        ) : null}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        {row.conversationId ? (
                          <Link to="/inbox" search={{ conversation: row.conversationId }} className="truncate font-semibold hover:underline">
                            {row.personName}
                          </Link>
                        ) : row.patientId ? (
                          <Link
                            to="/patients/$patientId"
                            params={{ patientId: row.patientId }}
                            search={copy.patientTab ? { tab: copy.patientTab } : {}}
                            className="truncate font-semibold hover:underline"
                          >
                            {row.personName}
                          </Link>
                        ) : (
                          <span className="truncate font-semibold">{row.personName}</span>
                        )}
                        {detail ? <span className="text-[13px] text-muted-foreground">{detail}</span> : null}
                      </span>
                      {row.cents !== null && row.currency ? (
                        <span className="shrink-0 font-semibold tabular-nums">{formatMoney(row.cents, row.currency, data.locale)}</span>
                      ) : null}
                      {copy.showNext && row.hasNextAppointment ? (
                        <Badge variant="success" className="shrink-0">
                          Ya tiene otra cita
                        </Badge>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
              {hidden > 0 ? (
                <Button type="button" variant="link" className="h-auto min-h-11 self-start p-0 sm:min-h-8" onClick={() => setExpanded(list)}>
                  {hidden === 1 ? "Mostrar la otra" : `Mostrar las otras ${hidden}`}
                </Button>
              ) : null}
              {all && data.rows.length < data.total ? (
                <p className="text-[13px] text-muted-foreground">
                  Se muestran {data.rows.length} de {data.total}.
                </p>
              ) : null}
            </>
          )}
          <div className="flex flex-col gap-0.5 rounded-xl bg-muted px-3.5 py-3 text-[13px]">
            <span className="font-bold">Cómo se calcula</span>
            <span>{copy.how(period)}</span>
          </div>
        </div>
      ) : null}
    </DetailDrawer>
  )
}
