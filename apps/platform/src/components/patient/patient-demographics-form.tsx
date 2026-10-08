import { UUID_RE, validateDemographics } from "@odentia/clinical"
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

/**
 * Campos y validación demográfica compartidos entre el alta
 * (create-patient-drawer) y la edición (filiacion-drawer): un solo criterio
 * para nombre, documento, nacimiento, sexo y contacto. La edición reutiliza
 * estos mismos límites; la creación añade el flujo de contacto.
 */

export const DOC_TYPE_OPTIONS = [
  { value: "", label: "—" },
  { value: "DNI", label: "DNI" },
  { value: "CE", label: "CE" },
  { value: "PASAPORTE", label: "Pasaporte" },
  { value: "OTRO", label: "Otro" },
] as const

export const SEX_OPTIONS = [
  { value: "", label: "—" },
  { value: "M", label: "Masculino" },
  { value: "F", label: "Femenino" },
] as const

export const INSURANCE_OPTIONS = [
  { value: "", label: "—" },
  { value: "PARTICULAR", label: "Particular" },
  { value: "SIS", label: "SIS" },
  { value: "ESSALUD", label: "EsSalud" },
  { value: "EPS", label: "EPS" },
  { value: "OTRO", label: "Otro" },
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
  insuranceDetail: string
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
  insuranceDetail: "",
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

/** Paso 2: datos complementarios, seguro y sucursal. */
export function validateComplementary(values: DemographicsValues): StepErrors {
  const { registeredBranchId, ...demographics } = values
  const errs = Object.fromEntries(
    Object.entries(validateDemographics(demographics)).filter(
      ([key]) => !IDENTITY_FIELDS.includes(key),
    ),
  )
  if (registeredBranchId && !UUID_RE.test(registeredBranchId))
    errs.registeredBranchId = "Sucursal inválida"
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
    <div className="flex flex-col gap-6 elevated rounded-xl border bg-card p-6">
      <div className="flex flex-col gap-1.5 pb-3">
        <div className="font-heading text-base font-medium">{title}</div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </div>
  )
}

