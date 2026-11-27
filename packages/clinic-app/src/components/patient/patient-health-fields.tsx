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
  MEDICATION_FREQUENCY_LABELS, type MedicationFrequency, FAMILY_KINSHIP_LABELS, kinshipFromWords, everydayConditionOf, frequencyCodeOf } from "@odentia/clinical"
import { Button, Input } from "@odentia/ui"
import { PastDateInput, withForm } from "@odentia/ui-patterns"
import { formOptions } from "@tanstack/react-form"
import { CONDITION_STATUS_LABELS, HEALTH_REVIEW_LABELS, type HealthReviewState } from "../../lib/patients"
import { ChoiceButtons } from "../choice-buttons"
import { DiagnosisSearch } from "./diagnosis-search"
import { MedicationPicker } from "./medication-picker"

/** Lo que respondió en una declaración, leído por el equipo: su «No sé» es «No sabe», como en la entrevista. */
export const DECLARATION_STATE_LABELS: Record<DeclarationState, string> = {
  unanswered: "Sin responder",
  unknown: "No sabe",
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

/**
 * Los grupos de lo que dijo en la consulta que «Corregir algo» deja puestos en el formulario: todo
 * menos las alergias, que tienen su propia lista (su «No sabe» se revisa en el aviso).
 */
export const SAID_HEALTH_IN_FORM = ["conditions", "medications", "anticoagulants", "boneMedicines", "personal", "gyneco", "medical", "dental", "family"] as const

/**
 * Un familiar como se lee (revisión final del 25 nov): «Hermana: cáncer de boca». Con las palabras que se
 * dijeron si las guardó (`notes`), y si no, el nombre de su parentesco.
 */
export function familyLine(row: { relationship: string; condition: string; notes?: string | null }): string {
  const label = row.notes?.trim() || FAMILY_KINSHIP_LABELS[row.relationship as keyof typeof FAMILY_KINSHIP_LABELS] || "Otro familiar"
  return `${label.replace(/^./u, (letter) => letter.toLocaleUpperCase("es"))}: ${row.condition}`
}

/** El código del parentesco de un familiar dicho («abuelo materno», «tía materna»); sin código, otro familiar. */
export function familyKinshipFromWords(words: string): string {
  const plain = words.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/^(?:su|sus|mi|mis)\s+/, "").trim()
  return kinshipFromWords(plain) ?? (/^tia (materna|paterna)$/.test(plain) ? "AUNT" : /^tio (materno|paterno)$/.test(plain) ? "UNCLE" : "FAMMEMB")
}

/**
 * Lo que dejó de tomar en el último año, con el día: «apixabán, lo dejó el 24 nov» (revisión final
 * del 25 nov: lo terminado con «Sí, lo dejó» no se leía en ninguna parte).
 */
export function endedMedicineWords(rows: ReadonlyArray<{ name: string; endDate?: string | null }>, today: string): string[] {
  const yearAgo = `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`
  return rows
    .filter((row) => !!row.endDate && row.endDate < today && row.endDate >= yearAgo)
    .sort((a, b) => (b.endDate ?? "").localeCompare(a.endDate ?? ""))
    .slice(0, 5)
    .map((row) => `${row.name}, lo dejó el ${new Date(`${row.endDate}T12:00:00Z`).toLocaleDateString("es", { day: "numeric", month: "short", timeZone: "UTC" }).replace(".", "")}`)
}

/**
 * Lo que oyó Clío, para el formulario: `health` con la forma de su registro y `interview` ya con
 * las claves de la entrevista de su producto (lo arma el servidor, la misma regla que al confirmarla).
 */
export interface SaidForForm {
  health: Record<string, unknown>
  interview?: Record<string, unknown>
}

/**
 * «Corregir algo» desde lo que Clío oyó en la consulta (mesa del 20 nov 2026): el formulario de
 * Antecedentes se abre con sus enfermedades y sus medicinas ya puestas (también el anticoagulante y
 * la medicina para los huesos, que son medicinas) y con lo de su entrevista (la anestesia, el
 * corazón, el miedo, el embarazo; lo de cada producto), para corregir y no escribir de cero. Lo que
 * ya estaba con el mismo nombre no se repite; en la entrevista, lo dicho va encima, campo por campo.
 */
export function withSaidHealth(values: HealthFormValues, { health: said, interview: saidInterview = {} }: SaidForForm): HealthFormValues {
  const loose = (text: string) =>
    text
      .toLocaleLowerCase("es")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .trim()
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "")
  const group = (key: string) => {
    const value = said[key]
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null
  }
  const items = (key: string) => {
    const value = group(key)
    return value?.state === "recorded" && Array.isArray(value.items) ? (value.items as Array<Record<string, unknown>>) : []
  }
  const conditions = [...values.conditions]
  for (const item of items("conditions")) {
    const name = text(item.name)
    if (!name || conditions.some((row) => loose(row.name) === loose(name))) continue
    conditions.push({ key: nextRowKey("con"), name, diagnosisCode: "", diagnosisSystem: null, status: "activa", startDate: "", endDate: "", notes: text(item.notes), persisted: false })
  }
  const medications = [...values.medications]
  const named = [
    ...items("medications").map((item) => ({ name: text(item.name), dose: text(item.dose), frequency: text(item.frequency), notes: text(item.notes) })),
    ...(["anticoagulants", "boneMedicines"] as const).flatMap((key) => {
      const value = group(key)
      return value?.state === "recorded" && text(value.detail) ? [{ name: text(value.detail), dose: "", frequency: "", notes: "" }] : []
    }),
  ]
  for (const item of named) {
    if (!item.name || medications.some((row) => loose(row.name) === loose(item.name))) continue
    medications.push({
      key: nextRowKey("med"),
      name: item.name,
      genericName: "",
      dose: item.dose,
      doseValue: "",
      doseUnit: "",
      frequency: item.frequency,
      // Lo dicho que es una de la lista («dos veces al día») queda elegida en ella, con lo dicho al lado.
      frequencyCode: item.frequency ? (frequencyCodeOf(item.frequency) ?? "otra") : "",
      startDate: "",
      endDate: "",
      notes: item.notes,
      persisted: false,
    })
  }
  // Lo que dijo que no (y nada anotado) queda «No»; lo que nombró, «Sí».
  const state = (key: "conditions" | "medications", rows: readonly unknown[]): HealthReviewState => {
    if (rows.length > 0) return "recorded"
    return group(key)?.state === "none" ? "none" : values.reviewStatus[key]
  }
  // Lo de la entrevista, grupo por grupo y campo por campo: lo anotado que no se dijo se queda.
  const interview: Record<string, unknown> = { ...values.interview }
  for (const [key, value] of Object.entries(saidInterview)) {
    const before = interview[key]
    const isGroup = (item: unknown): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item)
    interview[key] = isGroup(value) && isGroup(before) ? { ...before, ...value } : value
  }
  // Lo de su familia que oyó Clío, para corregirlo antes de guardarlo (revisión final del 25 nov).
  const familyHistory = [...values.familyHistory]
  for (const item of items("family")) {
    const condition = text(item.name)
    const relationship = familyKinshipFromWords(text(item.relation))
    if (!condition || familyHistory.some((row) => row.relationship === relationship && loose(row.condition) === loose(condition))) continue
    familyHistory.push({ key: nextRowKey("fam"), relationship, condition, diagnosisCode: "", diagnosisSystem: null })
  }
  return {
    ...values,
    conditions,
    medications,
    familyHistory,
    reviewStatus: { conditions: state("conditions", conditions), medications: state("medications", medications) },
    interview,
  }
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
                <div className="flex flex-col gap-1">
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
                  {/* «Presión» dicha: se sugiere la del catálogo y la elige quien atiende (QA del 26 nov). */}
                  {everydayConditionOf(row.name) ? (
                    <p className="flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
                      Sugerencia: {everydayConditionOf(row.name)?.toLocaleLowerCase("es")}.
                      <Button
                        type="button"
                        variant="link"
                        size="sm"
                        className="h-auto min-h-11 px-1 sm:min-h-0"
                        disabled={readOnly}
                        onClick={() => form.setFieldValue(`conditions[${index}].name`, everydayConditionOf(row.name) ?? row.name)}
                      >
                        Usar «{everydayConditionOf(row.name)}»
                      </Button>
                    </p>
                  ) : null}
                </div>
                {/* «Quitar código» lo trae el buscador, junto al código elegido: no se repite
                    debajo (repaso final de la ficha, B6). */}
                <form.AppField name={`conditions[${index}].diagnosisCode`}>
                  {(field) => (
                    <field.Control
                      id={fid(`con-dx-${row.key}`)}
                      label="Código de diagnóstico (opcional)"
                    >
                      {(control) => (
                        <DiagnosisSearch
                          id={control.id}
                          invalid={control.invalid}
                          aria-describedby={control.describedBy}
                          onBlur={control.onBlur}
                          value={field.state.value}
                          system={row.diagnosisSystem}
                          onChange={(code, description, system) => {
                            field.handleChange(code)
                            form.setFieldValue(`conditions[${index}].diagnosisSystem`, system)
                            // El nombre vacío toma el del código; lo escrito no se pisa (QA de la ficha del 10 nov, B3).
                            if (code && description && !form.getFieldValue(`conditions[${index}].name`)?.trim())
                              form.setFieldValue(`conditions[${index}].name`, description.slice(0, HEALTH_NAME_MAX))
                          }}
                          disabled={readOnly}
                        />
                      )}
                    </field.Control>
                  )}
                </form.AppField>
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

/** La frecuencia de la lista, por su código; vacío si no es de la lista. */
const frequencyLabel = (code: string): string =>
  (MEDICATION_FREQUENCIES as readonly string[]).includes(code) ? MEDICATION_FREQUENCY_LABELS[code as MedicationFrequency] : ""

/**
 * Cada cuánto la toma, como se dijo («2 veces al día») o, sin eso, el nombre de la de la lista, en
 * minúscula para ir dentro de una línea (QA del 26 nov: lo dicho se guardaba como «Cada 12 horas»).
 */
export function frequencyWords(frequency: string | null | undefined, code: string | null | undefined): string {
  const said = frequency?.trim() || frequencyLabel(code ?? "")
  return said ? said.charAt(0).toLocaleLowerCase("es") + said.slice(1) : ""
}

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
                    {/* Lo dicho que dice lo mismo que la de la lista: se ve como se dijo (QA del 26 nov). */}
                    {row.frequencyCode !== "otra" && row.frequency.trim() && row.frequency.trim().toLocaleLowerCase("es") !== frequencyLabel(row.frequencyCode).toLocaleLowerCase("es") ? (
                      <p className="text-xs text-muted-foreground">Se dijo: «{row.frequency.trim()}».</p>
                    ) : null}
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
