import { useId, type InputHTMLAttributes } from "react";
import { Card, CardContent, CardHeader, CardTitle, Field, FieldError, FieldLabel, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@odentia/ui";
import { fieldErrorMessages } from "@odentia/ui-patterns";
import { z } from "zod";

/**
 * Campos y validación demográfica compartidos entre el alta
 * (create-patient-drawer) y la edición (filiacion-drawer): un solo criterio
 * para nombre, documento, nacimiento, sexo y contacto. La edición reutiliza
 * estos mismos límites; la creación añade el flujo de contacto.
 */

export const DOC_TYPES = ["DNI", "CE", "PASAPORTE", "OTRO"] as const;
export const INSURANCE_TYPES = ["PARTICULAR", "SIS", "ESSALUD", "EPS", "OTRO"] as const;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DOC_TYPE_OPTIONS = [
  { value: "", label: "—" },
  { value: "DNI", label: "DNI" },
  { value: "CE", label: "CE" },
  { value: "PASAPORTE", label: "Pasaporte" },
  { value: "OTRO", label: "Otro" },
] as const;

export const SEX_OPTIONS = [
  { value: "", label: "—" },
  { value: "M", label: "Masculino" },
  { value: "F", label: "Femenino" },
] as const;

export const INSURANCE_OPTIONS = [
  { value: "", label: "—" },
  { value: "PARTICULAR", label: "Particular" },
  { value: "SIS", label: "SIS" },
  { value: "ESSALUD", label: "EsSalud" },
  { value: "EPS", label: "EPS" },
  { value: "OTRO", label: "Otro" },
] as const;

export interface DemographicsValues {
  displayName: string;
  docType: string;
  docNumber: string;
  birthDate: string;
  sex: string;
  phone: string;
  email: string;
  maritalStatus: string;
  educationLevel: string;
  occupation: string;
  address: string;
  origin: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  insuranceType: string;
  insuranceDetail: string;
  referralSource: string;
  registeredBranchId: string;
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
};

export const identitySchema = z.object({
  displayName: z.string().trim().min(1, "Ingresa el nombre del paciente").max(200, "Máximo 200 caracteres"),
  docType: z.string(),
  docNumber: z.string().trim().max(20, "Máximo 20 caracteres"),
  birthDate: z.string(),
  sex: z.string(),
  phone: z.string().trim().max(50, "Máximo 50 caracteres"),
  email: z.string().trim().max(200, "Máximo 200 caracteres"),
});

export const complementarySchema = z.object({
  maritalStatus: z.string().max(100, "Máximo 100 caracteres"),
  educationLevel: z.string().max(100, "Máximo 100 caracteres"),
  occupation: z.string().max(200, "Máximo 200 caracteres"),
  address: z.string().max(500, "Máximo 500 caracteres"),
  origin: z.string().max(200, "Máximo 200 caracteres"),
  emergencyContactName: z.string().max(200, "Máximo 200 caracteres"),
  emergencyContactPhone: z.string().max(50, "Máximo 50 caracteres"),
  insuranceType: z.string(),
  insuranceDetail: z.string().max(500, "Máximo 500 caracteres"),
  referralSource: z.string().max(500, "Máximo 500 caracteres"),
  registeredBranchId: z.string(),
});

export type StepErrors = Record<string, string>;

function collectIssues(error: z.ZodError, errs: StepErrors): void {
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "");
    if (key && !errs[key]) errs[key] = issue.message;
  }
}

/** Paso 1: identidad y contacto. Solo el DNI exige formato exacto (8 dígitos); ninguna regla peruana aplica a pasaporte. */
export function validateIdentity(values: DemographicsValues): StepErrors {
  const errs: StepErrors = {};
  const parsed = identitySchema.safeParse(values);
  if (!parsed.success) collectIssues(parsed.error, errs);
  if (values.docType && !(DOC_TYPES as readonly string[]).includes(values.docType)) {
    errs.docType = "Tipo de documento inválido";
  }
  if (values.docType === "DNI" && !/^\d{8}$/.test(values.docNumber.trim())) {
    errs.docNumber = "El DNI tiene exactamente 8 dígitos";
  }
  const email = values.email.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errs.email = "Ingresa un correo válido";
  }
  if (values.sex && values.sex !== "M" && values.sex !== "F") {
    errs.sex = "Sexo inválido";
  }
  return errs;
}

/** Paso 2: datos complementarios, seguro y sucursal. */
export function validateComplementary(values: DemographicsValues): StepErrors {
  const errs: StepErrors = {};
  const parsed = complementarySchema.safeParse({
    maritalStatus: values.maritalStatus,
    educationLevel: values.educationLevel,
    occupation: values.occupation,
    address: values.address,
    origin: values.origin,
    emergencyContactName: values.emergencyContactName,
    emergencyContactPhone: values.emergencyContactPhone,
    insuranceType: values.insuranceType,
    insuranceDetail: values.insuranceDetail,
    referralSource: values.referralSource,
    registeredBranchId: values.registeredBranchId,
  });
  if (!parsed.success) collectIssues(parsed.error, errs);
  if (values.insuranceType && !(INSURANCE_TYPES as readonly string[]).includes(values.insuranceType)) {
    errs.insuranceType = "Tipo de seguro inválido";
  }
  if (values.registeredBranchId && !UUID_RE.test(values.registeredBranchId)) {
    errs.registeredBranchId = "Sucursal inválida";
  }
  return errs;
}

export function TextRow({
  label,
  value,
  onChange,
  error,
  fallbackError,
  inputProps,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  fallbackError?: string[];
  inputProps?: InputHTMLAttributes<HTMLInputElement>;
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} {...inputProps} value={value} onChange={(e) => onChange(e.target.value)} />
      <FieldError>{error ?? fallbackError?.[0]}</FieldError>
    </Field>
  );
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
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  fallbackError?: string[];
  options: readonly { value: string; label: string }[];
  disabled?: boolean;
}) {
  const id = useId();
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
            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldError>{error ?? fallbackError?.[0]}</FieldError>
    </Field>
  );
}

export function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">{children}</CardContent>
    </Card>
  );
}

/** Revisión del alta con TODOS los campos, incluidos educación, procedencia y referencia. */
export function ReviewList({ values, branchName }: { values: DemographicsValues; branchName?: string }) {
  const rows: Array<[string, string]> = [
    ["Nombre", values.displayName.trim() || "—"],
    ["Documento", [values.docType, values.docNumber.trim()].filter(Boolean).join(" ") || "—"],
    ["Nacimiento", values.birthDate || "—"],
    ["Sexo", values.sex === "M" ? "Masculino" : values.sex === "F" ? "Femenino" : "—"],
    ["Teléfono", values.phone.trim() || "—"],
    ["Correo", values.email.trim() || "—"],
    ["Estado civil", values.maritalStatus.trim() || "—"],
    ["Educación", values.educationLevel.trim() || "—"],
    ["Ocupación", values.occupation.trim() || "—"],
    ["Procedencia", values.origin.trim() || "—"],
    ["Dirección", values.address.trim() || "—"],
    ["Seguro", [values.insuranceType, values.insuranceDetail.trim()].filter(Boolean).join(" · ") || "—"],
    ["Contacto de emergencia", [values.emergencyContactName.trim(), values.emergencyContactPhone.trim()].filter(Boolean).join(" · ") || "—"],
    ["Referencia", values.referralSource.trim() || "—"],
    ["Sucursal", branchName ?? (values.registeredBranchId ? values.registeredBranchId : "—")],
  ];
  return (
    <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
          <dd className="break-words text-sm">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Mensajes de validación de TanStack Form a texto (para FieldError con fallback). */
export function tanstackFieldErrors(metaErrors: unknown): string[] {
  return fieldErrorMessages(metaErrors);
}
