import {
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
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
import { FormDrawer, fieldErrorMessages } from "@odentia/ui-patterns"
import { useForm } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown } from "lucide-react"
import { useEffect, useId, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { timeAgo, useCanWrite } from "../../lib/crm"
import type { PatientFull } from "../../lib/patients"
import {
  type DemographicsValues,
  DOC_TYPE_OPTIONS,
  emptyDemographics,
  INSURANCE_OPTIONS,
  SEX_OPTIONS,
  type StepErrors,
  validateComplementary,
  validateIdentity,
} from "./patient-demographics-form"

interface Branch {
  id: string
  name: string
}

function strField(v: unknown): string {
  return typeof v === "string" ? v : ""
}

function errorText(error: unknown): string | null {
  if (error instanceof ApiError) {
    const shape = error.shape as { message?: unknown; code?: unknown }
    if (typeof shape.message === "string" && shape.message !== "") return shape.message
    if (typeof shape.code === "string" && shape.code !== "") return `Error: ${shape.code}`
    return `Error ${error.status}`
  }
  if (error instanceof Error && error.message !== "") return error.message
  return null
}

function toFormValues(detail: PatientFull): DemographicsValues {
  const p = detail.patient
  return {
    ...emptyDemographics,
    displayName: detail.patient.displayName,
    docType: strField(p.docType),
    docNumber: strField(p.docNumber),
    birthDate: strField(p.birthDate),
    sex: strField(p.sex),
    phone: strField(p.phone),
    email: strField(p.email),
    maritalStatus: strField(p.maritalStatus),
    educationLevel: strField(p.educationLevel),
    occupation: strField(p.occupation),
    address: strField(p.address),
    origin: strField(p.origin),
    emergencyContactName: strField(p.emergencyContactName),
    emergencyContactPhone: strField(p.emergencyContactPhone),
    insuranceType: strField(p.insuranceType),
    insuranceDetail: strField(p.insuranceDetail),
    referralSource: strField(p.referralSource),
    registeredBranchId: strField(p.registeredBranchId),
  }
}

/** Editor ancho de filiación con los mismos campos y validación del alta. */
export function FiliacionDrawer({
  patientId,
  detail,
  open,
  onOpenChange,
}: {
  patientId: string
  detail: PatientFull
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const canWrite = useCanWrite()
  const uid = useId()
  const p = detail.patient
  const [stepErrors, setStepErrors] = useState<StepErrors>({})
  const [isActive, setIsActive] = useState<boolean>(p.isActive)
  const [openAddress, setOpenAddress] = useState(false)
  const [openEmergency, setOpenEmergency] = useState(false)
  const [openInsurance, setOpenInsurance] = useState(false)
  const [openExtra, setOpenExtra] = useState(false)

  const form = useForm({ defaultValues: toFormValues(detail) })

  useEffect(() => {
    if (open) {
      form.reset(toFormValues(detail))
      setStepErrors({})
      setIsActive(p.isActive)
    }
    // Se resincroniza al abrir con el detalle vigente.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const branchesQuery = useQuery({
    queryKey: ["branches"],
    queryFn: () => apiFetch<{ data: Branch[] }>("/api/branches"),
    enabled: open,
  })

  const invalidatePatient = () => {
    void queryClient.invalidateQueries({ queryKey: ["patient", patientId] })
    void queryClient.invalidateQueries({ queryKey: ["patients"] })
  }

  const patchMutation = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      apiFetch(`/api/patients/${patientId}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => {
      invalidatePatient()
      onOpenChange(false)
    },
  })

  const consentGiven = p.dataConsentAt != null

  function submit(): void {
    if (patchMutation.isPending || !canWrite) return
    const values = form.state.values
    const errs = { ...validateIdentity(values), ...validateComplementary(values) }
    setStepErrors(errs)
    if (Object.keys(errs).length > 0) {
      const first = document.querySelector<HTMLElement>(
        `[data-filiacion-error="1"] input, [data-filiacion-error="1"] button`,
      )
      first?.focus()
      return
    }
    // Solo campos explícitamente editados: lo no visitado no se envía (nunca null involuntario).
    const touched = (name: keyof DemographicsValues): boolean =>
      form.state.fieldMeta[name]?.isTouched === true
    const patch: Record<string, unknown> = {}
    const textOrNull = (name: keyof DemographicsValues): string | null => {
      const v = values[name].trim()
      return v === "" ? null : v
    }
    if (touched("displayName")) patch.displayName = values.displayName.trim()
    if (touched("docType")) patch.docType = values.docType === "" ? null : values.docType
    if (touched("docNumber")) patch.docNumber = textOrNull("docNumber")
    if (touched("birthDate")) patch.birthDate = textOrNull("birthDate")
    if (touched("sex")) patch.sex = values.sex === "" ? null : values.sex
    if (touched("phone")) patch.phone = textOrNull("phone")
    if (touched("email")) patch.email = textOrNull("email")
    if (touched("maritalStatus")) patch.maritalStatus = textOrNull("maritalStatus")
    if (touched("educationLevel")) patch.educationLevel = textOrNull("educationLevel")
    if (touched("occupation")) patch.occupation = textOrNull("occupation")
    if (touched("address")) patch.address = textOrNull("address")
    if (touched("origin")) patch.origin = textOrNull("origin")
    if (touched("emergencyContactName"))
      patch.emergencyContactName = textOrNull("emergencyContactName")
    if (touched("emergencyContactPhone"))
      patch.emergencyContactPhone = textOrNull("emergencyContactPhone")
    if (touched("insuranceType"))
      patch.insuranceType = values.insuranceType === "" ? null : values.insuranceType
    if (touched("insuranceDetail")) patch.insuranceDetail = textOrNull("insuranceDetail")
    if (touched("referralSource")) patch.referralSource = textOrNull("referralSource")
    if (touched("registeredBranchId"))
      patch.registeredBranchId = values.registeredBranchId === "" ? null : values.registeredBranchId
    if (isActive !== p.isActive) patch.isActive = isActive
    if (Object.keys(patch).length === 0) {
      onOpenChange(false)
      return
    }
    void patchMutation.mutate(patch)
  }

  function textField(
    name: keyof DemographicsValues,
    label: string,
    inputProps?: React.InputHTMLAttributes<HTMLInputElement>,
  ): React.JSX.Element {
    return (
      <form.Field
        name={name}
        children={(field) => (
          <Field
            data-filiacion-error={
              stepErrors[name] || fieldErrorMessages(field.state.meta.errors)[0] ? "1" : undefined
            }
          >
            <FieldLabel htmlFor={`${uid}-${name}`}>{label}</FieldLabel>
            <Input
              id={`${uid}-${name}`}
              {...inputProps}
              value={field.state.value}
              onChange={(e) => {
                field.handleChange(e.target.value)
                setStepErrors((prev) => {
                  if (!prev[name]) return prev
                  const next = { ...prev }
                  delete next[name]
                  return next
                })
              }}
              onBlur={field.handleBlur}
            />
            <FieldError>
              {stepErrors[name] ?? fieldErrorMessages(field.state.meta.errors)[0]}
            </FieldError>
          </Field>
        )}
      />
    )
  }

  function selectField(
    name: keyof DemographicsValues,
    label: string,
    options: readonly { value: string; label: string }[],
    disabled?: boolean,
  ): React.JSX.Element {
    return (
      <form.Field
        name={name}
        children={(field) => (
          <Field>
            <FieldLabel htmlFor={`${uid}-${name}`}>{label}</FieldLabel>
            <Select
              value={field.state.value}
              items={Object.fromEntries(options.map((o) => [o.value, o.label]))}
              disabled={disabled}
              onValueChange={(v) => field.handleChange(v ?? "")}
            >
              <SelectTrigger id={`${uid}-${name}`} aria-label={label}>
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
            <FieldError>
              {stepErrors[name] ?? fieldErrorMessages(field.state.meta.errors)[0]}
            </FieldError>
          </Field>
        )}
      />
    )
  }

  return (
    <FormDrawer
      open={open}
      onClose={() => !patchMutation.isPending && onOpenChange(false)}
      title="Editar datos personales"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
      isSubmitting={patchMutation.isPending}
      isDirty={form.state.isDirty || isActive !== p.isActive}
      submitLabel="Guardar cambios"
      error={
        patchMutation.isError ? (errorText(patchMutation.error) ?? "No se pudo guardar.") : null
      }
      className="sm:max-w-4xl"
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-6 rounded-md bg-card p-6">
          <div className="flex flex-col gap-1.5 pb-3">
            <div className="font-heading text-base font-medium">Identidad</div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {textField("displayName", "Nombre completo")}
            {selectField("docType", "Tipo de documento", DOC_TYPE_OPTIONS)}
            {textField("docNumber", "Número de documento", { maxLength: 20 })}
            {textField("birthDate", "Fecha de nacimiento", { type: "date" })}
            {selectField("sex", "Sexo", SEX_OPTIONS)}
          </div>
        </div>

        <div className="flex flex-col gap-6 rounded-md bg-card p-6">
          <div className="flex flex-col gap-1.5 pb-3">
            <div className="font-heading text-base font-medium">Contacto</div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {textField("phone", "Teléfono", { type: "tel", maxLength: 50 })}
            {textField("email", "Correo electrónico", { type: "email", maxLength: 200 })}
          </div>
        </div>

        <Collapsible open={openAddress} onOpenChange={setOpenAddress}>
          <div className="flex flex-col gap-6 rounded-md bg-card p-6">
            <div className="flex flex-col gap-1.5 pb-3">
              <CollapsibleTrigger className="text-base font-semibold">
                <span className="flex items-center gap-1">
                  Domicilio <ChevronDown aria-hidden className="size-4" />
                </span>
              </CollapsibleTrigger>
            </div>
            <CollapsibleContent>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2">{textField("address", "Domicilio")}</div>
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>

        <Collapsible open={openEmergency} onOpenChange={setOpenEmergency}>
          <div className="flex flex-col gap-6 rounded-md bg-card p-6">
            <div className="flex flex-col gap-1.5 pb-3">
              <CollapsibleTrigger className="text-base font-semibold">
                <span className="flex items-center gap-1">
                  Tutor y emergencia <ChevronDown aria-hidden className="size-4" />
                </span>
              </CollapsibleTrigger>
            </div>
            <CollapsibleContent>
              <div className="grid gap-4 sm:grid-cols-2">
                {textField("emergencyContactName", "Contacto de emergencia")}
                {textField("emergencyContactPhone", "Teléfono de emergencia", { type: "tel" })}
                {textField("referralSource", "Referido por")}
                <Field>
                  <FieldLabel htmlFor={`${uid}-branch`}>Sucursal de registro</FieldLabel>
                  <form.Field
                    name="registeredBranchId"
                    children={(field) => (
                      <>
                        <Select
                          value={field.state.value}
                          disabled={branchesQuery.isLoading}
                          onValueChange={(v) => field.handleChange(v ?? "")}
                        >
                          <SelectTrigger id={`${uid}-branch`} aria-label="Sucursal de registro">
                            <SelectValue
                              placeholder={branchesQuery.isLoading ? "Cargando…" : "Sin asignar"}
                            />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="">Sin asignar</SelectItem>
                            {(branchesQuery.data?.data ?? []).map((b) => (
                              <SelectItem key={b.id} value={b.id}>
                                {b.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FieldError>
                          {stepErrors.registeredBranchId ??
                            fieldErrorMessages(field.state.meta.errors)[0]}
                        </FieldError>
                      </>
                    )}
                  />
                </Field>
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>

        <Collapsible open={openInsurance} onOpenChange={setOpenInsurance}>
          <div className="flex flex-col gap-6 rounded-md bg-card p-6">
            <div className="flex flex-col gap-1.5 pb-3">
              <CollapsibleTrigger className="text-base font-semibold">
                <span className="flex items-center gap-1">
                  Seguro <ChevronDown aria-hidden className="size-4" />
                </span>
              </CollapsibleTrigger>
            </div>
            <CollapsibleContent>
              <div className="grid gap-4 sm:grid-cols-2">
                {selectField("insuranceType", "Seguro", INSURANCE_OPTIONS)}
                {textField("insuranceDetail", "Detalle del seguro")}
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>
        <Collapsible open={openExtra} onOpenChange={setOpenExtra}>
          <div className="flex flex-col gap-6 rounded-md bg-card p-6">
            <div className="flex flex-col gap-1.5 pb-3">
              <CollapsibleTrigger className="text-base font-semibold">
                <span className="flex items-center gap-1">
                  Datos complementarios <ChevronDown aria-hidden className="size-4" />
                </span>
              </CollapsibleTrigger>
            </div>
            <CollapsibleContent>
              <div className="grid gap-4 sm:grid-cols-2">
                {textField("maritalStatus", "Estado civil")}
                {textField("educationLevel", "Grado de instrucción")}
                {textField("occupation", "Ocupación")}
                {textField("origin", "Procedencia")}
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>

        <div className="flex flex-col gap-6 rounded-md bg-card p-6">
          <div className="flex flex-col gap-1.5 pb-3">
            <div className="font-heading text-base font-medium">Estado</div>
          </div>
          <div>
            <Field className="flex-row items-center gap-2">
              <Checkbox
                id={`${uid}-isActive`}
                checked={isActive}
                onCheckedChange={(c) => setIsActive(c === true)}
              />
              <FieldLabel htmlFor={`${uid}-isActive`} className="font-normal">
                Paciente activo
              </FieldLabel>
            </Field>
          </div>
        </div>

        <div className="flex flex-col gap-6 rounded-md bg-card p-6">
          <div className="flex flex-col gap-1.5 pb-3">
            <div className="font-heading text-base font-medium">Consentimiento de datos</div>
          </div>
          <div className="flex flex-col gap-2">
            {consentGiven ? (
              <p className="text-sm text-muted-foreground">
                Consentimiento registrado el {timeAgo(p.dataConsentAt ?? null)}. No puede retirarse
                desde este formulario.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Sin consentimiento de datos registrado. Se registra desde Antecedentes, en un solo
                paso explícito.
              </p>
            )}
          </div>
        </div>
      </div>
    </FormDrawer>
  )
}
