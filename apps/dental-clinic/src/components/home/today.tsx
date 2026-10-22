import { formatMoney } from "@odentia/clinical"
import { Badge, Button, buttonVariants, cn } from "@odentia/ui"
import { EmptyState, StatusIcon, SubmitButton, statusTextClass, useScheduleNow } from "@odentia/ui-patterns"
import { Link, useNavigate } from "@tanstack/react-router"
import { CalendarDays, Wallet } from "lucide-react"
import { type ReactNode, useId } from "react"
import type { BranchOption } from "../../lib/active-branch"
import { visitLabel, visitName, visitState } from "../../lib/agenda"
import { usePermission, useMyUserId } from "../../lib/crm"
import { type DebtRow, debtConcepts, debtDue, formatClock } from "../../lib/finance-cash"
import { agendaSummary, attendedPercent, patientsSummary } from "../../lib/home"
import type { WorkspaceAppointment, WorkspaceCash, WorkspaceToday, WorkspaceTodaySummary } from "../../lib/workspace"
import { useAppointmentArrival } from "../agenda/arrival"
import { BranchSwitcher } from "../branch-switcher"
import { useAttendAppointment } from "../patient/new-encounter-button"

const CARD = "enter elevated flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-4 sm:p-5"
const MORE = "inline-flex min-h-11 items-center self-start font-semibold text-primary underline underline-offset-4 sm:min-h-8"
/** Toda la fila abre algo; la acción rápida va en su propio botón, como en «Te espera». */
const ROW =
  "h-auto min-h-11 w-full min-w-0 flex-1 justify-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm font-normal whitespace-normal"

/** La sede se elige en la tarjeta, y solo si hay más de una: «Te espera» es de toda la clínica. */
export interface BranchChoice {
  branches: BranchOption[]
  onChange: (id: string) => void
}

function CardHeader({ id, title, count, branch, choice }: { id: string; title: string; count?: number; branch?: { id: string; name: string } | null; choice?: BranchChoice }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <h2 id={id} className="flex min-w-0 flex-1 items-center gap-2 text-[17px] font-bold tracking-tight">
        {title}
        {count ? (
          <Badge variant="secondary" className="tabular-nums">
            {count}
            <span className="sr-only"> {count === 1 ? "paciente" : "pacientes"}</span>
          </Badge>
        ) : null}
      </h2>
      {branch && choice && choice.branches.length > 1 ? (
        <BranchSwitcher branches={choice.branches} value={branch.id} fallbackName={branch.name} onChange={choice.onChange} />
      ) : null}
    </div>
  )
}

/** Cuánto del día ya se atendió. Decorativa: el resumen escrito dice lo mismo. */
function DayProgress({ percent }: { percent: number }) {
  return (
    <div aria-hidden className="h-1.5 rounded-full bg-muted">
      <div className="h-1.5 rounded-full bg-primary" style={{ width: `${percent}%` }} />
    </div>
  )
}

/** El momento de la cita en palabras, con su icono: nunca solo con color. */
function VisitText({ item, now, timeZone }: { item: WorkspaceAppointment; now: string; timeZone: string }) {
  const state = visitState(item.visit)
  return (
    <span className={cn("flex shrink-0 items-center gap-1 text-[13px] font-semibold", statusTextClass(state))}>
      <StatusIcon status={state} className="size-3.5" />
      {visitLabel({ ...item, encounter: item.encounter ? { ...item.encounter, status: "borrador", endedAt: null } : null }, { now, timeZone })}
    </span>
  )
}

const detailOf = (parts: Array<string | null | false>) => parts.filter(Boolean).join(" · ")

/**
 * «Agenda de hoy» de una sede: quién está en la sala, lo que falta y quién no
 * vino. Cada fila abre la cita; al lado, su paso: «Llegó», «Deshacer» o
 * «Reagendar». Se refresca sola con cada cambio de la agenda.
 */
export function TodayAgenda({ today, locale, choice }: { today: WorkspaceToday; locale: string; choice: BranchChoice }) {
  const headingId = useId()
  const navigate = useNavigate()
  const now = useScheduleNow()
  const canWrite = usePermission("appointments.write")
  const rebook = (patient: { id: string; name: string }) => void navigate({ to: "/agenda", search: { patientId: patient.id, branch: branch?.id } })
  const arrival = useAppointmentArrival({ onRebook: rebook })
  const { summary, branch } = today
  const agenda = { branch: branch?.id }
  const actionOf = (item: WorkspaceAppointment): { label: string; run: () => void } | null => {
    if (!canWrite) return null
    const patient = { id: item.patientId, name: item.patientName }
    if (item.visit === "por_confirmar" || item.visit === "confirmada") {
      return { label: "Llegó", run: () => arrival.mutate({ id: item.id, arrived: true, patient }) }
    }
    if (item.visit === "llego") return { label: "Deshacer", run: () => arrival.mutate({ id: item.id, arrived: false }) }
    if (item.visit === "no_vino") return { label: "Reagendar", run: () => rebook(patient) }
    return null
  }
  return (
    <section aria-labelledby={headingId} className={CARD}>
      <CardHeader id={headingId} title="Agenda de hoy" branch={branch} choice={choice} />
      {summary.total === 0 && today.appointments.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          className="p-5"
          title={branch ? `Hoy no hay citas en ${branch.name}` : "Hoy no hay citas"}
          description=""
          actionLabel="Abrir la Agenda"
          onAction={() => void navigate({ to: "/agenda", search: agenda })}
        />
      ) : (
        <>
          <p>{agendaSummary(summary)}</p>
          <DayProgress percent={attendedPercent(summary)} />
          {today.appointments.length > 0 ? (
            <ul className="flex flex-col divide-y">
              {today.appointments.map((item) => {
                const action = actionOf(item)
                const busy = arrival.isPending && arrival.variables?.id === item.id
                return (
                  <li key={item.id} className="flex items-center gap-2 py-0.5">
                    <Link
                      to="/agenda"
                      search={{ appointmentId: item.id, branch: branch?.id }}
                      className={cn(buttonVariants({ variant: "ghost" }), ROW)}
                    >
                      <span className="w-12 shrink-0 font-semibold tabular-nums">{formatClock(item.startsAt, locale, today.timezone)}</span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-semibold">{item.patientName}</span>
                        <span className="truncate text-[13px] text-muted-foreground">{detailOf([item.professionalName, item.serviceName])}</span>
                      </span>
                      <VisitText item={item} now={now} timeZone={today.timezone} />
                    </Link>
                    {action ? (
                      <SubmitButton
                        size="sm"
                        variant={action.label === "Llegó" ? "default" : "outline"}
                        className="min-h-11 shrink-0 sm:min-h-8"
                        pending={busy}
                        aria-label={`${action.label}: ${item.patientName}`}
                        onClick={action.run}
                      >
                        {action.label}
                      </SubmitButton>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          ) : null}
          <Link to="/agenda" search={agenda} className={MORE}>
            {summary.total > 1 ? `Ver las ${summary.total} en la Agenda` : summary.total === 1 ? "Ver la cita en la Agenda" : "Abrir la Agenda"}
          </Link>
        </>
      )}
    </section>
  )
}

/** Una fila de «Mis pacientes de hoy»: el nombre abre su página y la acción va en su botón. */
function PatientRow({
  item,
  locale,
  timezone,
  now,
  multiBranch,
  action,
}: {
  item: WorkspaceAppointment
  locale: string
  timezone: string
  now: string
  multiBranch: boolean
  action: ReactNode
}) {
  const what = detailOf([item.serviceName, multiBranch && item.branchName])
  const later = item.visit === "por_confirmar" || item.visit === "confirmada"
  return (
    <li className="flex items-center gap-2 py-0.5">
      <Link to="/patients/$patientId" params={{ patientId: item.patientId }} className={cn(buttonVariants({ variant: "ghost" }), ROW)}>
        {later ? <span className="w-12 shrink-0 font-semibold tabular-nums">{formatClock(item.startsAt, locale, timezone)}</span> : null}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-semibold">{detailOf([item.patientName, what])}</span>
          <span className="truncate text-[13px]">
            {later ? (
              <span className={statusTextClass(visitState(item.visit))}>{visitName(item.visit)}</span>
            ) : item.visit === "en_atencion" && item.encounter ? (
              <span className="text-primary">En atención desde {formatClock(item.encounter.startedAt, locale, timezone)}</span>
            ) : (
              <VisitText item={item} now={now} timeZone={timezone} />
            )}
          </span>
        </span>
      </Link>
      {action}
    </li>
  )
}

/**
 * «Mis pacientes de hoy» de quien atiende, también la dueña: «Sala de espera»
 * (quien llegó, con «Atender»), «Ahora» (lo que atiende, con «Seguir la
 * atención») y «Más tarde». El nombre abre su página para mirarla antes de
 * llamarla. Se actualiza solo con cada cambio de la agenda.
 */
export function TodayPatients({ today, locale, multiBranch }: { today: WorkspaceToday; locale: string; multiBranch: boolean }) {
  const headingId = useId()
  const navigate = useNavigate()
  const now = useScheduleNow()
  const myUserId = useMyUserId()
  const canAttend = usePermission("clinical.write")
  const attend = useAttendAppointment()
  const mine = { who: myUserId }
  const waiting = today.appointments.filter((item) => item.visit === "llego")
  const attending = today.appointments.filter((item) => item.visit === "en_atencion")
  const later = today.appointments.filter((item) => item.visit === "por_confirmar" || item.visit === "confirmada")
  const attended = today.summary.attended
  const attendButton = (item: WorkspaceAppointment) =>
    canAttend ? (
      <SubmitButton
        size="sm"
        className="min-h-11 shrink-0 sm:min-h-8"
        pending={attend.isPending && attend.variables?.appointment.id === item.id}
        aria-label={`Atender: ${item.patientName}`}
        onClick={() =>
          attend.mutate({ patientId: item.patientId, appointment: { id: item.id, professionalUserId: item.professionalUserId, professionalName: item.professionalName } })
        }
      >
        Atender
      </SubmitButton>
    ) : null
  const group = (title: string, items: WorkspaceAppointment[], actionOf: (item: WorkspaceAppointment, index: number) => ReactNode) =>
    items.length > 0 ? (
      <div className="flex flex-col gap-0.5">
        <h3 className="pt-1 text-[13px] font-bold text-muted-foreground">{title}</h3>
        <ul aria-label={title} className="flex flex-col divide-y">
          {items.map((item, index) => (
            <PatientRow key={item.id} item={item} locale={locale} timezone={today.timezone} now={now} multiBranch={multiBranch} action={actionOf(item, index)} />
          ))}
        </ul>
      </div>
    ) : null
  return (
    <section aria-labelledby={headingId} className={CARD}>
      <CardHeader id={headingId} title="Mis pacientes de hoy" count={today.summary.total} />
      {today.summary.total === 0 ? (
        <EmptyState
          icon={CalendarDays}
          className="p-5"
          title="Hoy no tienes pacientes"
          description=""
          actionLabel="Ver mi agenda"
          onAction={() => void navigate({ to: "/agenda", search: mine })}
        />
      ) : (
        <>
          <p className="sr-only">{patientsSummary(today.summary)}</p>
          {group("Sala de espera", waiting, (item) => attendButton(item))}
          {group("Ahora", attending, (item) =>
            item.encounter ? (
              <Link
                to="/patients/$patientId/encounters/$encounterId"
                params={{ patientId: item.patientId, encounterId: item.encounter.id }}
                aria-label={`${item.encounter.professionalUserId === myUserId ? "Seguir la atención" : "Ver la atención"}: ${item.patientName}`}
                className={cn(buttonVariants({ variant: "outline", size: "sm" }), "min-h-11 shrink-0 sm:min-h-8")}
              >
                {item.encounter.professionalUserId === myUserId ? "Seguir la atención" : "Ver la atención"}
              </Link>
            ) : null,
          )}
          {/* Si nadie espera ni se está atendiendo, la siguiente se atiende desde aquí: «Atender» marca la llegada. */}
          {group("Más tarde", later, (item, index) => (index === 0 && waiting.length === 0 && attending.length === 0 ? attendButton(item) : null))}
          {attended > 0 ? (
            <p className="text-[13px] text-muted-foreground">
              {attended === 1 ? "1 paciente atendido hoy" : `${attended} pacientes atendidos hoy`}
            </p>
          ) : null}
          <Link to="/agenda" search={mine} className={MORE}>
            Ver mi agenda
          </Link>
        </>
      )}
    </section>
  )
}

/** La agenda de la sede en una línea, para quien hoy atiende y además la ve: lleva a la Agenda de esa sede. */
export function AgendaLine({ line }: { line: { branch: { id: string; name: string }; summary: WorkspaceTodaySummary } }) {
  return (
    <Link
      to="/agenda"
      search={{ branch: line.branch.id }}
      className={cn(
        buttonVariants({ variant: "ghost" }),
        "enter elevated h-auto min-h-11 w-full justify-start gap-3 rounded-xl border-border bg-card px-4 py-4 text-left text-sm font-normal whitespace-normal hover:bg-card sm:px-5",
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[17px] font-bold tracking-tight">Agenda de {line.branch.name}</span>
        <span>{line.summary.total === 0 ? "Hoy no hay citas" : agendaSummary(line.summary)}</span>
      </span>
      <span className="shrink-0 font-semibold text-primary">Abrir la Agenda</span>
    </Link>
  )
}

const collectedText = (cash: WorkspaceCash, locale: string) =>
  `Cobrado ${formatMoney(cash.collectedCents, cash.currency, locale)} en ${cash.tickets} ${cash.tickets === 1 ? "cobro" : "cobros"}`
const peopleText = (count: number) => `${count} ${count === 1 ? "persona" : "personas"}`

function ToCollectRow({ row, cash, locale, onCollect }: { row: DebtRow; cash: WorkspaceCash; locale: string; onCollect?: (row: DebtRow) => void }) {
  const name = row.displayName || "Paciente sin nombre"
  const at = row.attendedTodayAt
  // Las mismas palabras que la Caja: salió de su atención o se le anotó algo hoy.
  const when = at ? `${row.lastAttended?.at === at ? "salió a las" : "anotado hoy a las"} ${formatClock(at, locale, cash.timezone)}` : null
  const className = "h-auto min-h-11 w-full justify-start gap-3 rounded-lg px-2.5 py-2 text-left text-sm font-normal whitespace-normal"
  const content: ReactNode = (
    <>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-semibold">{name}</span>
        <span className="text-[13px] text-muted-foreground">{detailOf([debtConcepts(row), when])}</span>
      </span>
      <span className="shrink-0 font-semibold tabular-nums">{formatMoney(debtDue(row).dueCents, row.currency, locale)}</span>
      <span className="shrink-0 font-semibold text-primary">{onCollect ? "Cobrar" : "Ver su cuenta"}</span>
    </>
  )
  return (
    <li className="border-b last:border-b-0">
      {onCollect ? (
        <Button type="button" variant="ghost" className={className} onClick={() => onCollect(row)}>
          {content}
        </Button>
      ) : (
        <Link
          to="/patients/$patientId"
          params={{ patientId: row.patientId }}
          search={{ tab: "cuenta" }}
          className={cn(buttonVariants({ variant: "ghost" }), className)}
        >
          {content}
        </Link>
      )}
    </li>
  )
}

/**
 * «Caja de hoy» de quien cobra: lo cobrado en el día y a quién falta cobrar de
 * lo atendido hoy (la lista de Finanzas › Caja). «Cobrar» abre el mismo cobro.
 */
export function TodayCash({
  cash,
  locale,
  choice,
  onCollect,
}: {
  cash: WorkspaceCash
  locale: string
  choice: BranchChoice
  /** Abre el cobro de esa persona; sin permiso para cobrar, la fila lleva a su cuenta. */
  onCollect?: (row: DebtRow) => void
}) {
  const headingId = useId()
  const navigate = useNavigate()
  const finance = { branch: cash.branchId }
  return (
    <section aria-labelledby={headingId} className={CARD}>
      <CardHeader id={headingId} title="Caja de hoy" branch={{ id: cash.branchId, name: cash.branchName }} choice={choice} />
      <p>{collectedText(cash, locale)}</p>
      {cash.toCollect.length === 0 ? (
        <EmptyState
          icon={Wallet}
          className="p-5"
          title="Nadie por cobrar de lo atendido hoy"
          description="Cuando se cierre una atención con costo, la persona aparece aquí sola."
          actionLabel="Ir a Caja"
          onAction={() => void navigate({ to: "/finance", search: finance })}
        />
      ) : (
        <>
          <h3 className="pt-1 text-[13px] font-bold">Por cobrar · {peopleText(cash.toCollect.length)}</h3>
          <ul className="flex flex-col">
            {cash.toCollect.map((row) => (
              <ToCollectRow key={`${row.patientId}-${row.currency}`} row={row} cash={cash} locale={locale} onCollect={onCollect} />
            ))}
          </ul>
          <Link to="/finance" search={finance} className={MORE}>
            Ir a Caja
          </Link>
        </>
      )}
    </section>
  )
}

/** La caja del día en una línea, para quien dirige: lleva a Finanzas › Caja de esa sede. */
export function CashLine({ cash, locale }: { cash: WorkspaceCash; locale: string }) {
  const pending = cash.toCollect.length
  return (
    <Link
      to="/finance"
      search={{ branch: cash.branchId }}
      className={cn(
        buttonVariants({ variant: "ghost" }),
        "enter elevated h-auto min-h-11 w-full justify-start gap-3 rounded-xl border-border bg-card px-4 py-4 text-left text-sm font-normal whitespace-normal hover:bg-card sm:px-5",
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[17px] font-bold tracking-tight">Caja de hoy</span>
        <span>
          {collectedText(cash, locale)} · {pending === 0 ? "nadie por cobrar" : `${peopleText(pending)} por cobrar`}
        </span>
      </span>
      <span className="shrink-0 font-semibold text-primary">Ir a Caja</span>
    </Link>
  )
}
