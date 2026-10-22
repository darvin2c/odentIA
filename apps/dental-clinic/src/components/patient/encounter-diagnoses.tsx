import { DIAGNOSIS_VERIFICATION, diagnosisCodeLabel } from "@odentia/clinical"
import { surfaceLabel } from "@odentia/dental"
import { Badge, Button, Field, FieldLabel, Textarea } from "@odentia/ui"
import { ConfirmDialog, FormDrawer } from "@odentia/ui-patterns"
import { useQueryClient } from "@tanstack/react-query"
import { useId, useState } from "react"
import { ApiError } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { addDiagnosisApi, type EncounterDiagnosis, voidDiagnosisApi } from "../../lib/encounters"
import { DIAGNOSIS_TYPE_LABELS, type EncounterDetail } from "../../lib/patients"
import { DiagnosisPicker } from "./diagnosis-picker"
import { type ToothSite, ToothSiteSelector } from "../dental/tooth-site-selector"

/** Presuntivo o definitivo (FHIR verificationStatus); «ya diagnosticado antes» lo marca el sistema. */
const TYPES = DIAGNOSIS_VERIFICATION

function mutationMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.shape.message) return err.shape.message
  return err instanceof Error ? err.message : fallback
}

/** «36 · Oclusal, Mesial» o «Sin pieza». */
export function diagnosisSiteLabel(dx: Pick<EncounterDiagnosis, "toothNumber" | "surfaces">) {
  if (dx.toothNumber === null) return "Sin pieza"
  const surfaces = dx.surfaces.map(surfaceLabel).join(", ")
  return surfaces ? `${dx.toothNumber} · ${surfaces}` : String(dx.toothNumber)
}

/**
 * Diagnósticos de la atención (lista de la clínica, su certeza y sitio dental;
 * ADR 0041). Se eligen en tres pasos (`DiagnosisPicker`). Toda
 * escritura respeta la barrera del editor: avisa pending, espera
 * `beforeWrite` (flush del borrador), escribe, espera `onChanged` y libera.
 * Un diagnóstico mal registrado se anula con motivo; nunca se borra.
 */
export function EncounterDiagnoses({
  patientId,
  detail,
  disabled = false,
  beforeWrite,
  onChanged,
  onPendingChange,
  autoOpen = false,
}: {
  patientId: string
  detail: EncounterDetail
  disabled?: boolean
  beforeWrite: () => Promise<void>
  onChanged: () => Promise<void>
  onPendingChange: (pending: boolean) => void
  /** Recién agregado el bloque: el formulario de agregar ya viene abierto. */
  autoOpen?: boolean
}): React.JSX.Element {
  const canWrite = usePermission("clinical.write")
  const queryClient = useQueryClient()
  const typeGroupId = useId()
  const [open, setOpen] = useState(autoOpen && !disabled)
  const [code, setCode] = useState("")
  const [codeSystem, setCodeSystem] = useState<string | null>(null)
  const [description, setDescription] = useState("")
  // Sin valor por defecto: afirmar la certeza es una decisión explícita del clínico.
  const [diagnosisType, setDiagnosisType] = useState<string>("")
  const [site, setSite] = useState<ToothSite>({ toothNumber: null, surfaces: [] })
  const [note, setNote] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [voiding, setVoiding] = useState<EncounterDiagnosis | null>(null)
  const [voidReason, setVoidReason] = useState("")
  const [voidError, setVoidError] = useState<string | null>(null)

  const encounter = detail.encounter
  const editable = encounter.status === "borrador"
  const diagnoses = detail.diagnoses ?? []
  const active = diagnoses.filter((dx) => !dx.voidedAt)
  const voided = diagnoses.filter((dx) => dx.voidedAt)
  const busy = disabled || saving
  const canSubmit = canWrite && editable && !busy && code.trim() !== "" && diagnosisType !== ""

  const reset = () => {
    setCode("")
    setCodeSystem(null)
    setDescription("")
    setDiagnosisType("")
    setSite({ toothNumber: null, surfaces: [] })
    setNote("")
    setError(null)
  }

  const write = async (operation: () => Promise<unknown>) => {
    onPendingChange(true)
    try {
      await beforeWrite()
      await operation()
      await queryClient.invalidateQueries({ queryKey: ["timeline", patientId] })
      await queryClient.invalidateQueries({ queryKey: ["patient-diagnoses", patientId] })
      await onChanged()
    } finally {
      onPendingChange(false)
    }
  }

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (!canSubmit) return
    setSaving(true)
    setError(null)
    try {
      await write(() =>
        addDiagnosisApi(patientId, encounter.id, {
          diagnosisCode: code.trim(),
          diagnosisSystem: codeSystem,
          diagnosisType,
          toothNumber: site.toothNumber,
          surfaces: site.surfaces,
          note: note.trim() || null,
        }),
      )
      reset()
      setOpen(false)
    } catch (err) {
      setError(mutationMessage(err, "No se pudo registrar el diagnóstico."))
    } finally {
      setSaving(false)
    }
  }

  const confirmVoid = async () => {
    if (!voiding || !voidReason.trim()) return
    setSaving(true)
    setVoidError(null)
    try {
      await write(() => voidDiagnosisApi(patientId, encounter.id, voiding.id, voidReason.trim()))
      setVoiding(null)
      setVoidReason("")
    } catch (err) {
      setVoidError(mutationMessage(err, "No se pudo anular el diagnóstico."))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section
      aria-labelledby={`${typeGroupId}-title`}
      className="flex flex-col gap-4 elevated rounded-xl border bg-card p-6"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`${typeGroupId}-title`} className="font-heading text-base font-medium">
          Diagnóstico ({active.length})
        </h2>
        {editable ? (
          <p className="text-xs text-muted-foreground">
            Al menos uno para cerrar la atención; «Presuntivo» basta.
          </p>
        ) : null}
      </div>

      {active.length === 0 ? (
        <p className="text-sm text-muted-foreground">Sin diagnósticos registrados.</p>
      ) : (
        <ul className="flex flex-col divide-y" aria-label="Diagnósticos registrados">
          {active.map((dx) => (
            <li key={dx.id} className="flex flex-wrap items-start justify-between gap-3 py-2.5">
              <div className="flex min-w-0 flex-col gap-1">
                <p className="text-sm">
                  <span className="font-semibold">{diagnosisCodeLabel(dx.diagnosisSystem, dx.diagnosisCode)}</span>
                  {dx.note ? <span className="text-muted-foreground"> · {dx.note}</span> : null}
                </p>
                <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {dx.diagnosisType ? (
                    <Badge variant={dx.diagnosisType === "confirmed" ? "success" : "outline"}>
                      {DIAGNOSIS_TYPE_LABELS[dx.diagnosisType] ?? dx.diagnosisType}
                    </Badge>
                  ) : (
                    <Badge variant="outline">Sin tipo (histórico)</Badge>
                  )}
                  {dx.previouslyDiagnosed ? <Badge variant="secondary">Ya diagnosticado antes</Badge> : null}
                  <span>{diagnosisSiteLabel(dx)}</span>
                  {dx.status === "resuelto" ? <Badge variant="secondary">Resuelto</Badge> : null}
                </p>
              </div>
              {canWrite && editable ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setVoidReason("")
                    setVoidError(null)
                    setVoiding(dx)
                  }}
                >
                  Anular…
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {voided.length > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            Anulados ({voided.length})
          </summary>
          <ul className="mt-2 flex flex-col gap-1 text-muted-foreground">
            {voided.map((dx) => (
              <li key={dx.id}>
                <span className="line-through">{diagnosisCodeLabel(dx.diagnosisSystem, dx.diagnosisCode)}</span> · {diagnosisSiteLabel(dx)} ·
                Motivo: {dx.voidReason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {canWrite && editable ? (
        <div>
          <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(true)}>
            Registrar diagnóstico
          </Button>
        </div>
      ) : null}

      {canWrite && editable ? (
        <FormDrawer
          open={open}
          onClose={() => {
            if (saving) return
            reset()
            setOpen(false)
          }}
          title="Registrar diagnóstico"
          description="El código de la lista de la clínica, su tipo y, si corresponde, la pieza y sus superficies."
          onSubmit={(event) => void onSubmit(event)}
          isDirty={code.trim() !== "" || diagnosisType !== "" || site.toothNumber !== null}
          isSubmitting={saving}
          submitDisabled={!canSubmit}
          submitLabel="Registrar diagnóstico"
          error={error}
        >
          <div className="flex flex-col gap-5">
            <DiagnosisPicker
              patientId={patientId}
              encounterId={encounter.id}
              value={code}
              system={codeSystem}
              disabled={busy}
              onChange={(choice, proposedSite) => {
                setCode(choice.code)
                setCodeSystem(choice.code ? choice.system : null)
                setDescription(choice.code ? choice.description : "")
                // Lo que propone un hallazgo trae su pieza y sus caras, si aún no se eligió otra.
                if (proposedSite && site.toothNumber === null) setSite(proposedSite)
              }}
            />
            {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
            <div className="flex flex-col gap-2">
              <span id={typeGroupId} className="text-sm font-medium">
                Tipo de diagnóstico
              </span>
              <div
                className="flex flex-wrap gap-1.5"
                role="radiogroup"
                aria-labelledby={typeGroupId}
              >
                {TYPES.map((type) => (
                  <Button
                    key={type}
                    type="button"
                    size="sm"
                    role="radio"
                    aria-checked={diagnosisType === type}
                    variant={diagnosisType === type ? "default" : "outline"}
                    disabled={busy}
                    onClick={() => setDiagnosisType(type)}
                  >
                    {DIAGNOSIS_TYPE_LABELS[type]}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Presuntivo mientras se confirma; definitivo cuando se confirma. Si la persona ya lo
                tenía, el sistema lo anota solo.
              </p>
            </div>
            <ToothSiteSelector value={site} onChange={setSite} withSurfaces disabled={busy} />
            <Field>
              <FieldLabel htmlFor={`${typeGroupId}-note`}>
                Hallazgos que lo sustentan (opcional)
              </FieldLabel>
              <Textarea
                id={`${typeGroupId}-note`}
                rows={2}
                maxLength={2000}
                value={note}
                disabled={busy}
                onChange={(event) => setNote(event.target.value)}
              />
            </Field>
          </div>
        </FormDrawer>
      ) : null}

      <ConfirmDialog
        open={voiding !== null}
        title="Anular diagnóstico"
        description={`${voiding ? diagnosisCodeLabel(voiding.diagnosisSystem, voiding.diagnosisCode) : ""} · ${voiding ? diagnosisSiteLabel(voiding) : ""}. Queda en la historia como anulado, con tu nombre y el motivo.`}
        confirmLabel="Anular diagnóstico"
        pending={saving}
        confirmDisabled={!voidReason.trim()}
        onConfirm={() => void confirmVoid()}
        onClose={() => {
          if (!saving) setVoiding(null)
        }}
      >
        <Field>
          <FieldLabel htmlFor={`${typeGroupId}-void`}>Motivo</FieldLabel>
          <Textarea
            id={`${typeGroupId}-void`}
            rows={2}
            maxLength={2000}
            value={voidReason}
            onChange={(event) => setVoidReason(event.target.value)}
          />
        </Field>
        {voidError ? (
          <p role="alert" className="text-sm text-destructive">
            {voidError}
          </p>
        ) : null}
      </ConfirmDialog>
    </section>
  )
}
