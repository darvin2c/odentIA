import { isValidTooth } from "@odentia/clinical"
import { Badge, Button, Field, FieldLabel, Input } from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { DIAGNOSIS_TYPE_LABELS, type EncounterDetail } from "../../lib/patients"
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
  // Presuntivo por defecto: afirmar certeza es una decisión explícita del clínico.
  const [diagnosisType, setDiagnosisType] = useState("presuntivo")
  const [tooth, setTooth] = useState("")
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
    const toothNumber = tooth.trim() === "" ? null : Number(tooth)
    if (toothNumber !== null && !isValidTooth(toothNumber)) {
      setError("Indica una pieza FDI válida (11–48 o 51–85) o deja el campo vacío.")
      return
    }
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
          diagnosisType,
          ...(toothNumber !== null ? { toothNumber } : {}),
          encounterId: encounter.id,
        }),
      })
      await queryClient.invalidateQueries({ queryKey: ["timeline", patientId] })
      await onChanged()
      setCode("")
      setDescription("")
      setDiagnosisType("presuntivo")
      setTooth("")
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
    setDiagnosisType("presuntivo")
    setTooth("")
    setError(null)
    setOpen(false)
  }

  return (
    <div className="flex flex-col gap-6 elevated rounded-xl border bg-card p-6">
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
                    {note.diagnosisType ? (
                      <Badge variant={note.diagnosisType === "definitivo" ? "success" : "outline"}>
                        {DIAGNOSIS_TYPE_LABELS[note.diagnosisType] ?? note.diagnosisType}
                      </Badge>
                    ) : null}
                    {note.toothNumber ? <Badge variant="secondary">Pieza {note.toothNumber}</Badge> : null}
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
              <Field>
                <FieldLabel htmlFor="dx-type">Tipo de diagnóstico</FieldLabel>
                <select
                  id="dx-type"
                  className="rounded-md border bg-background px-2 py-1.5 text-sm"
                  value={diagnosisType}
                  disabled={busy}
                  onChange={(event) => setDiagnosisType(event.target.value)}
                >
                  {Object.entries(DIAGNOSIS_TYPE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor="dx-tooth">Pieza (opcional)</FieldLabel>
                <Input
                  id="dx-tooth"
                  inputMode="numeric"
                  maxLength={2}
                  placeholder="Ej.: 46"
                  value={tooth}
                  disabled={busy}
                  onChange={(event) => setTooth(event.target.value.replace(/\D/g, ""))}
                />
              </Field>
            </div>
          </FormDrawer>
        )}
      </div>
    </div>
  )
}
