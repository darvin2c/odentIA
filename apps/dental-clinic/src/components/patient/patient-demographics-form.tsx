import {
  SEX_CODES,
  SEX_LABELS,
  UUID_RE,
  validateDemographics,
} from "@odentia/clinical"
import {
  Field,
  FieldError,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@odentia/ui"
import { isValidE164 } from "@odentia/ui-patterns"
import { type InputHTMLAttributes, useId } from "react"
import { ChoiceButtons } from "../choice-buttons"

/**
 * Campos y validación demográfica compartidos entre el alta
 * (new-patient-drawer y el registro público) y la edición (filiacion-drawer): un solo criterio
 * para nombre, documento, nacimiento, sexo y contacto. La edición reutiliza
 * estos mismos límites; la creación añade el flujo de contacto.
 */

export const SEX_OPTIONS = [
  { value: "", label: "—" },
  ...SEX_CODES.map((value) => ({ value, label: SEX_LABELS[value] })),
] as const

export interface DemographicsValues {
  displayName: string
  docType: string
  docNumber: string
  birthDate: string
  sex: string
  phone: string
  email: string
  maritalStatus: string
  educationLevel: string
  occupation: string
  address: string
  origin: string
  emergencyContactName: string
  emergencyContactPhone: string
  insuranceType: string
  referralSource: string
  registeredBranchId: string
}

export const emptyDemographics: DemographicsValues = {
  displayName: "",
  docType: "",
  docNumber: "",
  birthDate: "",
  sex: "",
  phone: "",
  email: "",
  maritalStatus: "",
  educationLevel: "",
  occupation: "",
  address: "",
  origin: "",
  emergencyContactName: "",
  emergencyContactPhone: "",
  insuranceType: "",
  referralSource: "",
  registeredBranchId: "",
}

const IDENTITY_FIELDS = [
  "displayName",
  "docType",
  "docNumber",
  "birthDate",
  "sex",
  "phone",
  "email",
]

export type StepErrors = Record<string, string>

/** Paso 1: identidad y contacto. Solo el DNI exige formato exacto (8 dígitos); ninguna regla peruana aplica a pasaporte. */
export function validateIdentity(values: DemographicsValues): StepErrors {
  const { registeredBranchId: _branch, ...demographics } = values
  const errs = Object.fromEntries(
    Object.entries(validateDemographics(demographics)).filter(([key]) =>
      IDENTITY_FIELDS.includes(key),
    ),
  )
  // El campo de teléfono emite E.164: si hay algo escrito, tiene que ser un
  // número real (el servidor sigue siendo quien manda, esto es la pantalla).
  const phone = values.phone.trim()
  if (phone !== "" && !isValidE164(phone)) errs.phone = "Teléfono inválido"
  return errs
}

/** Paso 2: datos complementarios, seguro y sede. */
export function validateComplementary(values: DemographicsValues): StepErrors {
  const { registeredBranchId, ...demographics } = values
  const errs = Object.fromEntries(
    Object.entries(validateDemographics(demographics)).filter(
      ([key]) => !IDENTITY_FIELDS.includes(key),
    ),
  )
  if (registeredBranchId && !UUID_RE.test(registeredBranchId))
    errs.registeredBranchId = "Sede inválida"
  // Los teléfonos de este paso emiten E.164 igual que el de contacto.
  const emergency = values.emergencyContactPhone.trim()
  if (emergency !== "" && !isValidE164(emergency)) errs.emergencyContactPhone = "Teléfono inválido"
  return errs
}

export function TextRow({
  label,
  value,
  onChange,
  error,
  fallbackError,
  inputProps,
  renderControl,
}: {
  label: string
  /** Se ignora cuando hay `renderControl`: el control propio lleva su valor. */
  value?: string
  onChange?: (value: string) => void
  error?: string
  fallbackError?: string[]
  inputProps?: InputHTMLAttributes<HTMLInputElement>
  /** Control propio (p. ej. `PhoneInput`) asociado a la misma etiqueta. */
  renderControl?: (id: string) => React.ReactNode
}) {
  const id = useId()
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {renderControl ? (
        renderControl(id)
      ) : (
        <Input
          id={id}
          {...inputProps}
          value={value ?? ""}
          onChange={(e) => onChange?.(e.target.value)}
        />
      )}
      <FieldError>{error ?? fallbackError?.[0]}</FieldError>
    </Field>
  )
}

export function SelectRow({
  label,
  value,
  onChange,
  error,
  fallbackError,
  options,
  disabled,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  error?: string
  fallbackError?: string[]
  options: readonly { value: string; label: string }[]
  disabled?: boolean
}) {
  const id = useId()
  // Pocas opciones y cortas: botones a la vista, sin abrir una lista. El «—»
  // de «sin elegir» no es una opción: sin elegir, ningún botón queda marcado.
  const real = options.filter((option) => option.value !== "")
  const asButtons = real.length >= 2 && real.length <= 4 && real.every((option) => option.label.length <= 26)
  if (asButtons) {
    return (
      <Field>
        <FieldLabel id={id}>{label}</FieldLabel>
        <ChoiceButtons
          label={label}
          value={real.some((option) => option.value === value) ? value : null}
          options={real}
          onChange={onChange}
          disabled={disabled}
        />
        <FieldError>{error ?? fallbackError?.[0]}</FieldError>
      </Field>
    )
  }
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        value={value}
        items={Object.fromEntries(options.map((o) => [o.value, o.label]))}
        disabled={disabled}
        onValueChange={(next) => onChange(next ?? "")}
      >
        <SelectTrigger id={id} aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldError>{error ?? fallbackError?.[0]}</FieldError>
    </Field>
  )
}

export function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="@container flex flex-col gap-6 elevated rounded-xl border bg-card p-6">
      <div className="flex flex-col gap-1.5 pb-3">
        <div className="font-heading text-base font-medium">{title}</div>
      </div>
      {/* Dos columnas según el ancho de la tarjeta, no de la ventana: en un cajón o en la vista previa del celular, una. */}
      <div className="grid gap-4 @lg:grid-cols-2">{children}</div>
    </div>
  )
}
