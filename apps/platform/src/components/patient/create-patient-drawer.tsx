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
} from "@odentia/ui"
import { FormDrawer, fieldErrorMessages, WizardSteps } from "@odentia/ui-patterns"
import { useForm } from "@tanstack/react-form"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { type InputHTMLAttributes, useEffect, useId, useRef, useState } from "react"
import { z } from "zod"
import { ApiError, apiFetch } from "../../lib/api"
import type { ContactFull } from "../../lib/crm"
import type { Patient } from "../../lib/patients"
import {
  DOC_TYPE_OPTIONS,
  emptyDemographics as emptyForm,
  type DemographicsValues as FormValues,
  INSURANCE_OPTIONS,
  ReviewList,
  SEX_OPTIONS,
  SectionCard,
  SelectRow,
  type StepErrors,
  TextRow,
  validateIdentity as validateStep1,
  validateComplementary as validateStep2,
} from "./patient-demographics-form"

const STEPS = [
  { id: "datos", label: "Datos personales" },
  { id: "filiacion", label: "Filiación y seguro" },
  { id: "revision", label: "Revisión" },
]

interface Branch {
  id: string
  name: string
}

function buildPatientBody(
  values: FormValues,
  contactId: string | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (contactId) {
    body.contactId = contactId
  } else {
    body.displayName = values.displayName.trim()
  }
  const set = (key: string, raw: string) => {
    const v = raw.trim()
    if (v) body[key] = v
  }
  if (values.docType) body.docType = values.docType
  set("docNumber", values.docNumber)
  set("birthDate", values.birthDate)
  if (values.sex) body.sex = values.sex
  set("phone", values.phone)
  set("email", values.email)
  set("maritalStatus", values.maritalStatus)
  set("educationLevel", values.educationLevel)
  set("occupation", values.occupation)
  set("address", values.address)
  set("origin", values.origin)
  set("emergencyContactName", values.emergencyContactName)
  set("emergencyContactPhone", values.emergencyContactPhone)
  if (values.insuranceType) body.insuranceType = values.insuranceType
  set("insuranceDetail", values.insuranceDetail)
  set("referralSource", values.referralSource)
  if (values.registeredBranchId) body.registeredBranchId = values.registeredBranchId
  return body
}

export function CreatePatientDrawer({
  open,
  onClose,
  contactId,
}: {
  open: boolean
  onClose: () => void
  contactId?: string
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const [current, setCurrent] = useState(0)
  const [visited, setVisited] = useState<readonly number[]>([0])
  const [stepErrors, setStepErrors] = useState<StepErrors>({})
  const [pending, setPending] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const prefilled = useRef(false)

  const form = useForm({ defaultValues: emptyForm })

  const contactQuery = useQuery({
    queryKey: ["contact", contactId ?? "none"],
    queryFn: () => apiFetch<{ data: ContactFull }>(`/api/contacts/${contactId}`),
    enabled: Boolean(contactId),
  })
  const contactName = contactQuery.data?.data.contact.displayName ?? ""

  useEffect(() => {
    if (contactName && !prefilled.current) {
      prefilled.current = true
      form.reset({ ...emptyForm, displayName: contactName })
    }
  }, [contactName, form])

  const branchesQuery = useQuery({
    queryKey: ["branches"],
    queryFn: () => apiFetch<{ data: Branch[] }>("/api/branches"),
  })

  function go(index: number) {
    setCurrent(index)
    setVisited((v) => (v.includes(index) ? v : [...v, index]))
  }

  function clearError(key: string) {
    setStepErrors((prev) => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  function next() {
    if (pending) return
    if (current === 0) {
      const errs = validateStep1(form.state.values)
      setStepErrors(errs)
      if (Object.keys(errs).length > 0) return
    } else if (current === 1) {
      const errs = validateStep2(form.state.values)
      setStepErrors(errs)
      if (Object.keys(errs).length > 0) return
    }
    go(current + 1)
  }

  async function finish(): Promise<void> {
    if (pending) return
    const values = form.state.values
    const e1 = validateStep1(values)
    if (Object.keys(e1).length > 0) {
      setStepErrors(e1)
      go(0)
      return
    }
    const e2 = validateStep2(values)
    if (Object.keys(e2).length > 0) {
      setStepErrors(e2)
      go(1)
      return
    }
    setStepErrors({})
    setSaveError(null)
    setPending(true)
    try {
      const created = await apiFetch<{ data: Patient }>("/api/patients", {
        method: "POST",
        body: JSON.stringify(buildPatientBody(values, contactId)),
      })
      const patientId = created.data.id
      await queryClient.invalidateQueries({ queryKey: ["patients"] })
      toast.success("Paciente registrado")
      await navigate({
        to: "/patients/$patientId",
        params: { patientId },
        search: { tab: "antecedentes" },
      })
    } catch (err) {
      setSaveError(
        err instanceof ApiError
          ? (err.shape.message ?? err.message)
          : "No se pudo registrar el paciente",
      )
    } finally {
      setPending(false)
    }
  }

  const fromContact = Boolean(contactId)

  return (
    <form.Subscribe selector={(state) => state.isDirty}>
      {(isDirty) => (
        <FormDrawer
          open={open}
          onClose={onClose}
          title="Nuevo paciente"
          description="Completa los datos de registro. Al guardar continuarás con los antecedentes de salud."
          isDirty={isDirty}
          isSubmitting={pending}
          isLoading={fromContact && contactQuery.isLoading}
          submitDisabled={fromContact && !contactQuery.data}
          error={saveError ?? (contactQuery.isError ? contactQuery.error.message : null)}
          submitLabel={current < STEPS.length - 1 ? "Siguiente" : "Registrar paciente"}
          onSubmit={(event) => {
            event.preventDefault()
            if (current < STEPS.length - 1) next()
            else void finish()
          }}
          className="data-[swipe-axis=x]:sm:[--drawer-content-width:min(42rem,calc(100vw-2rem))]"
          headerContent={
            <WizardSteps
              steps={STEPS}
              current={current}
              visited={visited}
              onGo={(index) => {
                if (!pending) setCurrent(index)
              }}
            />
          }
        >
          <fieldset disabled={pending} className="flex min-w-0 flex-col gap-4">
            {fromContact ? (
              contactQuery.isLoading ? (
                <p className="text-sm text-muted-foreground">Cargando contacto…</p>
              ) : contactName ? (
                <p className="text-sm text-muted-foreground">
                  Registrando a partir del contacto{" "}
                  <span className="font-medium text-foreground">{contactName}</span>. El nombre
                  queda bloqueado.
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
                          field.handleChange(v)
                          clearError("displayName")
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
                        options={DOC_TYPE_OPTIONS}
                        onChange={(v) => {
                          field.handleChange(v)
                          clearError("docType")
                          clearError("docNumber")
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
                          field.handleChange(v)
                          clearError("docNumber")
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
                          field.handleChange(v)
                          clearError("birthDate")
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
                        options={SEX_OPTIONS}
                        onChange={(v) => {
                          field.handleChange(v)
                          clearError("sex")
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
                          field.handleChange(v)
                          clearError("phone")
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
                          field.handleChange(v)
                          clearError("email")
                        }}
                      />
                    )}
                  </form.Field>
                </SectionCard>
              </div>
            ) : null}

            {current === 1 ? (
              <div className="flex min-w-0 flex-col gap-4">
                <SectionCard title="Filiación">
                  <form.Field name="maritalStatus">
                    {(field) => (
                      <TextRow
                        label="Estado civil"
                        value={field.state.value}
                        error={stepErrors.maritalStatus}
                        fallbackError={fieldErrorMessages(field.state.meta.errors)}
                        inputProps={{ "aria-label": "Estado civil" }}
                        onChange={(v) => {
                          field.handleChange(v)
                          clearError("maritalStatus")
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
                          field.handleChange(v)
                          clearError("educationLevel")
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
                          field.handleChange(v)
                          clearError("occupation")
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
                          field.handleChange(v)
                          clearError("origin")
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
                            field.handleChange(v)
                            clearError("address")
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
                        options={INSURANCE_OPTIONS}
                        onChange={(v) => {
                          field.handleChange(v)
                          clearError("insuranceType")
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
                          field.handleChange(v)
                          clearError("insuranceDetail")
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
                          field.handleChange(v)
                          clearError("emergencyContactName")
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
                        inputProps={{
                          "aria-label": "Contacto de emergencia (teléfono)",
                          type: "tel",
                        }}
                        onChange={(v) => {
                          field.handleChange(v)
                          clearError("emergencyContactPhone")
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
                          field.handleChange(v)
                          clearError("referralSource")
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
                          field.handleChange(v)
                          clearError("registeredBranchId")
                        }}
                      />
                    )}
                  </form.Field>
                </SectionCard>
              </div>
            ) : null}
            {current === 2 ? (
              <div className="flex min-w-0 flex-col gap-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Revisa los datos antes de guardar</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ReviewList
                      values={form.state.values}
                      branchName={
                        (branchesQuery.data?.data ?? []).find(
                          (b) => b.id === form.state.values.registeredBranchId,
                        )?.name
                      }
                    />
                  </CardContent>
                </Card>
                <Card className="border-primary/40 bg-primary/5">
                  <CardContent className="flex flex-col gap-1 pt-4">
                    <p className="text-sm font-medium">
                      Al registrar pasarás a los antecedentes de salud.
                    </p>
                    <p className="text-sm text-muted-foreground">
                      1. Antecedentes: alergias, condiciones, medicación y entrevista · 2. Ficha:
                      evaluación clínica · 3. Plan: tratamientos indicados desde el tarifario, luego
                      su presupuesto.
                    </p>
                  </CardContent>
                </Card>
              </div>
            ) : null}

            {current > 0 && (
              <div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => setCurrent(current - 1)}
                >
                  Anterior
                </Button>
              </div>
            )}
          </fieldset>
        </FormDrawer>
      )}
    </form.Subscribe>
  )
}
