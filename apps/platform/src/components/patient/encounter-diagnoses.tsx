import { Badge, Button } from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import type { EncounterDetail } from "../../lib/patients"
import { Cie10Search } from "./cie10-search"

function formatDateTime(iso: string | null): string {
  if (!iso) return "—"
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "—"
  return date.toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" })
}

function mutationMessage(err: unknown): string {
  if (err instanceof ApiError && err.shape.message) return err.shape.message
  return err instanceof Error ? err.message : "No se pudo registrar el diagnóstico."
}

/**
 * Diagnósticos de la atención: resumen de lectura con las notas de evolución
 * del detalle y registro de diagnósticos CIE-10 en un FormDrawer hermano.
 * Toda escritura respeta el protocolo de barrera: avisa pending al padre,
 * espera `beforeWrite` (flush del borrador), escribe, espera `onChanged`
 * (refresh del encounter) y recién ahí libera y cierra.
 */
export function EncounterDiagnoses({
  patientId,
  detail,
  disabled = false,
  beforeWrite,
  onChanged,
  onPendingChange,
}: {
  patientId: string
  detail: EncounterDetail
  disabled?: boolean
  beforeWrite: () => Promise<void>
  onChanged: () => Promise<void>
  onPendingChange: (pending: boolean) => void
}): React.JSX.Element {
  const canWrite = usePermission("clinical.write")
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState("")
  const [description, setDescription] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const encounter = detail.encounter
  const finalized = encounter.status === "finalizada"
  const busy = disabled || saving
  const canSubmit = canWrite && !finalized && !busy && code.trim() !== ""
  const canOpen = canWrite && !finalized && !disabled

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const selectedCode = code.trim()
    if (!selectedCode || saving || disabled) return
    const selectedDescription = description.trim()
    onPendingChange(true)
    setSaving(true)
    setError(null)
    try {
      await beforeWrite()
      await apiFetch(`/api/patients/${patientId}/notes`, {
        method: "POST",
        body: JSON.stringify({
          note: `Dx: ${selectedDescription || selectedCode}`,
          diagnosisCode: selectedCode,
          encounterId: encounter.id,
        }),
      })
      await queryClient.invalidateQueries({ queryKey: ["timeline", patientId] })
      await onChanged()
      setCode("")
      setDescription("")
      setOpen(false)
    } catch (err) {
      setError(mutationMessage(err))
    } finally {
      setSaving(false)
      onPendingChange(false)
    }
  }

  const handleClose = () => {
    // Durante el guardado no se cierra: el error y el borrador se conservan
    // en el drawer y no se pierde lo seleccionado.
    if (saving) return
    setCode("")
    setDescription("")
    setError(null)
    setOpen(false)
  }

  return (
    <div className="flex flex-col gap-6 rounded-md bg-card p-6">
      <div className="flex flex-col gap-1.5">
        <div className="font-heading text-base font-medium">Diagnósticos ({detail.notes.length})</div>
      </div>
      <div className="flex flex-col gap-3">
        <section aria-label="Diagnósticos registrados">
          {detail.notes.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sin diagnósticos registrados.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {detail.notes.map((note) => (
                <li key={note.id} className="border-b pb-2 text-sm last:border-0">
                  <p className="whitespace-pre-wrap">{note.note}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {note.diagnosisCode ? <Badge>{note.diagnosisCode}</Badge> : null}
                    <time dateTime={note.createdAt}>{formatDateTime(note.createdAt)}</time>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      
        {canWrite && !finalized && (
          <div>
            <Button
              type="button"
              variant="outline"
              disabled={!canOpen}
              onClick={() => setOpen(true)}
            >
              Registrar diagnóstico
            </Button>
          </div>
        )}
      
        {canWrite && !finalized && (
          <FormDrawer
            open={open}
            onClose={handleClose}
            title="Registrar diagnóstico"
            description="Se registrará como nota de evolución de esta atención."
            onSubmit={(event) => void onSubmit(event)}
            isDirty={code.trim() !== ""}
            isSubmitting={saving}
            submitDisabled={!canSubmit}
            submitLabel="Registrar diagnóstico"
            error={error}
          >
            <div className="flex flex-col gap-3">
              <Cie10Search
                value={code}
                onChange={(nextCode, nextDescription) => {
                  setCode(nextCode)
                  setDescription(nextCode ? nextDescription : "")
                }}
                disabled={busy}
              />
              {description && (
                <p className="text-sm text-muted-foreground">
                  Se registrará como: Dx: {description}
                </p>
              )}
            </div>
          </FormDrawer>
        )}
      </div>
    </div>
  )
}
