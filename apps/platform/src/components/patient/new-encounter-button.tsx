import {
  Button,
  Field,
  FieldLabel,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  toast,
} from "@odentia/ui"
import { addDays, FormDrawer, minutesToInstant, SubmitButton, zonedDateOf } from "@odentia/ui-patterns"
import { canAccess } from "@odentia/auth/permissions"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { useActiveBranch } from "../../lib/active-branch"
import { type AgendaAppointment, invalidateAppointmentQueries, professionalSaid } from "../../lib/agenda"
import { ApiError, apiFetch } from "../../lib/api"
import { useMyUserId, useOrgMembers, usePermission } from "../../lib/crm"
import { activeOrgTimeZone } from "../../lib/locale"
import type { Encounter, PatientFull } from "../../lib/patients"

/** Cita de agenda desde la que se atiende: fija la sede y dice de quién es. */
export interface AttendedAppointment {
  id: string
  dentistUserId: string
  /** Para decir «Atiendes la cita de la Dra. Ana Torres» cuando atiende otro. */
  dentistName: string
}

/** La atención en curso de un paciente, sin nada de su historia: cuál es y quién la lleva. */
interface OpenEncounterRef {
  id: string
  dentistUserId: string
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
          const current = await apiFetch<{ data: OpenEncounterRef | null }>(`/api/patients/${input.patientId}/open-encounter`)
          if (current.data) return current.data.id
        }
        throw err
      }
    },
    onSuccess: async (encounterId, input) => {
      if (input.appointment.dentistUserId !== myUserId) {
        toast.info(`Atiendes la cita de ${professionalSaid(input.appointment.dentistName, { full: true })}`)
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
    onError: (err) => {
      toast.error(err instanceof ApiError ? (err.shape.message ?? "No se pudo abrir la atención.") : "No se pudo abrir la atención.")
    },
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
  const attendable = (query.data?.data ?? []).filter(
    (item) => item.visit === "por_confirmar" || item.visit === "confirmada" || item.visit === "llego",
  )
  return (
    attendable.find((item) => item.visit === "llego") ??
    [...attendable].sort((a, b) => Math.abs(Date.parse(a.startsAt) - now) - Math.abs(Date.parse(b.startsAt) - now))[0] ??
    null
  )
}

/**
 * Nueva y en curso abren el mismo espacio clínico. Con una atención en curso
 * el botón la continúa («Continuar la atención»), así lo escrito no se pierde.
 * Con una cita hoy (o desde la cita) es «Atender»: un clic, sin formulario.
 * Sin cita, «Nueva atención» pide el motivo de la visita y el profesional que
 * atiende (por defecto quien pulsa). Solo se ofrece a quien escribe en la
 * historia clínica. La cita se marca atendida al cerrar.
 */
export function NewEncounterButton({
  patientId,
  openEncounterId,
  initialPlanItemIds,
  appointment,
}: {
  patientId: string
  detail?: PatientFull
  openEncounterId?: string | null
  initialPlanItemIds?: string[]
  appointment?: AttendedAppointment
}) {
  const canWrite = usePermission("clinical.write")
  const canSeeAgenda = usePermission("appointments.read")
  const myUserId = useMyUserId()
  const members = useOrgMembers()
  const sede = useActiveBranch()
  const queryClient = useQueryClient()
  const attend = useAttendAppointment()
  // Solo profesionales clínicos: nunca caja ni recepción (el servidor lo exige igual).
  const professionals = members.filter((m) => canAccess(m.role, "clinical.write"))
  const eligible = (userId: string | undefined) =>
    Boolean(userId) && professionals.some((m) => m.userId === userId)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [dentistUserId, setDentistUserId] = useState(eligible(myUserId) ? myUserId : "")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()
  const openQuery = useQuery({
    queryKey: ["open-encounter", patientId],
    queryFn: () =>
      apiFetch<{ data: OpenEncounterRef | null }>(`/api/patients/${patientId}/open-encounter`),
    enabled: canWrite && !appointment && !openEncounterId,
  })
  const inProgressId = openEncounterId ?? openQuery.data?.data?.id ?? null
  // En la página de la persona: si hoy tiene cita, atender es un clic y se une a ella.
  const todayVisit = useTodayAppointment(patientId, canWrite && canSeeAgenda && !appointment && !inProgressId)
  const visit: AttendedAppointment | null =
    appointment ?? (todayVisit ? { id: todayVisit.id, dentistUserId: todayVisit.dentistUserId, dentistName: todayVisit.dentistName } : null)
  const open = (id: string) =>
    void navigate({
      to: "/patients/$patientId/encounters/$encounterId",
      params: { patientId, encounterId: id },
    })
  const start = async () => {
    if (saving || !reason.trim() || !dentistUserId) return
    setSaving(true)
    setError(null)
    try {
      const result = await apiFetch<{ data: Encounter }>(`/api/patients/${patientId}/encounters`, {
        method: "POST",
        body: JSON.stringify({
          reason: reason.trim(),
          dentistUserId,
          // Sin cita, la sede en la que se trabaja: así lo que quede por cobrar
          // aparece en la caja de esa sede.
          ...(sede.branchId ? { branchId: sede.branchId } : {}),
          planItemIds: [...new Set(initialPlanItemIds ?? [])],
        }),
      })
      await queryClient.invalidateQueries({ queryKey: ["patient-summary", patientId] })
      await queryClient.invalidateQueries({ queryKey: ["open-encounter", patientId] })
      open(result.data.id)
    } catch (err) {
      // Ya hay una atención abierta: se retoma.
      if (err instanceof ApiError && err.shape.code === "DRAFT_OPEN") {
        try {
          const current = await apiFetch<{ data: OpenEncounterRef | null }>(
            `/api/patients/${patientId}/open-encounter`,
          )
          if (current.data) {
            open(current.data.id)
            return
          }
        } catch {
          /* Conserva el error original si no se puede recuperar el borrador. */
        }
      }
      setError(
        err instanceof ApiError
          ? (err.shape.message ?? "No se pudo abrir la atención.")
          : "No se pudo abrir la atención.",
      )
      setSaving(false)
    }
  }
  if (!canWrite) return null
  if (!appointment && inProgressId) {
    return <Button onClick={() => open(inProgressId)}>Continuar la atención</Button>
  }
  if (visit) {
    return (
      <SubmitButton pending={attend.isPending} onClick={() => attend.mutate({ patientId, appointment: visit })}>
        Atender
      </SubmitButton>
    )
  }
  return (
    <>
      <Button
        onClick={() => {
          setError(null)
          setDrawerOpen(true)
        }}
      >
        Nueva atención
      </Button>
      <FormDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Nueva atención"
        description="Registra por qué viene el paciente y quién lo atiende. La atención se abre en curso."
        onSubmit={(event) => {
          event.preventDefault()
          void start()
        }}
        isSubmitting={saving}
        isDirty={reason.trim().length > 0}
        error={error}
        submitLabel="Abrir atención"
        submitDisabled={!reason.trim() || !dentistUserId || saving}
      >
        <Field>
          <FieldLabel htmlFor="new-encounter-reason">Motivo de la visita</FieldLabel>
          <Textarea
            id="new-encounter-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Ej.: dolor en muela inferior derecha desde anoche"
            rows={3}
            maxLength={2000}
            required
            autoFocus
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="new-encounter-dentist">Profesional que atiende</FieldLabel>
          <Select
            value={dentistUserId}
            items={Object.fromEntries(professionals.map((m) => [m.userId, m.user.name]))}
            onValueChange={(value) => {
              if (value) setDentistUserId(value)
            }}
          >
            <SelectTrigger id="new-encounter-dentist" aria-label="Profesional que atiende">
              <SelectValue placeholder="Selecciona el profesional…" />
            </SelectTrigger>
            <SelectContent>
              {professionals.map((m) => (
                <SelectItem key={m.userId} value={m.userId}>
                  {m.user.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </FormDrawer>
    </>
  )
}
