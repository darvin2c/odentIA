import { Button, toast } from "@odentia/ui"
import { addDays, minutesToInstant, SubmitButton, zonedDateOf } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { useActiveBranch } from "../../lib/active-branch"
import { type AgendaAppointment, invalidateAppointmentQueries, ofProfessional } from "../../lib/agenda"
import { ApiError, apiFetch } from "../../lib/api"
import { useMyUserId, usePermission } from "../../lib/crm"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"
import { fetchOpenEncounter, type OpenEncounterRef } from "../../lib/encounters"
import type { Encounter, PatientFull } from "../../lib/patients"
import { usePersonArchived } from "../../lib/person-archived"
import { encounterDayWords, StaleEncounterDialog } from "./stale-encounter"

/** Cita de agenda desde la que se atiende: fija la sede y dice de quién es. */
export interface AttendedAppointment {
  id: string
  professionalUserId: string
  /** Para decir «Atiendes la cita de la Dra. Ana Torres» cuando atiende otro. */
  professionalName: string
  /**
   * Es una cita de otro día que quedó sin cerrar («Registrar la atención»). Si la
   * persona ya tiene otra atención en curso, no se continúa esa: lo de cada día va
   * en su propia atención (mesa del 9 nov). Se avisa y se ofrece ir a la otra.
   */
  pastVisit?: boolean
}

/** La persona ya tiene otra atención en curso: la de esta cita no se abre encima. */
class OtherEncounterOpen extends Error {
  constructor(readonly encounterId: string) {
    super("Ya tiene otra atención en curso")
  }
}

/**
 * La persona tiene abierta una atención de otro día (10 nov): no se continúa en silencio ni se
 * rechaza; en su ficha se pregunta qué hacer con ella (seguir, cerrarla o descartarla).
 */
class StaleEncounterOpen extends Error {
  constructor(readonly open: OpenEncounterRef) {
    super("Quedó abierta una atención de otro día")
  }
}

/**
 * «Atender» una cita en un clic (ADR 0032): abre su atención sin formulario, a
 * nombre de quien pulsa; el servidor marca la llegada si nadie lo hizo y el
 * motivo se escribe dentro (lo exige el cierre). Si la persona ya tiene una
 * atención en curso, se continúa esa. Cuando quien pulsa no es el profesional
 * de la cita, se le dice de quién es.
 */
export function useAttendAppointment() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const myUserId = useMyUserId()
  return useMutation({
    mutationFn: async (input: { patientId: string; appointment: AttendedAppointment }) => {
      try {
        const result = await apiFetch<{ data: Encounter }>(`/api/patients/${input.patientId}/encounters`, {
          method: "POST",
          body: JSON.stringify({ appointmentId: input.appointment.id }),
        })
        return result.data.id
      } catch (err) {
        // Ya hay una atención abierta (de la persona o de esta cita): se retoma.
        if (err instanceof ApiError && (err.shape.code === "DRAFT_OPEN" || err.shape.code === "APPOINTMENT_HAS_ENCOUNTER")) {
          const current = await fetchOpenEncounter(input.patientId)
          // La de otro día no se continúa en silencio: se pregunta en su ficha.
          if (current.data && err.shape.code === "DRAFT_OPEN" && !current.data.today)
            throw new StaleEncounterOpen(current.data)
          // Una cita pasada con otra atención abierta: no se escribe lo de ese día en la otra.
          if (current.data && err.shape.code === "DRAFT_OPEN" && input.appointment.pastVisit)
            throw new OtherEncounterOpen(current.data.id)
          if (current.data) return current.data.id
        }
        throw err
      }
    },
    onSuccess: async (encounterId, input) => {
      if (input.appointment.professionalUserId !== myUserId) {
        toast.info(`Atiendes la cita ${ofProfessional(input.appointment.professionalName, { full: true })}`)
      }
      await Promise.all([
        invalidateAppointmentQueries(queryClient),
        queryClient.invalidateQueries({ queryKey: ["open-encounter", input.patientId] }),
      ])
      void navigate({
        to: "/patients/$patientId/encounters/$encounterId",
        params: { patientId: input.patientId, encounterId },
      })
    },
    onError: (err, input) => {
      if (err instanceof StaleEncounterOpen) {
        toast.info(`Quedó abierta su atención del ${encounterDayWords(err.open.startedAt)}: elige en su ficha qué hacer con ella.`)
        void navigate({ to: "/patients/$patientId", params: { patientId: input.patientId } })
        return
      }
      if (err instanceof OtherEncounterOpen) {
        toast.error(
          "Ya tiene otra atención en curso. Termínala o anúlala y vuelve a «Registrar la atención» de esta cita: lo de cada día va en su propia atención.",
          {
            // Se queda hasta que la persona lo cierre: es una decisión, no un aviso al paso (segunda mesa).
            duration: Number.POSITIVE_INFINITY,
            closeButton: true,
            action: {
              label: "Ir a la atención en curso",
              onClick: () =>
                void navigate({
                  to: "/patients/$patientId/encounters/$encounterId",
                  params: { patientId: input.patientId, encounterId: err.encounterId },
                }),
            },
          },
        )
        return
      }
      toast.error(err instanceof ApiError ? (err.shape.message ?? "No se pudo abrir la atención.") : "No se pudo abrir la atención.")
    },
  })
}

/** La hora de la cita en la zona de la clínica, «10:00». */
function clockOf(iso: string): string {
  return new Date(iso).toLocaleTimeString(activeOrgLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: activeOrgTimeZone(),
  })
}

/** La cita de hoy que se puede atender (sigue en pie), de la que llegó primero o la más cercana a la hora. */
function useTodayAppointment(patientId: string, enabled: boolean): AgendaAppointment | null {
  const timeZone = activeOrgTimeZone()
  const today = zonedDateOf(new Date().toISOString(), timeZone)
  const query = useQuery({
    queryKey: ["patient-appointments", patientId, "hoy", today],
    enabled,
    queryFn: () => {
      const params = new URLSearchParams({
        patientId,
        from: minutesToInstant(today, 0, timeZone),
        to: minutesToInstant(addDays(today, 1), 0, timeZone),
      })
      return apiFetch<{ data: AgendaAppointment[] }>(`/api/appointments?${params}`)
    },
    retry: false,
  })
  const now = Date.now()
  // Una cita para lo que ya se terminó no se ofrece atender, salvo que haya llegado (QA del 10 nov, M1).
  const attendable = (query.data?.data ?? []).filter(
    (item) =>
      item.visit === "llego" ||
      ((item.visit === "por_confirmar" || item.visit === "confirmada" || item.visit === "sin_cerrar") && !item.doneFor),
  )
  return (
    attendable.find((item) => item.visit === "llego") ??
    [...attendable].sort((a, b) => Math.abs(Date.parse(a.startsAt) - now) - Math.abs(Date.parse(b.startsAt) - now))[0] ??
    null
  )
}

/**
 * El botón de atender, el mismo en la cabecera de la página (desde cualquier
 * pestaña) y en los vacíos que lo piden (ADR 0035). Un solo nombre por caso:
 * con una atención en curso, «Continuar la atención» (lo escrito no se
 * pierde); con una cita hoy, «Atender (10:00)»; sin cita, «Atender». Siempre un
 * clic (ADR 0098): abre la atención a nombre de quien pulsa y en la sede
 * activa; el motivo se dicta, si Clío está encendida, o se escribe dentro, en
 * «Consulta» (lo exige el cierre). Solo se ofrece a quien escribe en la historia
 * clínica.
 * La cita se marca atendida al cerrar.
 */
export function NewEncounterButton({
  patientId,
  openEncounterId,
  initialPlanItemIds,
  appointment,
  variant = "default",
  size = "default",
  openFromSearch = false,
}: {
  patientId: string
  detail?: PatientFull
  openEncounterId?: string | null
  initialPlanItemIds?: string[]
  appointment?: AttendedAppointment
  /** En un vacío («Todavía no tiene atenciones») va como acción secundaria. */
  variant?: "default" | "outline"
  /**
   * El de la cabecera: con `?atender=true` (viene de «Atender ahora» al
   * registrarlo) abre la atención una vez y quita el parámetro.
   */
  openFromSearch?: boolean
  size?: "default" | "sm"
}) {
  // Una ficha archivada se lee, pero no se atiende: se recupera primero.
  const archived = usePersonArchived()
  const canWrite = usePermission("clinical.write") && !archived
  const canSeeAgenda = usePermission("appointments.read")
  const sede = useActiveBranch()
  const queryClient = useQueryClient()
  const attend = useAttendAppointment()
  const [saving, setSaving] = useState(false)
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as { atender?: boolean }
  const openQuery = useQuery({
    queryKey: ["open-encounter", patientId],
    queryFn: () => fetchOpenEncounter(patientId),
    enabled: canWrite && !appointment,
  })
  const openRef = openQuery.data?.data ?? null
  // La de otro día no se continúa con un clic: se pregunta qué hacer con ella (10 nov).
  const staleRef = openRef && !openRef.today ? openRef : null
  const [asking, setAsking] = useState<OpenEncounterRef | null>(null)
  const inProgressId = staleRef ? null : (openEncounterId ?? openRef?.id ?? null)
  // En la página de la persona: si hoy tiene cita, atender es un clic y se une a ella.
  const todayVisit = useTodayAppointment(patientId, canWrite && canSeeAgenda && !appointment && !inProgressId)
  const visit: AttendedAppointment | null =
    appointment ?? (todayVisit ? { id: todayVisit.id, professionalUserId: todayVisit.professionalUserId, professionalName: todayVisit.professionalName } : null)
  const open = (id: string) =>
    void navigate({
      to: "/patients/$patientId/encounters/$encounterId",
      params: { patientId, encounterId: id },
    })
  // Sin cita: a nombre de quien pulsa (el servidor lo pone por defecto) y en la
  // sede activa, la misma de la Agenda, para que lo que se cobre llegue a su caja.
  const start = async () => {
    if (saving) return
    setSaving(true)
    try {
      const result = await apiFetch<{ data: Encounter }>(`/api/patients/${patientId}/encounters`, {
        method: "POST",
        body: JSON.stringify({
          ...(sede.effectiveId ? { branchId: sede.effectiveId } : {}),
          planItemIds: [...new Set(initialPlanItemIds ?? [])],
        }),
      })
      await queryClient.invalidateQueries({ queryKey: ["patient-summary", patientId] })
      await queryClient.invalidateQueries({ queryKey: ["open-encounter", patientId] })
      open(result.data.id)
    } catch (err) {
      // Ya hay una atención abierta: se retoma la de hoy; la de otro día, se pregunta.
      if (err instanceof ApiError && err.shape.code === "DRAFT_OPEN") {
        try {
          const current = await fetchOpenEncounter(patientId)
          if (current.data && !current.data.today) {
            setAsking(current.data)
            setSaving(false)
            return
          }
          if (current.data) {
            open(current.data.id)
            return
          }
        } catch {
          /* Conserva el error original si no se puede recuperar el borrador. */
        }
      }
      toast.error(
        err instanceof ApiError
          ? (err.shape.message ?? "No se pudo abrir la atención.")
          : "No se pudo abrir la atención.",
      )
      setSaving(false)
    }
  }
  const wantsToAttend = openFromSearch && search.atender === true
  const startOnArrival = useRef(start)
  startOnArrival.current = start
  // biome-ignore lint/correctness/useExhaustiveDependencies: `open` cambia en cada render; corre una vez por llegada.
  useEffect(() => {
    if (!wantsToAttend || !canWrite || openQuery.isPending) return
    if (staleRef) setAsking(staleRef)
    else if (inProgressId) open(inProgressId)
    else if (!visit) void startOnArrival.current()
    void navigate({ to: ".", search: (previous: Record<string, unknown>) => ({ ...previous, atender: undefined }), replace: true } as never)
  }, [wantsToAttend, canWrite, openQuery.isPending, inProgressId, visit, navigate])
  if (!canWrite) return null
  const staleDialog = (
    <StaleEncounterDialog
      patientId={patientId}
      open={asking}
      onClose={() => setAsking(null)}
      onDiscarded={async () => {
        // Descartada la vacía, se sigue con lo que se quería: atender hoy.
        if (visit) attend.mutate({ patientId, appointment: visit })
        else await start()
      }}
    />
  )
  if (!appointment && staleRef) {
    return (
      <>
        <Button variant={variant} size={size} onClick={() => setAsking(staleRef)}>
          Atender
        </Button>
        {staleDialog}
      </>
    )
  }
  if (!appointment && inProgressId) {
    return (
      <Button variant={variant} size={size} onClick={() => open(inProgressId)}>
        Continuar la atención
      </Button>
    )
  }
  if (visit) {
    // La hora de la cita de hoy dice cuál se atiende: «Atender (10:00)».
    const at = !appointment && todayVisit ? clockOf(todayVisit.startsAt) : null
    return (
      <>
        <SubmitButton
          variant={variant}
          size={size}
          pending={attend.isPending}
          onClick={() => attend.mutate({ patientId, appointment: visit })}
        >
          {at ? `Atender (${at})` : "Atender"}
        </SubmitButton>
        {staleDialog}
      </>
    )
  }
  return (
    <>
      <SubmitButton variant={variant} size={size} pending={saving} onClick={() => void start()}>
        Atender
      </SubmitButton>
      {staleDialog}
    </>
  )
}
