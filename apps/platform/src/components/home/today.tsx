import { formatMoney } from "@odentia/clinical"
import { Button, buttonVariants, cn } from "@odentia/ui"
import { EmptyState } from "@odentia/ui-patterns"
import { Link, useNavigate } from "@tanstack/react-router"
import { CalendarDays, Wallet } from "lucide-react"
import { type ReactNode, useId } from "react"
import type { BranchOption } from "../../lib/active-branch"
import { type DebtRow, debtConcepts, debtDue, formatClock } from "../../lib/finance-cash"
import { agendaSummary, appointmentState, attendedPercent, patientsSummary } from "../../lib/home"
import type { WorkspaceAppointment, WorkspaceCash, WorkspaceToday } from "../../lib/workspace"
import { BranchSwitcher } from "../branch-switcher"

const CARD = "enter elevated flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-4 sm:p-5"
const MORE = "inline-flex min-h-11 items-center self-start font-semibold text-primary underline underline-offset-4 sm:min-h-8"

/** La sede se elige en la tarjeta, y solo si hay más de una: «Te espera» es de toda la clínica. */
export interface BranchChoice {
  branches: BranchOption[]
  onChange: (id: string) => void
}

function CardHeader({ id, title, branch, choice }: { id: string; title: string; branch?: { id: string; name: string } | null; choice?: BranchChoice }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <h2 id={id} className="min-w-0 flex-1 text-[17px] font-bold tracking-tight">
        {title}
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

function StateText({ status }: { status: string }) {
  return (
    <span className={cn("shrink-0 text-[13px]", status === "programada" ? "font-semibold text-warning" : "text-muted-foreground")}>
      {appointmentState(status)}
    </span>
  )
}

const detailOf = (parts: Array<string | null | false>) => parts.filter(Boolean).join(" · ")

/** «Agenda de hoy» de una sede: lo que falta, con la siguiente cita marcada. */
export function TodayAgenda({ today, locale, choice }: { today: WorkspaceToday; locale: string; choice: BranchChoice }) {
  const headingId = useId()
  const navigate = useNavigate()
  const { summary, branch } = today
  const agenda = { branch: branch?.id }
  return (
    <section aria-labelledby={headingId} className={CARD}>
      <CardHeader id={headingId} title="Agenda de hoy" branch={branch} choice={choice} />
      {summary.total === 0 ? (
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
            <ul className="flex flex-col">
              {today.appointments.map((item) => (
                <li
                  key={item.id}
                  className={cn("flex items-center gap-2.5 px-2.5", item.next ? "rounded-lg bg-primary-soft py-2" : "border-b py-1.5 last:border-b-0")}
                >
                  <span className={cn("w-12 shrink-0 tabular-nums", item.next ? "font-bold" : "font-semibold")}>
                    {formatClock(item.startsAt, locale, today.timezone)}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-semibold">{item.patientName}</span>
                    <span className={cn("truncate text-[13px]", item.next ? "text-primary-soft-foreground" : "text-muted-foreground")}>
                      {detailOf([item.serviceName, item.dentistName, item.next && item.status === "programada" && "Sin confirmar"])}
                    </span>
                  </span>
                  {item.next ? <span className="shrink-0 text-[13px] font-bold text-primary-soft-foreground">Sigue</span> : <StateText status={item.status} />}
                </li>
              ))}
            </ul>
          ) : null}
          <Link to="/agenda" search={agenda} className={MORE}>
            {summary.upcoming > 1 ? `Ver las ${summary.upcoming} en la Agenda` : summary.upcoming === 1 ? "Ver la cita en la Agenda" : "Abrir la Agenda"}
          </Link>
        </>
      )}
    </section>
  )
}

function PatientRow({ item, locale, timezone, multiBranch }: { item: WorkspaceAppointment; locale: string; timezone: string; multiBranch: boolean }) {
  const attended = item.status === "atendida"
  const place = detailOf([item.serviceName, item.chairName, multiBranch && item.branchName])
  return (
    <li className={item.next ? undefined : "border-b last:border-b-0"}>
      <Link
        to="/patients/$patientId"
        params={{ patientId: item.patientId }}
        className={cn(
          buttonVariants({ variant: "ghost" }),
          "h-auto min-h-11 w-full justify-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm font-normal whitespace-normal",
          item.next && "bg-primary-soft py-2.5 hover:bg-primary-soft",
          attended && "text-muted-foreground",
        )}
      >
        <span className={cn("w-12 shrink-0 tabular-nums", item.next ? "font-bold" : attended ? "" : "font-semibold")}>
          {formatClock(item.startsAt, locale, timezone)}
        </span>
        {attended ? (
          <span className="min-w-0 flex-1 truncate">{detailOf([item.patientName, item.serviceName])}</span>
        ) : (
          <span className="flex min-w-0 flex-1 flex-col">
            <span className={cn("truncate", item.next ? "font-bold" : "font-semibold")}>{item.patientName}</span>
            <span className={cn("truncate text-[13px]", item.next ? "text-primary-soft-foreground" : "text-muted-foreground")}>
              {item.next ? detailOf([place, appointmentState(item.status)]) : place}
            </span>
          </span>
        )}
        {item.next ? (
          <span className="shrink-0 text-[13px] font-bold text-primary-soft-foreground">
            Sigue<span className="sr-only sm:not-sr-only"> · Abrir su ficha</span>
          </span>
        ) : (
          <StateText status={item.status} />
        )}
      </Link>
    </li>
  )
}

/** «Mis pacientes de hoy»: las citas de quien atiende, también las atendidas; cada fila abre la ficha. */
export function TodayPatients({ today, locale, multiBranch }: { today: WorkspaceToday; locale: string; multiBranch: boolean }) {
  const headingId = useId()
  const navigate = useNavigate()
  return (
    <section aria-labelledby={headingId} className={CARD}>
      <CardHeader id={headingId} title="Mis pacientes de hoy" />
      {today.summary.total === 0 ? (
        <EmptyState
          icon={CalendarDays}
          className="p-5"
          title="Hoy no tienes pacientes"
          description=""
          actionLabel="Ver mi agenda"
          onAction={() => void navigate({ to: "/agenda", search: {} })}
        />
      ) : (
        <>
          <p>{patientsSummary(today.summary)}</p>
          <DayProgress percent={attendedPercent(today.summary)} />
          <ul className="flex flex-col">
            {today.appointments.map((item) => (
              <PatientRow key={item.id} item={item} locale={locale} timezone={today.timezone} multiBranch={multiBranch} />
            ))}
          </ul>
          <Link to="/agenda" search={{}} className={MORE}>
            Ver mi agenda
          </Link>
        </>
      )}
    </section>
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
