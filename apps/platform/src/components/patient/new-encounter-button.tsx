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
import { ApiError, apiFetch } from "../../lib/api"
import { useMyUserId, useOrgMembers, usePermission } from "../../lib/crm"
import type { Encounter, PatientFull, PatientSummary } from "../../lib/patients"

/**
 * Nueva y reanudada abren el mismo espacio clínico. La apertura exige el
 * motivo de la visita y el profesional que atiende (por defecto quien abre);
 * la puede crear recepción o el propio médico.
 */
export function NewEncounterButton({
  patientId,
  openEncounterId,
  initialPlanItemIds,
}: {
  patientId: string
  detail?: PatientFull
  openEncounterId?: string | null
  initialPlanItemIds?: string[]
}) {
  const canWrite = usePermission("clinical.write")
  const myUserId = useMyUserId()
  const members = useOrgMembers()
  const queryClient = useQueryClient()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [dentistUserId, setDentistUserId] = useState(myUserId)
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
          planItemIds: [...new Set(initialPlanItemIds ?? [])],
        }),
      })
      await queryClient.invalidateQueries({ queryKey: ["patient-summary", patientId] })
      open(result.data.id)
    } catch (err) {
      if (err instanceof ApiError && err.shape.code === "DRAFT_OPEN") {
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
        Nueva atención
      </Button>
      <FormDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Nueva atención"
        description="Registra por qué viene el paciente y quién lo atiende. La atención se abre en borrador."
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
