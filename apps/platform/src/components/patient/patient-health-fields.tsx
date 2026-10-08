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
import { ConfirmDialog } from "@odentia/ui-patterns"
import type { ReactNode } from "react"
import { useId, useState } from "react"
import {
  ALLERGY_CATEGORY_LABELS,
  ALLERGY_SEVERITY_LABELS,
  CONDITION_STATUS_LABELS,
  HEALTH_REVIEW_LABELS,
  type HealthReviewState,
} from "../../lib/patients"
import { Cie10Search } from "./cie10-search"

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

export const ALLERGY_SEVERITY_OPTIONS = ["leve", "moderada", "severa", "desconocida"] as const
export const CONDITION_STATUS_OPTIONS = ["activa", "resuelta", "inactiva"] as const

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
  const options: DeclarationState[] = ["unanswered", "unknown", "none", "recorded"]
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label ?? "Respuesta"}</FieldLabel>
      <Select
        value={value}
        onValueChange={(v) => onChange(v as DeclarationState)}
        disabled={readOnly}
      >
        <SelectTrigger id={id}>
          <SelectValue>{DECLARATION_STATE_LABELS[value]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {DECLARATION_STATE_LABELS[option]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </Field>
  )
}

/** Estado de revisión clínica Sin determinar/Ausencia/Registrados (ficha interna). */
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

const KIND_LABELS: Record<string, string> = { alergia: "Alergia", intolerancia: "Intolerancia" }
const CRITICALITY_LABELS: Record<string, string> = {
  baja: "Baja",
  alta: "Alta",
  no_evaluable: "No evaluable",
}
const VERIFICATION_LABELS: Record<string, string> = {
  no_confirmada: "No confirmada",
  confirmada: "Confirmada",
  descartada: "Descartada",
}

export interface ConditionRowValue {
  key: string
  name: string
  /** Código CIE-10 que precisa la condición; solo en modo clínico. */
  cie10Code?: string
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
  dose: string
  frequency: string
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
  mode,
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
          {mode === "clinical" ? (
            <Field>
              <FieldLabel htmlFor={fid(`alg-cat-${row.key}`)}>Tipo de alérgeno</FieldLabel>
              <Select
                value={row.category || "__sin__"}
                onValueChange={(v) => patch(row.key, { category: !v || v === "__sin__" ? "" : v })}
                disabled={readOnly}
              >
                <SelectTrigger id={fid(`alg-cat-${row.key}`)}>
                  <SelectValue>
                    {ALLERGY_CATEGORY_LABELS[row.category ?? ""] ?? "Sin precisar"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__sin__">Sin precisar</SelectItem>
                  {Object.entries(ALLERGY_CATEGORY_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
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
          {mode === "clinical" ? (
            <>
              {(
                [
                  ["kind", "Tipo", KIND_LABELS, "alergia"],
                  ["criticality", "Criticidad", CRITICALITY_LABELS, ""],
                  ["verification", "Verificación", VERIFICATION_LABELS, "no_confirmada"],
                ] as const
              ).map(([key, text, options, fallback]) => (
                <Field key={key}>
                  <FieldLabel htmlFor={fid(`alg-${key}-${row.key}`)}>{text}</FieldLabel>
                  <select
                    id={fid(`alg-${key}-${row.key}`)}
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                    value={row[key] ?? fallback}
                    disabled={readOnly}
                    onChange={(e) => patch(row.key, { [key]: e.target.value })}
                  >
                    {key === "criticality" ? <option value="">Sin evaluar</option> : null}
                    {Object.entries(options).map(([value, optionLabel]) => (
                      <option key={value} value={value}>
                        {optionLabel}
                      </option>
                    ))}
                  </select>
                </Field>
              ))}
            </>
          ) : null}
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
            {mode === "clinical" && row.persisted ? (
              <div className="flex items-center gap-2">
                <Checkbox
                  id={fid(`alg-vig-${row.key}`)}
                  checked={row.isActive}
                  disabled={readOnly}
                  onCheckedChange={(c: boolean) => patch(row.key, { isActive: c === true })}
                />
                <label htmlFor={fid(`alg-vig-${row.key}`)} className="text-sm">
                  Vigente (quitar para archivar)
                </label>
              </div>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={readOnly}
                onClick={() => onChange(rows.filter((r) => r.key !== row.key))}
              >
                Quitar fila
              </Button>
            )}
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
              <Cie10Search
                value={row.cie10Code ?? ""}
                onChange={(code) => patch(row.key, { cie10Code: code })}
                label="Código CIE-10 (opcional)"
                disabled={readOnly}
              />
              {row.cie10Code ? (
                <button
                  type="button"
                  className="self-start text-xs text-muted-foreground underline underline-offset-4"
                  disabled={readOnly}
                  onClick={() => patch(row.key, { cie10Code: "" })}
                >
                  Quitar el código {row.cie10Code}
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
              <Input
                id={fid(`con-ini-${row.key}`)}
                type="date"
                value={row.startDate}
                disabled={readOnly}
                onChange={(e) => patch(row.key, { startDate: e.target.value })}
              />
              <RowError message={pickError(errors, [fid(`con-ini-${row.key}`)])} />
            </Field>
          ) : null}
          {mode === "clinical" ? (
            <Field>
              <FieldLabel htmlFor={fid(`con-fin-${row.key}`)}>Fin (vacío = activa)</FieldLabel>
              <Input
                id={fid(`con-fin-${row.key}`)}
                type="date"
                value={row.endDate}
                disabled={readOnly}
                onChange={(e) => patch(row.key, { endDate: e.target.value })}
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
              <Input
                id={fid(`med-gen-${row.key}`)}
                value={row.genericName ?? ""}
                maxLength={200}
                disabled={readOnly}
                placeholder="Ej.: losartán"
                onChange={(e) => patch(row.key, { genericName: e.target.value })}
              />
            </Field>
          ) : null}
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
          {mode === "clinical" ? (
            <Field>
              <FieldLabel htmlFor={fid(`med-ini-${row.key}`)}>Inicio</FieldLabel>
              <Input
                id={fid(`med-ini-${row.key}`)}
                type="date"
                value={row.startDate}
                disabled={readOnly}
                onChange={(e) => patch(row.key, { startDate: e.target.value })}
              />
              <RowError message={pickError(errors, [fid(`med-ini-${row.key}`)])} />
            </Field>
          ) : null}
          {mode === "clinical" && row.persisted ? (
            <Field>
              <FieldLabel htmlFor={fid(`med-fin-${row.key}`)}>Fin (suspender)</FieldLabel>
              <Input
                id={fid(`med-fin-${row.key}`)}
                type="date"
                value={row.endDate}
                disabled={readOnly}
                onChange={(e) => patch(row.key, { endDate: e.target.value })}
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
