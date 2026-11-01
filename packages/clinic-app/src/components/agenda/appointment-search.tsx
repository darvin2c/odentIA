import { Button, cn, Dialog, DialogContent, DialogTitle, Input, ScrollArea, Spinner } from "@odentia/ui"
import {
  dayMinutesIn,
  hourLabel,
  SCHEDULE_AGENDA_LABELS,
  StatusIcon,
  statusTextClass,
  zonedDateOf,
} from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { ArrowLeft, Plus, Search } from "lucide-react"
import * as React from "react"
import type { AgendaAppointment, AgendaSearchPerson } from "../../lib/agenda"
import { apiFetch } from "../../lib/api"
import { dayShort } from "./shared"

/** Espera breve tras la última tecla antes de consultar. */
const DEBOUNCE_MS = 250

/**
 * «¿Cuándo es mi cita?»: se escribe el nombre, el documento o el teléfono y salen
 * las personas con sus próximas citas. Elegir una abre su detalle. En escritorio
 * el campo se abre en su sitio y los resultados caen debajo, con la agenda a la
 * vista; en el teléfono, donde el teclado no deja sitio, ocupa la pantalla.
 */
export function AppointmentSearch({
  compact,
  timeZone,
  today,
  canBook,
  onOpen,
  onBook,
}: {
  /** En teléfono ocupa la pantalla al abrirse. */
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
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const close = React.useCallback((returnFocus = true) => {
    setOpen(false)
    setText("")
    setQ("")
    // El campo se va al cerrar: el foco vuelve a la lupa, que aparece después de pintar.
    if (returnFocus) window.requestAnimationFrame(() => triggerRef.current?.focus())
  }, [])

  // Tocar fuera cierra, sin robarle el foco a lo que se tocó.
  React.useEffect(() => {
    if (!open || compact) return
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false)
    }
    document.addEventListener("pointerdown", onPointer)
    return () => document.removeEventListener("pointerdown", onPointer)
  }, [open, compact, close])

  const field = (
    <div className="relative min-w-0 flex-1">
      <Search
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        autoFocus
        aria-label="Buscar la cita de un paciente"
        placeholder="Nombre, documento o teléfono"
        className={cn("pr-9 pl-9", compact ? "h-11 rounded-full bg-muted" : "h-9 rounded-full")}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation()
            close()
          }
        }}
      />
      {search.isFetching ? <Spinner className="absolute top-1/2 right-3 size-4 -translate-y-1/2" /> : null}
    </div>
  )

  const results = (
    <div className="grid gap-1">
      {search.isError ? (
        <p role="alert" className="p-2 text-sm text-destructive">
          No se pudo buscar.{" "}
          <Button variant="outline" size="sm" onClick={() => void search.refetch()}>
            Reintentar
          </Button>
        </p>
      ) : q.length < 2 ? (
        <p className="p-2 text-sm text-muted-foreground">Escribe al menos dos letras.</p>
      ) : search.isSuccess && people.length === 0 ? (
        <p className="p-2 text-sm text-muted-foreground">
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
                    close(false)
                    onOpen(appointment)
                  }}
                  className="h-auto min-h-11 w-full justify-start gap-3 rounded-lg px-2.5 text-left font-normal max-sm:flex-wrap"
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
                <span className="min-w-0 flex-1 text-muted-foreground">No tiene citas próximas</span>
                {canBook ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      close(false)
                      onBook({ id: person.patientId, name: person.patientName })
                    }}
                  >
                    <Plus aria-hidden />
                    Reservar cita
                  </Button>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )

  const trigger = (
    <Button
      ref={triggerRef}
      variant="outline"
      size="icon"
      aria-label="Buscar la cita de un paciente"
      title="Buscar la cita de un paciente"
      onClick={() => setOpen(true)}
    >
      <Search aria-hidden />
    </Button>
  )

  if (compact) {
    return (
      <>
        {trigger}
        <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
          <DialogContent
            showCloseButton={false}
            className="flex flex-col gap-2 p-0 max-sm:inset-0 max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none!"
          >
            <DialogTitle className="sr-only">Buscar una cita</DialogTitle>
            <div className="flex items-center gap-1 border-b p-2 pr-3">
              <Button variant="ghost" size="icon" aria-label="Volver a la agenda" className="size-11" onClick={() => close()}>
                <ArrowLeft aria-hidden />
              </Button>
              {field}
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="p-2 pb-4">{results}</div>
            </ScrollArea>
          </DialogContent>
        </Dialog>
      </>
    )
  }

  if (!open) return trigger
  return (
    <div ref={rootRef} className="relative flex w-72">
      {field}
      <div
        role="region"
        aria-label="Resultados de la búsqueda"
        className="absolute top-11 right-0 z-40 flex max-h-[60vh] w-[30rem] flex-col overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-lg"
      >
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-2">{results}</div>
        </ScrollArea>
      </div>
    </div>
  )
}
