import { productUi } from "../../product/product-ui"
import { DIAGNOSIS_VERIFICATION, diagnosisCodeLabel } from "@odentia/clinical"
import { Badge, Button } from "@odentia/ui"
import {
  ConfirmDialog,
  FormDrawer,
  type ServerFieldMap,
  submitForm,
  useAppForm,
  useFormSubmitError,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useQueryClient } from "@tanstack/react-query"
import { useId, useState } from "react"
import { z } from "zod"
import { usePermission } from "../../lib/crm"
import { addDiagnosisApi, type EncounterDiagnosis, voidDiagnosisApi } from "../../lib/encounters"
import { DIAGNOSIS_TYPE_LABELS, type EncounterDetail } from "../../lib/patients"
import { ChoiceButtons } from "../choice-buttons"
import { DiagnosisPicker } from "./diagnosis-picker"
import type { PlaceWithParts } from "../../product/product-ui"
import { partNames, SiteField } from "../../product/site-fields"

/** Presuntivo o definitivo (FHIR verificationStatus); «ya diagnosticado antes» lo marca el sistema. */
const TYPE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = DIAGNOSIS_VERIFICATION.map((type) => ({
  value: type,
  label: DIAGNOSIS_TYPE_LABELS[type] ?? type,
}))

const NO_SITE: PlaceWithParts = { toothNumber: null, surfaces: [] }
const MAX_TEXT = 2000

/** Los mismos límites que `operationBodySchema("atencion.diagnostico")` en la API. */
const diagnosisSchema = z.object({
  diagnosisCode: z.string().trim().min(1, "Elige el diagnóstico"),
  diagnosisSystem: z.string().nullable(),
  description: z.string(),
  diagnosisType: z.string().min(1, "Elige si el diagnóstico es presuntivo o definitivo"),
  site: z.custom<PlaceWithParts>(),
  note: z.string().max(MAX_TEXT, `Escribe como mucho ${MAX_TEXT} caracteres.`),
})

/** La pieza y sus caras van juntas en «Pieza» (el sitio); la lista, con el código. */
const SERVER_FIELDS: ServerFieldMap = { toothNumber: "site", surfaces: "site", diagnosisSystem: "diagnosisCode" }

const reasonSchema = z.object({
  reason: z.string().trim().min(1, "Escribe el motivo.").max(MAX_TEXT, `Escribe como mucho ${MAX_TEXT} caracteres.`),
})

/** «36 · Oclusal, Mesial» o «Sin pieza»; nada si el producto no registra el «dónde» (latidIA). */
export function diagnosisSiteLabel(dx: Pick<EncounterDiagnosis, "toothNumber" | "surfaces">): string | null {
  // Un producto sin «dónde» no manda la pieza ni las caras: ni null.
  if (dx.toothNumber == null) return productUi().site ? "Sin pieza" : null
  const surfaces = partNames(dx.surfaces)
  return surfaces ? `${dx.toothNumber} · ${surfaces}` : String(dx.toothNumber)
}

/** « · 36 · Oclusal» para seguir a otro dato, o nada. */
export function diagnosisSiteSuffix(dx: Pick<EncounterDiagnosis, "toothNumber" | "surfaces">): string {
  const site = diagnosisSiteLabel(dx)
  return site ? ` · ${site}` : ""
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
  const [voiding, setVoiding] = useState<EncounterDiagnosis | null>(null)

  const encounter = detail.encounter
  const editable = encounter.status === "borrador"
  const diagnoses = detail.diagnoses ?? []
  const active = diagnoses.filter((dx) => !dx.voidedAt)
  const voided = diagnoses.filter((dx) => dx.voidedAt)

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

  const form = useAppForm({
    defaultValues: {
      diagnosisCode: "",
      diagnosisSystem: null as string | null,
      description: "",
      // Sin valor por defecto: afirmar la certeza es una decisión explícita del clínico.
      diagnosisType: "",
      site: NO_SITE,
      note: "",
    },
    validators: { onSubmit: diagnosisSchema },
    onSubmit: async ({ value, formApi }) => {
      await write(() =>
        addDiagnosisApi(patientId, encounter.id, {
          diagnosisCode: value.diagnosisCode.trim(),
          diagnosisSystem: value.diagnosisSystem,
          diagnosisType: value.diagnosisType,
          toothNumber: value.site.toothNumber,
          surfaces: value.site.surfaces,
          note: value.note.trim() || null,
        }),
      )
      formApi.reset()
      setOpen(false)
    },
  })
  const surface = useFormSurface(form, { fieldMap: SERVER_FIELDS })
  const codeSystem = useStore(form.store, (state) => state.values.diagnosisSystem)
  const description = useStore(form.store, (state) => state.values.description)

  const voidForm = useAppForm({
    defaultValues: { reason: "" },
    validators: { onSubmit: reasonSchema },
    onSubmit: async ({ value }) => {
      if (!voiding) return
      await write(() => voidDiagnosisApi(patientId, encounter.id, voiding.id, value.reason.trim()))
      setVoiding(null)
    },
  })
  const voidSubmitting = useStore(voidForm.store, (state) => state.isSubmitting)
  const voidError = useFormSubmitError(voidForm)

  const busy = disabled || surface.isSubmitting || voidSubmitting

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
                {/* Primero el nombre, que es lo que se lee; el código lo acompaña. */}
                <p className="text-sm">
                  <span className="font-semibold">{dx.diagnosisTitle ?? diagnosisCodeLabel(dx.diagnosisSystem, dx.diagnosisCode)}</span>
                  {dx.diagnosisTitle ? (
                    <span className="text-muted-foreground"> · {diagnosisCodeLabel(dx.diagnosisSystem, dx.diagnosisCode)}</span>
                  ) : null}
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
                  {diagnosisSiteLabel(dx) ? <span>{diagnosisSiteLabel(dx)}</span> : null}
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
                    voidForm.reset()
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
                <span className="line-through">{diagnosisCodeLabel(dx.diagnosisSystem, dx.diagnosisCode)}</span>
                {diagnosisSiteSuffix(dx)} ·
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
          {...surface}
          open={open}
          onClose={() => {
            if (surface.isSubmitting) return
            form.reset()
            setOpen(false)
          }}
          title="Registrar diagnóstico"
          description={
            productUi().site
              ? "El código de la lista de la clínica, su tipo y, si corresponde, la pieza y sus superficies."
              : "El código de la lista de la clínica y su tipo."
          }
          submitLabel="Registrar diagnóstico"
        >
          <div className="flex flex-col gap-5">
            <form.AppField name="diagnosisCode">
              {(field) => (
                <field.Group legend="Diagnóstico">
                  {(control) => (
                    <DiagnosisPicker
                      patientId={patientId}
                      encounterId={encounter.id}
                      value={field.state.value}
                      system={codeSystem}
                      disabled={busy}
                      id={control.id}
                      invalid={control.invalid}
                      aria-describedby={control.describedBy}
                      onBlur={control.onBlur}
                      onChange={(choice, proposedSite) => {
                        field.handleChange(choice.code)
                        form.setFieldValue("diagnosisSystem", choice.code ? choice.system : null)
                        form.setFieldValue("description", choice.code ? choice.description : "")
                        // Lo que propone un hallazgo trae su pieza y sus caras, si aún no se eligió otra.
                        if (proposedSite && form.getFieldValue("site").toothNumber === null)
                          form.setFieldValue("site", proposedSite)
                      }}
                    />
                  )}
                </field.Group>
              )}
            </form.AppField>
            {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
            <form.AppField name="diagnosisType">
              {(field) => (
                <field.Group
                  legend="Tipo de diagnóstico"
                  description="Presuntivo mientras se confirma; definitivo cuando se confirma. Si la persona ya lo tenía, el sistema lo anota solo."
                >
                  {(control) => (
                    <ChoiceButtons
                      id={control.id}
                      value={field.state.value || null}
                      options={TYPE_OPTIONS}
                      onChange={(next) => field.handleChange(next)}
                      disabled={busy}
                      invalid={control.invalid}
                      aria-describedby={control.describedBy}
                      onBlur={control.onBlur}
                    />
                  )}
                </field.Group>
              )}
            </form.AppField>
            {productUi().site ? (
              <form.AppField name="site">
                {(field) => (
                  <field.Group
                    legend={
                      <>
                        {productUi().site?.placeLabel}
                        <span className="text-muted-foreground"> (opcional)</span>
                      </>
                    }
                  >
                    {(control) => (
                      <SiteField
                        value={field.state.value}
                        onChange={(next) => field.handleChange(next)}
                        withSurfaces
                        disabled={busy}
                        id={control.id}
                        invalid={control.invalid}
                        aria-describedby={control.describedBy}
                        onBlur={control.onBlur}
                      />
                    )}
                  </field.Group>
                )}
              </form.AppField>
            ) : null}
            <form.AppField name="note">
              {(field) => (
                <field.TextareaField
                  label="Hallazgos que lo sustentan (opcional)"
                  rows={2}
                  maxLength={MAX_TEXT}
                  disabled={busy}
                />
              )}
            </form.AppField>
          </div>
        </FormDrawer>
      ) : null}

      <ConfirmDialog
        open={voiding !== null}
        title="Anular diagnóstico"
        description={`${voiding ? diagnosisCodeLabel(voiding.diagnosisSystem, voiding.diagnosisCode) : ""}${voiding ? diagnosisSiteSuffix(voiding) : ""}. Queda en la historia como anulado, con tu nombre y el motivo.`}
        confirmLabel="Anular diagnóstico"
        pending={voidSubmitting}
        error={voidError}
        onConfirm={() => void submitForm(voidForm)}
        onClose={() => {
          if (!voidSubmitting) setVoiding(null)
        }}
      >
        <voidForm.AppField name="reason">
          {(field) => <field.TextareaField label="Motivo" rows={2} maxLength={MAX_TEXT} aria-required />}
        </voidForm.AppField>
      </ConfirmDialog>
    </section>
  )
}
