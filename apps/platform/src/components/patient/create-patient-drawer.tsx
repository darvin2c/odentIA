import { Alert, AlertDescription, AlertTitle, Button, toast } from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useRef, useState } from "react"
import type {
  RegistrationAnswers,
  RegistrationConfig,
  RegistrationDemographics,
} from "@odentia/clinical"
import { ApiError, apiFetch } from "../../lib/api"
import type { ContactFull } from "../../lib/crm"
import { hcLabel, type Patient } from "../../lib/patients"
import {
  PatientRegistrationForm,
  type RegistrationFormView,
  type RegistrationSubmitDraft,
} from "./patient-registration-form"

interface Branch {
  id: string
  name: string
}

interface DuplicateSuggestion {
  id: string
  patientNumber: number
  displayName: string
  isActive: boolean
  reason: "document" | "name_birthDate" | "phone"
}

const DUPLICATE_REASON_LABELS: Record<DuplicateSuggestion["reason"], string> = {
  document: "Mismo documento",
  name_birthDate: "Mismo nombre y fecha de nacimiento",
  phone: "Mismo teléfono",
}

async function fetchDuplicates(answers: RegistrationAnswers): Promise<DuplicateSuggestion[]> {
  const demographics = answers.demographics as Partial<RegistrationDemographics>
  const params = new URLSearchParams()
  const set = (key: string, raw: unknown): void => {
    const value = typeof raw === "string" ? raw.trim() : ""
    if (value) params.set(key, value)
  }
  set("displayName", demographics.displayName)
  set("birthDate", demographics.birthDate)
  set("docType", demographics.docType)
  set("docNumber", demographics.docNumber)
  set("phone", demographics.phone)
  if ([...params.keys()].length === 0) return []
  const result = await apiFetch<{ data: DuplicateSuggestion[] }>(
    `/api/patients/duplicates?${params.toString()}`,
  )
  return result.data
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
  const fromContact = Boolean(contactId)
  const submissionRef = useRef<string>(crypto.randomUUID())
  const confirmedRef = useRef(false)
  const [duplicates, setDuplicates] = useState<DuplicateSuggestion[]>([])

  const contactQuery = useQuery({
    queryKey: ["contact", contactId ?? "none"],
    queryFn: () => apiFetch<{ data: ContactFull }>(`/api/contacts/${contactId}`),
    enabled: open && Boolean(contactId),
    retry: false,
  })
  const contact = contactQuery.data?.data

  const branchesQuery = useQuery({
    queryKey: ["branches"],
    queryFn: () => apiFetch<{ data: Branch[] }>("/api/branches"),
    enabled: open,
    retry: false,
  })

  const configQuery = useQuery({
    queryKey: ["patient-registration-config"],
    queryFn: () =>
      apiFetch<{ data: RegistrationConfig; meta: { today: string } }>(
        "/api/patient-registration/config",
      ),
    enabled: open,
    retry: false,
  })

  const configResult = open ? configQuery.data : undefined
  const ready =
    configResult !== undefined &&
    (!fromContact || contact !== undefined) &&
    !branchesQuery.isPending

  async function register(draft: RegistrationSubmitDraft): Promise<void> {
    const created = await apiFetch<{ data: Patient }>("/api/patients", {
      method: "POST",
      body: JSON.stringify({
        submissionId: submissionRef.current,
        answers: draft.answers,
        ...(draft.contacts ? { contacts: draft.contacts } : {}),
        ...(draft.registeredBranchId ? { registeredBranchId: draft.registeredBranchId } : {}),
        ...(contactId ? { contextContactId: contactId } : {}),
      }),
    })
    await queryClient.invalidateQueries({ queryKey: ["patients"] })
    toast.success("Paciente registrado")
    await navigate({
      to: "/patients/$patientId",
      params: { patientId: created.data.id },
      search: { tab: "antecedentes" },
    })
  }

  async function handleSubmit(draft: RegistrationSubmitDraft): Promise<void> {
    if (!confirmedRef.current) {
      const found = await fetchDuplicates(draft.answers)
      if (found.length > 0) {
        setDuplicates(found)
        throw new Error(
          "Encontramos posibles coincidencias: revisa la lista antes de registrar. Si el paciente ya existe, abre su ficha en lugar de crear otra.",
        )
      }
    }
    try {
      await register(draft)
    } catch (error) {
      const shape = error instanceof ApiError ? error.shape : null
      if (shape?.code === "FORM_CHANGED") {
        await queryClient.invalidateQueries({ queryKey: ["patient-registration-config"] })
        throw new Error(
          "La configuración del registro cambió: recargamos los campos vigentes. Revisa y vuelve a enviar.",
        )
      }
      throw new Error(shape?.message ?? "No se pudo registrar el paciente")
    }
  }

  function handleConfirmAnyway(view: RegistrationFormView): void {
    confirmedRef.current = true
    view.onSubmit({ preventDefault() {} } as React.FormEvent)
  }

  function handleCancelDuplicates(): void {
    confirmedRef.current = false
    setDuplicates([])
  }

  const today =
    configQuery.data?.meta.today ?? new Date().toISOString().slice(0, 10)
  const queryError = contactQuery.isError
    ? contactQuery.error.message
    : configQuery.isError
      ? (configQuery.error instanceof ApiError
          ? (configQuery.error.shape.message ?? "No se pudo cargar la configuración del registro")
          : "No se pudo cargar la configuración del registro")
      : null

  if (!ready) {
    return (
      <FormDrawer
        open={open}
        onClose={onClose}
        title="Nuevo paciente"
        description="Completa los datos de registro. Al guardar continuarás con los antecedentes de salud."
        isLoading
        submitDisabled
        error={queryError}
        submitLabel="Registrar paciente"
        onSubmit={(event) => event.preventDefault()}
        className="data-[swipe-axis=x]:sm:[--drawer-content-width:min(42rem,calc(100vw-2rem))]"
      >
        <p className="text-sm text-muted-foreground">Cargando formulario…</p>
      </FormDrawer>
    )
  }

  const config = configResult.data
  return (
    <PatientRegistrationForm
      mode="internal"
      config={config}
      today={today}
      context={contact ? { kind: "contact", contact } : { kind: "generic" }}
      branches={branchesQuery.data?.data}
      initialValues={
        contact ? { demographics: { displayName: contact.contact.displayName } } : undefined
      }
      onSubmit={handleSubmit}
    >
      {(view) => (
        <FormDrawer
          open={open}
          onClose={onClose}
          title="Nuevo paciente"
          description="Completa los datos de registro. Al guardar continuarás con los antecedentes de salud."
          isDirty={view.isDirty}
          isSubmitting={view.isSubmitting}
          submitDisabled={view.submitDisabled}
          error={view.error ?? queryError}
          submitLabel={view.submitLabel}
          onSubmit={view.onSubmit}
          className="data-[swipe-axis=x]:sm:[--drawer-content-width:min(42rem,calc(100vw-2rem))]"
          headerContent={view.progress}
        >
          {duplicates.length > 0 ? (
            <Alert className="mb-4">
              <AlertTitle>Posibles duplicados</AlertTitle>
              <AlertDescription>
                <span className="block">
                  Estos pacientes ya existen y coinciden con los datos ingresados. Abrir la ficha
                  evita crear duplicados; las coincidencias débiles (teléfono compartido) no
                  impiden registrar a un familiar.
                </span>
                <ul className="mt-2 flex flex-col gap-1">
                  {duplicates.map((duplicate) => (
                    <li key={duplicate.id} className="flex flex-wrap items-center gap-x-2 text-sm">
                      <a
                        className="font-medium underline"
                        href={`/patients/${duplicate.id}`}
                      >
                        {duplicate.displayName} · {hcLabel(duplicate.patientNumber)}
                      </a>
                      <span className="text-xs text-muted-foreground">
                        {DUPLICATE_REASON_LABELS[duplicate.reason]}
                        {duplicate.isActive ? "" : " · archivada"}
                      </span>
                    </li>
                  ))}
                </ul>
                <span className="mt-3 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => handleConfirmAnyway(view)}
                  >
                    Registrar de todos modos
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleCancelDuplicates}
                  >
                    Revisar datos
                  </Button>
                </span>
              </AlertDescription>
            </Alert>
          ) : null}
          <fieldset disabled={view.isSubmitting} className="flex min-w-0 flex-col gap-4">
            {view.body}
            {view.previous ? <div>{view.previous}</div> : null}
          </fieldset>
        </FormDrawer>
      )}
    </PatientRegistrationForm>
  )
}
