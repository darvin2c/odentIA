import { DetailDrawer, scheduleToneAt, useScheduleNow, zonedDateOf } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import * as React from "react"
import { useActiveBranch } from "../../lib/active-branch"
import { type AgendaAppointment, type AgendaResources, invalidateAppointmentQueries } from "../../lib/agenda"
import { apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import type { BookingSeed } from "./booking-drawer"

// Se montan en todas las pantallas pero se abren de vez en cuando: su código baja al abrirlos.
const AppointmentDrawer = React.lazy(() => import("./appointment-drawer").then((m) => ({ default: m.AppointmentDrawer })))
const BookingDrawer = React.lazy(() => import("./booking-drawer").then((m) => ({ default: m.BookingDrawer })))

/**
 * La cita y «Nueva cita» abiertas desde cualquier pantalla, sin ir a la Agenda
 * (lienzo «Argos y citas sin cerrar», tableros 1, 2, 10 y 12): las filas de
 * Argos, las listas de Reportes e Inicio las abren al lado y quien las abrió
 * sigue a la vista. Son los mismos cajones de la Agenda, con su cuadrícula;
 * lo único que no hacen aquí es reflejar lo elegido en la rejilla grande.
 */

const OPEN_EVENT = "odentia:abrir-agenda"
/** Avisa a quien abrió la cita o la reserva de cómo quedó, para marcar su fila. */
export const APPOINTMENT_SAVED_EVENT = "odentia:cita-guardada"

type ScheduleRequest = { kind: "cita"; appointmentId: string } | { kind: "reserva"; seed: BookingSeed }

export function openAppointmentAnywhere(appointmentId: string): void {
  window.dispatchEvent(new CustomEvent<ScheduleRequest>(OPEN_EVENT, { detail: { kind: "cita", appointmentId } }))
}

export function openBookingAnywhere(seed: BookingSeed): void {
  window.dispatchEvent(new CustomEvent<ScheduleRequest>(OPEN_EVENT, { detail: { kind: "reserva", seed } }))
}

/** Cómo quedó una cita abierta o reservada desde fuera de la Agenda. */
export function useAppointmentSaved(onSaved: (appointment: AgendaAppointment) => void): void {
  const handler = React.useRef(onSaved)
  handler.current = onSaved
  React.useEffect(() => {
    const listener = (event: Event) => handler.current((event as CustomEvent<AgendaAppointment>).detail)
    window.addEventListener(APPOINTMENT_SAVED_EVENT, listener)
    return () => window.removeEventListener(APPOINTMENT_SAVED_EVENT, listener)
  }, [])
}

function announce(appointment: AgendaAppointment) {
  window.dispatchEvent(new CustomEvent<AgendaAppointment>(APPOINTMENT_SAVED_EVENT, { detail: appointment }))
}

function useResources(branchId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["agenda-resources", branchId ?? null],
    enabled,
    queryFn: () =>
      apiFetch<{ data: AgendaResources }>(`/api/agenda/resources${branchId ? `?branchId=${encodeURIComponent(branchId)}` : ""}`),
  })
}

function useToneOf(resources: AgendaResources | undefined) {
  return React.useMemo(() => {
    const index = new Map((resources?.professionals ?? []).map((item, at) => [item.id, at]))
    return (id: string) => scheduleToneAt(index.get(id) ?? 0)
  }, [resources])
}

/** Se monta una vez en el layout de la clínica, como Argos. */
export function ScheduleHost() {
  const [request, setRequest] = React.useState<ScheduleRequest | null>(null)
  const canWrite = usePermission("appointments.write")
  React.useEffect(() => {
    // Un cuadro después: quien la abre puede estar cerrando un menú o el buscador.
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<ScheduleRequest>).detail
      requestAnimationFrame(() => setRequest(detail))
    }
    window.addEventListener(OPEN_EVENT, listener)
    return () => window.removeEventListener(OPEN_EVENT, listener)
  }, [])
  if (!request) return null
  if (request.kind === "cita")
    return (
      <AppointmentHost
        key={request.appointmentId}
        appointmentId={request.appointmentId}
        canWrite={canWrite}
        onClose={() => setRequest(null)}
        onRebook={(patient) => setRequest({ kind: "reserva", seed: { patient, lockedPatient: true } })}
      />
    )
  if (!canWrite) return null
  return <BookingHost key={JSON.stringify(request.seed)} seed={request.seed} onClose={() => setRequest(null)} />
}

function AppointmentHost({
  appointmentId,
  canWrite,
  onClose,
  onRebook,
}: {
  appointmentId: string
  canWrite: boolean
  onClose: () => void
  onRebook: (patient: { id: string; name: string }) => void
}) {
  const client = useQueryClient()
  const appointment = useQuery({
    queryKey: ["agenda-appointment", appointmentId],
    queryFn: () => apiFetch<{ data: AgendaAppointment }>(`/api/appointments/${appointmentId}`),
  })
  const item = appointment.data?.data
  const resources = useResources(item?.branchId, Boolean(item))
  const toneOf = useToneOf(resources.data?.data)
  const now = useScheduleNow()
  if (appointment.isError || resources.isError) return <Waiting title="Cita" error="No se pudo abrir la cita. Ciérrala y vuelve a intentarlo." onClose={onClose} />
  if (!item || !resources.data) return <Waiting title="Cita" onClose={onClose} />
  const timeZone = resources.data.data.timeZone
  return (
    <React.Suspense fallback={<Waiting title="Cita" onClose={onClose} />}>
    <AppointmentDrawer
      appointment={item}
      canWrite={canWrite}
      timeZone={timeZone}
      today={zonedDateOf(now, timeZone)}
      now={now}
      resources={resources.data.data}
      toneOf={toneOf}
      onClose={onClose}
      onChanged={async () => {
        await invalidateAppointmentQueries(client)
        // El cambio ya se hizo: si releerla falla, solo no se marca la fila de quien la abrió.
        const fresh = await apiFetch<{ data: AgendaAppointment }>(`/api/appointments/${appointmentId}`).catch(() => null)
        if (fresh) announce(fresh.data)
      }}
      onRebook={onRebook}
    />
    </React.Suspense>
  )
}

function BookingHost({ seed, onClose }: { seed: BookingSeed; onClose: () => void }) {
  const client = useQueryClient()
  // La sede que se está mirando, la misma de la Agenda.
  const sede = useActiveBranch()
  const resources = useResources(sede.branchId, true)
  const toneOf = useToneOf(resources.data?.data)
  const now = useScheduleNow()
  if (resources.isError) return <Waiting title="Nueva cita" error="No se pudo abrir la agenda. Ciérrala y vuelve a intentarlo." onClose={onClose} />
  if (!resources.data) return <Waiting title="Nueva cita" onClose={onClose} />
  const data = resources.data.data
  return (
    <React.Suspense fallback={<Waiting title="Nueva cita" onClose={onClose} />}>
    <BookingDrawer
      seed={seed}
      branchId={data.branchId}
      timeZone={data.timeZone}
      today={zonedDateOf(now, data.timeZone)}
      now={now}
      defaultMinutes={data.defaultDurationMin}
      toneOf={toneOf}
      onPreview={noPreview}
      onClose={onClose}
      onSaved={async (created) => {
        onClose()
        await invalidateAppointmentQueries(client)
        announce(created)
      }}
    />
    </React.Suspense>
  )
}

/** El cajón mientras llega lo que necesita, o con lo que falló: el clic nunca se queda sin respuesta. */
function Waiting({ title, error, onClose }: { title: string; error?: string; onClose: () => void }) {
  return (
    <DetailDrawer open title={title} isLoading={!error} error={error ?? null} onClose={onClose}>
      {null}
    </DetailDrawer>
  )
}

/** Fuera de la Agenda no hay rejilla grande donde reflejar lo elegido. */
function noPreview() {}
