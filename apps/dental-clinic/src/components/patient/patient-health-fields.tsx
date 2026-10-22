/**
 * Controles de salud compartidos entre la ficha clínica y el registro declarado.
 *
 * Composición de dominio sin queries ni `useCanWrite`: los padres aportan
 * valores/onChange/readOnly y conservan sus propios hooks. Las filas de
 * alergias/condiciones/medicación se definen aquí una sola vez; la pantalla
 * clínica y `RegistrationHealthFields` las consumen sin copiarlas.
 */

import {
  BLOOD_GROUPS,
  type BloodGroup,
  type DeclarationState,
  type HealthAllergyDeclaration,
  type HealthConditionDeclaration,
  type HealthMedicationDeclaration,
  type RegistrationAnswers,
  type RegistrationConfig,
  ALLERGY_SEVERITIES,
  CONDITION_STATUSES,
  DOSE_UNIT_LABELS,
  DOSE_UNITS,
  type DoseUnit,
  MEDICATION_FREQUENCIES,
  MEDICATION_FREQUENCY_LABELS,
} from "@odentia/clinical"
import {
  Badge,
  Button,
  Checkbox,
  Field,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@odentia/ui"
import { ConfirmDialog, PastDateInput } from "@odentia/ui-patterns"
import type { ReactNode } from "react"
import { useId, useState } from "react"
import {
  ALLERGY_CATEGORY_LABELS,
  ALLERGY_SEVERITY_LABELS,
  CONDITION_STATUS_LABELS,
  HEALTH_REVIEW_LABELS,
  type HealthReviewState,
} from "../../lib/patients"
import { ChoiceButtons } from "../choice-buttons"
import { ChoiceSelect } from "../ui/choice-select"
import { DiagnosisSearch } from "./diagnosis-search"
import { MedicationPicker } from "./medication-picker"

export type HealthDeclaration = NonNullable<RegistrationAnswers["health"]>

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

// Las listas de `@odentia/clinical`, las mismas que valida el servidor.
export const ALLERGY_SEVERITY_OPTIONS = ALLERGY_SEVERITIES
export const CONDITION_STATUS_OPTIONS = CONDITION_STATUSES

let rowSeq = 0
function nextRowKey(prefix: string): string {
  rowSeq += 1
  return `${prefix}-${rowSeq}`
}

/** Primera coincidencia no vacía entre candidatos (id clínico exacto o clave semántica). */
function pickError(
  errors: Record<string, string> | undefined,
  candidates: string[],
): string | undefined {
  if (!errors) return undefined
  for (const key of candidates) {
    const message = errors[key]
    if (message) return message
  }
  return undefined
}

/* ------------------------------------------------------------------ */
/* Grupo sanguíneo                                                     */
/* ------------------------------------------------------------------ */

export function BloodGroupSelect({
  id,
  value,
  onChange,
  readOnly,
  error,
  declared,
}: {
  id: string
  value: BloodGroup | null | undefined
  onChange: (next: BloodGroup | null) => void
  readOnly?: boolean
  error?: string
  /** Origen declarado: muestra que la revisión clínica no es confirmación de laboratorio. */
  declared?: boolean
}): React.JSX.Element {
  return (
    <Field>
      <FieldLabel htmlFor={id}>Grupo sanguíneo</FieldLabel>
      <Select
        value={value ?? "sin-responder"}
        onValueChange={(v) => onChange(v === "sin-responder" ? null : (v as BloodGroup))}
        disabled={readOnly}
      >
        <SelectTrigger id={id}>
          <SelectValue>{value ? BLOOD_GROUP_LABELS[value] : "Sin responder"}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="sin-responder">Sin responder</SelectItem>
          {BLOOD_GROUPS.map((group) => (
            <SelectItem key={group} value={group}>
              {BLOOD_GROUP_LABELS[group]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {declared ? (
        <p className="text-xs text-muted-foreground">
          Valor declarado por el paciente/responsable: la revisión clínica no equivale a
          confirmación de laboratorio.
        </p>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </Field>
  )
}

/* ------------------------------------------------------------------ */
/* Selectores de estado                                                */
/* ------------------------------------------------------------------ */

/** Respuesta declarada Sí/No/No sé/Sin responder (registro público e interno). */
export function DeclarationStateSelect({
  id,
  value,
  onChange,
  readOnly,
  error,
  label,
}: {
  id: string
  value: DeclarationState
  onChange: (next: DeclarationState) => void
  readOnly?: boolean
  error?: string
  label?: string
}): React.JSX.Element {
  // Tres botones a la vista; «Sin responder» es no haber tocado ninguno.
  const options = (["none", "recorded", "unknown"] as const).map((option) => ({
    value: option,
    label: DECLARATION_STATE_LABELS[option],
  }))
  return (
    <Field>
      <FieldLabel id={id}>{label ?? "Respuesta"}</FieldLabel>
      <ChoiceButtons
        label={label ?? "Respuesta"}
        value={value === "unanswered" ? null : value}
        options={options}
        onChange={(next) => onChange(next)}
        disabled={readOnly}
      />
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </Field>
  )
}

/** Estado de revisión clínica: no se le preguntó, niega o registrados (ficha interna). */
export function ReviewStateSelect({
  id,
  value,
  onChange,
  readOnly,
  error,
}: {
  id: string
  value: HealthReviewState
  onChange: (next: HealthReviewState) => void
  readOnly?: boolean
  error?: string
}): React.JSX.Element {
  const options: HealthReviewState[] = ["unknown", "recorded", "none"]
  return (
    <Field>
      <FieldLabel htmlFor={id}>Revisión del grupo</FieldLabel>
      <Select
        value={value}
        onValueChange={(v) => onChange(v as HealthReviewState)}
        disabled={readOnly}
      >
        <SelectTrigger id={id}>
          <SelectValue>{HEALTH_REVIEW_LABELS[value]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {HEALTH_REVIEW_LABELS[option]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </Field>
  )
}

/* ------------------------------------------------------------------ */
/* Filas compartidas (modo clínico completo o declaración reducida)    */
/* ------------------------------------------------------------------ */

export interface AllergyRowValue {
  key: string
  substance: string
  /** Tipo de alérgeno; solo en modo clínico. */
  category?: string
  reaction: string
  severity: string
  /** Alergia o intolerancia, criticidad y verificación; solo en modo clínico. */
  kind?: string
  criticality?: string
  verification?: string
  isActive: boolean
  persisted?: boolean
}

export interface ConditionRowValue {
  key: string
  name: string
  /** Código de la lista de diagnósticos que precisa la condición; solo en modo clínico. */
  diagnosisCode?: string
  /** Su lista: la de la clínica en uno nuevo; uno guardado conserva la suya. */
  diagnosisSystem?: string | null
  status: string
  startDate: string
  endDate: string
  notes: string
  persisted?: boolean
}

export interface MedicationRowValue {
  key: string
  name: string
  /** Principio activo (DCI); solo en modo clínico. */
  genericName?: string
  /** Lo escrito antes del cambio (o en la declaración); con número y unidad se escribe solo. */
  dose: string
  /** Número y unidad UCUM de la dosis; solo en modo clínico. */
  doseValue?: string
  doseUnit?: string
  frequency: string
  /** Frecuencia de la lista (`MEDICATION_FREQUENCIES`); «otra» deja `frequency` escrita. */
  frequencyCode?: string
  startDate: string
  endDate: string
  notes: string
  persisted?: boolean
}

export type HealthRowsMode = "clinical" | "declaration"

interface RowsBase {
  readOnly?: boolean
  errors?: Record<string, string>
  idPrefix: string
  mode: HealthRowsMode
}

function RowError({ message }: { message: string | undefined }): React.JSX.Element | null {
  if (!message) return null
  return <p className="text-sm text-destructive">{message}</p>
}

export function AllergyRows({
  rows,
  onChange,
  readOnly,
  errors,
  idPrefix,
}: RowsBase & {
  rows: AllergyRowValue[]
  onChange: (next: AllergyRowValue[]) => void
}): React.JSX.Element {
  const fid = (name: string): string => `${idPrefix}-${name}`
  const patch = (key: string, next: Partial<AllergyRowValue>): void => {
    onChange(rows.map((row) => (row.key === key ? { ...row, ...next } : row)))
  }
  return (
    <div className="flex flex-col gap-3">
      {rows.map((row, index) => (
        <div key={row.key} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={fid(`alg-sus-${row.key}`)}>Sustancia</FieldLabel>
            <Input
              id={fid(`alg-sus-${row.key}`)}
              value={row.substance}
              disabled={readOnly}
              onChange={(e) => patch(row.key, { substance: e.target.value })}
            />
            <RowError
              message={pickError(errors, [
                fid(`alg-sus-${row.key}`),
                `allergies.${index}.substance`,
                `allergies.items.${index}.substance`,
                `health.allergies.items.${index}.substance`,
              ])}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={fid(`alg-rea-${row.key}`)}>Reacción</FieldLabel>
            <Input
              id={fid(`alg-rea-${row.key}`)}
              value={row.reaction}
              disabled={readOnly}
              onChange={(e) => patch(row.key, { reaction: e.target.value })}
            />
            <RowError
              message={pickError(errors, [
                fid(`alg-rea-${row.key}`),
                `allergies.${index}.reaction`,
                `allergies.items.${index}.reaction`,
              ])}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={fid(`alg-sev-${row.key}`)}>Gravedad</FieldLabel>
            <Select
              value={row.severity === "" ? "__elegir__" : row.severity}
              onValueChange={(v) => patch(row.key, { severity: !v || v === "__elegir__" ? "" : v })}
              disabled={readOnly}
            >
              <SelectTrigger id={fid(`alg-sev-${row.key}`)}>
                <SelectValue>
                  {ALLERGY_SEVERITY_LABELS[row.severity] ?? "Elige la gravedad"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__elegir__">Elige la gravedad</SelectItem>
                {ALLERGY_SEVERITY_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {ALLERGY_SEVERITY_LABELS[option] ?? option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <RowError
              message={pickError(errors, [
                fid(`alg-sev-${row.key}`),
                `allergies.${index}.severity`,
                `allergies.items.${index}.severity`,
              ])}
            />
            <p className="text-xs text-muted-foreground">
              Si se desconoce, márcala como desconocida: sigue siendo alerta.
            </p>
          </Field>
          <div className="flex items-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={readOnly}
              onClick={() => onChange(rows.filter((r) => r.key !== row.key))}
            >
              Quitar fila
            </Button>
          </div>
        </div>
      ))}
      <div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={readOnly}
          onClick={() =>
            onChange([
              ...rows,
              { key: nextRowKey("alg"), substance: "", reaction: "", severity: "", isActive: true },
            ])
          }
        >
          Agregar otra
        </Button>
      </div>
    </div>
  )
}

export function ConditionRows({
  rows,
  onChange,
  readOnly,
  errors,
  idPrefix,
  mode,
}: RowsBase & {
  rows: ConditionRowValue[]
  onChange: (next: ConditionRowValue[]) => void
}): React.JSX.Element {
  const fid = (name: string): string => `${idPrefix}-${name}`
  const patch = (key: string, next: Partial<ConditionRowValue>): void => {
    onChange(rows.map((row) => (row.key === key ? { ...row, ...next } : row)))
  }
  return (
    <div className="flex flex-col gap-3">
      {rows.map((row, index) => (
        <div key={row.key} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={fid(`con-nom-${row.key}`)}>Nombre</FieldLabel>
            <Input
              id={fid(`con-nom-${row.key}`)}
              value={row.name}
              disabled={readOnly}
              onChange={(e) => patch(row.key, { name: e.target.value })}
            />
            <RowError
              message={pickError(errors, [
                fid(`con-nom-${row.key}`),
                `conditions.${index}.name`,
                `conditions.items.${index}.name`,
                `health.conditions.items.${index}.name`,
              ])}
            />
          </Field>
          {mode === "clinical" ? (
            <div className="flex flex-col gap-1">
              <DiagnosisSearch
                value={row.diagnosisCode ?? ""}
                system={row.diagnosisSystem ?? null}
                onChange={(code, _description, system) => patch(row.key, { diagnosisCode: code, diagnosisSystem: system })}
                label="Código de diagnóstico (opcional)"
                disabled={readOnly}
              />
              {row.diagnosisCode ? (
                <button
                  type="button"
                  className="self-start text-xs text-muted-foreground underline underline-offset-4"
                  disabled={readOnly}
                  onClick={() => patch(row.key, { diagnosisCode: "", diagnosisSystem: null })}
                >
                  Quitar el código {row.diagnosisCode}
                </button>
              ) : null}
            </div>
          ) : null}
          {mode === "clinical" ? (
            <Field>
              <FieldLabel htmlFor={fid(`con-est-${row.key}`)}>Estado</FieldLabel>
              <Select
                value={row.status}
                onValueChange={(v) => patch(row.key, { status: v ?? "activa" })}
                disabled={readOnly}
              >
                <SelectTrigger id={fid(`con-est-${row.key}`)}>
                  <SelectValue>{CONDITION_STATUS_LABELS[row.status] ?? row.status}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {CONDITION_STATUS_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {CONDITION_STATUS_LABELS[option] ?? option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <RowError message={pickError(errors, [fid(`con-est-${row.key}`)])} />
            </Field>
          ) : null}
          {mode === "clinical" ? (
            <Field>
              <FieldLabel htmlFor={fid(`con-ini-${row.key}`)}>Inicio</FieldLabel>
              <PastDateInput
                id={fid(`con-ini-${row.key}`)}
                value={row.startDate}
                disabled={readOnly}
                onChange={(next) => patch(row.key, { startDate: next })}
              />
              <RowError message={pickError(errors, [fid(`con-ini-${row.key}`)])} />
            </Field>
          ) : null}
          {mode === "clinical" ? (
            <Field>
              <FieldLabel htmlFor={fid(`con-fin-${row.key}`)}>Fin (vacío = activa)</FieldLabel>
              <PastDateInput
                id={fid(`con-fin-${row.key}`)}
                value={row.endDate}
                disabled={readOnly}
                onChange={(next) => patch(row.key, { endDate: next })}
              />
              <RowError message={pickError(errors, [fid(`con-fin-${row.key}`)])} />
            </Field>
          ) : null}
          <Field className="sm:col-span-2">
            <FieldLabel htmlFor={fid(`con-not-${row.key}`)}>Notas</FieldLabel>
            <Textarea
              id={fid(`con-not-${row.key}`)}
              rows={2}
              value={row.notes}
              disabled={readOnly}
              onChange={(e) => patch(row.key, { notes: e.target.value })}
            />
          </Field>
          {mode === "declaration" || !row.persisted ? (
            <div className="sm:col-span-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={readOnly}
                onClick={() => onChange(rows.filter((r) => r.key !== row.key))}
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
            onChange([
              ...rows,
              {
                key: nextRowKey("con"),
                name: "",
                status: "activa",
                startDate: "",
                endDate: "",
                notes: "",
              },
            ])
          }
        >
          Agregar otra
        </Button>
      </div>
    </div>
  )
}

function capitalize(text: string): string {
  return text.charAt(0).toLocaleUpperCase("es") + text.slice(1)
}

const FREQUENCY_OPTIONS = [
  ...MEDICATION_FREQUENCIES.map((value) => ({ value, label: MEDICATION_FREQUENCY_LABELS[value] })),
  { value: "otra" as const, label: "Otra" },
]

/**
 * La dosis con número y unidad (UCUM) y la frecuencia elegida de la lista,
 * como en la receta (tablero 7). Lo escrito antes del cambio se muestra y se
 * conserva mientras no se elija otra cosa: es el respaldo.
 */
function ClinicalDoseFields({
  row,
  fid,
  readOnly,
  errors,
  onPatch,
}: {
  row: MedicationRowValue
  fid: (name: string) => string
  readOnly?: boolean
  errors?: Record<string, string>
  onPatch: (next: Partial<MedicationRowValue>) => void
}): React.JSX.Element {
  const frequencyChoice = row.frequencyCode || (row.frequency.trim() ? "otra" : null)
  const legacyDose = !row.doseValue && row.dose.trim() ? row.dose.trim() : null
  return (
    <>
      <Field>
        <FieldLabel htmlFor={fid(`med-dos-${row.key}`)}>Dosis (opcional)</FieldLabel>
        <div className="flex gap-2">
          <Input
            id={fid(`med-dos-${row.key}`)}
            inputMode="decimal"
            className="w-28"
            value={row.doseValue ?? ""}
            disabled={readOnly}
            placeholder="500"
            aria-describedby={legacyDose ? fid(`med-dos-ant-${row.key}`) : undefined}
            onChange={(e) => onPatch({ doseValue: e.target.value.replace(/[^\d.,]/g, "") })}
          />
          <Select
            value={row.doseUnit || "__elegir__"}
            onValueChange={(v) => onPatch({ doseUnit: !v || v === "__elegir__" ? "" : v })}
            disabled={readOnly}
          >
            <SelectTrigger id={fid(`med-uni-${row.key}`)} aria-label="Unidad de la dosis" className="min-w-0 flex-1">
              <SelectValue>{row.doseUnit ? (DOSE_UNIT_LABELS[row.doseUnit as DoseUnit]?.[1] ?? row.doseUnit) : "Unidad"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {DOSE_UNITS.map((unit) => (
                <SelectItem key={unit} value={unit}>
                  {DOSE_UNIT_LABELS[unit][1]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {legacyDose ? (
          <p id={fid(`med-dos-ant-${row.key}`)} className="text-xs text-muted-foreground">
            Escrita antes: «{legacyDose}». Se conserva mientras no la cambies.
          </p>
        ) : null}
        <RowError message={pickError(errors, [fid(`med-dos-${row.key}`), fid(`med-uni-${row.key}`)])} />
      </Field>
      <Field>
        <FieldLabel id={fid(`med-fre-${row.key}`)}>Frecuencia (opcional)</FieldLabel>
        <ChoiceButtons
          label="Frecuencia"
          value={frequencyChoice as (typeof FREQUENCY_OPTIONS)[number]["value"] | null}
          options={FREQUENCY_OPTIONS}
          disabled={readOnly}
          onChange={(next) =>
            onPatch(next === "otra" ? { frequencyCode: "" } : { frequencyCode: next, frequency: "" })
          }
        />
        {frequencyChoice === "otra" ? (
          <Input
            aria-label="Otra frecuencia"
            value={row.frequency}
            disabled={readOnly}
            placeholder="Ej.: lunes, miércoles y viernes"
            onChange={(e) => onPatch({ frequency: e.target.value })}
          />
        ) : null}
      </Field>
    </>
  )
}

export function MedicationRows({
  rows,
  onChange,
  readOnly,
  errors,
  idPrefix,
  mode,
}: RowsBase & {
  rows: MedicationRowValue[]
  onChange: (next: MedicationRowValue[]) => void
}): React.JSX.Element {
  const fid = (name: string): string => `${idPrefix}-${name}`
  const patch = (key: string, next: Partial<MedicationRowValue>): void => {
    onChange(rows.map((row) => (row.key === key ? { ...row, ...next } : row)))
  }
  return (
    <div className="flex flex-col gap-3">
      {rows.map((row, index) => (
        <div key={row.key} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={fid(`med-nom-${row.key}`)}>Nombre</FieldLabel>
            <Input
              id={fid(`med-nom-${row.key}`)}
              value={row.name}
              disabled={readOnly}
              onChange={(e) => patch(row.key, { name: e.target.value })}
            />
            <RowError
              message={pickError(errors, [
                fid(`med-nom-${row.key}`),
                `medications.${index}.name`,
                `medications.items.${index}.name`,
                `health.medications.items.${index}.name`,
              ])}
            />
          </Field>
          {mode === "clinical" ? (
            <Field>
              <FieldLabel htmlFor={fid(`med-gen-${row.key}`)}>
                Principio activo (opcional)
              </FieldLabel>
              <MedicationPicker
                id={fid(`med-gen-${row.key}`)}
                value={row.genericName ?? ""}
                disabled={readOnly}
                onChange={(dci) =>
                  // Sin nombre aún, el nombre es la misma DCI.
                  patch(row.key, { genericName: dci, ...(row.name.trim() === "" && dci ? { name: capitalize(dci) } : {}) })
                }
              />
            </Field>
          ) : null}
          {mode === "clinical" ? (
            <ClinicalDoseFields row={row} fid={fid} readOnly={readOnly} errors={errors} onPatch={(next) => patch(row.key, next)} />
          ) : (
            <>
              <Field>
                <FieldLabel htmlFor={fid(`med-dos-${row.key}`)}>Dosis</FieldLabel>
                <Input
                  id={fid(`med-dos-${row.key}`)}
                  value={row.dose}
                  disabled={readOnly}
                  placeholder="Se deja vacío si se desconoce, no se inventa"
                  onChange={(e) => patch(row.key, { dose: e.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={fid(`med-fre-${row.key}`)}>Frecuencia</FieldLabel>
                <Input
                  id={fid(`med-fre-${row.key}`)}
                  value={row.frequency}
                  disabled={readOnly}
                  onChange={(e) => patch(row.key, { frequency: e.target.value })}
                />
              </Field>
            </>
          )}
          {mode === "clinical" ? (
            <Field>
              <FieldLabel htmlFor={fid(`med-ini-${row.key}`)}>Inicio</FieldLabel>
              <PastDateInput
                id={fid(`med-ini-${row.key}`)}
                value={row.startDate}
                disabled={readOnly}
                onChange={(next) => patch(row.key, { startDate: next })}
              />
              <RowError message={pickError(errors, [fid(`med-ini-${row.key}`)])} />
            </Field>
          ) : null}
          {mode === "clinical" && row.persisted ? (
            <Field>
              <FieldLabel htmlFor={fid(`med-fin-${row.key}`)}>Fin (suspender)</FieldLabel>
              <PastDateInput
                id={fid(`med-fin-${row.key}`)}
                value={row.endDate}
                disabled={readOnly}
                onChange={(next) => patch(row.key, { endDate: next })}
              />
              <RowError message={pickError(errors, [fid(`med-fin-${row.key}`)])} />
            </Field>
          ) : null}
          <Field className={mode === "clinical" && row.persisted ? "" : "sm:col-span-2"}>
            <FieldLabel htmlFor={fid(`med-not-${row.key}`)}>Notas</FieldLabel>
            <Textarea
              id={fid(`med-not-${row.key}`)}
              rows={2}
              value={row.notes}
              disabled={readOnly}
              onChange={(e) => patch(row.key, { notes: e.target.value })}
            />
          </Field>
          {mode === "declaration" || !row.persisted ? (
            <div className="sm:col-span-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={readOnly}
                onClick={() => onChange(rows.filter((r) => r.key !== row.key))}
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
            onChange([
              ...rows,
              {
                key: nextRowKey("med"),
                name: "",
                dose: "",
                frequency: "",
                startDate: "",
                endDate: "",
                notes: "",
              },
            ])
          }
        >
          Agregar otra
        </Button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Grupos de declaración (wizard público e interno)                    */
/* ------------------------------------------------------------------ */

function useDiscardConfirm<T extends { items: unknown[] }>(
  value: T,
  onChange: (next: T) => void,
): {
  pending: DeclarationState | null
  request: (next: DeclarationState, empty: T) => void
  close: () => void
  confirm: () => void
  count: number
} {
  const [pending, setPending] = useState<DeclarationState | null>(null)
  return {
    pending,
    request: (next, empty) => {
      if (next !== "recorded" && value.items.length > 0) {
        setPending(next)
        return
      }
      onChange(next === "recorded" ? { ...value, state: next } : empty)
    },
    close: () => setPending(null),
    confirm: () => {
      if (pending === null) return
      const cleared = { ...value, state: pending, items: [] }
      setPending(null)
      onChange(cleared as T)
    },
    count: value.items.length,
  }
}

function DiscardConfirm({
  open,
  count,
  state,
  onClose,
  onConfirm,
}: {
  open: boolean
  count: number
  state: DeclarationState | null
  onClose: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onConfirm={onConfirm}
      title="Quitar filas del borrador"
      description={`Cambiar la respuesta a «${state ? DECLARATION_STATE_LABELS[state] : ""}» quitará ${count} fila${count === 1 ? "" : "s"} del borrador. Esta acción no se puede deshacer.`}
      confirmLabel="Quitar filas"
    />
  )
}

function emptyHintFor(state: DeclarationState, noun: string): string {
  if (state === "none") return `El declarante indica que no tiene ${noun}.`
  if (state === "unknown") return "El declarante indica que no sabe."
  if (state === "recorded") return "Agrega al menos una entrada."
  return "Sin responder."
}

function DeclarationGroupShell({
  title,
  stateId,
  state,
  stateError,
  onStateChange,
  question,
  readOnly,
  emptyHint,
  confirm,
  children,
}: {
  title: string
  stateId: string
  state: DeclarationState
  stateError?: string
  onStateChange: (next: DeclarationState) => void
  question: string
  readOnly?: boolean
  emptyHint: string
  confirm: ReactNode
  children: (hasRows: boolean) => ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6 elevated rounded-xl border bg-card p-6">
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="font-heading text-base font-medium">{title}</div>
          <Badge variant={state === "recorded" ? "default" : "outline"}>
            {DECLARATION_STATE_LABELS[state]}
          </Badge>
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <DeclarationStateSelect
          id={stateId}
          value={state}
          onChange={onStateChange}
          readOnly={readOnly}
          error={stateError}
          label={question}
        />
        {children(true)}
        {emptyHint ? <p className="text-sm text-muted-foreground">{emptyHint}</p> : null}
        {confirm}
      </div>
    </div>
  )
}

function declarationItems<T>(state: DeclarationState, items: T[]): T[] {
  return state === "recorded" ? items : []
}

export function AllergyDeclarationGroup({
  value,
  onChange,
  readOnly,
  errors,
  idPrefix,
}: {
  value: { state: DeclarationState; items: HealthAllergyDeclaration[] }
  onChange: (next: { state: DeclarationState; items: HealthAllergyDeclaration[] }) => void
  readOnly?: boolean
  errors?: Record<string, string>
  idPrefix: string
}): React.JSX.Element {
  const confirm = useDiscardConfirm(value, onChange)
  const rows: AllergyRowValue[] = value.items.map((item, index) => ({
    key: `dcl-alg-${index}`,
    substance: item.substance,
    reaction: item.reaction ?? "",
    severity: item.severity,
    isActive: true,
  }))
  return (
    <DeclarationGroupShell
      title="Alergias"
      stateId={`${idPrefix}-alg-estado`}
      state={value.state}
      stateError={pickError(errors, [
        `${idPrefix}-alg-estado`,
        "allergies.state",
        "health.allergies.state",
      ])}
      onStateChange={(next) =>
        confirm.request(next, { state: next, items: [] as HealthAllergyDeclaration[] })
      }
      question="¿Tiene alergias?"
      readOnly={readOnly}
      emptyHint={rows.length === 0 ? emptyHintFor(value.state, "alergias") : ""}
      confirm={
        <DiscardConfirm
          open={confirm.pending !== null}
          count={confirm.count}
          state={confirm.pending}
          onClose={confirm.close}
          onConfirm={confirm.confirm}
        />
      }
    >
      {() =>
        value.state === "recorded" || rows.length > 0 ? (
          <AllergyRows
            mode="declaration"
            rows={rows}
            onChange={(next) =>
              onChange({
                state: value.state,
                items: declarationItems(
                  value.state,
                  next.map((row) => ({
                    substance: row.substance,
                    ...(row.reaction.trim() === "" ? {} : { reaction: row.reaction }),
                    severity: (row.severity === ""
                      ? "desconocida"
                      : row.severity) as HealthAllergyDeclaration["severity"],
                  })),
                ),
              })
            }
            readOnly={readOnly}
            errors={errors}
            idPrefix={idPrefix}
          />
        ) : null
      }
    </DeclarationGroupShell>
  )
}

export function ConditionDeclarationGroup({
  value,
  onChange,
  readOnly,
  errors,
  idPrefix,
}: {
  value: { state: DeclarationState; items: HealthConditionDeclaration[] }
  onChange: (next: { state: DeclarationState; items: HealthConditionDeclaration[] }) => void
  readOnly?: boolean
  errors?: Record<string, string>
  idPrefix: string
}): React.JSX.Element {
  const confirm = useDiscardConfirm(value, onChange)
  const rows: ConditionRowValue[] = value.items.map((item, index) => ({
    key: `dcl-con-${index}`,
    name: item.name,
    status: "activa",
    startDate: "",
    endDate: "",
    notes: item.notes ?? "",
  }))
  return (
    <DeclarationGroupShell
      title="Enfermedades"
      stateId={`${idPrefix}-con-estado`}
      state={value.state}
      stateError={pickError(errors, [
        `${idPrefix}-con-estado`,
        "conditions.state",
        "health.conditions.state",
      ])}
      onStateChange={(next) =>
        confirm.request(next, { state: next, items: [] as HealthConditionDeclaration[] })
      }
      question="¿Tiene alguna enfermedad actual?"
      readOnly={readOnly}
      emptyHint={rows.length === 0 ? emptyHintFor(value.state, "enfermedades actuales") : ""}
      confirm={
        <DiscardConfirm
          open={confirm.pending !== null}
          count={confirm.count}
          state={confirm.pending}
          onClose={confirm.close}
          onConfirm={confirm.confirm}
        />
      }
    >
      {() =>
        value.state === "recorded" || rows.length > 0 ? (
          <ConditionRows
            mode="declaration"
            rows={rows}
            onChange={(next) =>
              onChange({
                state: value.state,
                items: declarationItems(
                  value.state,
                  next.map((row) => ({
                    name: row.name,
                    ...(row.notes.trim() === "" ? {} : { notes: row.notes }),
                  })),
                ),
              })
            }
            readOnly={readOnly}
            errors={errors}
            idPrefix={idPrefix}
          />
        ) : null
      }
    </DeclarationGroupShell>
  )
}

export function MedicationDeclarationGroup({
  value,
  onChange,
  readOnly,
  errors,
  idPrefix,
}: {
  value: { state: DeclarationState; items: HealthMedicationDeclaration[] }
  onChange: (next: { state: DeclarationState; items: HealthMedicationDeclaration[] }) => void
  readOnly?: boolean
  errors?: Record<string, string>
  idPrefix: string
}): React.JSX.Element {
  const confirm = useDiscardConfirm(value, onChange)
  const rows: MedicationRowValue[] = value.items.map((item, index) => ({
    key: `dcl-med-${index}`,
    name: item.name,
    dose: item.dose ?? "",
    frequency: item.frequency ?? "",
    startDate: "",
    endDate: "",
    notes: item.notes ?? "",
  }))
  return (
    <DeclarationGroupShell
      title="Medicación actual"
      stateId={`${idPrefix}-med-estado`}
      state={value.state}
      stateError={pickError(errors, [
        `${idPrefix}-med-estado`,
        "medications.state",
        "health.medications.state",
      ])}
      onStateChange={(next) =>
        confirm.request(next, { state: next, items: [] as HealthMedicationDeclaration[] })
      }
      question="¿Toma medicación actualmente?"
      readOnly={readOnly}
      emptyHint={rows.length === 0 ? emptyHintFor(value.state, "medicación actual") : ""}
      confirm={
        <DiscardConfirm
          open={confirm.pending !== null}
          count={confirm.count}
          state={confirm.pending}
          onClose={confirm.close}
          onConfirm={confirm.confirm}
        />
      }
    >
      {() =>
        value.state === "recorded" || rows.length > 0 ? (
          <MedicationRows
            mode="declaration"
            rows={rows}
            onChange={(next) =>
              onChange({
                state: value.state,
                items: declarationItems(
                  value.state,
                  next.map((row) => ({
                    name: row.name,
                    ...(row.dose.trim() === "" ? {} : { dose: row.dose }),
                    ...(row.frequency.trim() === "" ? {} : { frequency: row.frequency }),
                    ...(row.notes.trim() === "" ? {} : { notes: row.notes }),
                  })),
                ),
              })
            }
            readOnly={readOnly}
            errors={errors}
            idPrefix={idPrefix}
          />
        ) : null
      }
    </DeclarationGroupShell>
  )
}

/* ------------------------------------------------------------------ */
/* Campos de salud del registro (solo sangre + grupos; dental aparte)  */
/* ------------------------------------------------------------------ */

export function RegistrationHealthFields({
  value,
  onChange,
  fields,
  readOnly,
  errors,
}: {
  value: HealthDeclaration
  onChange: (value: HealthDeclaration) => void
  fields: RegistrationConfig["fields"]
  readOnly?: boolean
  errors?: Record<string, string>
}): React.JSX.Element {
  const rawPrefix = useId()
  const idPrefix = rawPrefix.replace(/[^a-zA-Z0-9_-]/g, "")
  const allergies = value.allergies ?? { state: "unanswered" as DeclarationState, items: [] }
  const conditions = value.conditions ?? { state: "unanswered" as DeclarationState, items: [] }
  const medications = value.medications ?? { state: "unanswered" as DeclarationState, items: [] }
  return (
    <div className="flex flex-col gap-4">
      {fields.bloodGroup === "hidden" ? null : (
        <div className="flex flex-col gap-6 elevated rounded-xl border bg-card p-6">
          <div className="flex flex-col gap-1.5">
            <div className="font-heading text-base font-medium">Grupo sanguíneo</div>
          </div>
          <div>
            <BloodGroupSelect
              id={`${idPrefix}-blood`}
              value={value.bloodGroup ?? null}
              onChange={(next) => onChange({ ...value, bloodGroup: next })}
              readOnly={readOnly}
              error={pickError(errors, [`${idPrefix}-blood`, "bloodGroup", "health.bloodGroup"])}
              declared
            />
          </div>
        </div>
      )}
      {fields.allergies === "hidden" ? null : (
        <AllergyDeclarationGroup
          value={allergies}
          onChange={(next) => onChange({ ...value, allergies: next })}
          readOnly={readOnly}
          errors={errors}
          idPrefix={idPrefix}
        />
      )}
      {fields.conditions === "hidden" ? null : (
        <ConditionDeclarationGroup
          value={conditions}
          onChange={(next) => onChange({ ...value, conditions: next })}
          readOnly={readOnly}
          errors={errors}
          idPrefix={idPrefix}
        />
      )}
      {fields.medications === "hidden" ? null : (
        <MedicationDeclarationGroup
          value={medications}
          onChange={(next) => onChange({ ...value, medications: next })}
          readOnly={readOnly}
          errors={errors}
          idPrefix={idPrefix}
        />
      )}
    </div>
  )
}
