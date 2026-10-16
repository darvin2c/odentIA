import { canAccess } from "@odentia/auth/permissions"
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
} from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { useActiveBranch } from "../../lib/active-branch"
import { ApiError, apiFetch } from "../../lib/api"
import { useMyUserId, useOrgMembers, usePermission } from "../../lib/crm"
import type { Encounter, PatientFull } from "../../lib/patients"

/** Cita de agenda desde la que se atiende: fija la sede. */
export interface AttendedAppointment {
  id: string
  dentistUserId: string
  reason: string | null
  serviceName: string | null
}

/** La atención en curso de un paciente, sin nada de su historia: cuál es y quién la lleva. */
interface OpenEncounterRef {
  id: string
  dentistUserId: string
}

/**
 * Nueva y en curso abren el mismo espacio clínico. Con una atención en curso
 * el botón la continúa («Continuar la atención»), así lo escrito no se pierde.
 * La apertura exige el motivo de la visita y el profesional que atiende: por
 * defecto quien pulsa, y solo se ofrece a quien escribe en la historia clínica.
 * Sin cita, el servidor la une a la cita de hoy que siga en pie; desde la
 * agenda («Atender») queda unida a esa cita, y un borrador del mismo día sin
 * cita se une a ella. La cita se marca atendida al cerrar.
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
  const myUserId = useMyUserId()
  const members = useOrgMembers()
  const sede = useActiveBranch()
  const queryClient = useQueryClient()
  // Solo profesionales clínicos: nunca caja ni recepción (el servidor lo exige igual).
  const professionals = members.filter((m) => canAccess(m.role, "clinical.write"))
  const eligible = (userId: string | undefined) =>
    Boolean(userId) && professionals.some((m) => m.userId === userId)
  const defaultDentist = eligible(myUserId)
    ? myUserId
    : eligible(appointment?.dentistUserId)
      ? (appointment?.dentistUserId ?? "")
      : ""
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [reason, setReason] = useState(appointment?.reason ?? "")
  const [dentistUserId, setDentistUserId] = useState(defaultDentist)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()
  // Desde la agenda, el servidor continúa el borrador si es de esta visita.
  const openQuery = useQuery({
    queryKey: ["open-encounter", patientId],
    queryFn: () =>
      apiFetch<{ data: OpenEncounterRef | null }>(`/api/patients/${patientId}/open-encounter`),
    enabled: canWrite && !appointment && !openEncounterId,
  })
  const inProgressId = openEncounterId ?? openQuery.data?.data?.id ?? null
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
          // Con cita manda su sede; sin cita, la sede en la que se trabaja:
          // así lo que quede por cobrar aparece en la caja de esa sede.
          ...(appointment
            ? { appointmentId: appointment.id }
            : sede.branchId
              ? { branchId: sede.branchId }
              : {}),
          planItemIds: [...new Set(initialPlanItemIds ?? [])],
        }),
      })
      await queryClient.invalidateQueries({ queryKey: ["patient-summary", patientId] })
      await queryClient.invalidateQueries({ queryKey: ["open-encounter", patientId] })
      open(result.data.id)
    } catch (err) {
      // Ya hay una atención abierta (del paciente o de esta cita): se retoma.
      if (
        err instanceof ApiError &&
        (err.shape.code === "DRAFT_OPEN" || err.shape.code === "APPOINTMENT_HAS_ENCOUNTER")
      ) {
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
  return (
    <>
      <Button
        onClick={() => {
          setError(null)
          setDrawerOpen(true)
        }}
      >
        {appointment ? "Atender" : "Nueva atención"}
      </Button>
      <FormDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={appointment ? "Atender la cita" : "Nueva atención"}
        description={
          appointment
            ? `Confirma el motivo con el paciente${appointment.serviceName ? ` (cita para ${appointment.serviceName})` : ""}. La atención se abre en curso y la cita se marca atendida al cerrarla.`
            : "Registra por qué viene el paciente y quién lo atiende. La atención se abre en curso; si tiene una cita hoy, se une a ella y la cita se marca atendida al cerrarla."
        }
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
