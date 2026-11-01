/**
 * La lista detrás de una cifra: quiénes son, cómo se calculó y a dónde ir para
 * resolverlo. Tiene tantas filas como dice la cifra (hasta 200 a la vista).
 */
import { formatMoney } from "@odentia/clinical"
import { Badge, Button, buttonVariants, cn } from "@odentia/ui"
import { DetailDrawer, EmptyState } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import type { AgendaAppointment } from "../../lib/agenda"
import { usePermission } from "../../lib/crm"
import { QueryErrorState } from "../../lib/query-error"
import {
  fetchReportList,
  firstContactChannel,
  reportKey,
  type ReportList,
  type ReportListKey,
  type ReportListRow,
  type ReportQuery,
  spanLabel,
} from "../../lib/reports"
import { openAppointmentAnywhere, openBookingAnywhere, useAppointmentSaved } from "../agenda/schedule-host"
import { PatientQuickView, type QuickViewContext } from "../patient/patient-quick-view"
import { DownloadButton, during } from "./report-parts"
import { ADMIN_NAME } from "../../lib/agent-names"
import { downloadReportList } from "../../lib/reports-ask"
import { productUi } from "../../product/product-ui"

/** Filas a la vista antes de «Mostrar las otras». */
const PREVIEW = 8

/** Lo que dice la lista de quien tiene una cita por venir, si no se dice otra cosa. */
const NEXT_APPOINTMENT = "Ya tiene otra cita"

interface ListCopy {
  title: string
  /** El título con los plazos que entrega el servidor, cuando ya llegó la lista. */
  titleOf?: (list: ReportList) => string
  noun: { one: string; many: string }
  /** Cómo se calcula, en una línea; recibe el periodo ya escrito y la lista (sus plazos). */
  how: (period: string, list: ReportList) => string
  where: { to: "/agenda" | "/people" | "/finance" | "/inbox"; label: string }
  /** La fila lleva a la sección del paciente donde se resuelve. */
  patientTab?: "plan" | "cuenta"
  /** «Ya tiene otra cita» solo importa donde alguien va a llamar. */
  showNext: boolean
  /** Cómo se dice que tiene una cita por venir cuando la fila no es una cita: no es «otra». */
  nextLabel?: string
  /** Es a hoy, no de un periodo: el encabezado no lo nombra. */
  asOfToday?: boolean
}

/** Las listas del embudo: personas con el canal por el que nos buscaron. */
function isFunnelList(list: ReportListKey): boolean {
  return list.startsWith("funnel_")
}

/** Sin presupuesto que aceptar (latidIA, decisión 15 del issue 229), pagar viene después de venir. */
function paysAfterComing(): boolean {
  return !productUi().plan.budgetRequired
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
  new_patients: {
    title: "Pacientes nuevos",
    noun: { one: "persona", many: "personas" },
    how: (period) => `Personas cuya primera cita atendida fue en ${period}.`,
    where: { to: "/people", label: "Ir a Pacientes" },
    showNext: false,
  },
  funnel_sought: {
    title: "Nos buscaron por primera vez",
    noun: { one: "persona", many: "personas" },
    how: (period) =>
      `Personas cuya primera conversación, por cualquier canal, o su registro como paciente fue en ${period}. Si alguien escribe por un paciente (su madre, por ejemplo), cuenta el paciente, desde el primer mensaje de quien escribió y por su canal. Spam y bloqueados no cuentan.`,
    where: { to: "/people", label: "Ir a Pacientes" },
    showNext: false,
  },
  funnel_booked: {
    title: "Agendaron",
    noun: { one: "persona", many: "personas" },
    how: (period) =>
      `De quienes nos buscaron por primera vez en ${period}, los que desde entonces tienen una cita sin cancelar (aunque no vinieran) o llegaron a un paso posterior, hasta hoy. Como «Evaluación agendada» en Oportunidades: quien canceló sin agendar otra no cuenta.`,
    where: { to: "/agenda", label: "Abrir la Agenda" },
    showNext: true,
    nextLabel: "Tiene cita por venir",
  },
  funnel_came: {
    title: "Vinieron",
    noun: { one: "persona", many: "personas" },
    how: (period) =>
      `De quienes nos buscaron por primera vez en ${period}, los que desde entonces tienen una cita atendida o una atención firmada, o recibieron un presupuesto.`,
    where: { to: "/people", label: "Ir a Pacientes" },
    showNext: false,
  },
  funnel_budget: {
    title: "Recibieron presupuesto",
    noun: { one: "persona", many: "personas" },
    how: (period) =>
      `De quienes nos buscaron por primera vez en ${period}, los que recibieron un presupuesto desde entonces, aunque después lo aceptaran o rechazaran. Como «Presupuesto enviado» en Oportunidades.`,
    where: { to: "/people", label: "Ir a Pacientes" },
    patientTab: "plan",
    showNext: false,
  },
  funnel_accepted: {
    title: "Aceptaron su presupuesto",
    noun: { one: "persona", many: "personas" },
    how: (period) =>
      `De quienes nos buscaron por primera vez en ${period}, los que aceptaron un presupuesto que recibieron desde entonces, del todo o en parte. Como «Ganada» en Oportunidades.`,
    where: { to: "/people", label: "Ir a Pacientes" },
    patientTab: "plan",
    showNext: false,
  },
  funnel_paid: {
    title: "Pagaron algo",
    noun: { one: "persona", many: "personas" },
    how: (period) =>
      paysAfterComing()
        ? `De quienes nos buscaron por primera vez en ${period}, los que vinieron y pagaron algo desde entonces: la consulta cobrada.`
        : `De quienes nos buscaron por primera vez en ${period}, los que aceptaron su presupuesto y pagaron algo desde entonces.`,
    where: { to: "/finance", label: "Abrir Finanzas" },
    patientTab: "cuenta",
    showNext: false,
  },
  funnel_lost_booked: {
    title: "No agendaron",
    noun: { one: "persona", many: "personas" },
    how: (period) =>
      `De quienes nos buscaron por primera vez en ${period}, los que hoy no tienen una cita sin cancelar ni llegaron a un paso posterior: no agendaron o cancelaron sin agendar otra.`,
    where: { to: "/inbox", label: "Abrir la Bandeja" },
    showNext: false,
  },
  funnel_lost_came: {
    title: "Agendaron y no vinieron",
    noun: { one: "persona", many: "personas" },
    how: (period) =>
      `De quienes nos buscaron por primera vez en ${period}, los que tienen una cita sin cancelar y todavía no vinieron: faltaron («No vino») o su cita aún no llega. Quien canceló sin agendar otra está en «No agendaron».`,
    where: { to: "/agenda", label: "Abrir la Agenda" },
    showNext: true,
    nextLabel: "Tiene cita por venir",
  },
  funnel_lost_budget: {
    title: "Vinieron y no recibieron presupuesto",
    noun: { one: "persona", many: "personas" },
    how: (period) =>
      `De quienes nos buscaron por primera vez en ${period}, los que vinieron (una cita atendida o una atención firmada) y todavía no recibieron un presupuesto.`,
    where: { to: "/people", label: "Ir a Pacientes" },
    patientTab: "plan",
    showNext: false,
  },
  funnel_lost_accepted: {
    title: "Aún no responden o lo rechazaron",
    noun: { one: "persona", many: "personas" },
    how: (period) => `De quienes nos buscaron por primera vez en ${period}, los que recibieron su presupuesto y no lo aceptaron: lo están pensando, no respondieron o lo rechazaron.`,
    where: { to: "/people", label: "Ir a Pacientes" },
    patientTab: "plan",
    showNext: false,
  },
  funnel_lost_paid: {
    get title() {
      return paysAfterComing() ? "Vinieron y aún no pagan" : "Aceptaron y aún no pagan"
    },
    noun: { one: "persona", many: "personas" },
    how: (period) =>
      paysAfterComing()
        ? `De quienes nos buscaron por primera vez en ${period}, los que vinieron y todavía no pagaron nada.`
        : `De quienes nos buscaron por primera vez en ${period}, los que aceptaron su presupuesto y todavía no pagaron nada.`,
    where: { to: "/finance", label: "Abrir Finanzas" },
    patientTab: "cuenta",
    showNext: false,
  },
  funnel_stopped: {
    title: "Dejaron de escribir",
    noun: { one: "persona", many: "personas" },
    how: (period, list) =>
      `De quienes nos buscaron por primera vez en ${period} y no agendaron, los que preguntaron algo y no escriben hace más de ${days(list.rules?.stoppedDays)}: ninguna conversación suya, ni de quien escribió por ellos, sigue abierta.`,
    where: { to: "/inbox", label: "Abrir la Bandeja" },
    showNext: false,
  },
  controls_missed: {
    title: "No vinieron a su control",
    noun: { one: "control", many: "controles" },
    how: (period) => `Controles que tocaban en ${period} y no se hicieron: siguen pendientes, se cancelaron o se marcaron hechos sin una atención cerrada.`,
    where: { to: "/agenda", label: "Abrir la Agenda" },
    showNext: true,
    nextLabel: "Tiene cita por venir",
  },
  lapsed: {
    title: "Sin venir hace meses",
    titleOf: (list) => `Sin venir hace más de ${months(list.rules?.lapsedMonths)}`,
    noun: { one: "persona", many: "personas" },
    how: (_, list) =>
      `A hoy: su última cita atendida fue hace más de ${months(list.rules?.lapsedMonths)} y no tienen cita por venir, presupuesto que espere respuesta ni control pendiente. La fecha es la de su última cita.`,
    where: { to: "/people", label: "Ir a Pacientes" },
    showNext: false,
    asOfToday: true,
  },
  invited_returned: {
    title: "Volvieron tras la invitación",
    noun: { one: "persona", many: "personas" },
    how: (period) =>
      `Personas invitadas a volver ${during(period)}, por ${ADMIN_NAME} o con «Ya la invité», que después vinieron a una cita atendida, hasta hoy. La fecha es la de la cita en que volvieron.`,
    where: { to: "/people", label: "Ir a Pacientes" },
    showNext: false,
  },
  debts_overdue: {
    title: "Te deben hace más de 30 días",
    noun: { one: "persona", many: "personas" },
    how: (period, list) =>
      `${owedAt(period, list)}: lo que suman sus conceptos por cobrar menos lo que pagó y lo que tiene a favor, si su concepto sin pagar más antiguo se anotó hace más de 30 días. Es la misma regla de «Saldo vencido» de ${ADMIN_NAME}.`,
    where: { to: "/finance", label: "Abrir Finanzas" },
    patientTab: "cuenta",
    showNext: false,
  },
  agent_booked: {
    title: "Citas que agendó el agente",
    noun: { one: "cita", many: "citas" },
    how: (period) =>
      `Citas que el agente reservó ${during(period)}, en su conversación o desde su enlace. La fecha es la de la reserva; la de la cita va al lado. El importe es lo que la persona pagó hasta hoy en esa cita, sin lo anulado ni lo devuelto.`,
    where: { to: "/agenda", label: "Abrir la Agenda" },
    showNext: false,
  },
  agent_handoffs: {
    title: "Pasaron al equipo",
    noun: { one: "conversación", many: "conversaciones" },
    how: (period) =>
      `De quienes escribieron por primera vez ${during(period)}, las conversaciones que el agente pasó al equipo hasta hoy, con el motivo que dejó. Cada una se abre en la Bandeja.`,
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
    asOfToday: true,
  },
}

/** A qué momento se cuenta lo que se debe: hoy si el periodo sigue en curso; si no, su cierre. */
function owedAt(period: string, list: ReportList): string {
  return list.period.partial ? "Quién debe hoy" : `Quién debía al cerrar ${period}`
}

/** «Te deben» por antigüedad: la misma regla del saldo vencido, cada persona en el tramo de su concepto más antiguo. */
function agingLists(): Record<"debts_age_0_30" | "debts_age_31_60" | "debts_age_61_90" | "debts_age_90_plus", ListCopy> {
  const copy = (title: string, range: string): ListCopy => ({
    title: `Te deben: ${title}`,
    noun: { one: "persona", many: "personas" },
    how: (period, list) =>
      `${owedAt(period, list)} y cuyo concepto sin pagar más antiguo se anotó ${range}. Lo que debe es lo que suman sus conceptos por cobrar menos lo que pagó y lo que tiene a favor, como en «Saldo vencido».`,
    where: { to: "/finance", label: "Abrir Finanzas" },
    patientTab: "cuenta",
    showNext: false,
  })
  return {
    debts_age_0_30: copy("hasta 30 días", "hace 30 días o menos"),
    debts_age_31_60: copy("de 31 a 60 días", "hace más de 30 días y hasta 60"),
    debts_age_61_90: copy("de 61 a 90 días", "hace más de 60 días y hasta 90"),
    debts_age_90_plus: copy("más de 90 días", "hace más de 90 días"),
  }
}

/** «3 días»: el plazo que entrega el servidor con la lista. */
function days(count: number | undefined): string {
  if (count === undefined) return "unos días"
  return count === 1 ? "1 día" : `${count} días`
}

/** «6 meses»: el plazo que entrega el servidor con la lista. */
function months(count: number | undefined): string {
  if (count === undefined) return "unos meses"
  return count === 1 ? "1 mes" : `${count} meses`
}

/** «3 personas · septiembre de 2026 · Centro»: lo que es a hoy no nombra un periodo y lo que no es de una sede no nombra la sede. */
function describe(copy: ListCopy, data: ReportList, period: string): string {
  const where = data.wholeClinic ? "toda la clínica" : (data.branch?.name ?? "todas las sedes")
  return [`${data.total} ${data.total === 1 ? copy.noun.one : copy.noun.many}`, copy.asOfToday ? "a hoy" : period, where].join(" · ")
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
  const canBook = usePermission("appointments.write")
  const canReadAgenda = usePermission("appointments.read")
  // Lo reservado desde esta lista se queda en ella, marcado, hasta que se cierra: así se ve el avance.
  const [booked, setBooked] = useState<Record<string, AgendaAppointment>>({})
  const [quick, setQuick] = useState<QuickViewContext | null>(null)
  const queryClient = useQueryClient()
  // Otra lista (o la misma vuelta a abrir) empieza sin marcas ni vista rápida.
  // biome-ignore lint/correctness/useExhaustiveDependencies: se reinicia al cambiar de lista.
  useEffect(() => {
    setBooked({})
    setQuick(null)
  }, [list])
  // Solo una cita en pie y por venir la saca de «no tienen cita»: «No vino» o cancelar no la agendan.
  useAppointmentSaved((appointment) => {
    if (!bookedNow(appointment)) return
    setBooked((current) => ({ ...current, [appointment.patientId]: appointment }))
    // Las cifras de Reportes («No tienen cita: 76») ya no valen; la lista abierta se queda con sus marcas.
    void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === "report" && query.queryKey[1] !== `list:${list}` })
  })
  const bookFor = (context: QuickViewContext) =>
    openBookingAnywhere({
      patient: { id: context.patientId, name: context.name },
      lockedPatient: true,
      ...(context.planItemIds?.length ? { planItemIds: context.planItemIds } : {}),
      ...(context.serviceId ? { serviceId: context.serviceId } : {}),
    })

  if (list === null) return null
  const bookable = list === "upcoming_unbooked"
  const appointmentRows = list === "no_show" || list === "cancelled" || list === "unmarked"
  const copy = LISTS[list]
  const data = report.data?.data
  const period = data ? spanLabel(data.period, data.locale) : ""
  const rows = data ? (all ? data.rows : data.rows.slice(0, PREVIEW)) : []
  const hidden = data ? data.rows.length - rows.length : 0

  return (
    <DetailDrawer
      open
      title={data && copy.titleOf ? copy.titleOf(data) : copy.title}
      description={data ? describe(copy, data, period) : undefined}
      onClose={onClose}
      isLoading={report.isPending}
      actions={
        <>
          {/* La lista entera en CSV, con el teléfono si quien descarga puede verlo (decisión 11). */}
          {data && data.total > 0 ? <DownloadButton onDownload={() => downloadReportList(list, query)} /> : null}
          {copy.where.to === "/inbox" ? (
            <Link to="/inbox" search={{ conversation: undefined }} className={buttonVariants()}>
              {copy.where.label}
            </Link>
          ) : (
            <Link to={copy.where.to} className={buttonVariants()}>
              {copy.where.label}
            </Link>
          )}
        </>
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
                  const detail = [
                    isFunnelList(list) && row.channel !== undefined ? firstContactChannel(row.channel) : null,
                    row.title,
                    row.professionalName,
                    data.branch ? null : row.branchName,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                  if (bookable && row.patientId) {
                    const patientId = row.patientId
                    const done = booked[patientId]
                    const amount = row.cents !== null && row.currency ? formatMoney(row.cents, row.currency, data.locale) : null
                    const context: QuickViewContext = {
                      patientId,
                      name: row.personName,
                      pending: row.title,
                      amount,
                      planItemIds: row.planItemIds ?? null,
                      serviceId: row.serviceId ?? null,
                    }
                    // Agendar sin salir de la lista (tablero 10): la reserva se abre al lado y la fila dice cómo quedó.
                    return (
                      <li key={row.id} className={cn("flex min-h-[60px] min-w-0 items-center gap-3 py-2", done && "-mx-2 rounded-lg bg-success-soft px-2")}>
                        <span className="flex min-w-0 flex-1 flex-col">
                          <Button type="button" variant="link" className="h-auto min-h-0 justify-start truncate p-0 text-left font-semibold text-foreground" onClick={() => setQuick(context)}>
                            {row.personName}
                          </Button>
                          {done ? (
                            <span className="text-[13px] font-semibold text-success">
                              Cita el {bookedLabel(done.startsAt, data.locale, data.timezone)} · {done.professionalName}
                            </span>
                          ) : (
                            <span className="text-[13px] text-muted-foreground">{[row.title, amount].filter(Boolean).join(" · ")}</span>
                          )}
                        </span>
                        {done ? (
                          <Badge variant="success" className="shrink-0">
                            Agendada
                          </Badge>
                        ) : canBook ? (
                          <Button type="button" size="sm" className="min-h-11 shrink-0 sm:min-h-8" onClick={() => bookFor(context)}>
                            Reservar cita
                          </Button>
                        ) : null}
                      </li>
                    )
                  }
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
                        {appointmentRows && canReadAgenda ? (
                          // Quien no vino, canceló o quedó sin marcar: su cita, al lado.
                          <Button type="button" variant="link" className="h-auto min-h-0 justify-start truncate p-0 text-left font-semibold" onClick={() => openAppointmentAnywhere(row.id)}>
                            {row.personName}
                          </Button>
                        ) : row.conversationId ? (
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
                          {copy.nextLabel ?? NEXT_APPOINTMENT}
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
            <span>{copy.how(period, data)}</span>
          </div>
          {quick ? <PatientQuickView context={quick} onClose={() => setQuick(null)} /> : null}
        </div>
      ) : null}
    </DetailDrawer>
  )
}

/** Una cita que deja a la persona con algo por venir: en pie y aún no empieza. */
function bookedNow(appointment: AgendaAppointment): boolean {
  return (appointment.status === "programada" || appointment.status === "confirmada") && Date.parse(appointment.startsAt) > Date.now()
}

/** «jue 29 oct, 10:00»: el día y la hora de la cita recién reservada. */
function bookedLabel(iso: string, locale: string, timeZone: string): string {
  const date = new Date(iso)
  const day = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone }).format(date).replace(/\./g, "")
  const hour = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", timeZone }).format(date)
  return `${day}, ${hour}`
}
