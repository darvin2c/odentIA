import { Badge, Button } from "@odentia/ui"
import { ConfirmDialog, SubmitButton } from "@odentia/ui-patterns"
import { MapPin } from "lucide-react"
import { useState } from "react"
import { longDay, timeLabel } from "./week-slots"

/** Lo que el bloque necesita de la cita: lo mismo en «Su enlace» y en el portal. */
export interface AppointmentBlockData {
  startsAt: string
  endsAt: string
  timeZone: string
  branchName: string
  branchAddress?: string | null
  /** «Cómo llegar» a la sede (Google Maps), si tiene dirección. */
  branchDirectionsUrl?: string | null
  professionalName: string
  serviceName: string | null
  confirmed: boolean
}

/**
 * «Tu cita»: día y hora, dónde y con quién; confirmar, cambiar, cancelar,
 * cómo llegar y añadir al calendario. El mismo bloque en «Su enlace» y en el portal.
 */
export function AppointmentBlock({
  title,
  appointment,
  onAddToCalendar,
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
  appointment: AppointmentBlockData
  /**
   * Descarga el `.ics` de la cita, que arma el servidor (issue 46): el mismo
   * evento que el del correo, así el calendario no la duplica.
   */
  onAddToCalendar: () => Promise<void>
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
  const [saving, setSaving] = useState(false)
  const [calendarError, setCalendarError] = useState(false)
  const addToCalendar = async () => {
    setSaving(true)
    setCalendarError(false)
    try {
      await onAddToCalendar()
    } catch {
      setCalendarError(true)
    } finally {
      setSaving(false)
    }
  }
  return (
    <section aria-label={title} className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">{title}</h2>
        <Badge variant={appointment.confirmed ? "default" : "secondary"}>{appointment.confirmed ? "Confirmada" : "Por confirmar"}</Badge>
      </div>
      <div className="flex flex-col gap-0.5 text-sm">
        <p className="text-base font-semibold">{when}</p>
        <p>{[appointment.serviceName, appointment.branchName, appointment.professionalName].filter(Boolean).join(" · ")}</p>
        {appointment.branchAddress ? <p className="text-muted-foreground">{appointment.branchAddress}</p> : null}
      </div>
      {error || calendarError ? (
        <p role="alert" className="text-sm text-destructive">
          {error ?? "No pudimos descargar tu cita. Intenta de nuevo."}
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
        {appointment.branchDirectionsUrl ? (
          <Button
            variant="outline"
            className="min-h-11"
            render={<a href={appointment.branchDirectionsUrl} target="_blank" rel="noopener noreferrer" />}
          >
            <MapPin aria-hidden />
            Cómo llegar
          </Button>
        ) : null}
        <SubmitButton type="button" variant="ghost" className="min-h-11" pending={saving} onClick={() => void addToCalendar()}>
          Añadir al calendario
        </SubmitButton>
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
