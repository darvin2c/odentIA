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
  where: { to: "/agenda" | "/people"; label: string }
  /** La fila lleva a la sección del paciente donde se resuelve. */
  patientTab?: "plan"
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
}

function when(row: ReportListRow, list: ReportListKey, locale: string, timeZone: string): { day: string; hour: string | null } {
  const date = new Date(row.at)
  const day = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone }).format(date).replace(/\./g, "")
  // Un control o un presupuesto tienen día, no hora.
  const timed = list === "no_show" || list === "cancelled" || list === "unmarked" || list === "new_patients"
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
        <Link to={copy.where.to} className={buttonVariants()}>
          {copy.where.label}
        </Link>
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
                        <Link
                          to="/patients/$patientId"
                          params={{ patientId: row.patientId }}
                          search={copy.patientTab ? { tab: copy.patientTab } : {}}
                          className="truncate font-semibold hover:underline"
                        >
                          {row.personName}
                        </Link>
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
