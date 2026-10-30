/**
 * Campos del formulario de Antecedentes (`useAppForm`, ADR 0113): grupo
 * sanguíneo, revisión de cada grupo y las filas de condiciones y medicación.
 *
 * Composición de dominio sin queries ni permisos: reciben el `form` del padre
 * (`withForm`) con `healthFormOptions`, y cada dato es un `form.AppField` con
 * su etiqueta, su ayuda y su error. Los nombres son los del cuerpo de
 * `PUT /api/patients/:id/health` (`conditions[0].name`), así lo que rechaza el
 * servidor cae en su fila y su campo.
 */

import {
  BLOOD_GROUPS,
  type BloodGroup,
  type DeclarationState,
  CONDITION_STATUSES,
  DOSE_UNIT_LABELS,
  DOSE_UNITS,
  type DoseUnit,
  MEDICATION_FREQUENCIES,
  MEDICATION_FREQUENCY_LABELS,
} from "@odentia/clinical"
import { Button, Input } from "@odentia/ui"
import { PastDateInput, withForm } from "@odentia/ui-patterns"
import { formOptions } from "@tanstack/react-form"
import { CONDITION_STATUS_LABELS, HEALTH_REVIEW_LABELS, type HealthReviewState } from "../../lib/patients"
import { ChoiceButtons } from "../choice-buttons"
import { DiagnosisSearch } from "./diagnosis-search"
import { MedicationPicker } from "./medication-picker"

export const DECLARATION_STATE_LABELS: Record<DeclarationState, string> = {
  unanswered: "Sin responder",
  unknown: "No sé",
  none: "No",
  recorded: "Sí",
}

export const BLOOD_GROUP_LABELS: Record<BloodGroup, string> = {
  "A+": "A+",
  "A-": "A−",
  "B+": "B+",
  "B-": "B−",
  "AB+": "AB+",
  "AB-": "AB−",
  "O+": "O+",
  "O-": "O−",
  unknown: "No lo sé",
}

/** Los mismos límites que la ruta (`healthCondition`/`healthMedication` en patients.ts). */
export const HEALTH_NAME_MAX = 200
export const HEALTH_NOTES_MAX = 2000

let rowSeq = 0
function nextRowKey(prefix: string): string {
  rowSeq += 1
  return `${prefix}-${rowSeq}`
}

/* ------------------------------------------------------------------ */
/* Valores del formulario                                              */
/* ------------------------------------------------------------------ */

export interface ConditionRowValue {
  key: string
  /** Id guardado; una fila nueva no lo tiene. */
  id?: string
  name: string
  /** Código de la lista de diagnósticos que precisa la condición. */
  diagnosisCode: string
  /** Su lista: la de la clínica en uno nuevo; uno guardado conserva la suya. */
  diagnosisSystem: string | null
  status: string
  startDate: string
  endDate: string
  notes: string
  persisted: boolean
}

export interface MedicationRowValue {
  key: string
  id?: string
  name: string
  /** Principio activo (DCI). */
  genericName: string
  /** Lo escrito antes del cambio; con número y unidad se escribe solo. */
  dose: string
  /** Número y unidad UCUM de la dosis. */
  doseValue: string
  doseUnit: string
  /** «Otra frecuencia», escrita. */
  frequency: string
  /** Frecuencia de la lista (`MEDICATION_FREQUENCIES`), «otra» o vacía. */
  frequencyCode: string
  startDate: string
  endDate: string
  notes: string
  persisted: boolean
}

export interface FamilyRowValue {
  key: string
  relationship: string
  condition: string
  diagnosisCode: string
  diagnosisSystem: string | null
}

export interface HealthFormValues {
  /** `""`: sin responder. */
  bloodGroup: string
  asaClass: string
  reviewStatus: { conditions: HealthReviewState; medications: HealthReviewState }
  conditions: ConditionRowValue[]
  medications: MedicationRowValue[]
  familyHistory: FamilyRowValue[]
  /** La entrevista como se está editando (sin las semanas de embarazo, que van aparte). */
  interview: Record<string, unknown>
  /** «Semanas de embarazo», escrita; se guarda en la entrevista. */
  pregnancyWeeks: string
}

export const EMPTY_HEALTH_FORM: HealthFormValues = {
  bloodGroup: "",
  asaClass: "",
  reviewStatus: { conditions: "unknown", medications: "unknown" },
  conditions: [],
  medications: [],
  familyHistory: [],
  interview: {},
  pregnancyWeeks: "",
}

export const healthFormOptions = formOptions({ defaultValues: EMPTY_HEALTH_FORM })

/* ------------------------------------------------------------------ */
/* Grupo sanguíneo y revisión del grupo                                */
/* ------------------------------------------------------------------ */

const BLOOD_GROUP_OPTIONS = [
  { value: "", label: "Sin responder" },
  ...BLOOD_GROUPS.map((group) => ({ value: group, label: BLOOD_GROUP_LABELS[group] })),
]

export const BloodGroupField = withForm({
  ...healthFormOptions,
  props: { id: "", readOnly: false, declared: false },
  render: function BloodGroupFieldRender({ form, id, readOnly, declared }) {
    return (
      <form.AppField name="bloodGroup">
        {(field) => (
          <field.SelectField
            id={id}
            label="Grupo sanguíneo"
            options={BLOOD_GROUP_OPTIONS}
            disabled={readOnly}
            description={
              declared
                ? "Valor declarado por el paciente/responsable: la revisión clínica no equivale a confirmación de laboratorio."
                : undefined
            }
          />
        )}
      </form.AppField>
    )
  },
})

const REVIEW_OPTIONS = (["unknown", "recorded", "none"] as const).map((value) => ({
  value,
  label: HEALTH_REVIEW_LABELS[value],
}))

/** Estado de revisión clínica del grupo: no se le preguntó, niega o registrados. */
export const ReviewStateField = withForm({
  ...healthFormOptions,
  props: { id: "", group: "conditions" as "conditions" | "medications", readOnly: false },
  render: function ReviewStateFieldRender({ form, id, group, readOnly }) {
    return (
      <form.AppField name={`reviewStatus.${group}`}>
        {(field) => (
          <field.SelectField id={id} label="Revisión del grupo" options={REVIEW_OPTIONS} disabled={readOnly} />
        )}
      </form.AppField>
    )
  },
})

/* ------------------------------------------------------------------ */
/* Condiciones                                                         */
/* ------------------------------------------------------------------ */

const STATUS_OPTIONS = CONDITION_STATUSES.map((value) => ({
  value,
  label: CONDITION_STATUS_LABELS[value] ?? value,
}))

export const ConditionRows = withForm({
  ...healthFormOptions,
  props: { idPrefix: "", readOnly: false },
  render: function ConditionRowsRender({ form, idPrefix, readOnly }) {
    const fid = (name: string): string => `${idPrefix}-${name}`
    return (
      <form.AppField name="conditions" mode="array">
        {(rowsField) => (
          <div className="flex flex-col gap-3">
            {rowsField.state.value.map((row, index) => (
              <div key={row.key} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
                <form.AppField name={`conditions[${index}].name`}>
                  {(field) => (
                    <field.TextField
                      id={fid(`con-nom-${row.key}`)}
                      label="Nombre"
                      maxLength={HEALTH_NAME_MAX}
                      disabled={readOnly}
                    />
                  )}
                </form.AppField>
                <div className="flex flex-col gap-1">
                  <form.AppField name={`conditions[${index}].diagnosisCode`}>
                    {(field) => (
                      <field.Control id={fid(`con-dx-${row.key}`)} label="Código de diagnóstico (opcional)">
                        {(control) => (
                          <DiagnosisSearch
                            id={control.id}
                            invalid={control.invalid}
                            aria-describedby={control.describedBy}
                            onBlur={control.onBlur}
                            value={field.state.value}
                            system={row.diagnosisSystem}
                            onChange={(code, _description, system) => {
                              field.handleChange(code)
                              form.setFieldValue(`conditions[${index}].diagnosisSystem`, system)
                            }}
                            disabled={readOnly}
                          />
                        )}
                      </field.Control>
                    )}
                  </form.AppField>
                  {row.diagnosisCode ? (
                    <button
                      type="button"
                      className="self-start text-xs text-muted-foreground underline underline-offset-4"
                      disabled={readOnly}
                      onClick={() => {
                        form.setFieldValue(`conditions[${index}].diagnosisCode`, "")
                        form.setFieldValue(`conditions[${index}].diagnosisSystem`, null)
                      }}
                    >
                      Quitar el código {row.diagnosisCode}
                    </button>
                  ) : null}
                </div>
                <form.AppField name={`conditions[${index}].status`}>
                  {(field) => (
                    <field.SelectField
                      id={fid(`con-est-${row.key}`)}
                      label="Estado"
                      options={STATUS_OPTIONS}
                      disabled={readOnly}
                    />
                  )}
                </form.AppField>
                <DateField
                  form={form}
                  name={`conditions[${index}].startDate`}
                  id={fid(`con-ini-${row.key}`)}
                  label="Inicio"
                  readOnly={readOnly}
                />
                <DateField
                  form={form}
                  name={`conditions[${index}].endDate`}
                  id={fid(`con-fin-${row.key}`)}
                  label="Fin (vacío = activa)"
                  readOnly={readOnly}
                />
                <form.AppField name={`conditions[${index}].notes`}>
                  {(field) => (
                    <field.TextareaField
                      id={fid(`con-not-${row.key}`)}
                      className="sm:col-span-2"
                      label="Notas"
                      rows={2}
                      maxLength={HEALTH_NOTES_MAX}
                      disabled={readOnly}
                    />
                  )}
                </form.AppField>
                {!row.persisted ? (
                  <div className="sm:col-span-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={readOnly}
                      onClick={() => rowsField.removeValue(index)}
                    >
                      Quitar fila
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
            <div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={readOnly}
                onClick={() =>
                  rowsField.pushValue({
                    key: nextRowKey("con"),
                    name: "",
                    diagnosisCode: "",
                    diagnosisSystem: null,
                    status: "activa",
                    startDate: "",
                    endDate: "",
                    notes: "",
                    persisted: false,
                  })
                }
              >
                Agregar otra
              </Button>
            </div>
          </div>
        )}
      </form.AppField>
    )
  },
})

/** Una fecha pasada de una fila (inicio o fin), con su error debajo. */
const DateField = withForm({
  ...healthFormOptions,
  props: {
    name: "" as
      | `conditions[${number}].startDate`
      | `conditions[${number}].endDate`
      | `medications[${number}].startDate`
      | `medications[${number}].endDate`,
    id: "",
    label: "",
    readOnly: false,
  },
  render: function DateFieldRender({ form, name, id, label, readOnly }) {
    return (
      <form.AppField name={name}>
        {(field) => (
          <field.Control id={id} label={label}>
            {(control) => (
              <PastDateInput
                id={control.id}
                name={control.name}
                invalid={control.invalid}
                aria-describedby={control.describedBy}
                onBlur={control.onBlur}
                value={field.state.value}
                disabled={readOnly}
                onChange={(next) => field.handleChange(next)}
              />
            )}
          </field.Control>
        )}
      </form.AppField>
    )
  },
})

/* ------------------------------------------------------------------ */
/* Medicación                                                          */
/* ------------------------------------------------------------------ */

function capitalize(text: string): string {
  return text.charAt(0).toLocaleUpperCase("es") + text.slice(1)
}

const FREQUENCY_OPTIONS = [
  ...MEDICATION_FREQUENCIES.map((value) => ({ value, label: MEDICATION_FREQUENCY_LABELS[value] })),
  { value: "otra" as const, label: "Otra" },
]
type FrequencyChoice = (typeof FREQUENCY_OPTIONS)[number]["value"]

const UNIT_OPTIONS = [
  { value: "", label: "Unidad" },
  ...DOSE_UNITS.map((unit) => ({ value: unit, label: DOSE_UNIT_LABELS[unit as DoseUnit][1] })),
]

export const MedicationRows = withForm({
  ...healthFormOptions,
  props: { idPrefix: "", readOnly: false },
  render: function MedicationRowsRender({ form, idPrefix, readOnly }) {
    const fid = (name: string): string => `${idPrefix}-${name}`
    return (
      <form.AppField name="medications" mode="array">
        {(rowsField) => (
          <div className="flex flex-col gap-3">
            {rowsField.state.value.map((row, index) => {
              // Lo escrito antes del cambio se muestra y se conserva mientras no se elija otra cosa.
              const legacyDose = !row.doseValue && row.dose.trim() ? row.dose.trim() : null
              return (
                <div key={row.key} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
                  <form.AppField name={`medications[${index}].name`}>
                    {(field) => (
                      <field.TextField
                        id={fid(`med-nom-${row.key}`)}
                        label="Nombre"
                        maxLength={HEALTH_NAME_MAX}
                        disabled={readOnly}
                      />
                    )}
                  </form.AppField>
                  <form.AppField name={`medications[${index}].genericName`}>
                    {(field) => (
                      <field.Control id={fid(`med-gen-${row.key}`)} label="Principio activo (opcional)">
                        {(control) => (
                          <MedicationPicker
                            id={control.id}
                            value={field.state.value}
                            disabled={readOnly}
                            onChange={(dci) => {
                              field.handleChange(dci)
                              // Sin nombre aún, el nombre es la misma DCI.
                              if (row.name.trim() === "" && dci)
                                form.setFieldValue(`medications[${index}].name`, capitalize(dci))
                            }}
                          />
                        )}
                      </field.Control>
                    )}
                  </form.AppField>
                  <div className="flex flex-col gap-2">
                    <div className="flex items-start gap-2">
                      <form.AppField name={`medications[${index}].doseValue`}>
                        {(field) => (
                          <field.Control
                            id={fid(`med-dos-${row.key}`)}
                            className="w-28"
                            label="Dosis (opcional)"
                          >
                            {(control) => (
                              <Input
                                {...control.props}
                                aria-describedby={
                                  [control.describedBy, legacyDose ? fid(`med-dos-ant-${row.key}`) : null]
                                    .filter(Boolean)
                                    .join(" ") || undefined
                                }
                                inputMode="decimal"
                                value={field.state.value}
                                disabled={readOnly}
                                placeholder="500"
                                onChange={(e) => field.handleChange(e.target.value.replace(/[^\d.,]/g, ""))}
                              />
                            )}
                          </field.Control>
                        )}
                      </form.AppField>
                      <form.AppField name={`medications[${index}].doseUnit`}>
                        {(field) => (
                          <field.SelectField
                            id={fid(`med-uni-${row.key}`)}
                            className="min-w-0 flex-1"
                            label="Unidad de la dosis"
                            hideLabel
                            options={UNIT_OPTIONS}
                            disabled={readOnly}
                          />
                        )}
                      </form.AppField>
                    </div>
                    {legacyDose ? (
                      <p id={fid(`med-dos-ant-${row.key}`)} className="text-xs text-muted-foreground">
                        Escrita antes: «{legacyDose}». Se conserva mientras no la cambies.
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-col gap-2">
                    <form.AppField name={`medications[${index}].frequencyCode`}>
                      {(field) => (
                        <field.Group legend="Frecuencia (opcional)">
                          {(control) => (
                            <ChoiceButtons
                              id={control.id}
                              invalid={control.invalid}
                              aria-describedby={control.describedBy}
                              onBlur={control.onBlur}
                              value={(field.state.value || null) as FrequencyChoice | null}
                              options={FREQUENCY_OPTIONS}
                              disabled={readOnly}
                              onChange={(next) => {
                                field.handleChange(next)
                                if (next !== "otra") form.setFieldValue(`medications[${index}].frequency`, "")
                              }}
                            />
                          )}
                        </field.Group>
                      )}
                    </form.AppField>
                    {row.frequencyCode === "otra" ? (
                      <form.AppField name={`medications[${index}].frequency`}>
                        {(field) => (
                          <field.TextField
                            id={fid(`med-fre-otra-${row.key}`)}
                            label="Otra frecuencia"
                            hideLabel
                            maxLength={HEALTH_NAME_MAX}
                            disabled={readOnly}
                            placeholder="Ej.: lunes, miércoles y viernes"
                          />
                        )}
                      </form.AppField>
                    ) : null}
                  </div>
                  <DateField
                    form={form}
                    name={`medications[${index}].startDate`}
                    id={fid(`med-ini-${row.key}`)}
                    label="Inicio"
                    readOnly={readOnly}
                  />
                  {row.persisted ? (
                    <DateField
                      form={form}
                      name={`medications[${index}].endDate`}
                      id={fid(`med-fin-${row.key}`)}
                      label="Fin (suspender)"
                      readOnly={readOnly}
                    />
                  ) : null}
                  <form.AppField name={`medications[${index}].notes`}>
                    {(field) => (
                      <field.TextareaField
                        id={fid(`med-not-${row.key}`)}
                        className={row.persisted ? "" : "sm:col-span-2"}
                        label="Notas"
                        rows={2}
                        maxLength={HEALTH_NOTES_MAX}
                        disabled={readOnly}
                      />
                    )}
                  </form.AppField>
                  {!row.persisted ? (
                    <div className="sm:col-span-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={readOnly}
                        onClick={() => rowsField.removeValue(index)}
                      >
                        Quitar fila
                      </Button>
                    </div>
                  ) : null}
                </div>
              )
            })}
            <div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={readOnly}
                onClick={() =>
                  rowsField.pushValue({
                    key: nextRowKey("med"),
                    name: "",
                    genericName: "",
                    dose: "",
                    doseValue: "",
                    doseUnit: "",
                    frequency: "",
                    frequencyCode: "",
                    startDate: "",
                    endDate: "",
                    notes: "",
                    persisted: false,
                  })
                }
              >
                Agregar otra
              </Button>
            </div>
          </div>
        )}
      </form.AppField>
    )
  },
})
