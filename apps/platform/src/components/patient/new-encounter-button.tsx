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
import { useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { useActiveBranch } from "../../lib/active-branch"
import { ApiError, apiFetch } from "../../lib/api"
import { useMyUserId, useOrgMembers, usePermission } from "../../lib/crm"
import type { Encounter, PatientFull, PatientSummary } from "../../lib/patients"

/** Cita de agenda desde la que se atiende: fija sede y profesional. */
export interface AttendedAppointment {
  id: string
  dentistUserId: string
  reason: string | null
  serviceName: string | null
}

/**
 * Nueva y reanudada abren el mismo espacio clínico. La apertura exige el
 * motivo de la visita y el profesional que atiende (por defecto quien abre);
 * la puede crear recepción o el propio médico. Desde la agenda («Atender»)
 * la atención queda vinculada a la cita, que se marca atendida al cerrar.
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
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [reason, setReason] = useState(appointment?.reason ?? "")
  const [dentistUserId, setDentistUserId] = useState(appointment?.dentistUserId ?? myUserId)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()
  const open = (id: string) =>
    void navigate({
      to: "/patients/$patientId/encounters/$encounterId",
      params: { patientId, encounterId: id },
    })
  const start = async () => {
    if (saving || !reason.trim()) return
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
      open(result.data.id)
    } catch (err) {
      // Ya hay una atención abierta (del paciente o de esta cita): se retoma.
      if (
        err instanceof ApiError &&
        (err.shape.code === "DRAFT_OPEN" || err.shape.code === "APPOINTMENT_HAS_ENCOUNTER")
      ) {
        try {
          const summary = await apiFetch<{ data: PatientSummary }>(
            `/api/patients/${patientId}/summary`,
          )
          if (summary.data.openEncounterId) {
            open(summary.data.openEncounterId)
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
  if (openEncounterId) {
    return <Button onClick={() => open(openEncounterId)}>Reanudar atención</Button>
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
            : "Registra por qué viene el paciente y quién lo atiende. La atención se abre en curso."
        }
        onSubmit={(event) => {
          event.preventDefault()
          void start()
        }}
        isSubmitting={saving}
        isDirty={reason.trim().length > 0}
        error={error}
        submitLabel="Abrir atención"
        submitDisabled={!reason.trim() || saving}
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
            items={Object.fromEntries(members.map((m) => [m.userId, m.user.name]))}
            onValueChange={(value) => {
              if (value) setDentistUserId(value)
            }}
          >
            <SelectTrigger id="new-encounter-dentist" aria-label="Profesional que atiende">
              <SelectValue placeholder="Selecciona el profesional…" />
            </SelectTrigger>
            <SelectContent>
              {members.map((m) => (
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
