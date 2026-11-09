import { productUi } from "../../product/product-ui"
import { DIAGNOSIS_VERIFICATION, diagnosisCodeLabel } from "@odentia/clinical"
import { Badge, Button } from "@odentia/ui"
import {
  ConfirmDialog,
  FormDrawer,
  type ServerFieldMap,
  submitErrorMessage,
  submitForm,
  useAppForm,
  useFormSubmitError,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useId, useState } from "react"
import { z } from "zod"
import { usePermission } from "../../lib/crm"
import { addDiagnosisApi, type EncounterDiagnosis, voidDiagnosisApi } from "../../lib/encounters"
import { DIAGNOSIS_TYPE_LABELS, type EncounterDetail } from "../../lib/patients"
import { ChoiceButtons } from "../choice-buttons"
import {
  areaWords,
  DiagnosisPicker,
  type ProposedDiagnosis,
  proposalKey,
  proposalOrigin,
  proposedSite,
  useDiagnosisSuggestions,
} from "./diagnosis-picker"
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
  /** El cuadrante o la arcada de una propuesta de un tratamiento por área; sin pieza, se registra con él. */
  area: z.custom<{ quadrant: number | null; arch: string | null } | null>(),
  note: z.string().max(MAX_TEXT, `Escribe como mucho ${MAX_TEXT} caracteres.`),
})

/** La pieza y sus caras van juntas en «Pieza» (el sitio); la lista, con el código. */
const SERVER_FIELDS: ServerFieldMap = { toothNumber: "site", surfaces: "site", diagnosisSystem: "diagnosisCode" }

const reasonSchema = z.object({
  reason: z.string().trim().min(1, "Escribe el motivo.").max(MAX_TEXT, `Escribe como mucho ${MAX_TEXT} caracteres.`),
})

/** «36 · Oclusal, Mesial», «Cuadrante 1» o «Sin pieza»; nada si el producto no registra el «dónde» (latidIA). */
export function diagnosisSiteLabel(
  dx: Pick<EncounterDiagnosis, "toothNumber" | "surfaces" | "quadrant" | "arch">,
): string | null {
  // Un producto sin «dónde» no manda la pieza ni las caras: ni null.
  if (dx.toothNumber == null) return productUi().site ? (areaWords(dx) ?? "Sin pieza") : null
  const surfaces = partNames(dx.surfaces)
  return surfaces ? `${dx.toothNumber} · ${surfaces}` : String(dx.toothNumber)
}

/** « · 36 · Oclusal» para seguir a otro dato, o nada. */
export function diagnosisSiteSuffix(
  dx: Pick<EncounterDiagnosis, "toothNumber" | "surfaces" | "quadrant" | "arch">,
): string {
  const site = diagnosisSiteLabel(dx)
  return site ? ` · ${site}` : ""
}

/**
 * Lo que proponen los tratamientos que la atención continúa, cada propuesta
 * con «Usar». Lo que propone el odontograma sigue en el buscador del
 * formulario («Elegir»), como antes. Nada entra solo: con
 * el tipo de la última vez, «Usar» lo registra con el alta de siempre; sin
 * tipo, pide al clínico que lo elija (`onChoose` abre el formulario lleno).
 * Respeta la barrera del editor como el resto de escrituras del bloque.
 */
export function DiagnosisProposals({
  patientId,
  encounterId,
  disabled = false,
  beforeWrite,
  onChanged,
  onPendingChange,
  onChoose,
}: {
  patientId: string
  encounterId: string
  disabled?: boolean
  beforeWrite: () => Promise<void>
  onChanged: () => Promise<void>
  onPendingChange: (pending: boolean) => void
  onChoose: (item: ProposedDiagnosis) => void
}): React.JSX.Element | null {
  const queryClient = useQueryClient()
  const suggestions = useDiagnosisSuggestions(patientId, encounterId)
  const [using, setUsing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const proposed = (suggestions.data?.proposed ?? []).filter((item) => item.source === "tratamiento")
  if (proposed.length === 0) return null
  const keyOf = proposalKey

  const use = async (item: ProposedDiagnosis) => {
    setError(null)
    if (!item.diagnosisType) {
      onChoose(item)
      return
    }
    setUsing(keyOf(item))
    onPendingChange(true)
    try {
      await beforeWrite()
      // El sitio entero, como lo propuso el servidor (también el cuadrante o la arcada):
      // así lo registrado coincide con la propuesta y deja de proponerse.
      await addDiagnosisApi(patientId, encounterId, {
        diagnosisCode: item.code,
        diagnosisSystem: item.system,
        diagnosisType: item.diagnosisType,
        ...proposedSite(item),
      })
      await queryClient.invalidateQueries({ queryKey: ["diagnosis-suggestions", patientId] })
      await queryClient.invalidateQueries({ queryKey: ["timeline", patientId] })
      await queryClient.invalidateQueries({ queryKey: ["patient-diagnoses", patientId] })
      await onChanged()
    } catch (err) {
      setError(submitErrorMessage(err))
    } finally {
      setUsing(null)
      onPendingChange(false)
    }
  }

  return (
    <div className="flex w-full flex-col gap-2">
      <ul className="flex flex-col gap-2" aria-label="Diagnósticos propuestos">
        {proposed.map((item) => {
          const type = item.diagnosisType ? (DIAGNOSIS_TYPE_LABELS[item.diagnosisType] ?? item.diagnosisType) : null
          return (
            <li
              key={keyOf(item)}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2"
            >
              <div className="flex min-w-0 flex-col">
                <span className="text-sm font-medium">
                  {item.description}
                  <span className="font-normal text-muted-foreground"> · {item.code}</span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {proposalOrigin(item)}
                  {/* Lo que hará «Usar»: con el tipo de la última vez, o se elige al usarlo. */}
                  {type ? ` · se registra ${type.toLowerCase()}, como la última vez` : " · eliges el tipo al usarlo"}
                </span>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled || using !== null}
                aria-label={`Usar ${item.description}${item.toothNumber != null ? ` de la ${item.toothNumber}` : areaWords(item) ? ` · ${areaWords(item)?.toLowerCase()}` : ""}`}
                onClick={() => void use(item)}
              >
                {using === keyOf(item) ? "Registrando…" : "Usar"}
              </Button>
            </li>
          )
        })}
      </ul>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
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
  openSignal = 0,
  prefill = null,
  onPrefillUsed,
}: {
  patientId: string
  detail: EncounterDetail
  disabled?: boolean
  beforeWrite: () => Promise<void>
  onChanged: () => Promise<void>
  onPendingChange: (pending: boolean) => void
  /** Recién agregado el bloque: el formulario de agregar ya viene abierto. */
  autoOpen?: boolean
  /** Cada vez que cambia, abre «Registrar diagnóstico» (desde lo que falta para firmar), sin perder lo escrito. */
  openSignal?: number
  /** Una propuesta que se usó desde la tarjeta sin tipo: el formulario se abre con ella. */
  prefill?: ProposedDiagnosis | null
  onPrefillUsed?: () => void
}): React.JSX.Element {
  const canWrite = usePermission("clinical.write")
  const queryClient = useQueryClient()
  const typeGroupId = useId()
  const [open, setOpen] = useState(autoOpen && !disabled)
  useEffect(() => {
    if (openSignal > 0) setOpen(true)
  }, [openSignal])
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
      // Lo registrado o anulado cambia lo que se propone.
      await queryClient.invalidateQueries({ queryKey: ["diagnosis-suggestions", patientId] })
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
      area: null as { quadrant: number | null; arch: string | null } | null,
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
          // El área de la propuesta solo cuenta mientras no se eligió una pieza.
          quadrant: value.site.toothNumber == null ? (value.area?.quadrant ?? null) : null,
          arch: value.site.toothNumber == null ? (value.area?.arch ?? null) : null,
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
  const area = useStore(form.store, (state) => (state.values.site.toothNumber == null ? areaWords(state.values.area ?? {}) : null))

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

  /** Una propuesta sin tipo: el formulario se abre lleno y el clínico elige el tipo. */
  const choose = (item: ProposedDiagnosis) => {
    form.reset()
    form.setFieldValue("diagnosisCode", item.code)
    form.setFieldValue("diagnosisSystem", item.system)
    form.setFieldValue("description", item.description)
    const site = proposedSite(item)
    form.setFieldValue("site", { toothNumber: site.toothNumber, surfaces: site.surfaces })
    form.setFieldValue("area", site.quadrant != null || site.arch != null ? { quadrant: site.quadrant, arch: site.arch } : null)
    setOpen(true)
  }
  // Lo que se eligió en la tarjeta de la atención, antes de abrir el bloque.
  // biome-ignore lint/correctness/useExhaustiveDependencies: se usa una vez por propuesta elegida.
  useEffect(() => {
    if (!prefill || !canWrite || !editable) return
    choose(prefill)
    onPrefillUsed?.()
  }, [prefill])

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
        <DiagnosisProposals
          patientId={patientId}
          encounterId={encounter.id}
          disabled={busy}
          beforeWrite={beforeWrite}
          onChanged={onChanged}
          onPendingChange={onPendingChange}
          onChoose={choose}
        />
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
                      onChange={(choice, site) => {
                        field.handleChange(choice.code)
                        form.setFieldValue("diagnosisSystem", choice.code ? choice.system : null)
                        form.setFieldValue("description", choice.code ? choice.description : "")
                        // Lo que propone un hallazgo o un tratamiento trae su pieza y sus caras (o su área),
                        // si aún no se eligió otra pieza. Otro código del buscador no hereda el área.
                        const noTooth = form.getFieldValue("site").toothNumber === null
                        if (site && noTooth) form.setFieldValue("site", { toothNumber: site.toothNumber, surfaces: site.surfaces })
                        form.setFieldValue(
                          "area",
                          site && noTooth && (site.quadrant != null || site.arch != null)
                            ? { quadrant: site.quadrant, arch: site.arch }
                            : null,
                        )
                      }}
                    />
                  )}
                </field.Group>
              )}
            </form.AppField>
            {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
            {area ? <p className="text-sm text-muted-foreground">Se registra en {area.toLowerCase()}, como el tratamiento.</p> : null}
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
