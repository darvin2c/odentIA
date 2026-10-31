import {
  Button,
  Checkbox,
  cn,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@odentia/ui"
import { DatePickerButton, useFieldContext, useFieldControl } from "@odentia/ui-patterns"
import { useId } from "react"
import type { FormFieldDef, FormSchemaDef } from "../../lib/clinical-forms"
import { FirmaPad, FirmaView } from "./firma-pad"
import { productUi } from "../../product/product-ui"
import { PlacesField } from "../../product/site-fields"

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
 * ¿La respuesta se da con varios controles (opciones, casillas, piezas,
 * firma)? Entonces va en `FieldSet` + `FieldLegend`; si no, en `Field` +
 * `FieldLabel htmlFor`.
 */
export function answerIsGroup(field: FormFieldDef): boolean {
  return (
    field.type === "booleano" ||
    field.type === "escala" ||
    field.type === "opcion_multiple" ||
    field.type === "pieza" ||
    field.type === "firma"
  )
}

/** La etiqueta visible de un campo: su nombre, su unidad y si es obligatorio. */
export function AnswerLabel({ field }: { field: FormFieldDef }): React.JSX.Element {
  return (
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
}

/**
 * El marco de una respuesta: etiqueta (o leyenda), ayuda y error alrededor del
 * control que pinta `children` (recibe el id de la leyenda si es un grupo).
 */
function AnswerFrame({
  field,
  id,
  helpId,
  invalid = false,
  error,
  children,
}: {
  field: FormFieldDef
  id: string
  helpId: string | undefined
  invalid?: boolean
  error?: React.ReactNode
  children: (labelId: string | undefined) => React.ReactNode
}): React.JSX.Element {
  const labelId = `${id}-label`
  const help = field.help ? (
    <FieldDescription id={helpId} className="text-xs">
      {field.help}
    </FieldDescription>
  ) : null
  if (answerIsGroup(field)) {
    return (
      <FieldSet data-invalid={invalid || undefined} className="gap-1.5">
        <FieldLegend id={labelId} variant="label" className={cn("mb-0", invalid && "text-destructive")}>
          <AnswerLabel field={field} />
        </FieldLegend>
        {children(labelId)}
        {help}
        {error}
      </FieldSet>
    )
  }
  return (
    <Field data-invalid={invalid || undefined}>
      <FieldLabel htmlFor={id}>
        <AnswerLabel field={field} />
      </FieldLabel>
      {children(undefined)}
      {help}
      {error}
    </Field>
  )
}

/**
 * Un campo de formulario clínico con su etiqueta (o leyenda), su ayuda y la
 * respuesta unidos. Para las pantallas que pintan el formulario sin
 * `useAppForm`; con `useAppForm`, `AnswerAppField`.
 */
export function AnswerField(props: {
  field: FormFieldDef
  value: unknown
  disabled?: boolean
  onChange: (value: unknown) => void
  attachments?: AttachmentOption[]
}): React.JSX.Element | null {
  const { field } = props
  const id = useId()
  const helpId = field.help ? `${id}-help` : undefined
  // Sin lugares en el producto, la pieza no se pregunta.
  if (field.type === "pieza" && !productUi().site) return null
  return (
    <AnswerFrame field={field} id={id} helpId={helpId}>
      {(labelId) => <AnswerInput {...props} id={id} aria-labelledby={labelId} aria-describedby={helpId} />}
    </AnswerFrame>
  )
}

/**
 * La respuesta de un formulario clínico dentro de
 * ``<form.AppField name={`answers.${field.id}`}>``: etiqueta, ayuda y el error
 * de esa pregunta (del cliente o del servidor, `answers.<id>`) unidos al
 * control, que se marca y recibe el foco si hay que corregirla.
 */
export function AnswerAppField({
  field,
  disabled = false,
  attachments,
}: {
  field: FormFieldDef
  disabled?: boolean
  attachments?: AttachmentOption[]
}): React.JSX.Element | null {
  const formField = useFieldContext<unknown>()
  const { control, errors, descriptionId, errorId } = useFieldControl({ hasDescription: !!field.help })
  if (field.type === "pieza" && !productUi().site) return null
  return (
    <AnswerFrame
      field={field}
      id={control.id}
      helpId={descriptionId}
      invalid={control.invalid}
      error={
        control.invalid ? <FieldError id={errorId} errors={errors.map((message) => ({ message }))} /> : null
      }
    >
      {(labelId) => (
        <AnswerInput
          field={field}
          value={formField.state.value}
          disabled={disabled}
          attachments={attachments}
          onChange={(next) => formField.handleChange(next)}
          id={control.id}
          invalid={control.invalid}
          onBlur={control.onBlur}
          aria-labelledby={labelId}
          aria-describedby={control.describedBy}
        />
      )}
    </AnswerFrame>
  )
}

/**
 * La respuesta de un campo de formulario clínico, sin etiqueta ni ayuda (las
 * pinta quien la usa: `AnswerLabel` y, según `answerIsGroup`, `Field` o
 * `FieldSet`). Sí/No es una elección explícita (sin respuesta por defecto), la
 * pieza usa el selector único y la firma pide quién firma. `id` va en el
 * control enfocable o en la raíz del grupo; `aria-labelledby` nombra los
 * grupos; `onBlur` avisa al salir del control o del grupo.
 */
export function AnswerInput({
  field,
  value,
  disabled = false,
  onChange,
  attachments = [],
  id: givenId,
  invalid = false,
  onBlur,
  ...aria
}: {
  field: FormFieldDef
  value: unknown
  disabled?: boolean
  onChange: (value: unknown) => void
  attachments?: AttachmentOption[]
  id?: string
  invalid?: boolean
  onBlur?: () => void
  /** Id del texto visible que nombra la respuesta cuando es un grupo. */
  "aria-labelledby"?: string
  "aria-describedby"?: string
}): React.JSX.Element | null {
  const fallbackId = useId()
  const id = givenId ?? fallbackId
  const describedBy = aria["aria-describedby"]
  const labelledBy = aria["aria-labelledby"]
  const ariaInvalid = invalid || undefined
  const required = field.required ? true : undefined
  // Al salir del grupo, no al pasar de una opción a otra.
  const groupBlur = onBlur
    ? (event: React.FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onBlur()
      }
    : undefined
  const common = {
    id,
    disabled,
    "aria-required": required,
    "aria-describedby": describedBy,
    "aria-invalid": ariaInvalid,
    onBlur,
  } as const
  switch (field.type) {
    case "texto":
      return (
        <Input
          {...common}
          value={typeof value === "string" ? value : ""}
          maxLength={500}
          onChange={(event) => onChange(event.target.value)}
        />
      )
    case "texto_largo":
      return (
        <Textarea
          {...common}
          value={typeof value === "string" ? value : ""}
          rows={3}
          maxLength={5000}
          onChange={(event) => onChange(event.target.value)}
        />
      )
    case "numero":
      return (
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
        <div
          id={id}
          role="radiogroup"
          aria-required={required}
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          aria-invalid={ariaInvalid}
          onBlur={groupBlur}
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
                aria-invalid={ariaInvalid}
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
      )
    }
    case "opcion_unica":
      return (
        <Select
          items={Object.fromEntries((field.options ?? []).map((o) => [o, o]))}
          value={typeof value === "string" ? value : ""}
          onValueChange={(v) => onChange(v ?? null)}
          disabled={disabled}
        >
          <SelectTrigger
            id={id}
            aria-required={required}
            aria-describedby={describedBy}
            aria-invalid={ariaInvalid}
            onBlur={onBlur}
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
      )
    case "opcion_multiple": {
      const selected = Array.isArray(value) ? (value as string[]) : []
      return (
        <fieldset
          id={id}
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          aria-invalid={ariaInvalid}
          onBlur={groupBlur}
          className="flex min-w-0 flex-col gap-1"
        >
          {(field.options ?? []).map((option) => (
            <label key={option} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={selected.includes(option)}
                disabled={disabled}
                aria-invalid={ariaInvalid}
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
        </fieldset>
      )
    }
    case "fecha":
      return (
        <DatePickerButton
          {...common}
          className="w-56"
          value={typeof value === "string" ? value : ""}
          emptyLabel={field.required ? undefined : "Sin fecha"}
          onChange={(next) => onChange(next || null)}
        />
      )
    case "pieza":
      return (
        <PlacesField
          single
          id={id}
          invalid={invalid}
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          onBlur={onBlur}
          value={typeof value === "number" ? [value] : []}
          disabled={disabled}
          onChange={(teeth) => onChange(teeth[0] ?? null)}
        />
      )
    case "adjunto": {
      // Pista propia del control: dónde se suben los archivos que aquí se vinculan.
      const hintId = `${id}-hint`
      return (
        <>
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
              aria-required={required}
              aria-describedby={[describedBy, hintId].filter(Boolean).join(" ")}
              aria-invalid={ariaInvalid}
              onBlur={onBlur}
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
          <p id={hintId} className="text-xs text-muted-foreground">
            Los archivos se suben en Documentos y aquí se vinculan.
          </p>
        </>
      )
    }
    case "firma": {
      const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
      const strokes = isStrokes(raw.strokes) ? raw.strokes : []
      const signerName = typeof raw.signerName === "string" ? raw.signerName : ""
      return (
        <fieldset
          id={id}
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          aria-invalid={ariaInvalid}
          onBlur={groupBlur}
          className="flex min-w-0 flex-col gap-2"
        >
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
                  aria-invalid={ariaInvalid}
                  onChange={(event) => onChange({ strokes, signerName: event.target.value })}
                />
              </Field>
              <FirmaPad
                label={field.label}
                invalid={ariaInvalid === true}
                onChange={(next) => onChange({ strokes: next, signerName })}
              />
            </>
          )}
        </fieldset>
      )
    }
  }
}
