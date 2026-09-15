import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from "@odentia/ui";
import { PageHeader, WizardSteps, fieldErrorMessages } from "@odentia/ui-patterns";
import { useEffect, useId, useRef, useState, type InputHTMLAttributes } from "react";
import { z } from "zod";
import { ApiError, apiFetch } from "../../lib/api";
import type { ContactFull } from "../../lib/crm";
import type { Patient } from "../../lib/patients";

export const Route = createFileRoute("/_org/patients/new")({
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.contactId === "string" ? { contactId: search.contactId } : {}),
  }),
  component: NewPatientPage,
});

const STEPS = [
  { id: "identificacion", label: "Identificación" },
  { id: "filiacion", label: "Filiación" },
];

const DOC_TYPES = ["DNI", "CE", "PASAPORTE", "OTRO"];
const INSURANCE_TYPES = ["PARTICULAR", "SIS", "ESSALUD", "EPS", "OTRO"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface FormValues {
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

const emptyForm: FormValues = {
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

const step1Schema = z.object({
  displayName: z.string().trim().min(1, "Ingresa el nombre del paciente"),
  docType: z.string(),
  docNumber: z.string().trim().max(20, "Máximo 20 caracteres"),
  birthDate: z.string(),
  sex: z.string(),
  phone: z.string().trim().max(50, "Máximo 50 caracteres"),
  email: z.string().trim().max(200, "Máximo 200 caracteres"),
});

const step2Schema = z.object({
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

type StepErrors = Record<string, string>;

function validateStep1(values: FormValues): StepErrors {
  const errs: StepErrors = {};
  const parsed = step1Schema.safeParse(values);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "");
      if (key && !errs[key]) errs[key] = issue.message;
    }
  }
  if (values.docType && !DOC_TYPES.includes(values.docType)) {
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
function validateStep2(values: FormValues): StepErrors {
  const errs: StepErrors = {};
  const parsed = step2Schema.safeParse({
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
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "");
      if (key && !errs[key]) errs[key] = issue.message;
    }
  }
  if (values.insuranceType && !INSURANCE_TYPES.includes(values.insuranceType)) {
    errs.insuranceType = "Tipo de seguro inválido";
  }
  if (values.registeredBranchId && !UUID_RE.test(values.registeredBranchId)) {
    errs.registeredBranchId = "Sucursal inválida";
  }
  return errs;
}

interface Branch {
  id: string;
  name: string;
}

function buildPatientBody(values: FormValues, contactId: string | undefined): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (contactId) {
    body.contactId = contactId;
  } else {
    body.displayName = values.displayName.trim();
  }
  const set = (key: string, raw: string) => {
    const v = raw.trim();
    if (v) body[key] = v;
  };
  if (values.docType) body.docType = values.docType;
  set("docNumber", values.docNumber);
  set("birthDate", values.birthDate);
  if (values.sex) body.sex = values.sex;
  set("phone", values.phone);
  set("email", values.email);
  set("maritalStatus", values.maritalStatus);
  set("educationLevel", values.educationLevel);
  set("occupation", values.occupation);
  set("address", values.address);
  set("origin", values.origin);
  set("emergencyContactName", values.emergencyContactName);
  set("emergencyContactPhone", values.emergencyContactPhone);
  if (values.insuranceType) body.insuranceType = values.insuranceType;
  set("insuranceDetail", values.insuranceDetail);
  set("referralSource", values.referralSource);
  if (values.registeredBranchId) body.registeredBranchId = values.registeredBranchId;
  return body;
}

function TextRow({
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

function SelectRow({
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
        items={options}
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

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">{children}</CardContent>
    </Card>
  );
}

function NewPatientPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { contactId } = Route.useSearch();

  const [current, setCurrent] = useState(0);
  const [visited, setVisited] = useState<readonly number[]>([0]);
  const [stepErrors, setStepErrors] = useState<StepErrors>({});
  const [pending, setPending] = useState(false);
  const prefilled = useRef(false);

  const form = useForm({ defaultValues: emptyForm });

  const contactQuery = useQuery({
    queryKey: ["contact", contactId ?? "none"],
    queryFn: () => apiFetch<{ data: ContactFull }>(`/api/contacts/${contactId}`),
    enabled: Boolean(contactId),
  });
  const contactName = contactQuery.data?.data.contact.displayName ?? "";

  useEffect(() => {
    if (contactName && !prefilled.current) {
      prefilled.current = true;
      form.setFieldValue("displayName", contactName);
    }
  }, [contactName, form]);

  const branchesQuery = useQuery({
    queryKey: ["branches"],
    queryFn: () => apiFetch<{ data: Branch[] }>("/api/branches"),
  });

  function go(index: number) {
    setCurrent(index);
    setVisited((v) => (v.includes(index) ? v : [...v, index]));
  }

  function clearError(key: string) {
    setStepErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function next() {
    if (pending) return;
    if (current === 0) {
      const errs = validateStep1(form.state.values);
      setStepErrors(errs);
      if (Object.keys(errs).length > 0) return;
    } else if (current === 1) {
      const errs = validateStep2(form.state.values);
      setStepErrors(errs);
      if (Object.keys(errs).length > 0) return;
    }
    go(current + 1);
  }

  async function finish(): Promise<void> {
    if (pending) return;
    const values = form.state.values;
    const e1 = validateStep1(values);
    if (Object.keys(e1).length > 0) {
      setStepErrors(e1);
      go(0);
      return;
    }
    const e2 = validateStep2(values);
    if (Object.keys(e2).length > 0) {
      setStepErrors(e2);
      go(1);
      return;
    }
    setStepErrors({});
    setPending(true);
    try {
      const created = await apiFetch<{ data: Patient }>("/api/patients", {
        method: "POST",
        body: JSON.stringify(buildPatientBody(values, contactId)),
      });
      const patientId = created.data.id;
      await queryClient.invalidateQueries({ queryKey: ["patients"] });
      toast.success("Paciente registrado");
      await navigate({ to: "/patients/$patientId/triaje", params: { patientId } });
    } catch (err) {
      toast.error(err instanceof ApiError ? (err.shape.message ?? err.message) : "No se pudo registrar el paciente");
    } finally {
      setPending(false);
    }
  }

  const fromContact = Boolean(contactId);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Nuevo paciente"
        subtitle="Registro administrativo en 2 pasos. El triaje clínico se completa al finalizar el registro."
        actions={
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => void navigate({ to: "/patients" })}
          >
            Volver a pacientes
          </Button>
        }
      />
      <WizardSteps
        steps={STEPS}
        current={current}
        visited={visited}
        onGo={(index) => {
          if (!pending) setCurrent(index);
        }}
      />
      {fromContact ? (
        contactQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Cargando contacto…</p>
        ) : contactName ? (
          <p className="text-sm text-muted-foreground">
            Registrando a partir del contacto{" "}
            <span className="font-medium text-foreground">{contactName}</span>. El nombre queda
            bloqueado.
          </p>
        ) : null
      ) : null}

      {current === 0 ? (
        <div className="flex flex-col gap-4">
          <SectionCard title="Identidad">
            <form.Field name="displayName">
              {(field) => (
                <TextRow
                  label="Nombre del paciente"
                  value={field.state.value}
                  error={stepErrors.displayName}
                  fallbackError={fieldErrorMessages(field.state.meta.errors)}
                  inputProps={{
                    "aria-label": "Nombre del paciente",
                    disabled: fromContact,
                    placeholder: "Nombres y apellidos",
                  }}
                  onChange={(v) => {
                    field.handleChange(v);
                    clearError("displayName");
                  }}
                />
              )}
            </form.Field>
            <form.Field name="docType">
              {(field) => (
                <SelectRow
                  label="Tipo de documento"
                  value={field.state.value}
                  error={stepErrors.docType}
                  fallbackError={fieldErrorMessages(field.state.meta.errors)}
                  options={[
                    { value: "", label: "—" },
                    { value: "DNI", label: "DNI" },
                    { value: "CE", label: "CE" },
                    { value: "PASAPORTE", label: "Pasaporte" },
                    { value: "OTRO", label: "Otro" },
                  ]}
                  onChange={(v) => {
                    field.handleChange(v);
                    clearError("docType");
                    clearError("docNumber");
                  }}
                />
              )}
            </form.Field>
            <form.Field name="docNumber">
              {(field) => (
                <TextRow
                  label="Número de documento"
                  value={field.state.value}
                  error={stepErrors.docNumber}
                  fallbackError={fieldErrorMessages(field.state.meta.errors)}
                  inputProps={{ "aria-label": "Número de documento", inputMode: "numeric" }}
                  onChange={(v) => {
                    field.handleChange(v);
                    clearError("docNumber");
                  }}
                />
              )}
            </form.Field>
            <form.Field name="birthDate">
              {(field) => (
                <TextRow
                  label="Fecha de nacimiento"
                  value={field.state.value}
                  error={stepErrors.birthDate}
                  fallbackError={fieldErrorMessages(field.state.meta.errors)}
                  inputProps={{ "aria-label": "Fecha de nacimiento", type: "date" }}
                  onChange={(v) => {
                    field.handleChange(v);
                    clearError("birthDate");
                  }}
                />
              )}
            </form.Field>
            <form.Field name="sex">
              {(field) => (
                <SelectRow
                  label="Sexo"
                  value={field.state.value}
                  error={stepErrors.sex}
                  fallbackError={fieldErrorMessages(field.state.meta.errors)}
                  options={[
                    { value: "", label: "—" },
                    { value: "M", label: "Masculino" },
                    { value: "F", label: "Femenino" },
                  ]}
                  onChange={(v) => {
                    field.handleChange(v);
                    clearError("sex");
                  }}
                />
              )}
            </form.Field>
          </SectionCard>
          <SectionCard title="Contacto">
            <form.Field name="phone">
              {(field) => (
                <TextRow
                  label="Teléfono"
                  value={field.state.value}
                  error={stepErrors.phone}
                  fallbackError={fieldErrorMessages(field.state.meta.errors)}
                  inputProps={{ "aria-label": "Teléfono", type: "tel" }}
                  onChange={(v) => {
                    field.handleChange(v);
                    clearError("phone");
                  }}
                />
              )}
            </form.Field>
            <form.Field name="email">
              {(field) => (
                <TextRow
                  label="Correo electrónico"
                  value={field.state.value}
                  error={stepErrors.email}
                  fallbackError={fieldErrorMessages(field.state.meta.errors)}
                  inputProps={{ "aria-label": "Correo electrónico", type: "email" }}
                  onChange={(v) => {
                    field.handleChange(v);
                    clearError("email");
                  }}
                />
              )}
            </form.Field>
          </SectionCard>
        </div>
      ) : null}

      {current === 1 ? (
        <div className="flex flex-col gap-4">
          <SectionCard title="Datos personales">
            <form.Field name="maritalStatus">
              {(field) => (
                <TextRow
                  label="Estado civil"
                  value={field.state.value}
                  error={stepErrors.maritalStatus}
                  fallbackError={fieldErrorMessages(field.state.meta.errors)}
                  inputProps={{ "aria-label": "Estado civil" }}
                  onChange={(v) => {
                    field.handleChange(v);
                    clearError("maritalStatus");
                  }}
                />
              )}
            </form.Field>
            <form.Field name="educationLevel">
              {(field) => (
                <TextRow
                  label="Nivel educativo"
                  value={field.state.value}
                  error={stepErrors.educationLevel}
                  fallbackError={fieldErrorMessages(field.state.meta.errors)}
                  inputProps={{ "aria-label": "Nivel educativo" }}
                  onChange={(v) => {
                    field.handleChange(v);
                    clearError("educationLevel");
                  }}
                />
              )}
            </form.Field>
            <form.Field name="occupation">
              {(field) => (
                <TextRow
                  label="Ocupación"
                  value={field.state.value}
                  error={stepErrors.occupation}
                  fallbackError={fieldErrorMessages(field.state.meta.errors)}
                  inputProps={{ "aria-label": "Ocupación" }}
                  onChange={(v) => {
                    field.handleChange(v);
                    clearError("occupation");
                  }}
                />
              )}
            </form.Field>
            <form.Field name="origin">
              {(field) => (
                <TextRow
                  label="Procedencia"
                  value={field.state.value}
                  error={stepErrors.origin}
                  fallbackError={fieldErrorMessages(field.state.meta.errors)}
                  inputProps={{ "aria-label": "Procedencia" }}
                  onChange={(v) => {
                    field.handleChange(v);
                    clearError("origin");
                  }}
                />
              )}
            </form.Field>
          </SectionCard>
          <SectionCard title="Dirección">
            <div className="sm:col-span-2">
              <form.Field name="address">
                {(field) => (
                  <TextRow
                    label="Dirección"
                    value={field.state.value}
                    error={stepErrors.address}
                    fallbackError={fieldErrorMessages(field.state.meta.errors)}
                    inputProps={{ "aria-label": "Dirección" }}
                    onChange={(v) => {
                      field.handleChange(v);
                      clearError("address");
                    }}
                  />
                )}
              </form.Field>
            </div>
          </SectionCard>
          <SectionCard title="Seguro">
            <form.Field name="insuranceType">
              {(field) => (
                <SelectRow
                  label="Tipo de seguro"
                  value={field.state.value}
                  error={stepErrors.insuranceType}
                  fallbackError={fieldErrorMessages(field.state.meta.errors)}
                  options={[
                    { value: "", label: "—" },
                    { value: "PARTICULAR", label: "Particular" },
                    { value: "SIS", label: "SIS" },
                    { value: "ESSALUD", label: "EsSalud" },
                    { value: "EPS", label: "EPS" },
                    { value: "OTRO", label: "Otro" },
                  ]}
                  onChange={(v) => {
                    field.handleChange(v);
                    clearError("insuranceType");
                  }}
                />
              )}
            </form.Field>
            <form.Field name="insuranceDetail">
              {(field) => (
                <TextRow
                  label="Detalle del seguro"
                  value={field.state.value}
                  error={stepErrors.insuranceDetail}
                  fallbackError={fieldErrorMessages(field.state.meta.errors)}
                  inputProps={{ "aria-label": "Detalle del seguro" }}
                  onChange={(v) => {
                    field.handleChange(v);
                    clearError("insuranceDetail");
                  }}
                />
              )}
            </form.Field>
          </SectionCard>
          <SectionCard title="Emergencia y canal">
            <form.Field name="emergencyContactName">
              {(field) => (
                <TextRow
                  label="Contacto de emergencia (nombre)"
                  value={field.state.value}
                  error={stepErrors.emergencyContactName}
                  fallbackError={fieldErrorMessages(field.state.meta.errors)}
                  inputProps={{ "aria-label": "Contacto de emergencia (nombre)" }}
                  onChange={(v) => {
                    field.handleChange(v);
                    clearError("emergencyContactName");
                  }}
                />
              )}
            </form.Field>
            <form.Field name="emergencyContactPhone">
              {(field) => (
                <TextRow
                  label="Contacto de emergencia (teléfono)"
                  value={field.state.value}
                  error={stepErrors.emergencyContactPhone}
                  fallbackError={fieldErrorMessages(field.state.meta.errors)}
                  inputProps={{ "aria-label": "Contacto de emergencia (teléfono)", type: "tel" }}
                  onChange={(v) => {
                    field.handleChange(v);
                    clearError("emergencyContactPhone");
                  }}
                />
              )}
            </form.Field>
            <form.Field name="referralSource">
              {(field) => (
                <TextRow
                  label="Cómo nos conoció"
                  value={field.state.value}
                  error={stepErrors.referralSource}
                  fallbackError={fieldErrorMessages(field.state.meta.errors)}
                  inputProps={{ "aria-label": "Cómo nos conoció" }}
                  onChange={(v) => {
                    field.handleChange(v);
                    clearError("referralSource");
                  }}
                />
              )}
            </form.Field>
            <form.Field name="registeredBranchId">
              {(field) => (
                <SelectRow
                  label="Sucursal de registro"
                  value={field.state.value}
                  error={stepErrors.registeredBranchId}
                  fallbackError={fieldErrorMessages(field.state.meta.errors)}
                  disabled={branchesQuery.isLoading}
                  options={[
                    { value: "", label: "—" },
                    ...(branchesQuery.data?.data ?? []).map((b) => ({
                      value: b.id,
                      label: b.name,
                    })),
                  ]}
                  onChange={(v) => {
                    field.handleChange(v);
                    clearError("registeredBranchId");
                  }}
                />
              )}
            </form.Field>
          </SectionCard>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <Button type="button" variant="outline" disabled={current === 0 || pending} onClick={() => setCurrent(current - 1)}>
          Anterior
        </Button>
        {current < STEPS.length - 1 ? (
          <Button type="button" disabled={pending} onClick={next}>
            Siguiente
          </Button>
        ) : (
          <Button type="button" disabled={pending} onClick={() => void finish()}>
            Registrar paciente
          </Button>
        )}
      </div>
    </div>
  );
}
