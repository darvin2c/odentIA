import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Spinner,
} from "@odentia/ui"
import {
  dayMinutesIn,
  hourLabel,
  SCHEDULE_AGENDA_LABELS,
  StatusIcon,
  statusTextClass,
  zonedDateOf,
} from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { Plus, Search } from "lucide-react"
import * as React from "react"
import type { AgendaAppointment, AgendaSearchPerson } from "../../lib/agenda"
import { apiFetch } from "../../lib/api"
import { dayShort } from "./shared"

/** Espera breve tras la última tecla antes de consultar. */
const DEBOUNCE_MS = 250

/**
 * «¿Cuándo es mi cita?»: se escribe el nombre, el documento o el teléfono y
 * salen las personas con sus próximas citas. Elegir una abre su detalle.
 */
export function AppointmentSearch({
  compact,
  timeZone,
  today,
  canBook,
  onOpen,
  onBook,
}: {
  /** En teléfono el campo es solo la lupa. */
  compact: boolean
  timeZone: string
  today: string
  canBook: boolean
  onOpen: (appointment: AgendaAppointment) => void
  onBook: (patient: { id: string; name: string }) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [text, setText] = React.useState("")
  const [q, setQ] = React.useState("")
  React.useEffect(() => {
    const timer = window.setTimeout(() => setQ(text.trim()), DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [text])

  const search = useQuery({
    queryKey: ["agenda-search", q],
    enabled: open && q.length >= 2,
    queryFn: () =>
      apiFetch<{ data: AgendaSearchPerson[] }>(`/api/agenda/search?q=${encodeURIComponent(q)}`),
    placeholderData: (previous) => previous,
  })
  const people = q.length >= 2 ? (search.data?.data ?? []) : []
  const close = () => {
    setOpen(false)
    setText("")
    setQ("")
  }

  return (
    <>
      {compact ? (
        <Button
          variant="outline"
          size="icon"
          aria-label="Buscar la cita de un paciente"
          onClick={() => setOpen(true)}
        >
          <Search aria-hidden />
        </Button>
      ) : (
        <Button
          variant="outline"
          className="w-62 justify-start gap-2 font-normal text-muted-foreground"
          onClick={() => setOpen(true)}
        >
          <Search aria-hidden />
          Buscar la cita de un paciente
        </Button>
      )}
      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        <DialogContent scrollable contentClassName="gap-3" className="top-[12vh] max-h-[76vh] translate-y-0 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Buscar una cita</DialogTitle>
            <DialogDescription>Por nombre, documento o teléfono del paciente.</DialogDescription>
          </DialogHeader>
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              autoFocus
              aria-label="Paciente"
              placeholder="Nombre, documento o teléfono"
              className="h-11 pl-9"
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
            {search.isFetching ? (
              <Spinner className="absolute top-1/2 right-3 size-4 -translate-y-1/2" />
            ) : null}
          </div>

          {search.isError ? (
            <p role="alert" className="text-sm text-destructive">
              No se pudo buscar.{" "}
              <Button variant="outline" size="sm" onClick={() => void search.refetch()}>
                Reintentar
              </Button>
            </p>
          ) : q.length < 2 ? (
            <p className="text-sm text-muted-foreground">Escribe al menos dos letras.</p>
          ) : search.isSuccess && people.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nadie coincide con «{q}». Revisa cómo está escrito o búscalo en Pacientes.
            </p>
          ) : null}

          <ul className="grid gap-1 divide-y">
            {people.map((person) => (
              <li key={person.patientId} className="grid gap-0.5 pt-2 first:pt-0">
                <span className="px-2.5 text-sm font-bold">{person.patientName}</span>
                {person.appointments.map((appointment) => {
                  const date = zonedDateOf(appointment.startsAt, timeZone)
                  const what = appointment.serviceName ?? appointment.reason ?? "Cita"
                  return (
                    <Button
                      key={appointment.id}
                      variant="ghost"
                      onClick={() => {
                        close()
                        onOpen(appointment)
                      }}
                      className="h-auto min-h-11 w-full justify-start gap-3 rounded-lg px-2.5 text-left font-normal"
                    >
                      <span className="flex w-30 shrink-0 items-baseline gap-2">
                        <span className="w-17 text-[13px] font-semibold first-letter:uppercase">
                          {date === today ? "Hoy" : dayShort(date)}
                        </span>
                        <span className="text-[15px] font-bold tabular-nums">
                          {hourLabel(dayMinutesIn(appointment.startsAt, timeZone))}
                        </span>
                      </span>
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">
                        {what} con {appointment.professionalName}
                      </span>
                      <span
                        className={`flex shrink-0 items-center gap-1 text-xs font-bold ${statusTextClass(appointment.status)}`}
                      >
                        <StatusIcon status={appointment.status} className="size-3.5" />
                        {SCHEDULE_AGENDA_LABELS[appointment.status]}
                      </span>
                    </Button>
                  )
                })}
                {person.appointments.length === 0 ? (
                  <div className="flex min-h-12 items-center gap-3 px-2.5">
                    <span className="min-w-0 flex-1 text-muted-foreground">
                      No tiene citas próximas
                    </span>
                    {canBook ? (
                      <Button
                        variant="secondary"
                        onClick={() => {
                          close()
                          onBook({ id: person.patientId, name: person.patientName })
                        }}
                      >
                        <Plus aria-hidden />
                        Agendar
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  )
}
