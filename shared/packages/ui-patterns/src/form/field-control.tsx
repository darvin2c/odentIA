import {
  cn,
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@odentia/ui"
import { useStore } from "@tanstack/react-form"
import * as React from "react"
import { fieldErrorMessages } from "./field-errors.js"
import { useFieldContext } from "./form-context.js"

/** Lo que un control necesita para quedar unido a su etiqueta, su ayuda y su error. */
export interface FieldControl {
  id: string
  name: string
  invalid: boolean
  /** La ayuda y, si hay error, el error: para `aria-describedby`. */
  describedBy: string | undefined
  onBlur: () => void
  /** Lo mismo, listo para esparcir en una primitiva (`Input`, `SelectTrigger`…). */
  props: {
    id: string
    name: string
    "aria-invalid": true | undefined
    "aria-describedby": string | undefined
    onBlur: () => void
  }
}

interface FieldControlState {
  control: FieldControl
  errors: string[]
  descriptionId: string
  errorId: string
}

/**
 * El estado del campo de `form.AppField` para pintarlo: el error se muestra al
 * salir del campo o después del primer envío (no mientras se escribe la
 * primera vez) y desaparece en cuanto se corrige. Lo que dijo el último envío
 * (`errorMap.onServer`, ver `setSubmitErrors`) se ve siempre, hasta que el
 * campo cambia.
 */
export function useFieldControl(options: { id?: string; hasDescription: boolean }): FieldControlState {
  const field = useFieldContext<unknown>()
  const generated = React.useId()
  const id = options.id ?? generated
  const descriptionId = `${id}-ayuda`
  const errorId = `${id}-error`
  const submitted = useStore(field.form.store, (state) => state.submissionAttempts > 0)
  const errors = [...new Set(fieldErrorMessages(field.state.meta.errors))]
  const fromSubmit = field.state.meta.errorMap.onServer !== undefined
  const invalid = errors.length > 0 && (field.state.meta.isBlurred || submitted || fromSubmit)
  const describedBy =
    [options.hasDescription ? descriptionId : null, invalid ? errorId : null].filter(Boolean).join(" ") || undefined
  const onBlur = field.handleBlur
  return {
    control: {
      id,
      name: field.name,
      invalid,
      describedBy,
      onBlur,
      props: { id, name: field.name, "aria-invalid": invalid || undefined, "aria-describedby": describedBy, onBlur },
    },
    errors,
    descriptionId,
    errorId,
  }
}

export interface FormFieldProps {
  label: React.ReactNode
  description?: React.ReactNode
  /** La etiqueta solo para el lector de pantalla (la tabla ya dice qué es). */
  hideLabel?: boolean
  /** Id del control; por defecto, uno propio. */
  id?: string
  className?: string
  children: (control: FieldControl) => React.ReactNode
}

/**
 * Un campo con su etiqueta, su ayuda y su error, unidos al control que pinta
 * `children`: `data-invalid` en el `Field`, `aria-invalid` y `aria-describedby`
 * en el control y el `FieldError` con su id. Para cualquier control, también
 * los compuestos (`invalid`, `aria-describedby`).
 */
export function FormField({ label, description, hideLabel, id, className, children }: FormFieldProps) {
  const { control, errors, descriptionId, errorId } = useFieldControl({ id, hasDescription: description != null })
  return (
    <Field data-invalid={control.invalid || undefined} className={className}>
      <FieldLabel htmlFor={control.id} className={cn(hideLabel && "sr-only")}>
        {label}
      </FieldLabel>
      {children(control)}
      {description != null ? <FieldDescription id={descriptionId}>{description}</FieldDescription> : null}
      {control.invalid ? <FieldError id={errorId} errors={errors.map((message) => ({ message }))} /> : null}
    </Field>
  )
}

export interface FormChoiceFieldProps {
  label: React.ReactNode
  description?: React.ReactNode
  id?: string
  className?: string
  /** El control va delante de la etiqueta (casilla). */
  children: (control: FieldControl) => React.ReactNode
}

/** Casilla o interruptor: el control delante y la etiqueta con su ayuda al lado. */
export function FormChoiceField({ label, description, id, className, children }: FormChoiceFieldProps) {
  const { control, errors, descriptionId, errorId } = useFieldControl({ id, hasDescription: description != null })
  return (
    <Field orientation="horizontal" data-invalid={control.invalid || undefined} className={className}>
      {children(control)}
      <FieldContent>
        <FieldLabel htmlFor={control.id}>{label}</FieldLabel>
        {description != null ? <FieldDescription id={descriptionId}>{description}</FieldDescription> : null}
        {control.invalid ? <FieldError id={errorId} errors={errors.map((message) => ({ message }))} /> : null}
      </FieldContent>
    </Field>
  )
}

export interface FormFieldGroupProps {
  legend: React.ReactNode
  description?: React.ReactNode
  id?: string
  className?: string
  children: (control: FieldControl) => React.ReactNode
}

/**
 * Un dato que se elige con varios controles (opciones, chips, piezas): el
 * grupo lleva el nombre (`FieldLegend`) y el error va debajo de todo él. El
 * dato se da por visitado cuando el foco sale del grupo, no al pasar de una
 * opción a otra.
 */
export function FormFieldGroup({ legend, description, id, className, children }: FormFieldGroupProps) {
  const { control, errors, descriptionId, errorId } = useFieldControl({ id, hasDescription: description != null })
  return (
    <FieldSet
      data-invalid={control.invalid || undefined}
      aria-describedby={control.describedBy}
      className={className}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) control.onBlur()
      }}
    >
      <FieldLegend variant="label" className={cn(control.invalid && "text-destructive")}>
        {legend}
      </FieldLegend>
      {description != null ? <FieldDescription id={descriptionId}>{description}</FieldDescription> : null}
      {children(control)}
      {control.invalid ? <FieldError id={errorId} errors={errors.map((message) => ({ message }))} /> : null}
    </FieldSet>
  )
}
