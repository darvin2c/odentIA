import {
  Checkbox,
  cn,
  Field,
  FieldLabel,
  Input,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@odentia/ui"
import type * as React from "react"
import { useRef } from "react"
import { PasswordInput, type PasswordRequirement } from "../password-input.js"
import { PhoneInput, type PhoneInputProps } from "../phone/phone-input.js"
import {
  type FieldControl,
  FormChoiceField,
  FormField,
  FormFieldGroup,
  type FormFieldGroupProps,
  type FormFieldProps,
} from "./field-control.js"
import { useFieldContext } from "./form-context.js"

/*
 * Los campos de `useAppForm` (`<form.AppField name="…">{(field) => <field.TextField … />}`).
 * Cada uno pinta su etiqueta, su ayuda y su error unidos al control; la
 * pantalla solo dice qué dato es. Para un control propio, `field.Control`
 * entrega lo mismo (`id`, `invalid`, `describedBy`, `onBlur`) a quien lo pinta.
 */

interface FieldText {
  label: React.ReactNode
  description?: React.ReactNode
  hideLabel?: boolean
  id?: string
  /** Clases del `Field` (rejilla, ancho). */
  className?: string
}

type InputProps = Omit<
  React.ComponentProps<typeof Input>,
  "id" | "name" | "value" | "defaultValue" | "onChange" | "onBlur" | "aria-invalid" | "aria-describedby" | "className"
>

export type TextFieldProps = FieldText & InputProps & { inputClassName?: string }

/** Texto de una línea (también correo, número escrito o código). */
export function TextField({ label, description, hideLabel, id, className, inputClassName, ...input }: TextFieldProps) {
  const field = useFieldContext<string>()
  return (
    <FormField label={label} description={description} hideLabel={hideLabel} id={id} className={className}>
      {(control) => (
        <Input
          {...input}
          {...control.props}
          className={inputClassName}
          value={field.state.value ?? ""}
          onChange={(event) => field.handleChange(event.target.value)}
        />
      )}
    </FormField>
  )
}

type TextareaProps = Omit<
  React.ComponentProps<typeof Textarea>,
  "id" | "name" | "value" | "defaultValue" | "onChange" | "onBlur" | "aria-invalid" | "aria-describedby" | "className"
>

export type TextareaFieldProps = FieldText & TextareaProps & { textareaClassName?: string }

/** Texto de varias líneas. */
export function TextareaField({
  label,
  description,
  hideLabel,
  id,
  className,
  textareaClassName,
  ...textarea
}: TextareaFieldProps) {
  const field = useFieldContext<string>()
  return (
    <FormField label={label} description={description} hideLabel={hideLabel} id={id} className={className}>
      {(control) => (
        <Textarea
          {...textarea}
          {...control.props}
          className={textareaClassName}
          value={field.state.value ?? ""}
          onChange={(event) => field.handleChange(event.target.value)}
        />
      )}
    </FormField>
  )
}

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export type SelectFieldProps = FieldText & {
  options: readonly SelectOption[]
  /** Lo que dice el campo sin elección; si una opción tiene valor `""`, su texto. */
  placeholder?: string
  disabled?: boolean
  triggerClassName?: string
}

/**
 * Una opción de una lista corta. Cuenta como «salir del campo» al cerrar la
 * lista o al pasar de largo con el teclado, no al abrirla: el error no se
 * enciende antes de elegir.
 */
export function SelectField({
  label,
  description,
  hideLabel,
  id,
  className,
  options,
  placeholder = "Elige una opción",
  disabled,
  triggerClassName,
}: SelectFieldProps) {
  const field = useFieldContext<string>()
  const open = useRef(false)
  const empty = options.find((option) => option.value === "")?.label
  return (
    <FormField label={label} description={description} hideLabel={hideLabel} id={id} className={className}>
      {(control) => (
        <Select
          items={Object.fromEntries(options.map((option) => [option.value, option.label]))}
          value={field.state.value ?? ""}
          disabled={disabled}
          onOpenChange={(next) => {
            open.current = next
            if (!next) field.handleBlur()
          }}
          onValueChange={(next) => field.handleChange(next == null ? "" : String(next))}
        >
          <SelectTrigger
            id={control.id}
            aria-invalid={control.invalid || undefined}
            aria-describedby={control.describedBy}
            className={cn("w-full", triggerClassName)}
            onBlur={() => {
              if (!open.current) field.handleBlur()
            }}
          >
            <SelectValue placeholder={empty || placeholder} />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value} data-value={option.value} disabled={option.disabled}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </FormField>
  )
}

export type CheckboxFieldProps = Omit<FieldText, "hideLabel"> & { disabled?: boolean }

/** Una casilla (dentro de un formulario con «Guardar» van casillas, no interruptores). */
export function CheckboxField({ label, description, id, className, disabled }: CheckboxFieldProps) {
  const field = useFieldContext<boolean>()
  return (
    <FormChoiceField label={label} description={description} id={id} className={className}>
      {(control) => (
        <Checkbox
          id={control.id}
          name={control.name}
          checked={field.state.value === true}
          disabled={disabled}
          aria-invalid={control.invalid || undefined}
          aria-describedby={control.describedBy}
          onCheckedChange={(checked) => {
            field.handleChange(checked === true)
            field.handleBlur()
          }}
        />
      )}
    </FormChoiceField>
  )
}

export type RadioGroupFieldProps = Omit<FormFieldGroupProps, "children"> & {
  options: readonly SelectOption[]
  disabled?: boolean
}

/** Una opción entre pocas, todas a la vista. */
export function RadioGroupField({ legend, description, id, className, options, disabled }: RadioGroupFieldProps) {
  const field = useFieldContext<string>()
  return (
    <FormFieldGroup legend={legend} description={description} id={id} className={className}>
      {(control) => (
        <RadioGroup
          name={control.name}
          value={field.state.value ?? ""}
          disabled={disabled}
          aria-invalid={control.invalid || undefined}
          aria-describedby={control.describedBy}
          onValueChange={(next) => {
            field.handleChange(next == null ? "" : String(next))
            field.handleBlur()
          }}
        >
          {options.map((option) => {
            const optionId = `${control.id}-${option.value}`
            return (
              <Field key={option.value} orientation="horizontal">
                <RadioGroupItem
                  id={optionId}
                  value={option.value}
                  disabled={option.disabled}
                  aria-invalid={control.invalid || undefined}
                />
                <FieldLabel htmlFor={optionId} className="font-normal">
                  {option.label}
                </FieldLabel>
              </Field>
            )
          })}
        </RadioGroup>
      )}
    </FormFieldGroup>
  )
}

/** Lo que se dice de un teléfono a medio escribir: no se guarda vacío en silencio. */
export const INCOMPLETE_PHONE = "Revisa el número: le faltan dígitos o no es un teléfono."

export type PhoneFieldProps = FieldText &
  Pick<
    PhoneInputProps,
    "defaultCountry" | "countries" | "showCountrySelect" | "placeholder" | "autoComplete" | "disabled"
  >

/**
 * Teléfono en E.164 (`null` si está vacío). Un número a medias deja el valor
 * vacío pero no pasa: el campo lo dice y el envío espera a que se corrija.
 */
export function PhoneField({ label, description, hideLabel, id, className, ...phone }: PhoneFieldProps) {
  const field = useFieldContext<string | null>()
  return (
    <FormField label={label} description={description} hideLabel={hideLabel} id={id} className={className}>
      {(control) => (
        <PhoneInput
          {...phone}
          id={control.id}
          name={control.name}
          value={field.state.value ?? null}
          invalid={control.invalid}
          aria-describedby={control.describedBy}
          onBlur={control.onBlur}
          onChange={(next, meta) => {
            field.handleChange(next)
            // Solo se toca el aviso propio: el de un validador de la pantalla se respeta.
            if (meta.digits.length > 0 && !meta.e164) field.setErrorMap({ onChange: INCOMPLETE_PHONE })
            else if (field.state.meta.errorMap.onChange === INCOMPLETE_PHONE) field.setErrorMap({ onChange: undefined })
          }}
        />
      )}
    </FormField>
  )
}

export type PasswordFieldProps = Omit<FieldText, "hideLabel"> & {
  autoComplete: "current-password" | "new-password"
  requirements?: PasswordRequirement[]
  autoFocus?: boolean
}

/** Contraseña con «Ver» y, si se pasan, sus requisitos a la vista. */
export function PasswordField({ label, description, id, className, ...password }: PasswordFieldProps) {
  const field = useFieldContext<string>()
  return (
    <FormField label={label} description={description} id={id} className={className}>
      {(control) => (
        <PasswordInput
          {...password}
          id={control.id}
          value={field.state.value ?? ""}
          invalid={control.invalid}
          describedBy={control.describedBy}
          onBlur={control.onBlur}
          onChange={(next) => field.handleChange(next)}
        />
      )}
    </FormField>
  )
}

/**
 * Un control propio (selector de persona, fecha, importe…) con la etiqueta,
 * la ayuda y el error del campo: `children` recibe `id`, `invalid`,
 * `describedBy` y `onBlur` y los pasa al control.
 */
export function ControlField(props: FormFieldProps) {
  return <FormField {...props} />
}

/** Varios controles para un dato (opciones en chips, días, piezas): nombre y error del grupo. */
export function GroupField(props: FormFieldGroupProps) {
  return <FormFieldGroup {...props} />
}

export type { FieldControl }
