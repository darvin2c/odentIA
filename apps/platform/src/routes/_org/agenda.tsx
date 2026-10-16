import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Skeleton,
  toast,
} from "@odentia/ui"
import {
  addDays,
  conflictLabel,
  DatePickerButton,
  dayMinutesIn,
  dayRangeOf,
  daySegments,
  EmptyState,
  ErrorState,
  findScheduleConflicts,
  formatDateLong,
  formatSpan,
  freeMinutesOf,
  hourLabel,
  LoadingState,
  type MinuteRange,
  minutesToInstant,
  PageHeader,
  PageShell,
  type RowActionItem,
  ResourceAvatar,
  SCHEDULE_AGENDA_LABELS,
  SCHEDULE_DEFAULT_WINDOW,
  SCHEDULE_SMALL_QUERY,
  type ScheduleAgendaItem,
  ScheduleAgendaList,
  type ScheduleAvailability,
  type ScheduleBlocked,
  type ScheduleColumn,
  ScheduleDayStrip,
  type ScheduleEntry,
  ScheduleGrid,
  type ScheduleLane,
  ScheduleOccupancyLegend,
  type SchedulePreview,
  ScheduleResourceChips,
  type ScheduleStatus,
  ScheduleStatusSummary,
  ScheduleToolbar,
  ScheduleWeekOverview,
  scheduleToneAt,
  subtractRanges,
  useListSearch,
  useMediaQuery,
  useScheduleNow,
  weekDates,
  windowCovering,
  zonedDateOf,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import {
  Armchair,
  CalendarClock,
  CalendarDays,
  CalendarX2,
  ChevronDown,
  Clock,
  Plus,
} from "lucide-react"
import * as React from "react"
import {
  AppointmentDrawer,
  type AppointmentDrawerMode,
} from "../../components/agenda/appointment-drawer"
import { AppointmentSearch } from "../../components/agenda/appointment-search"
import { BookingDrawer, type BookingSeed } from "../../components/agenda/booking-drawer"
import { ScheduleDrawer } from "../../components/agenda/schedule-editor"
import { ChairForm } from "../../components/agenda/chair-form"
import { useAppointmentArrival } from "../../components/agenda/arrival"
import { dayShort, errorMessage, shortName } from "../../components/agenda/shared"
import { useAttendAppointment } from "../../components/patient/new-encounter-button"
import { BranchSwitcher } from "../../components/branch-switcher"
import { useActiveBranch } from "../../lib/active-branch"
import {
  type AgendaAppointment,
  type AgendaAvailability,
  type AgendaResources,
  type AppointmentStatus,
  invalidateAppointmentQueries,
  visitLabel,
  visitStage,
} from "../../lib/agenda"
import { apiFetch } from "../../lib/api"
import { useMyUserId, usePermission } from "../../lib/crm"
import { fetchCrmContext } from "../../lib/crm-workspace"
import { activeOrgTimeZone } from "../../lib/locale"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const Route = createFileRoute("/_org/agenda")({
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    patientId?: string
    contactId?: string
    conversationId?: string
    appointmentId?: string
    /** «Agendar» desde el Plan: tratamientos aceptados que trae la cita, separados por coma. */
    planItems?: string
    /** El servicio de esos tratamientos, si es uno solo. */
    serviceId?: string
    /** Vista, fecha, sede y filtros: los lee `useListSearch`; aquí solo se tipan para los enlaces. */
    view?: string
    date?: string
    branch?: string
    who?: string
    group?: string
    status?: string
  } => ({
    ...search,
    patientId: typeof search.patientId === "string" ? search.patientId : undefined,
    contactId: typeof search.contactId === "string" ? search.contactId : undefined,
    conversationId: typeof search.conversationId === "string" ? search.conversationId : undefined,
    appointmentId: typeof search.appointmentId === "string" ? search.appointmentId : undefined,
    planItems: typeof search.planItems === "string" && search.planItems.length <= 1200 ? search.planItems : undefined,
    serviceId: typeof search.serviceId === "string" && UUID_RE.test(search.serviceId) ? search.serviceId : undefined,
  }),
  component: AgendaPage,
})

/** Los tratamientos que llegan en la URL: solo identificadores válidos, sin repetir. */
function planItemIdsOf(value: string | undefined): string[] {
  if (!value) return []
  return [...new Set(value.split(",").filter((id) => UUID_RE.test(id)))].slice(0, 20)
}

type AgendaView = "dia" | "semana" | "lista"
type GroupMode = "professionals" | "chairs"

const VIEWS = [
  { id: "dia", label: "Día" },
  { id: "semana", label: "Semana" },
  { id: "lista", label: "Lista" },
]
const DATE = /^\d{4}-\d{2}-\d{2}$/
const STATUSES: AppointmentStatus[] = [
  "programada",
  "confirmada",
  "atendida",
  "no_asistio",
  "cancelada",
]

/** «Confirmar» deja paso a «Llegó» desde una hora antes de la cita. */
const ARRIVAL_WINDOW_MS = 60 * 60_000

/** Lo cancelado o no asistido deja el sitio libre: no ocupa la rejilla. */
const occupies = (status: AppointmentStatus) => status !== "cancelada" && status !== "no_asistio"
const standing = (status: AppointmentStatus) => status === "programada" || status === "confirmada"
const capitalize = (text: string) => text.charAt(0).toLocaleUpperCase("es") + text.slice(1)
/** `?who=todos`: ver a todos aunque quien mira tenga su propia columna. */
const WHO_ALL = "todos"

function rangesOn(
  items: Array<{ columnId: string; start: string; end: string }>,
  columnId: string,
  date: string,
  timeZone: string,
): MinuteRange[] {
  return items
    .filter((item) => item.columnId === columnId)
    .flatMap((item): MinuteRange[] => {
      const range = dayRangeOf(item.start, item.end, date, timeZone)
      return range ? [range] : []
    })
}

/** «12 al 17 de octubre», o con los dos meses si la semana los cruza. */
function weekLabel(dates: string[]): string {
  const first = dates[0] ?? ""
  const last = dates[dates.length - 1] ?? first
  const said = (date: string) => formatDateLong(date).split(" ").slice(1)
  const [firstDay = "", , firstMonth = ""] = said(first)
  const [lastDay = "", , lastMonth = ""] = said(last)
  return firstMonth === lastMonth
    ? `${firstDay} al ${lastDay} de ${lastMonth}`
    : `${firstDay} de ${firstMonth} al ${lastDay} de ${lastMonth}`
}

function AgendaPage() {
  const queryClient = useQueryClient()
  const { get, setParam, setParams } = useListSearch()
  const small = useMediaQuery(SCHEDULE_SMALL_QUERY)
  const canWrite = usePermission("appointments.write")
  const canConfigure = usePermission("settings.write")
  const canAttend = usePermission("clinical.write")
  const myUserId = useMyUserId()
  const requested = Route.useSearch()
  const navigate = useNavigate()

  const sede = useActiveBranch()
  const resourcesQuery = useQuery({
    queryKey: ["agenda-resources", sede.branchId ?? null],
    enabled: sede.ready,
    queryFn: () =>
      apiFetch<{ data: AgendaResources }>(
        `/api/agenda/resources${sede.branchId ? `?branchId=${encodeURIComponent(sede.branchId)}` : ""}`,
      ),
  })
  const resources = resourcesQuery.data?.data
  const branchId = resources?.branchId
  const TZ = resources?.timeZone ?? activeOrgTimeZone()

  const now = useScheduleNow()
  const today = zonedDateOf(now, TZ)
  const dateParam = get("date") ?? ""
  const day = DATE.test(dateParam) ? dateParam : today
  const viewParam = get("view")
  const view: AgendaView = viewParam === "semana" || viewParam === "lista" ? viewParam : "dia"
  const group: GroupMode =
    view === "dia" && get("group") === "chairs" ? "chairs" : "professionals"
  const whoParam = get("who") ?? null
  const statusParam = get("status")
  const statusFilter = STATUSES.find((item) => item === statusParam) ?? null

  const [booking, setBooking] = React.useState<BookingSeed | null>(null)
  const [preview, setPreview] = React.useState<SchedulePreview | null>(null)
  const [detail, setDetail] = React.useState<{ id: string; mode: AppointmentDrawerMode } | null>(
    null,
  )
  const [chairForm, setChairForm] = React.useState(false)
  const [scheduleForm, setScheduleForm] = React.useState(false)
  const [message, setMessage] = React.useState("")

  // ----- Datos -----
  const week = React.useMemo(() => weekDates(day), [day])
  const range = React.useMemo(
    () => ({
      from: minutesToInstant(week[0] ?? day, 0, TZ),
      to: minutesToInstant(addDays(week[6] ?? day, 1), 0, TZ),
    }),
    [week, day, TZ],
  )
  const appointmentsQuery = useQuery({
    queryKey: ["agenda", branchId, range.from, range.to],
    enabled: branchId != null,
    queryFn: () =>
      apiFetch<{ data: AgendaAppointment[] }>(
        `/api/appointments?branchId=${branchId ?? ""}&from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
      ),
    placeholderData: (previous, last) => (last?.queryKey[1] === branchId ? previous : undefined),
  })
  const appointments = React.useMemo(
    () => appointmentsQuery.data?.data ?? [],
    [appointmentsQuery.data],
  )
  const availabilityQuery = useQuery({
    queryKey: ["agenda-availability", branchId, range.from, range.to],
    enabled: branchId != null,
    queryFn: () =>
      apiFetch<{ data: AgendaAvailability }>(
        `/api/agenda/availability?branchId=${branchId ?? ""}&from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
      ),
    placeholderData: (previous, last) => (last?.queryKey[1] === branchId ? previous : undefined),
  })
  const availability = availabilityQuery.data?.data

  const invalidate = React.useCallback(
    () => invalidateAppointmentQueries(queryClient),
    [queryClient],
  )

  // ----- Enlaces que llegan de otras pantallas -----
  const linkedAppointment = useQuery({
    queryKey: ["agenda-appointment", requested.appointmentId],
    enabled: Boolean(requested.appointmentId),
    queryFn: () =>
      apiFetch<{ data: AgendaAppointment }>(`/api/appointments/${requested.appointmentId}`),
  })
  const openedAppointment = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (!requested.appointmentId) {
      openedAppointment.current = null
      return
    }
    const linked = linkedAppointment.data?.data
    if (!linked || !resources || openedAppointment.current === linked.id) return
    if (resources.branchId !== linked.branchId) {
      sede.choose(linked.branchId)
      return
    }
    openedAppointment.current = linked.id
    setParam("date", zonedDateOf(linked.startsAt, resources.timeZone))
    setDetail({ id: linked.id, mode: "view" })
  }, [requested.appointmentId, linkedAppointment.data, resources, setParam, sede.choose])

  // Desde «Contexto» llega la persona, con su paciente o sin él (aún no es paciente).
  const contextualPatient = useQuery({
    queryKey: ["crm-context", requested.contactId, requested.conversationId ?? "todas"],
    enabled: canWrite && !!requested.contactId,
    queryFn: () => fetchCrmContext(requested.contactId ?? "", requested.conversationId),
  })
  const patientLink = contextualPatient.data?.data.contact.patients.find(
    (item) => item.id === requested.patientId,
  )
  const soloPatient = useQuery({
    queryKey: ["agenda-patient", requested.patientId],
    enabled: canWrite && !!requested.patientId && !requested.contactId,
    queryFn: () =>
      apiFetch<{ data: { patient: { id: string; displayName: string } } }>(
        `/api/patients/${requested.patientId}`,
      ),
  })
  const openedRequest = React.useRef<string | null>(null)
  React.useEffect(() => {
    // Desde la ficha llega solo el paciente: la reserva se abre con esa persona.
    const solo = soloPatient.data?.data.patient
    if (requested.patientId && !requested.contactId && solo && resources && canWrite) {
      if (openedRequest.current === solo.id) return
      openedRequest.current = solo.id
      // «Agendar» desde el Plan trae también el servicio y los tratamientos aceptados.
      const planItemIds = planItemIdsOf(requested.planItems)
      setBooking({
        patient: { id: solo.id, name: solo.displayName },
        lockedPatient: true,
        ...(requested.serviceId ? { serviceId: requested.serviceId } : {}),
        ...(planItemIds.length > 0 ? { planItemIds } : {}),
      })
      return
    }
    // Quien aún no es paciente: «Nueva cita» abre con su ficha mínima por crear, unida a ella.
    const person = contextualPatient.data?.data.contact
    if (requested.contactId && !requested.patientId && person && resources && canWrite) {
      const personKey = `${requested.contactId}::${requested.conversationId ?? ""}`
      if (openedRequest.current === personKey) return
      openedRequest.current = personKey
      const self = person.patients.find((item) => item.relationship === "self")
      setBooking(
        self
          ? { patient: { id: self.id, name: self.displayName }, lockedPatient: true, conversationId: requested.conversationId }
          : {
              person: { contactId: person.contact.id, name: person.contact.displayName, phone: person.contact.phone },
              lockedPatient: true,
              conversationId: requested.conversationId,
            },
      )
      return
    }
    const key =
      requested.contactId && requested.patientId
        ? `${requested.contactId}:${requested.patientId}:${requested.conversationId ?? ""}`
        : null
    if (!key && !requested.patientId && !requested.contactId) openedRequest.current = null
    if (key && key !== openedRequest.current && patientLink && resources && canWrite) {
      openedRequest.current = key
      setBooking({
        patient: { id: patientLink.id, name: patientLink.displayName },
        lockedPatient: true,
        conversationId: requested.conversationId,
      })
    }
  }, [
    requested.contactId,
    requested.patientId,
    requested.conversationId,
    requested.planItems,
    requested.serviceId,
    patientLink,
    soloPatient.data,
    contextualPatient.data,
    resources,
    canWrite,
  ])

  const closeBooking = () => {
    if (booking?.lockedPatient) {
      setParams({
        patientId: undefined,
        contactId: undefined,
        conversationId: undefined,
        planItems: undefined,
        serviceId: undefined,
      })
    }
    setBooking(null)
  }
  const closeDetail = () => {
    setDetail(null)
    if (requested.appointmentId) setParam("appointmentId", undefined)
  }
  const openBooking = (seed: BookingSeed = {}) => {
    if (!canWrite) return
    setDetail(null)
    setBooking({ date: day, ...seed })
  }

  // ----- Recursos -----
  const toneOf = React.useMemo(() => {
    const index = new Map((resources?.professionals ?? []).map((item, at) => [item.id, at]))
    return (id: string) => scheduleToneAt(index.get(id) ?? 0)
  }, [resources])
  /** Quienes atienden en la sede, más quien tenga citas esta semana sin horario. */
  const team = React.useMemo((): ScheduleColumn[] => {
    const known = new Map<string, string>()
    for (const item of availability?.professionals ?? []) known.set(item.id, item.label)
    for (const item of appointments) {
      if (!known.has(item.dentistUserId)) known.set(item.dentistUserId, item.dentistName)
    }
    return [...known].map(([id, label]) => ({ id, label, tone: toneOf(id) }))
  }, [availability, appointments, toneOf])
  // Un odontólogo abre la Agenda en su columna (tablero 7); «todos» la abre entera.
  const ownColumn = canAttend && group === "professionals" && team.some((item) => item.id === myUserId) ? myUserId : null
  const who = whoParam === WHO_ALL ? null : (whoParam ?? ownColumn)
  const chairs = React.useMemo(
    (): ScheduleColumn[] =>
      (resources?.chairs ?? []).map((item, index) => ({
        id: item.id,
        label: item.label,
        tone: scheduleToneAt(index),
      })),
    [resources],
  )

  // ----- Citas -----
  const byId = React.useMemo(
    () => new Map(appointments.map((appointment) => [appointment.id, appointment])),
    [appointments],
  )
  const conflicts = React.useMemo(
    () =>
      findScheduleConflicts(
        appointments.map((item) => ({
          id: item.id,
          start: item.startsAt,
          end: item.endsAt,
          status: item.status,
          professionalId: item.dentistUserId,
          chairId: item.chairId,
        })),
      ),
    [appointments],
  )
  const dayAppointments = appointments.filter((item) => zonedDateOf(item.startsAt, TZ) === day)
  const dayStanding = dayAppointments.filter((item) => occupies(item.status)).length
  const pending = dayAppointments.filter((item) => item.status === "programada").length

  const open = React.useMemo(
    (): ScheduleAvailability[] =>
      (availability?.open ?? []).map((item) => ({
        columnId: item.dentistUserId,
        start: item.startsAt,
        end: item.endsAt,
      })),
    [availability],
  )
  const blocksBy = React.useCallback(
    (kind: GroupMode): ScheduleBlocked[] => {
      const targets = kind === "chairs" ? chairs : team
      return (availability?.blocks ?? []).flatMap((block) => {
        // Un bloqueo de sillón no cierra al profesional, ni al revés.
        const scoped = kind === "chairs" ? block.dentistUserId : block.chairId
        if (scoped) return []
        const own = kind === "chairs" ? block.chairId : block.dentistUserId
        const label = block.reason ?? (block.kind === "ausencia" ? "Ausencia" : "No disponible")
        return (own ? [own] : targets.map((item) => item.id)).map((columnId) => ({
          id: `${block.id}:${columnId}`,
          columnId,
          start: block.startsAt,
          end: block.endsAt,
          label,
        }))
      })
    },
    [availability, chairs, team],
  )
  /** Ausencias y cierres de cada profesional, sea cual sea la vista. */
  const absences = React.useMemo(() => blocksBy("professionals"), [blocksBy])
  const blocked = React.useMemo(
    () => (group === "chairs" ? blocksBy("chairs") : absences),
    [group, blocksBy, absences],
  )
  /** Si una ausencia cubre todo el horario de alguien ese día: el motivo y hasta cuándo. */
  const absenceOn = (id: string, date: string): { label: string; until: string | null } | null => {
    const hours = rangesOn(open, id, date, TZ)
    if (hours.length === 0) return null
    const own = absences.filter((item) => item.columnId === id)
    if (subtractRanges(hours, rangesOn(own, id, date, TZ)).length > 0) return null
    const cover = own.find((item) => dayRangeOf(item.start, item.end, date, TZ))
    if (!cover) return null
    const last = zonedDateOf(new Date(Date.parse(cover.end) - 1).toISOString(), TZ)
    return { label: cover.label ?? "Ausencia", until: last > date ? last : null }
  }
  /** Citas en pie que quedaron dentro de una ausencia: hay que moverlas. */
  const insideAbsence = (item: AgendaAppointment): string | undefined => {
    if (!standing(item.status)) return undefined
    const hit = absences.find(
      (block) =>
        block.columnId === item.dentistUserId &&
        Date.parse(block.start) < Date.parse(item.endsAt) &&
        Date.parse(block.end) > Date.parse(item.startsAt),
    )
    return hit ? `Dentro de una ausencia: ${hit.label ?? "sin motivo"}` : undefined
  }

  /** Llegó o en atención, dicho con su hora: el estado real, no el reloj. */
  const stateOf = (item: AgendaAppointment) => ({
    stage: visitStage(item.visit),
    stateLabel: visitLabel(item, { now, timeZone: TZ }),
  })
  const entries = appointments.map(
    (item): ScheduleEntry => ({
      id: item.id,
      columnId: group === "chairs" ? item.chairId : item.dentistUserId,
      title: item.patientName,
      subtitle: item.serviceName ?? item.reason ?? undefined,
      start: item.startsAt,
      end: item.endsAt,
      status: item.status,
      ...stateOf(item),
      warning: conflictLabel(conflicts.get(item.id)) ?? insideAbsence(item),
    }),
  )
  const active = entries.filter((entry) => occupies(entry.status))

  const attends = (id: string, date: string) =>
    rangesOn(open, id, date, TZ).length > 0 ||
    appointments.some(
      (item) => item.dentistUserId === id && zonedDateOf(item.startsAt, TZ) === date,
    )
  const hasAppointments = (id: string, date: string) =>
    appointments.some(
      (item) =>
        item.dentistUserId === id &&
        occupies(item.status) &&
        zonedDateOf(item.startsAt, TZ) === date,
    )
  // Quien está ausente todo el día sale de la rejilla, salvo que aún tenga citas que mover.
  const dayTeam = team.filter(
    (item) =>
      attends(item.id, day) && (absenceOn(item.id, day) === null || hasAppointments(item.id, day)),
  )
  const absent = team
    .filter((item) => !dayTeam.includes(item))
    .map((item) => ({ ...item, absence: absenceOn(item.id, day) }))
  /** Todos los que atendían ese día están ausentes por lo mismo (feriado, cierre de la sede). */
  const closedReason =
    absent.length > 0 && absent.every((item) => item.absence !== null)
      ? (absent[0]?.absence?.label ?? null)
      : null
  const dayColumns = group === "chairs" ? chairs : dayTeam
  /** Semana, y Día en teléfono: de quién es la agenda. */
  const focus =
    (who && team.some((item) => item.id === who) ? who : null) ??
    dayTeam[0]?.id ??
    team[0]?.id ??
    null
  const dayFocus = dayColumns.find((item) => item.id === who)?.id ?? dayColumns[0]?.id ?? null
  /** Día y Lista en escritorio: a quién se ve (null = todos). */
  const filter = who && dayColumns.some((item) => item.id === who) ? who : null

  // ----- Carriles -----
  const dayLanes: ScheduleLane[] = (
    small ? dayColumns.filter((item) => item.id === dayFocus) : dayColumns
  )
    .filter((item) => small || !filter || item.id === filter)
    .map((item) => ({
      id: item.id,
      columnId: item.id,
      date: day,
      label: item.label,
      tone: item.tone,
    }))

  const focusEntries = active.filter((entry) => entry.columnId === focus)
  const weekDays = week.filter(
    (date, index) =>
      index < 6 ||
      (focus !== null &&
        (rangesOn(open, focus, date, TZ).length > 0 ||
          focusEntries.some((entry) => zonedDateOf(entry.start, TZ) === date))),
  )
  const weekWindow = windowCovering(
    weekDays.flatMap((date) =>
      focus ? [...rangesOn(open, focus, date, TZ), ...rangesOn(focusEntries, focus, date, TZ)] : [],
    ),
    SCHEDULE_DEFAULT_WINDOW,
  )
  const weekModel = weekDays.map((date) => {
    const openRanges = focus ? rangesOn(open, focus, date, TZ) : []
    const blocks = blocked.filter(
      (item) => item.columnId === focus && dayRangeOf(item.start, item.end, date, TZ),
    )
    const segments = daySegments({
      window: weekWindow,
      open: openRanges,
      busy: focus ? rangesOn(focusEntries, focus, date, TZ) : [],
      blocked: focus ? rangesOn(blocked, focus, date, TZ) : [],
      nowMinutes:
        date === today
          ? dayMinutesIn(now, TZ)
          : date < today
            ? weekWindow.endMinutes
            : undefined,
    })
    const free = freeMinutesOf(segments)
    return {
      date,
      count: focusEntries.filter((entry) => zonedDateOf(entry.start, TZ) === date).length,
      segments,
      note: blocks[0]?.label?.toLocaleLowerCase("es"),
      summary:
        openRanges.length === 0
          ? "Sin atención"
          : focus && absenceOn(focus, date)
            ? (absenceOn(focus, date)?.label ?? "Ausencia")
          : date < today
            ? undefined
            : free >= 15
              ? `${formatSpan(Math.floor(free / 15) * 15)} libres`
              : "Sin sitio",
    }
  })
  const weekLanes: ScheduleLane[] = focus
    ? weekModel.map((item) => ({
        id: item.date,
        columnId: focus,
        date: item.date,
        label: capitalize(dayShort(item.date)),
        kind: "day",
        summary: item.summary,
      }))
    : []

  // ----- Acciones -----
  const statusMutation = useMutation({
    mutationFn: (input: { id: string; status: AppointmentStatus }) =>
      apiFetch<{ data: AgendaAppointment }>(`/api/appointments/${input.id}/status`, {
        method: "POST",
        body: JSON.stringify({ status: input.status }),
      }),
    onSuccess: async (result) => {
      const text =
        result.data.status === "confirmada"
          ? `Cita de ${result.data.patientName} confirmada`
          : `Cita de ${result.data.patientName}: ${SCHEDULE_AGENDA_LABELS[result.data.status].toLocaleLowerCase("es")}`
      toast.success(text)
      setMessage(text)
      await invalidate()
    },
    onError: async (error) => {
      toast.error(errorMessage(error))
      await invalidate()
    },
  })
  const moveMutation = useMutation({
    mutationFn: (input: {
      id: string
      expectedVersion: number
      startsAt: string
      endsAt: string
      dentistUserId?: string
      chairId?: string
    }) =>
      apiFetch<{ data: AgendaAppointment }>(`/api/appointments/${input.id}/move`, {
        method: "POST",
        body: JSON.stringify({
          expectedVersion: input.expectedVersion,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          dentistUserId: input.dentistUserId,
          chairId: input.chairId,
        }),
      }),
    onSuccess: async (result) => {
      const text = `Cita de ${result.data.patientName} reprogramada`
      toast.success(text)
      setMessage(text)
      await invalidate()
    },
    // El servicio rechazó el hueco: se dice por qué y la cita vuelve a su sitio.
    onError: async (error) => {
      toast.error(errorMessage(error))
      await invalidate()
    },
  })

  const started = (item: AgendaAppointment) => Date.parse(item.startsAt) <= Date.parse(now)
  /** Aún no llega: por confirmar o confirmada, sin llegada ni atención. */
  const before = (item: AgendaAppointment) => item.visit === "por_confirmar" || item.visit === "confirmada"
  const isToday = (item: AgendaAppointment) => zonedDateOf(item.startsAt, TZ) === today
  /** Su hora pasó sin llegada ni atención: «Ya pasaron · sin cerrar». */
  const unclosed = (item: AgendaAppointment) => before(item) && Date.parse(item.endsAt) <= Date.parse(now)
  const rebook = (patient: { id: string; name: string }) => openBooking({ patient })
  const arrival = useAppointmentArrival({ onRebook: rebook })
  const attend = useAttendAppointment()
  const attendItem = (item: AgendaAppointment) =>
    attend.mutate({
      patientId: item.patientId,
      appointment: { id: item.id, dentistUserId: item.dentistUserId, dentistName: item.dentistName },
    })
  const patientOf = (item: AgendaAppointment) => ({ id: item.patientId, name: item.patientName })
  const menuFor = (entry: ScheduleEntry): RowActionItem[] => {
    const item = byId.get(entry.id)
    if (!item || !canWrite) return []
    if (item.visit === "llego") {
      return [
        {
          key: "deshacer",
          label: "Deshacer la llegada",
          onSelect: () => arrival.mutate({ id: item.id, arrived: false }),
        },
      ]
    }
    if (!before(item)) return []
    return [
      {
        key: "mover",
        label: "Reprogramar",
        onSelect: () => setDetail({ id: item.id, mode: "move" }),
      },
      ...(started(item)
        ? [
            {
              key: "ausente",
              label: "No vino",
              onSelect: () => statusMutation.mutate({ id: item.id, status: "no_asistio" }),
            },
          ]
        : []),
      {
        key: "cancelar",
        label: "Cancelar cita",
        tone: "danger" as const,
        onSelect: () => setDetail({ id: item.id, mode: "cancel" }),
      },
    ]
  }
  /**
   * Una sola acción principal por cita, según su estado (tablero 7): «Confirmar»
   * lo que falta confirmar, «Llegó» lo de hoy, «Atender» a quien llegó,
   * «Reagendar» a quien no vino y, lo que pasó sin cerrarse, «Registrar la
   * atención» o «No vino».
   */
  const primaryFor = (item: AgendaAppointment): { label: string; pending?: boolean; onSelect: () => void } | null => {
    const busy = (id: string) => (arrival.isPending && arrival.variables?.id === id) || (attend.isPending && attend.variables?.appointment.id === id)
    if (item.visit === "llego") return canAttend ? { label: "Atender", pending: busy(item.id), onSelect: () => attendItem(item) } : null
    if (item.visit === "no_vino" || item.visit === "cancelada") {
      return canWrite ? { label: "Reagendar", onSelect: () => rebook(patientOf(item)) } : null
    }
    if (!before(item)) return null
    if (unclosed(item)) {
      if (canAttend) return { label: "Registrar la atención", pending: busy(item.id), onSelect: () => attendItem(item) }
      return canWrite ? { label: "No vino", pending: statusMutation.isPending && statusMutation.variables?.id === item.id, onSelect: () => statusMutation.mutate({ id: item.id, status: "no_asistio" }) } : null
    }
    if (!canWrite) return null
    // Hoy, cerca de la hora o pasada, lo que toca es marcar que llegó (eso también la confirma).
    const soon = isToday(item) && Date.parse(item.startsAt) - Date.parse(now) <= ARRIVAL_WINDOW_MS
    if (item.visit === "por_confirmar" && !soon) {
      return {
        label: "Confirmar",
        pending: statusMutation.isPending && statusMutation.variables?.id === item.id,
        onSelect: () => statusMutation.mutate({ id: item.id, status: "confirmada" }),
      }
    }
    return isToday(item)
      ? { label: "Llegó", pending: busy(item.id), onSelect: () => arrival.mutate({ id: item.id, arrived: true, patient: patientOf(item) }) }
      : null
  }

  const listItems: ScheduleAgendaItem[] = dayAppointments
    .filter((item) => !filter || item.dentistUserId === filter)
    .filter((item) => !statusFilter || item.status === statusFilter)
    .map((item) => ({
      entry: {
        id: item.id,
        columnId: item.dentistUserId,
        title: item.patientName,
        subtitle: item.serviceName ?? item.reason ?? undefined,
        start: item.startsAt,
        end: item.endsAt,
        status: item.status,
        ...stateOf(item),
      },
      resourceLabel: item.dentistName,
      resourceShortLabel: shortName(item.dentistName),
      resourceTone: toneOf(item.dentistUserId),
      resourceDetail: item.chairName,
    }))
  const counts: Partial<Record<ScheduleStatus, number>> = {}
  for (const item of dayAppointments) {
    if (filter && item.dentistUserId !== filter) continue
    counts[item.status] = (counts[item.status] ?? 0) + 1
  }

  // ----- Composición -----
  const step = view === "semana" ? 7 : 1
  const goTo = (date: string) => setParam("date", date === today ? undefined : date)
  const dayTitle =
    day === today ? `Hoy, ${formatDateLong(day).toLocaleLowerCase("es")}` : formatDateLong(day)
  const rangeLabel =
    view === "semana" ? weekLabel(weekDays) : small ? capitalize(dayTitle) : formatDateLong(day)
  const selected = detail
    ? (byId.get(detail.id) ??
      (linkedAppointment.data?.data.id === detail.id ? linkedAppointment.data.data : null))
    : null

  const resourceMenu = (
    current: string | null,
    options: ScheduleColumn[],
    onPick: (id: string | null) => void,
    allLabel: string | null,
  ) => {
    const chosen = options.find((item) => item.id === current)
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="outline" className="gap-2">
              {chosen ? (
                <ResourceAvatar
                  label={chosen.label}
                  tone={chosen.tone}
                  size="sm"
                  className="-ml-1.5"
                />
              ) : null}
              {chosen ? chosen.label : (allLabel ?? "Elegir")}
              <ChevronDown aria-hidden />
            </Button>
          }
        />
        <DropdownMenuContent align="end">
          {allLabel ? (
            <DropdownMenuItem onClick={() => onPick(null)}>{allLabel}</DropdownMenuItem>
          ) : null}
          {options.map((item) => (
            <DropdownMenuItem key={item.id} onClick={() => onPick(item.id)}>
              <ResourceAvatar label={item.label} tone={item.tone} size="sm" />
              {item.label}
            </DropdownMenuItem>
          ))}
          {view === "dia" && chairs.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() =>
                  setParams({
                    group: group === "chairs" ? undefined : "chairs",
                    who: undefined,
                  })
                }
              >
                {group === "chairs" ? "Ver por profesional" : "Ver por sillón"}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }
  const pickWho = (id: string | null) => setParam("who", id ?? (ownColumn ? WHO_ALL : undefined))

  const newButton = canWrite ? (
    <Button onClick={() => openBooking()} className={small ? "h-12 w-full text-base" : undefined}>
      <Plus aria-hidden />
      Nueva cita
    </Button>
  ) : null

  const loading =
    !resources || appointmentsQuery.data == null || availabilityQuery.data == null
  const noSchedules =
    resources != null && availability != null && availability.professionals.length === 0
  const noChairs = resources != null && resources.chairs.length === 0
  const hasData = resources != null && appointmentsQuery.data != null && availability != null
  const readFailed =
    resourcesQuery.isError || appointmentsQuery.isError || availabilityQuery.isError
  // Si falla una recarga se conserva lo que ya estaba en pantalla y se ofrece reintentar.
  const failed = readFailed && !hasData
  const stale = readFailed && hasData
  const refreshing =
    hasData && !readFailed && (appointmentsQuery.isFetching || availabilityQuery.isFetching)
  const retry = () => {
    void resourcesQuery.refetch()
    void appointmentsQuery.refetch()
    void availabilityQuery.refetch()
  }
  // Falta lo básico para reservar y no hay nada que mostrar: se dice qué falta y cómo resolverlo.
  const setupMissing = (noChairs || noSchedules) && appointments.length === 0
  /** Primer día con atención después del que se mira, para no dejar a nadie ante un día vacío. */
  const nextOpenDay =
    (availability?.professionals ?? [])
      .flatMap((item) => (item.nextFree ? [zonedDateOf(item.nextFree.startsAt, TZ)] : []))
      .filter((date) => date > day)
      .sort()[0] ??
    (availability?.open ?? [])
      .map((item) => zonedDateOf(item.startsAt, TZ))
      .filter((date) => date > day && team.some((item) => absenceOn(item.id, date) === null))
      .sort()[0] ??
    null
  // Los estados traen su propio marco: aquí solo ocupan el alto de la agenda.
  const framed = (content: React.ReactNode) => (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto [&>*]:flex-1">{content}</div>
  )
  const setupState = noChairs ? (
    <EmptyState
      icon={Armchair}
      title="Esta sede aún no tiene sillones"
      description={
        canConfigure
          ? "Añade al menos uno: cada cita ocupa un sillón."
          : "Cada cita ocupa un sillón. Pide a quien administra la clínica que añada uno."
      }
      actionLabel={canConfigure ? "Añadir sillón" : undefined}
      onAction={canConfigure ? () => setChairForm(true) : undefined}
    />
  ) : (
    <EmptyState
      icon={CalendarClock}
      title="Falta el horario de atención"
      description={
        canConfigure
          ? `Ningún profesional tiene horario en ${resources?.branchName ?? "esta sede"}. Con el horario, la agenda muestra los huecos y deja reservar.`
          : `Ningún profesional tiene horario en ${resources?.branchName ?? "esta sede"}. Pide a quien administra la clínica que lo configure.`
      }
      actionLabel={canConfigure ? "Configurar horario" : undefined}
      onAction={canConfigure ? () => setScheduleForm(true) : undefined}
    />
  )
  const emptyDay = (
    <EmptyState
      icon={CalendarX2}
      title={
        closedReason
          ? `La sede no atiende el ${formatDateLong(day).toLocaleLowerCase("es")}`
          : `Nadie atiende el ${formatDateLong(day).toLocaleLowerCase("es")}`
      }
      description={`${closedReason ? `${closedReason}. ` : ""}${
        nextOpenDay
          ? `El próximo día con atención es el ${formatDateLong(nextOpenDay).toLocaleLowerCase("es")}.`
          : "No hay atención programada en los días siguientes."
      }`}
      actionLabel={nextOpenDay ? `Ir al ${dayShort(nextOpenDay)}` : undefined}
      onAction={nextOpenDay ? () => goTo(nextOpenDay) : undefined}
      secondaryActionLabel={canWrite ? "Nueva cita" : undefined}
      onSecondaryAction={canWrite ? () => openBooking() : undefined}
    />
  )
  const filtered = Boolean(statusFilter || filter)
  const emptyList = (
    <EmptyState
      icon={CalendarDays}
      title={filtered ? "No hay citas con ese filtro" : "No hay citas este día"}
      description={
        filtered
          ? "Quita el filtro para ver todas las citas del día."
          : "Cuando se reserve una cita para este día aparecerá aquí."
      }
      actionLabel={filtered ? "Quitar filtros" : canWrite ? "Nueva cita" : undefined}
      onAction={
        filtered
          ? () => setParams({ status: undefined, who: undefined })
          : canWrite
            ? () => openBooking()
            : undefined
      }
    />
  )

  const grid = (
    <ScheduleGrid
      className="min-h-0 flex-1"
      label={
        view === "dia" ? `Agenda del ${formatDateLong(day)}` : `Semana del ${weekLabel(weekDays)}`
      }
      lanes={view === "dia" ? dayLanes : weekLanes}
      timeZone={TZ}
      entries={active}
      availability={group === "chairs" ? undefined : open}
      blocked={blocked}
      window={view === "semana" ? weekWindow : undefined}
      hourHeight={small ? 88 : view === "semana" ? 96 : 72}
      minLaneWidth={view === "semana" ? 132 : 168}
      hideHeader={small && view === "dia"}
      createMinutes={resources?.defaultDurationMin}
      now={now}
      selectedEntryId={detail?.id}
      preview={view === "dia" && group === "chairs" ? null : preview}
      onEntryClick={(entry) => setDetail({ id: entry.id, mode: "view" })}
      onEntryMove={
        canWrite
          ? (entry, move) => {
              const item = byId.get(entry.id)
              if (!item) return
              moveMutation.mutate({
                id: item.id,
                expectedVersion: item.version,
                startsAt: move.start,
                endsAt: move.end,
                dentistUserId:
                  group === "professionals" && move.columnId !== item.dentistUserId
                    ? move.columnId
                    : undefined,
                chairId:
                  group === "chairs" && move.columnId !== item.chairId ? move.columnId : undefined,
              })
            }
          : undefined
      }
      onEntryResize={
        canWrite
          ? (entry, resize) => {
              const item = byId.get(entry.id)
              if (!item) return
              moveMutation.mutate({
                id: item.id,
                expectedVersion: item.version,
                startsAt: resize.start,
                endsAt: resize.end,
              })
            }
          : undefined
      }
      onCreate={
        canWrite && group === "professionals"
          ? (target) =>
              openBooking({
                dentistUserId: target.columnId,
                startsAt: target.start,
                date: target.date,
              })
          : undefined
      }
      emptyLabel="Nadie atiende este día en la sede."
    />
  )

  return (
    <PageShell fill className="gap-3 text-foreground">
      <PageHeader
        title="Agenda"
        subtitle={
          resources ? (
            <BranchSwitcher
              branches={sede.branches}
              value={resources.branchId}
              fallbackName={resources.branchName}
              onChange={(id) => sede.choose(id, { who: undefined, group: undefined })}
            />
          ) : (
            <Skeleton className="h-4 w-28" />
          )
        }
        actions={
          <>
            {resources ? (
              <AppointmentSearch
                compact={small}
                timeZone={TZ}
                today={today}
                canBook={canWrite}
                onOpen={(appointment) => setParam("appointmentId", appointment.id)}
                onBook={(patient) => openBooking({ patient })}
              />
            ) : null}
            {small ? null : newButton}
          </>
        }
      />

      {((requested.patientId &&
        (contextualPatient.error ||
          soloPatient.isError ||
          (contextualPatient.isSuccess && requested.contactId && !patientLink))) ||
        (requested.contactId && !requested.patientId && contextualPatient.isError)) && (
          <p role="alert" className="text-sm text-destructive">
            No se pudo preparar la cita: comprueba el vínculo del paciente y vuelve a abrir el caso.
          </p>
        )}
      {linkedAppointment.isError && (
        <p role="alert" className="text-sm text-destructive">
          No se pudo cargar la cita vinculada.{" "}
          <Button variant="outline" size="sm" onClick={() => void linkedAppointment.refetch()}>
            Reintentar
          </Button>
        </p>
      )}

      <ScheduleToolbar
        rangeLabel={rangeLabel}
        rangeControl={
          <DatePickerButton
            value={day}
            onChange={goTo}
            variant="ghost"
            aria-label={`${rangeLabel}. Ir a otra fecha`}
            className="-mx-2 h-9 min-w-0 gap-1.5 px-2 text-lg font-bold tracking-tight"
          >
            <span className="truncate">{rangeLabel}</span>
            <ChevronDown aria-hidden className="shrink-0" />
          </DatePickerButton>
        }
        summary={
          view === "semana" ? undefined : `${dayStanding} ${dayStanding === 1 ? "cita" : "citas"}`
        }
        refreshing={refreshing}
        onPrevious={small && view !== "semana" ? undefined : () => goTo(addDays(day, -step))}
        onNext={small && view !== "semana" ? undefined : () => goTo(addDays(day, step))}
        onToday={small ? undefined : () => goTo(today)}
        previousLabel={view === "semana" ? "Semana anterior" : "Día anterior"}
        nextLabel={view === "semana" ? "Semana siguiente" : "Día siguiente"}
        views={VIEWS}
        view={view}
        onViewChange={(next) =>
          setParams({ view: next === "dia" ? undefined : next, status: undefined })
        }
        stretchViews={small}
        filters={
          small ? undefined : (
            <>
              {view !== "semana" && pending > 0 ? (
                <Button
                  variant="outline"
                  onClick={() => setParams({ view: "lista", status: "programada" })}
                >
                  <Clock aria-hidden className="text-warning-foreground" />
                  {pending} por confirmar
                </Button>
              ) : null}
              {view === "semana"
                ? resourceMenu(focus, team, pickWho, null)
                : resourceMenu(
                    filter,
                    dayColumns,
                    pickWho,
                    group === "chairs" ? "Sillones: todos" : "Profesionales: todos",
                  )}
            </>
          )
        }
      />

      {small && view !== "semana" ? (
        <ScheduleDayStrip
          dates={week.slice(0, 6).includes(day) ? week.slice(0, 6) : week}
          value={day}
          today={today}
          onChange={goTo}
          onPrevious={() => goTo(addDays(day, -7))}
          onNext={() => goTo(addDays(day, 7))}
        />
      ) : null}

      {small && view === "dia" && chairs.length > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          className="-mb-1.5 -ml-2.5 h-7 gap-1 self-start px-2.5 text-[13px] font-bold text-muted-foreground"
          onClick={() =>
            setParams({ group: group === "chairs" ? undefined : "chairs", who: undefined })
          }
        >
          {group === "chairs" ? "Sillones" : "Profesionales"}
          <span className="font-normal">· cambiar</span>
        </Button>
      ) : null}
      {small ? (
        <ScheduleResourceChips
          label={group === "chairs" ? "Sillones" : "Profesionales"}
          resources={view === "semana" ? team : view === "dia" ? dayColumns : dayTeam}
          formatLabel={(item) => (group === "chairs" ? item.label : shortName(item.label))}
          value={view === "lista" ? filter : view === "semana" ? focus : dayFocus}
          allLabel={view === "lista" ? "Todos" : undefined}
          onChange={pickWho}
          className="-mx-4 px-4"
        />
      ) : null}

      {stale ? (
        <p role="alert" className="text-sm text-destructive">
          No se pudo actualizar la agenda; se muestra lo último que se cargó.{" "}
          <Button variant="outline" size="sm" onClick={retry}>
            Reintentar
          </Button>
        </p>
      ) : null}

      {failed ? (
        framed(
          <ErrorState
            title="No se pudo cargar la agenda"
            onRetry={retry}
          />,
        )
      ) : loading ? (
        framed(<LoadingState message="Cargando agenda…" />)
      ) : setupMissing ? (
        framed(setupState)
      ) : view === "lista" ? (
        <div className="-mr-2 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-2">
          <ScheduleStatusSummary
            counts={counts}
            value={statusFilter}
            onChange={(next) => setParam("status", next ?? undefined)}
          />
          {listItems.length === 0 ? (
            framed(emptyList)
          ) : (
          <ScheduleAgendaList
            items={listItems}
            timeZone={TZ}
            now={day === today ? now : undefined}
            onOpen={(entry) => setDetail({ id: entry.id, mode: "view" })}
            primaryAction={({ entry }) => {
              const item = byId.get(entry.id)
              return item ? primaryFor(item) : null
            }}
            menuItems={({ entry }) => menuFor(entry)}
          />
          )}
        </div>
      ) : small && view === "semana" ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto">
          <div className="flex items-center gap-2">
            <ScheduleOccupancyLegend className="flex-1" />
            <span className="text-xs font-semibold text-muted-foreground tabular-nums">
              {hourLabel(weekWindow.startMinutes)} a {hourLabel(weekWindow.endMinutes)}
            </span>
          </div>
          <ScheduleWeekOverview
            days={weekModel}
            today={today}
            onSelect={(date) => setParams({ date: date === today ? undefined : date, view: undefined })}
          />
        </div>
      ) : view === "dia" && dayLanes.length === 0 ? (
        framed(emptyDay)
      ) : (
        grid
      )}

      {!small &&
      !failed &&
      !loading &&
      !setupMissing &&
      view === "dia" &&
      group === "professionals" &&
      dayLanes.length > 0 &&
      absent.length > 0 ? (
        <p className="shrink-0 text-xs text-muted-foreground">
          No {absent.length === 1 ? "atiende" : "atienden"} este día:{" "}
          {absent
            .map((item) =>
              item.absence
                ? `${item.label} (${item.absence.label.toLocaleLowerCase("es")}${
                    item.absence.until
                      ? ` hasta el ${formatDateLong(item.absence.until).toLocaleLowerCase("es")}`
                      : ""
                  })`
                : item.label,
            )
            .join(", ")}
        </p>
      ) : null}

      {small ? <div className="shrink-0">{newButton}</div> : null}

      <span role="status" className="sr-only">
        {message}
      </span>

      {booking && resources && branchId ? (
        <BookingDrawer
          key={`${booking.patient?.id ?? ""}:${booking.startsAt ?? ""}:${booking.dentistUserId ?? ""}`}
          seed={booking}
          branchId={branchId}
          timeZone={TZ}
          today={today}
          now={now}
          defaultMinutes={resources.defaultDurationMin}
          toneOf={toneOf}
          onPreview={setPreview}
          onClose={closeBooking}
          onSaved={async (created) => {
            setMessage(`Cita de ${created.patientName} reservada`)
            // Reservada desde una conversación: se vuelve al hilo, donde el agente le avisa.
            const backTo = booking.conversationId
            closeBooking()
            if (backTo) {
              await invalidate()
              await queryClient.invalidateQueries({ queryKey: ["crm-context"] })
              void navigate({ to: "/inbox", search: { conversation: backTo } })
              return
            }
            // Se va al día de la cita: quien reserva ve lo que acaba de reservar.
            const date = zonedDateOf(created.startsAt, TZ)
            if (date !== day) goTo(date)
            await invalidate()
            await queryClient.invalidateQueries({ queryKey: ["crm-context"] })
          }}
        />
      ) : null}

      {selected && resources ? (
        <AppointmentDrawer
          key={`${selected.id}:${detail?.mode ?? "view"}`}
          appointment={selected}
          initialMode={detail?.mode}
          canWrite={canWrite}
          timeZone={TZ}
          today={today}
          now={now}
          resources={resources}
          toneOf={toneOf}
          onClose={closeDetail}
          onChanged={invalidate}
          onRebook={(patient) => {
            closeDetail()
            openBooking({ patient })
          }}
        />
      ) : null}

      {scheduleForm && resources && branchId ? (
        <ScheduleDrawer
          branchId={branchId}
          branchName={resources.branchName}
          professionals={resources.professionals.map((item) => ({
            id: item.id,
            label: item.label,
            tone: toneOf(item.id),
          }))}
          onClose={() => setScheduleForm(false)}
          onSaved={invalidate}
        />
      ) : null}

      {chairForm && resources && branchId ? (
        <ChairForm
          branchId={branchId}
          branchName={resources.branchName}
          suggestedName={`Sillón ${resources.chairs.length + 1}`}
          onClose={() => setChairForm(false)}
          onSaved={async () => {
            setChairForm(false)
            await invalidate()
          }}
        />
      ) : null}
    </PageShell>
  )
}
