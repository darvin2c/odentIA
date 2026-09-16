import {
  Button,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
  toast,
} from "@odentia/ui"
import {
  fieldErrorMessages,
  PageHeader,
  PageShell,
  SubmitButton,
  WizardSteps,
} from "@odentia/ui-patterns"
import { useForm } from "@tanstack/react-form"
import { createFileRoute } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { z } from "zod"
import { apiFetch } from "../lib/api"
import { authClient } from "../lib/auth-client"
import { requireVerifiedSession } from "../lib/guards"
import { BASE_DOMAIN, tenantUrl } from "../lib/host"

export const Route = createFileRoute("/onboarding")({
  beforeLoad: () => requireVerifiedSession(),
  component: OnboardingPage,
})

const STEPS = [
  { id: "persona", label: "Tu perfil" },
  { id: "org", label: "Organización" },
  { id: "profile", label: "Perfil legal" },
  { id: "branch", label: "Sucursal" },
] as const

/** Tema de cada paso para el subtítulo "Paso N de M: …". */
const STEP_TOPICS = ["tus datos", "organización", "perfil legal", "primera sucursal"] as const

/** Campos validados al avanzar desde cada paso. */
const STEP_FIELDS = [
  ["firstName", "lastName"],
  ["orgName", "slug"],
  ["legalName", "fiscalDocNumber"],
  ["branchName", "branchAddress"],
] as const

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const RESERVED_SLUGS: Record<string, true> = { api: true, app: true, www: true }

const personaSchema = z.object({
  firstName: z.string().min(1, "Ingresa tu nombre"),
  lastName: z.string().min(1, "Ingresa tus apellidos"),
})

const onboardingSchema = personaSchema.extend({
  orgName: z.string().min(2, "Nombre de la organización"),
  slug: z
    .string()
    .regex(slugPattern, "Slug inválido (minúsculas, números y guiones)")
    .refine((slug) => !RESERVED_SLUGS[slug], "Ese subdominio está reservado"),
  legalName: z.string().min(2, "Razón social"),
  fiscalDocNumber: z.string().max(20),
  branchName: z.string().min(2, "Nombre de la sucursal"),
  branchAddress: z.string(),
})

/** Schema por campo; valida al salir de su paso y en el submit final. */
const FIELD_SCHEMAS = {
  firstName: personaSchema.shape.firstName,
  lastName: personaSchema.shape.lastName,
  orgName: onboardingSchema.shape.orgName,
  slug: onboardingSchema.shape.slug,
  legalName: onboardingSchema.shape.legalName,
  fiscalDocNumber: onboardingSchema.shape.fiscalDocNumber,
  branchName: onboardingSchema.shape.branchName,
  branchAddress: onboardingSchema.shape.branchAddress,
} as const

/** Paso que posee cada campo: antes de ese paso el campo no se valida. */
const FIELD_STEP: Record<keyof typeof FIELD_SCHEMAS, number> = {
  firstName: 0,
  lastName: 0,
  orgName: 1,
  slug: 1,
  legalName: 2,
  fiscalDocNumber: 2,
  branchName: 3,
  branchAddress: 3,
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
}

/** "María José Ruiz Vega" → { firstName: "María", lastName: "José Ruiz Vega" }. */
function splitName(full: string): { firstName: string; lastName: string } {
  const trimmed = full.trim()
  const space = trimmed.indexOf(" ")
  if (space === -1) return { firstName: trimmed, lastName: "" }
  return { firstName: trimmed.slice(0, space), lastName: trimmed.slice(space + 1).trim() }
}

function OnboardingPage() {
  const sessionUser = authClient.useSession().data?.user
  // Quien se registró por email ya dio nombre y apellidos: el paso "Tu perfil"
  // solo aparece cuando la sesión no los tiene (p. ej. cuenta vía Google).
  const hasStoredName = Boolean(sessionUser?.firstName || sessionUser?.lastName)
  const offset = hasStoredName ? 1 : 0
  const [step, setStep] = useState(0)
  const [visited, setVisited] = useState<number[]>([0])
  const form = useForm({
    defaultValues: {
      firstName: splitName(sessionUser?.name ?? "").firstName,
      lastName: splitName(sessionUser?.name ?? "").lastName,
      orgName: "",
      slug: "",
      legalName: "",
      fiscalDocNumber: "",
      branchName: "",
      branchAddress: "",
    },
    validators: { onSubmit: onboardingSchema },
    onSubmitInvalid: () => {
      // Si algún paso previo quedó inválido, lleva al usuario al primero con errores.
      const invalidStep = STEP_FIELDS.findIndex((fields) =>
        fields.some((field) => (form.getFieldMeta(field)?.errors.length ?? 0) > 0),
      )
      if (invalidStep !== -1 && invalidStep !== step) goTo(invalidStep)
    },
    onSubmit: async ({ value }) => {
      const { error: nameError } = await authClient.updateUser({
        name: `${value.firstName} ${value.lastName}`.trim(),
        firstName: value.firstName,
        lastName: value.lastName,
      })
      if (nameError) {
        toast.error("No pudimos guardar tu nombre.")
        return
      }
      const { error: orgError } = await authClient.organization.create({
        name: value.orgName,
        slug: value.slug,
      })
      if (orgError) {
        goTo(1)
        toast.error(orgError.message ?? "No se pudo crear la organización (¿slug en uso?).")
        return
      }
      try {
        await apiFetch("/api/org-profile", {
          method: "PUT",
          body: JSON.stringify({
            legalName: value.legalName,
            fiscalDocNumber: value.fiscalDocNumber || undefined,
            countryCode: "PE",
          }),
        })
        await apiFetch("/api/branches", {
          method: "POST",
          body: JSON.stringify({
            name: value.branchName,
            addressLine1: value.branchAddress || undefined,
          }),
        })
        await apiFetch("/api/services/bootstrap", { method: "POST" })
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : "Error al guardar los datos.")
        return
      }
      window.location.assign(tenantUrl(value.slug, "/branches"))
    },
  })

  // Precarga el nombre de la sesión cuando llega después del primer render y
  // salta el paso de perfil si la cuenta ya lo trae guardado.
  useEffect(() => {
    if (!sessionUser) return
    if (!form.getFieldValue("firstName") && !form.getFieldValue("lastName")) {
      const { firstName, lastName } = splitName(sessionUser.name)
      if (firstName) form.setFieldValue("firstName", firstName)
      if (lastName) form.setFieldValue("lastName", lastName)
    }
    if ((sessionUser.firstName || sessionUser.lastName) && step === 0 && !visited.includes(1)) {
      goTo(1)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionUser])

  function goTo(index: number) {
    setStep(index)
    setVisited((prev) => (prev.includes(index) ? prev : [...prev, index]))
  }

  /** Validador de campo activo solo desde su paso en adelante. */
  function stepValidator(key: keyof typeof FIELD_SCHEMAS) {
    return {
      onSubmit: ({ value }: { value: string }) => {
        if (step < FIELD_STEP[key]) return undefined
        const parsed = FIELD_SCHEMAS[key].safeParse(value)
        return parsed.success ? undefined : (parsed.error.issues[0]?.message ?? undefined)
      },
    }
  }

  /** Valida los campos del paso actual y avanza si pasan. */
  async function handleContinue() {
    const results = await Promise.all(
      STEP_FIELDS[step].map((field) => Promise.resolve(form.validateField(field, "submit"))),
    )
    if (results.some((errors) => errors.length > 0)) return
    goTo(step + 1)
  }

  const visibleSteps = STEPS.slice(offset)

  return (
    <PageShell maxWidth="md" className="py-10">
      <PageHeader
        title="Configura tu clínica"
        subtitle={`Paso ${step - offset + 1} de ${visibleSteps.length}: ${STEP_TOPICS[step]}`}
      />
      <WizardSteps
        steps={visibleSteps}
        current={step - offset}
        visited={visited.map((v) => v - offset).filter((v) => v >= 0)}
        onGo={(index) => goTo(index + offset)}
        className="mt-6"
      />
      <form
        className="mt-8"
        onSubmit={(event) => {
          event.preventDefault()
          if (step < STEPS.length - 1) void handleContinue()
          else void form.handleSubmit()
        }}
      >
        <FieldGroup className="gap-4">
          <div className={step === 0 ? "flex flex-col gap-4" : "hidden"}>
            <form.Field name="firstName" validators={stepValidator("firstName")}>
              {(field) => (
                <Field>
                  <FieldLabel htmlFor="firstName">Nombre</FieldLabel>
                  <Input
                    id="firstName"
                    autoComplete="given-name"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                  <FieldError>{fieldErrorMessages(field.state.meta.errors)[0] ?? null}</FieldError>
                </Field>
              )}
            </form.Field>
            <form.Field name="lastName" validators={stepValidator("lastName")}>
              {(field) => (
                <Field>
                  <FieldLabel htmlFor="lastName">Apellidos</FieldLabel>
                  <Input
                    id="lastName"
                    autoComplete="family-name"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                  <FieldError>{fieldErrorMessages(field.state.meta.errors)[0] ?? null}</FieldError>
                </Field>
              )}
            </form.Field>
          </div>

          <div className={step === 1 ? "flex flex-col gap-4" : "hidden"}>
            <form.Field name="orgName" validators={stepValidator("orgName")}>
              {(field) => (
                <Field>
                  <FieldLabel htmlFor="orgName">Nombre de la organización</FieldLabel>
                  <Input
                    id="orgName"
                    value={field.state.value}
                    onChange={(event) => {
                      field.handleChange(event.target.value)
                      const slugField = form.getFieldValue("slug")
                      if (!slugField) form.setFieldValue("slug", slugify(event.target.value))
                    }}
                  />
                  <FieldError>{fieldErrorMessages(field.state.meta.errors)[0] ?? null}</FieldError>
                </Field>
              )}
            </form.Field>
            <form.Field name="slug" validators={stepValidator("slug")}>
              {(field) => (
                <Field>
                  <FieldLabel htmlFor="slug">Slug (subdominio)</FieldLabel>
                  <Input
                    id="slug"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                  <FieldDescription>
                    {field.state.value || "tu-clinica"}.{BASE_DOMAIN}
                  </FieldDescription>
                  <FieldError>{fieldErrorMessages(field.state.meta.errors)[0] ?? null}</FieldError>
                </Field>
              )}
            </form.Field>
          </div>

          <div className={step === 2 ? "flex flex-col gap-4" : "hidden"}>
            <form.Field name="legalName" validators={stepValidator("legalName")}>
              {(field) => (
                <Field>
                  <FieldLabel htmlFor="legalName">Razón social</FieldLabel>
                  <Input
                    id="legalName"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                  <FieldError>{fieldErrorMessages(field.state.meta.errors)[0] ?? null}</FieldError>
                </Field>
              )}
            </form.Field>
            <form.Field name="fiscalDocNumber" validators={stepValidator("fiscalDocNumber")}>
              {(field) => (
                <Field>
                  <FieldLabel htmlFor="fiscalDocNumber">RUC (opcional)</FieldLabel>
                  <Input
                    id="fiscalDocNumber"
                    inputMode="numeric"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                </Field>
              )}
            </form.Field>
          </div>

          <div className={step === 3 ? "flex flex-col gap-4" : "hidden"}>
            <form.Field name="branchName" validators={stepValidator("branchName")}>
              {(field) => (
                <Field>
                  <FieldLabel htmlFor="branchName">Nombre de la sucursal</FieldLabel>
                  <Input
                    id="branchName"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                  <FieldError>{fieldErrorMessages(field.state.meta.errors)[0] ?? null}</FieldError>
                </Field>
              )}
            </form.Field>
            <form.Field name="branchAddress" validators={stepValidator("branchAddress")}>
              {(field) => (
                <Field>
                  <FieldLabel htmlFor="branchAddress">Dirección (opcional)</FieldLabel>
                  <Input
                    id="branchAddress"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                </Field>
              )}
            </form.Field>
          </div>

          <div className="flex justify-between">
            {step > offset ? (
              <Button type="button" variant="outline" onClick={() => goTo(step - 1)}>
                Atrás
              </Button>
            ) : (
              <span />
            )}
            <form.Subscribe selector={(state) => state.isSubmitting}>
              {(isSubmitting) => (
                <SubmitButton type="submit" pending={isSubmitting}>
                  {step === STEPS.length - 1 ? "Crear organización" : "Continuar"}
                </SubmitButton>
              )}
            </form.Subscribe>
          </div>
        </FieldGroup>
      </form>
    </PageShell>
  )
}
