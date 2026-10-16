import { Badge, Button } from "@odentia/ui"
import { ConfirmDialog, SubmitButton } from "@odentia/ui-patterns"
import { useState } from "react"
import { longDay, timeLabel } from "./week-slots"

/** Lo que el bloque necesita de la cita: lo mismo en «Su enlace» y en el portal. */
export interface AppointmentBlockData {
  startsAt: string
  endsAt: string
  timeZone: string
  branchName: string
  branchAddress?: string | null
  dentistName: string
  serviceName: string | null
  confirmed: boolean
}

/**
 * Identificador del evento (UID, RFC 5545): el mismo en cada descarga de la
 * misma cita, para que al cambiarla de horario el calendario actualice su
 * evento en vez de añadir otro. Sale de una huella: no lleva el enlace ni
 * ningún dato de la persona, porque los calendarios se sincronizan con terceros.
 */
async function calendarUid(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`odentia:cita:${key}`))
  const hex = Array.from(new Uint8Array(digest).subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `${hex}@odentia`
}

/** La cita como archivo de calendario (iCalendar, RFC 5545). */
function calendarFile(clinicName: string, appointment: AppointmentBlockData, uid: string): string {
  const stamp = (instant: string | Date) => new Date(instant).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")
  const text = (value: string) => value.replace(/\\/g, "\\\\").replace(/([,;])/g, "\\$1").replace(/\r?\n/g, "\\n")
  const where = [`Sede ${appointment.branchName}`, appointment.branchAddress].filter(Boolean).join(", ")
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//odentIA//Su enlace//ES",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(appointment.startsAt)}`,
    `DTEND:${stamp(appointment.endsAt)}`,
    // Sin el servicio: un título de calendario no lleva datos clínicos.
    `SUMMARY:${text(`Cita en ${clinicName}`)}`,
    `LOCATION:${text(where)}`,
    `DESCRIPTION:${text(`Con ${appointment.dentistName}`)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n")
}

/**
 * «Tu cita»: día y hora, dónde y con quién; confirmar, cambiar, cancelar y
 * añadir al calendario. El mismo bloque en «Su enlace» y en el portal.
 */
export function AppointmentBlock({
  title,
  clinicName,
  appointment,
  calendarKey,
  canChange,
  canConfirm,
  confirming,
  cancelling,
  error,
  onChange,
  onCancel,
  onConfirm,
}: {
  title: string
  clinicName: string
  appointment: AppointmentBlockData
  /** Lo que identifica a la cita para el UID del calendario. */
  calendarKey: string
  canChange: boolean
  canConfirm: boolean
  confirming: boolean
  cancelling: boolean
  error: string | null
  onChange: () => void
  onCancel: () => void
  onConfirm: () => void
}) {
  const [asking, setAsking] = useState(false)
  const when = `${longDay(appointment.startsAt, appointment.timeZone)} · ${timeLabel(appointment.startsAt, appointment.timeZone)}`
  const addToCalendar = async () => {
    const file = calendarFile(clinicName, appointment, await calendarUid(calendarKey))
    const url = URL.createObjectURL(new Blob([file], { type: "text/calendar;charset=utf-8" }))
    const link = document.createElement("a")
    link.href = url
    link.download = "mi-cita.ics"
    link.click()
    URL.revokeObjectURL(url)
  }
  return (
    <section aria-label={title} className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">{title}</h2>
        <Badge variant={appointment.confirmed ? "default" : "secondary"}>{appointment.confirmed ? "Confirmada" : "Por confirmar"}</Badge>
      </div>
      <div className="flex flex-col gap-0.5 text-sm">
        <p className="text-base font-semibold">{when}</p>
        <p>{[appointment.serviceName, `Sede ${appointment.branchName}`, appointment.dentistName].filter(Boolean).join(" · ")}</p>
        {appointment.branchAddress ? <p className="text-muted-foreground">{appointment.branchAddress}</p> : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {canConfirm ? (
          <SubmitButton type="button" className="min-h-11" pending={confirming} onClick={onConfirm}>
            Confirmar
          </SubmitButton>
        ) : null}
        {canChange ? (
          <>
            <Button type="button" variant="outline" className="min-h-11" onClick={onChange}>
              Cambiar
            </Button>
            <Button type="button" variant="outline" className="min-h-11" onClick={() => setAsking(true)}>
              Cancelar
            </Button>
          </>
        ) : null}
        <Button type="button" variant="ghost" className="min-h-11" onClick={() => void addToCalendar()}>
          Añadir al calendario
        </Button>
      </div>
      <ConfirmDialog
        open={asking}
        title="¿Cancelar tu cita?"
        description={`${when}. El horario queda libre para otra persona.`}
        confirmLabel="Sí, cancelar"
        cancelLabel="No, conservarla"
        variant="destructive"
        pending={cancelling}
        onClose={() => {
          if (!cancelling) setAsking(false)
        }}
        onConfirm={() => {
          onCancel()
          setAsking(false)
        }}
      />
    </section>
  )
}
