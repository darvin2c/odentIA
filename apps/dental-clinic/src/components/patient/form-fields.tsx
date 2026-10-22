import {
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
import { DatePickerButton } from "@odentia/ui-patterns"
import { useId } from "react"
import type { FormFieldDef, FormSchemaDef } from "../../lib/clinical-forms"
import { FirmaPad, FirmaView } from "./firma-pad"
import { ToothSelector } from "./tooth-selector"

/** ¿Se muestra el campo con las respuestas actuales? (misma regla que el servidor). */
export function isFieldVisible(field: FormFieldDef, answers: Record<string, unknown>): boolean {
  if (!field.showIf) return true
  const answer = answers[field.showIf.field]
  if (Array.isArray(answer)) return answer.includes(field.showIf.equals)
  return answer === field.showIf.equals
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === "object" && !Array.isArray(value) && "strokes" in value)
    return !isStrokes(value.strokes) || value.strokes.length === 0
  if (typeof value === "string") return value.trim() === ""
  if (Array.isArray(value)) return value.length === 0
  return false
}

/**
 * Respuestas listas para enviar: una firma sin trazo cuenta como vacía (el
 * nombre tecleado se conserva en pantalla hasta que haya trazo).
 */
export function answersForServer(
  schema: FormSchemaDef,
  answers: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of schema.sections.flatMap((section) => section.fields)) {
    const value = answers[field.id]
    if (field.type === "firma") {
      const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : null
      out[field.id] = raw && isStrokes(raw.strokes) && raw.strokes.length > 0 ? raw : null
    } else if (value !== undefined) {
      out[field.id] = value
    }
  }
  return out
}

/** Obligatorios visibles sin respuesta (para avisar antes de finalizar o enviar). */
export function missingRequired(
  schema: FormSchemaDef,
  answers: Record<string, unknown>,
): FormFieldDef[] {
  return schema.sections
    .flatMap((section) => section.fields)
    .filter(
      (field) => field.required && isFieldVisible(field, answers) && isEmpty(answers[field.id]),
    )
}

function isStrokes(raw: unknown): raw is number[][][] {
  return (
    Array.isArray(raw) &&
    raw.every(
      (stroke: unknown) =>
        Array.isArray(stroke) &&
        stroke.every(
          (point: unknown) => Array.isArray(point) && point.every((n) => typeof n === "number"),
        ),
    )
  )
}

export interface AttachmentOption {
  id: string
  label: string
}

/**
 * Campo de formulario clínico con su etiqueta asociada, obligatoriedad
 * anunciada y ayuda vinculada. Sí/No es una elección explícita (sin respuesta
 * por defecto), la pieza usa el selector único y la firma pide quién firma.
 */
export function AnswerInput({
  field,
  value,
  disabled = false,
  onChange,
  attachments = [],
}: {
  field: FormFieldDef
  value: unknown
  disabled?: boolean
  onChange: (value: unknown) => void
  attachments?: AttachmentOption[]
}): React.JSX.Element {
  const id = useId()
  const helpId = field.help ? `${id}-help` : undefined
  const label = (
    <>
      {field.label}
      {field.unit ? ` (${field.unit})` : ""}
      {field.required ? (
        <span aria-hidden="true" className="text-destructive">
          {" "}
          *
        </span>
      ) : null}
    </>
  )
  const help = field.help ? (
    <p id={helpId} className="text-xs text-muted-foreground">
      {field.help}
    </p>
  ) : null
  const common = {
    id,
    disabled,
    "aria-required": field.required ? true : undefined,
    "aria-describedby": helpId,
  } as const
  switch (field.type) {
    case "texto":
      return (
        <Field>
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <Input
            {...common}
            value={typeof value === "string" ? value : ""}
            maxLength={500}
            onChange={(event) => onChange(event.target.value)}
          />
          {help}
        </Field>
      )
    case "texto_largo":
      return (
        <Field>
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <Textarea
            {...common}
            value={typeof value === "string" ? value : ""}
            rows={3}
            maxLength={5000}
            onChange={(event) => onChange(event.target.value)}
          />
          {help}
        </Field>
      )
    case "numero":
      return (
        <Field>
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <Input
            {...common}
            type="number"
            inputMode="decimal"
            value={typeof value === "number" ? value : ""}
            min={field.min ?? undefined}
            max={field.max ?? undefined}
            onChange={(event) =>
              onChange(event.target.value === "" ? null : Number(event.target.value))
            }
          />
          {help}
        </Field>
      )
    case "booleano":
    case "escala": {
      const options: Array<{ value: boolean | number; text: string }> =
        field.type === "booleano"
          ? [
              { value: true, text: "Sí" },
              { value: false, text: "No" },
            ]
          : Array.from({ length: (field.max ?? 10) - (field.min ?? 0) + 1 }, (_, i) => {
              const n = (field.min ?? 0) + i
              return { value: n, text: String(n) }
            })
      return (
        <fieldset aria-describedby={helpId} className="flex flex-col gap-1.5">
          <legend className="text-sm font-medium">{label}</legend>
          <div
            role="radiogroup"
            aria-required={field.required ? true : undefined}
            aria-label={field.label}
            className="flex flex-wrap gap-1.5"
          >
            {options.map((option) => {
              const checked = value === option.value
              return (
                <Button
                  key={String(option.value)}
                  type="button"
                  size="sm"
                  role="radio"
                  aria-checked={checked}
                  variant={checked ? "default" : "outline"}
                  className={field.type === "escala" ? "w-10" : "min-w-16"}
                  disabled={disabled}
                  onClick={() => onChange(checked ? null : option.value)}
                >
                  {option.text}
                </Button>
              )
            })}
          </div>
          {help}
        </fieldset>
      )
    }
    case "opcion_unica":
      return (
        <Field>
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <Select
            items={Object.fromEntries((field.options ?? []).map((o) => [o, o]))}
            value={typeof value === "string" ? value : ""}
            onValueChange={(v) => onChange(v ?? null)}
            disabled={disabled}
          >
            <SelectTrigger
              id={id}
              aria-required={field.required ? true : undefined}
              aria-describedby={helpId}
            >
              <SelectValue placeholder="Elige una opción" />
            </SelectTrigger>
            <SelectContent>
              {(field.options ?? []).map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {help}
        </Field>
      )
    case "opcion_multiple": {
      const selected = Array.isArray(value) ? (value as string[]) : []
      return (
        <fieldset aria-describedby={helpId}>
          <legend className="text-sm font-medium">{label}</legend>
          <div className="mt-1 flex flex-col gap-1">
            {(field.options ?? []).map((option) => (
              <label key={option} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={selected.includes(option)}
                  disabled={disabled}
                  onCheckedChange={(checked) =>
                    onChange(
                      checked === true
                        ? [...selected, option]
                        : selected.filter((v) => v !== option),
                    )
                  }
                />
                {option}
              </label>
            ))}
          </div>
          {help}
        </fieldset>
      )
    }
    case "fecha":
      return (
        <Field>
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <DatePickerButton
            {...common}
            className="w-56"
            value={typeof value === "string" ? value : ""}
            emptyLabel={field.required ? undefined : "Sin fecha"}
            onChange={(next) => onChange(next || null)}
          />
          {help}
        </Field>
      )
    case "pieza":
      return (
        <div className="flex flex-col gap-1">
          <ToothSelector
            single
            label={`${field.label}${field.required ? " *" : ""}`}
            value={typeof value === "number" ? [value] : []}
            disabled={disabled}
            onChange={(teeth) => onChange(teeth[0] ?? null)}
          />
          {help}
        </div>
      )
    case "adjunto":
      return (
        <Field>
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <Select
            items={Object.fromEntries([
              ["", "Sin archivo"],
              ...attachments.map((a) => [a.id, a.label]),
            ])}
            value={typeof value === "string" ? value : ""}
            onValueChange={(v) => onChange(v || null)}
            disabled={disabled}
          >
            <SelectTrigger
              id={id}
              aria-required={field.required ? true : undefined}
              aria-describedby={helpId}
            >
              <SelectValue placeholder="Elige un archivo del paciente" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">Sin archivo</SelectItem>
              {attachments.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Los archivos se suben en Documentos y aquí se vinculan.
          </p>
          {help}
        </Field>
      )
    case "firma": {
      const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
      const strokes = isStrokes(raw.strokes) ? raw.strokes : []
      const signerName = typeof raw.signerName === "string" ? raw.signerName : ""
      return (
        <fieldset aria-describedby={helpId} className="flex flex-col gap-2">
          <legend className="text-sm font-medium">{label}</legend>
          {disabled ? (
            strokes.length > 0 ? (
              <>
                <FirmaView strokes={strokes} label={`${field.label}: ${signerName}`} />
                <p className="text-xs text-muted-foreground">Firmó: {signerName || "—"}</p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Sin firma registrada.</p>
            )
          ) : (
            <>
              <Field>
                <FieldLabel htmlFor={`${id}-signer`}>Nombre de quien firma</FieldLabel>
                <Input
                  id={`${id}-signer`}
                  value={signerName}
                  maxLength={200}
                  onChange={(event) => onChange({ strokes, signerName: event.target.value })}
                />
              </Field>
              <FirmaPad
                label={field.label}
                onChange={(next) => onChange({ strokes: next, signerName })}
              />
            </>
          )}
          {help}
        </fieldset>
      )
    }
  }
}
