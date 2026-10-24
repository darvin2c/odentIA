import {
  Button,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from "@odentia/ui"
import {
  CountrySelect,
  detectedTimeZone,
  fieldErrorMessages,
  isValidE164,
  normalizeCountry,
  PageHeader,
  PageShell,
  PhoneInput,
  regionCountry,
  SubmitButton,
  TimeZoneSelect,
  WizardSteps,
  zonesForCountry,
} from "@odentia/ui-patterns"
import { useForm, useStore } from "@tanstack/react-form"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router"
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { z } from "zod"
import { apiFetch } from "../lib/api"
import { API_URL, authClient } from "../lib/auth-client"
import { addressAlternatives, addressFromName, CLINIC_ADDRESS_PATTERN } from "../lib/clinic-address"
import { FOUNDER_INVITATION_HEADER, forgetInvitation, rememberInvitation, storedInvitation } from "../lib/founders"
import { requireTermsAccepted, requireVerifiedSession } from "../lib/guards"
import { BASE_DOMAIN, tenantUrl } from "../lib/host"
import { panelWords } from "../lib/brand"

export const Route = createFileRoute("/onboarding")({
  beforeLoad: async ({ location }) => {
    await requireVerifiedSession()
    await requireTermsAccepted(location)
  },
  validateSearch: (search: Record<string, unknown>) => ({
    continue: typeof search.continue === "string" ? search.continue : undefined,
    // Invitación Fundadores (issue 165): viaja al crear la clínica.
    ...(typeof search.invitacion === "string" && search.invitacion ? { invitacion: search.invitacion } : {}),
  }),
  component: OnboardingPage,
})

const STEPS = [
  { id: "persona", label: "Tu perfil" },
  { id: "org", label: "Organización" },
  { id: "profile", label: "Perfil legal" },
  { id: "branch", label: "Sede" },
] as const

/** Tema de cada paso para el subtítulo "Paso N de M: …". */
const STEP_TOPICS = ["tus datos", "organización", "perfil legal", "primera sede"] as const

/** Campos validados al avanzar desde cada paso. */
const STEP_FIELDS = [
  ["firstName", "lastName"],
  ["orgName", "slug"],
  ["legalName", "fiscalDocNumber", "countryCode", "currency"],
  ["branchName", "branchAddress", "branchPhone", "branchTimezone"],
] as const

// Subdominios reservados (misma lista que el servidor).
const RESERVED_SLUGS: Record<string, true> = { api: true, app: true, admin: true, www: true, storage: true }

const personaSchema = z.object({
  firstName: z.string().min(1, "Ingresa tu nombre"),
  lastName: z.string().min(1, "Ingresa tus apellidos"),
})

const onboardingSchema = personaSchema.extend({
  orgName: z.string().min(2, "Escribe el nombre de tu clínica"),
  slug: z
    .string()
    .min(1, "Escribe la dirección de tu clínica")
    .regex(CLINIC_ADDRESS_PATTERN, "Usa solo letras sin tilde, números y guiones")
    .refine(
      (slug) => !RESERVED_SLUGS[slug],
      `Esa dirección está reservada para ${panelWords.name}. Elige otra.`,
    ),
  legalName: z.string().min(2, "Razón social"),
  fiscalDocNumber: z.string().max(20),
  // El país define la máscara de los teléfonos y las zonas horarias sugeridas.
  countryCode: z.string().length(2, "Elige el país"),
  // ISO 4217: se propone según el país y se puede cambiar.
  currency: z.string().regex(/^[A-Z]{3}$/, "Elige la moneda con la que cobra la clínica"),
  branchName: z.string().min(2, "Nombre de la sede"),
  branchAddress: z.string(),
  // Vacío = sin teléfono; si hay valor, tiene que ser un número real (E.164).
  branchPhone: z
    .string()
    .refine((value) => value === "" || isValidE164(value), "Teléfono inválido"),
  branchTimezone: z.string().min(1, "Elige la zona horaria"),
})

const onboardingSubmitSchema = onboardingSchema.extend({
  orgName: z.string(),
  slug: z.string(),
})
/** Schema por campo; valida al salir de su paso y en el submit final. */
const FIELD_SCHEMAS = {
  firstName: personaSchema.shape.firstName,
  lastName: personaSchema.shape.lastName,
  orgName: onboardingSchema.shape.orgName,
  slug: onboardingSchema.shape.slug,
  legalName: onboardingSchema.shape.legalName,
  fiscalDocNumber: onboardingSchema.shape.fiscalDocNumber,
  countryCode: onboardingSchema.shape.countryCode,
  currency: onboardingSchema.shape.currency,
  branchName: onboardingSchema.shape.branchName,
  branchAddress: onboardingSchema.shape.branchAddress,
  branchPhone: onboardingSchema.shape.branchPhone,
  branchTimezone: onboardingSchema.shape.branchTimezone,
} as const

/** Paso que posee cada campo: antes de ese paso el campo no se valida. */
const FIELD_STEP: Record<keyof typeof FIELD_SCHEMAS, number> = {
  firstName: 0,
  lastName: 0,
  orgName: 1,
  slug: 1,
  legalName: 2,
  fiscalDocNumber: 2,
  countryCode: 2,
  currency: 2,
  branchName: 3,
  branchAddress: 3,
  branchPhone: 3,
  branchTimezone: 3,
}

/** Si la dirección está libre: `false` solo cuando el servidor dice que está en uso. */
async function addressIsFree(slug: string): Promise<boolean> {
  const { data, error } = await authClient.organization.checkSlug({ slug })
  if (data?.status) return true
  if (error?.code === "ORGANIZATION_SLUG_ALREADY_TAKEN") return false
  throw new Error(error?.message ?? "No se pudo comprobar la dirección")
}

type AddressCheck = { free: true } | { free: false; suggestion: string | null }

/** Comprueba la dirección y, si está en uso, busca la primera alternativa libre. */
async function checkAddress(slug: string): Promise<AddressCheck> {
  if (await addressIsFree(slug)) return { free: true }
  for (const option of addressAlternatives(slug)) {
    if (await addressIsFree(option)) return { free: false, suggestion: option }
  }
  return { free: false, suggestion: null }
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
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { continue: continueOrgId, invitacion } = useSearch({ from: "/onboarding" })
  // La invitación llega en la dirección (correo de verificación, Google) o quedó guardada al crear la cuenta.
  const [founderToken] = useState(() => invitacion ?? (typeof window === "undefined" ? null : storedInvitation()))
  useEffect(() => {
    if (invitacion) rememberInvitation(invitacion)
  }, [invitacion])
  const signUpInfo = useQuery({
    queryKey: ["public", "sign-up"],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/api/public/sign-up`)
      if (!res.ok) throw new Error(`Error ${res.status}`)
      return z.object({ signupMode: z.enum(["invitacion", "abierta"]).default("abierta") }).passthrough().parse(await res.json())
    },
    staleTime: 60_000,
  })
  // Alta asistida: la clínica ya existe (invitación aceptada); se completa su
  // perfil y sede sin crear otra. El servidor solo deja a owner/admin
  // (settings.write); el resto espera al responsable.
  const skipOrg = typeof continueOrgId === "string" && continueOrgId.length > 0
  // Sin invitación y con el alta «solo con invitación», no hay clínica que abrir: vuelve a «Mis organizaciones», que lo explica.
  const blocked = !skipOrg && !founderToken && signUpInfo.data?.signupMode === "invitacion"
  useEffect(() => {
    if (blocked) void navigate({ to: "/" })
  }, [blocked, navigate])
  // Quien se registró por email ya dio nombre y apellidos: el paso "Tu perfil"
  // solo aparece cuando la sesión no los tiene (p. ej. cuenta vía Google).
  const hasStoredName = Boolean(sessionUser?.firstName || sessionUser?.lastName)
  const offset = hasStoredName ? 1 : 0
  const [step, setStep] = useState(0)
  const [visited, setVisited] = useState<number[]>([0])
  // La dirección sigue al nombre hasta que la persona la escribe a mano; si la
  // borra entera, vuelve a seguirlo (issue 106).
  const [addressEdited, setAddressEdited] = useState(false)
  // Direcciones que el servidor dijo que están en uso: no dejan avanzar.
  const takenAddresses = useRef(new Set<string>())
  // La organización activa apunta a la clínica invitada para que el perfil y
  // la sede se guarden en ella (el contexto la deduce de la sesión).
  useEffect(() => {
    if (skipOrg && continueOrgId) {
      authClient.organization.setActive({ organizationId: continueOrgId }).catch(() => {})
    }
  }, [skipOrg, continueOrgId])
  // El tipo sale del esquema: `branchPhone` es `string | null` y `countryCode`
  // es un ISO de 2 letras, no el literal del valor inicial.
  const initialValues: z.infer<typeof onboardingSchema> = {
    firstName: splitName(sessionUser?.name ?? "").firstName,
    lastName: splitName(sessionUser?.name ?? "").lastName,
    orgName: "",
    slug: "",
    legalName: "",
    fiscalDocNumber: "",
    // Sin clínica todavía: el país del dispositivo (su zona y su idioma), nunca uno fijo.
    countryCode: regionCountry(),
    // Se completa con lo que propone el país elegido.
    currency: "",
    branchName: "",
    branchAddress: "",
    branchPhone: "",
    // La clínica se configura desde su propio dispositivo: su zona es la de
    // partida; sin ella se elige en el último paso.
    branchTimezone: detectedTimeZone() ?? "",
  }
  const form = useForm({
    defaultValues: initialValues,
    validators: { onSubmit: onboardingSubmitSchema },
    onSubmitInvalid: () => {
      // Si algún paso previo quedó inválido, lleva al usuario al primero con errores.
      const invalidStep = STEP_FIELDS.findIndex((fields) =>
        fields.some((field) => (form.getFieldMeta(field)?.errors.length ?? 0) > 0),
      )
      if (invalidStep !== -1 && invalidStep !== step) goTo(skipOrg && invalidStep === 1 ? 2 : invalidStep)
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
      let slug = value.slug
      if (!skipOrg) {
        const { error: orgError } = await authClient.organization.create(
          { name: value.orgName, slug: value.slug },
          founderToken ? { headers: { [FOUNDER_INVITATION_HEADER]: founderToken } } : undefined,
        )
        if (orgError) {
          const code = (orgError as { code?: string }).code ?? ""
          if (code.startsWith("INVITATION")) {
            if (code === "INVITATION_INVALID") forgetInvitation()
            toast.error(orgError.message ?? "Por ahora se abren clínicas solo con invitación.")
            if (code === "INVITATION_REQUIRED" || code === "INVITATION_INVALID") await navigate({ to: "/" })
            return
          }
          goTo(1)
          if (
            code === "ORGANIZATION_ALREADY_EXISTS" ||
            code === "ORGANIZATION_SLUG_ALREADY_TAKEN"
          ) {
            // Alguien la tomó entre la comprobación y el envío: se dice junto al campo.
            takenAddresses.current.add(value.slug)
            void validateStepField("slug")
            void queryClient.invalidateQueries({ queryKey: ["onboarding", "address", value.slug] })
            return
          }
          toast.error(orgError.message ?? "No se pudo crear tu clínica.")
          return
        }
        forgetInvitation()
      } else if (continueOrgId) {
        await authClient.organization.setActive({ organizationId: continueOrgId }).catch(() => {})
        const { data: orgs } = await authClient.organization.list()
        slug = orgs?.find((org) => org.id === continueOrgId)?.slug ?? ""
      }
      try {
        await apiFetch("/api/org-profile", {
          method: "PUT",
          body: JSON.stringify({
            legalName: value.legalName,
            // El nombre que se escribió es el nombre comercial: el que verán sus pacientes (decisión 19).
            ...(!skipOrg && value.orgName.trim() ? { tradeName: value.orgName.trim() } : {}),
            fiscalDocNumber: value.fiscalDocNumber || undefined,
            countryCode: value.countryCode,
            currency: value.currency,
            timezone: value.branchTimezone,
          }),
        })
        await apiFetch("/api/branches", {
          method: "POST",
          body: JSON.stringify({
            name: value.branchName,
            addressLine1: value.branchAddress || undefined,
            phone: value.branchPhone || undefined,
            timezone: value.branchTimezone,
          }),
        })
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : "Error al guardar los datos.")
        return
      }
      if (skipOrg) {
        // La clínica ya existía: el launcher decide a dónde seguir.
        await navigate({ to: "/" })
        return
      }
      window.location.assign(tenantUrl(slug, "/home"))
    },
  })
  // Alta reanudada: precarga lo que el alta asistida ya dejó (país, moneda,
  // razón social) para no repetirlo.
  useEffect(() => {
    if (!skipOrg) return
    let cancelled = false
    apiFetch<unknown>("/api/org-profile")
      .then((raw) => {
        const parsed = z
          .object({
            data: z
              .object({ legalName: z.string(), countryCode: z.string(), currency: z.string() })
              .nullable(),
          })
          .safeParse(raw)
        const profile = parsed.success ? parsed.data.data : null
        if (cancelled || !profile) return
        if (!form.getFieldValue("legalName")) form.setFieldValue("legalName", profile.legalName)
        if (profile.countryCode) form.setFieldValue("countryCode", profile.countryCode)
        if (profile.currency) form.setFieldValue("currency", profile.currency)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skipOrg])

  // El país elegido alimenta la máscara del teléfono y las zonas sugeridas.
  const country = useStore(form.store, (state) => state.values.countryCode)
  // Y propone la moneda: el servidor la deduce para el país; si no la conoce,
  // el campo queda vacío y se elige a mano. Nunca se asume la de otro país.
  useEffect(() => {
    let cancelled = false
    apiFetch<{ data: { currency: string | null } }>(
      `/api/org-profile/region-defaults?countryCode=${encodeURIComponent(country)}`,
    )
      .then((result) => {
        if (!cancelled) form.setFieldValue("currency", result.data.currency ?? "")
      })
      .catch(() => {
        if (!cancelled) form.setFieldValue("currency", "")
      })
    return () => {
      cancelled = true
    }
  }, [country, form])
  // Se comprueba si la dirección está libre mientras se escribe, sin esperar al final.
  const address = useStore(form.store, (state) => state.values.slug)
  const [checkedAddress, setCheckedAddress] = useState("")
  useEffect(() => {
    const timer = setTimeout(() => setCheckedAddress(address), 400)
    return () => clearTimeout(timer)
  }, [address])
  const addressCheckable =
    !skipOrg && CLINIC_ADDRESS_PATTERN.test(checkedAddress) && !RESERVED_SLUGS[checkedAddress]
  const availability = useQuery({
    queryKey: ["onboarding", "address", checkedAddress],
    queryFn: () => checkAddress(checkedAddress),
    enabled: addressCheckable,
    staleTime: 30_000,
    retry: false,
  })
  useEffect(() => {
    if (availability.data && !availability.data.free) takenAddresses.current.add(checkedAddress)
    if (availability.data?.free) takenAddresses.current.delete(checkedAddress)
  }, [availability.data, checkedAddress])

  const currencies = useMemo(() => {
    const names = new Intl.DisplayNames(["es"], { type: "currency" })
    return Intl.supportedValuesOf("currency").map((code) => ({
      code,
      label: `${code} — ${names.of(code) ?? code}`,
    }))
  }, [])

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
      goTo(skipOrg ? 2 : 1)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionUser])

  function goTo(index: number) {
    setStep(index)
    setVisited((prev) => (prev.includes(index) ? prev : [...prev, index]))
  }

  /** Validador de campo activo solo desde su paso en adelante (nunca org en reanudada). */
  function stepValidator(key: keyof typeof FIELD_SCHEMAS) {
    return {
      onSubmit: ({ value }: { value: string }) => {
        if (skipOrg && (key === "orgName" || key === "slug")) return undefined
        if (step < FIELD_STEP[key]) return undefined
        const parsed = FIELD_SCHEMAS[key].safeParse(value)
        if (!parsed.success) return parsed.error.issues[0]?.message ?? undefined
        if (key === "slug" && takenAddresses.current.has(value))
          return "Esa dirección ya está en uso. Elige otra."
        return undefined
      },
    }
  }

  /**
   * Valida un campo del paso con su propio validador. `form.validateField`
   * correría además el esquema de todo el formulario y dejaría errores en los
   * campos de pasos que aún no se ven («Nombre de la sede» en rojo al llegar).
   */
  function validateStepField(field: keyof typeof FIELD_SCHEMAS) {
    const instance = form.fieldInfo[field]?.instance
    if (!instance) return form.validateField(field, "submit")
    if (!form.getFieldMeta(field)?.isTouched) form.setFieldMeta(field, (prev) => ({ ...prev, isTouched: true }))
    return instance.validate("submit", { skipFormValidation: true })
  }

  /** Valida los campos del paso actual y avanza si pasan. */
  async function handleContinue() {
    const results = await Promise.all(
      STEP_FIELDS[step].map((field) => Promise.resolve(validateStepField(field))),
    )
    if (results.some((errors) => errors.length > 0)) return
    goTo(step + 1 === 1 && skipOrg ? 2 : step + 1)
  }

  /** Pasos visibles: en reanudada no se crea la organización; con nombre
   * guardado se salta el perfil. Todo índice visual sale de aquí. */
  const shownIndexes = STEPS.map((_, index) => index)
    .filter((index) => !(skipOrg && index === 1))
    .slice(offset)
  const visibleSteps = shownIndexes.map((index) => STEPS[index])
  const shownTopics = shownIndexes.map((index) => STEP_TOPICS[index])
  const currentPosition = shownIndexes.indexOf(step)

  return (
    <main>
      <PageShell maxWidth="md" className="py-10">
        <PageHeader
          title={skipOrg ? "Termina el alta de tu clínica" : "Configura tu clínica"}
          subtitle={`Paso ${currentPosition + 1} de ${visibleSteps.length}: ${shownTopics[currentPosition] ?? ""}`}
        />
        <WizardSteps
          steps={visibleSteps}
          current={currentPosition}
          visited={visited.map((v) => shownIndexes.indexOf(v)).filter((v) => v >= 0)}
          onGo={(index) => goTo(shownIndexes[index] ?? 0)}
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
                      aria-invalid={field.state.meta.errors.length > 0 || undefined}
                      aria-describedby={
                        field.state.meta.errors.length ? "firstName-error" : undefined
                      }
                      autoComplete="given-name"
                      value={field.state.value}
                      onChange={(event) => field.handleChange(event.target.value)}
                    />
                    <FieldError id="firstName-error">
                      {fieldErrorMessages(field.state.meta.errors)[0] ?? null}
                    </FieldError>
                  </Field>
                )}
              </form.Field>
              <form.Field name="lastName" validators={stepValidator("lastName")}>
                {(field) => (
                  <Field>
                    <FieldLabel htmlFor="lastName">Apellidos</FieldLabel>
                    <Input
                      id="lastName"
                      aria-invalid={field.state.meta.errors.length > 0 || undefined}
                      aria-describedby={
                        field.state.meta.errors.length ? "lastName-error" : undefined
                      }
                      autoComplete="family-name"
                      value={field.state.value}
                      onChange={(event) => field.handleChange(event.target.value)}
                    />
                    <FieldError id="lastName-error">
                      {fieldErrorMessages(field.state.meta.errors)[0] ?? null}
                    </FieldError>
                  </Field>
                )}
              </form.Field>
            </div>

            <div className={step === 1 && !skipOrg ? "flex flex-col gap-4" : "hidden"}>
              <form.Field name="orgName" validators={stepValidator("orgName")}>
                {(field) => (
                  <Field>
                    <FieldLabel htmlFor="orgName">Nombre de tu clínica</FieldLabel>
                    <Input
                      id="orgName"
                      aria-invalid={field.state.meta.errors.length > 0 || undefined}
                      aria-describedby={
                        field.state.meta.errors.length
                          ? "orgName-help orgName-error"
                          : "orgName-help"
                      }
                      value={field.state.value}
                      onChange={(event) => {
                        field.handleChange(event.target.value)
                        if (!addressEdited)
                          form.setFieldValue("slug", addressFromName(event.target.value))
                      }}
                    />
                    <FieldDescription id="orgName-help">
                      El que verán tus pacientes.
                    </FieldDescription>
                    <FieldError id="orgName-error">
                      {fieldErrorMessages(field.state.meta.errors)[0] ?? null}
                    </FieldError>
                  </Field>
                )}
              </form.Field>
              <form.Field name="slug" validators={stepValidator("slug")}>
                {(field) => {
                  const errors = fieldErrorMessages(field.state.meta.errors)
                  return (
                    <Field>
                      <FieldLabel htmlFor="slug">Dirección de tu {panelWords.place.one} en {panelWords.name}</FieldLabel>
                      <InputGroup>
                        <InputGroupInput
                          id="slug"
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                          aria-invalid={errors.length > 0 || undefined}
                          aria-describedby={
                            errors.length
                              ? "slug-status slug-help slug-error"
                              : "slug-status slug-help"
                          }
                          value={field.state.value}
                          onChange={(event) => {
                            const next = event.target.value.toLowerCase()
                            // Borrarla entera devuelve la dirección al nombre.
                            setAddressEdited(next !== "")
                            field.handleChange(next)
                          }}
                        />
                        <InputGroupAddon align="inline-end">
                          <InputGroupText>.{BASE_DOMAIN}</InputGroupText>
                        </InputGroupAddon>
                      </InputGroup>
                      <AddressStatus
                        id="slug-status"
                        address={field.state.value}
                        checking={field.state.value !== checkedAddress || availability.isFetching}
                        result={
                          addressCheckable && checkedAddress === field.state.value
                            ? availability.data
                            : undefined
                        }
                        failed={addressCheckable && availability.isError}
                        onUse={(suggestion) => {
                          setAddressEdited(true)
                          field.handleChange(suggestion)
                        }}
                      />
                      <FieldDescription id="slug-help">
                        Es la dirección de tu enlace de reservas. No se cambia después.
                      </FieldDescription>
                      <FieldError id="slug-error">{errors[0] ?? null}</FieldError>
                    </Field>
                  )
                }}
              </form.Field>
            </div>

            <div className={step === 2 ? "flex flex-col gap-4" : "hidden"}>
              <form.Field name="legalName" validators={stepValidator("legalName")}>
                {(field) => (
                  <Field>
                    <FieldLabel htmlFor="legalName">Razón social</FieldLabel>
                    <Input
                      id="legalName"
                      aria-invalid={field.state.meta.errors.length > 0 || undefined}
                      aria-describedby={
                        field.state.meta.errors.length ? "legalName-error" : undefined
                      }
                      value={field.state.value}
                      onChange={(event) => field.handleChange(event.target.value)}
                    />
                    <FieldError id="legalName-error">
                      {fieldErrorMessages(field.state.meta.errors)[0] ?? null}
                    </FieldError>
                  </Field>
                )}
              </form.Field>
              <form.Field name="fiscalDocNumber" validators={stepValidator("fiscalDocNumber")}>
                {(field) => (
                  <Field>
                    <FieldLabel htmlFor="fiscalDocNumber">Documento fiscal (opcional)</FieldLabel>
                    <Input
                      id="fiscalDocNumber"
                      value={field.state.value}
                      onChange={(event) => field.handleChange(event.target.value)}
                    />
                  </Field>
                )}
              </form.Field>
              <form.Field name="countryCode" validators={stepValidator("countryCode")}>
                {(field) => (
                  <Field>
                    <FieldLabel htmlFor="countryCode">País</FieldLabel>
                    <CountrySelect
                      id="countryCode"
                      value={normalizeCountry(field.state.value) ?? regionCountry()}
                      onChange={(next) => field.handleChange(next)}
                    />
                    <FieldDescription>
                      Define el formato de los teléfonos, la moneda y las zonas horarias que se sugieren.
                    </FieldDescription>
                    <FieldError>
                      {fieldErrorMessages(field.state.meta.errors)[0] ?? null}
                    </FieldError>
                  </Field>
                )}
              </form.Field>
              <form.Field name="currency" validators={stepValidator("currency")}>
                {(field) => (
                  <Field>
                    <FieldLabel htmlFor="currency">Moneda</FieldLabel>
                    <Select<string>
                      value={field.state.value || null}
                      onValueChange={(next) => {
                        if (next) field.handleChange(next)
                      }}
                    >
                      <SelectTrigger id="currency" className="w-full">
                        <SelectValue placeholder="Elige la moneda">
                          {(selected: string) =>
                            currencies.find((item) => item.code === selected)?.label ?? selected
                          }
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {currencies.map((item) => (
                          <SelectItem key={item.code} value={item.code}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FieldDescription>
                      Con ella se cobran y se muestran los importes. Se propone según el país.
                    </FieldDescription>
                    <FieldError>
                      {fieldErrorMessages(field.state.meta.errors)[0] ?? null}
                    </FieldError>
                  </Field>
                )}
              </form.Field>
            </div>

            <div className={step === 3 ? "flex flex-col gap-4" : "hidden"}>
              <form.Field name="branchName" validators={stepValidator("branchName")}>
                {(field) => (
                  <Field>
                    <FieldLabel htmlFor="branchName">Nombre de la sede</FieldLabel>
                    <Input
                      id="branchName"
                      aria-invalid={field.state.meta.errors.length > 0 || undefined}
                      aria-describedby={
                        field.state.meta.errors.length ? "branchName-error" : undefined
                      }
                      value={field.state.value}
                      onChange={(event) => field.handleChange(event.target.value)}
                    />
                    <FieldError id="branchName-error">
                      {fieldErrorMessages(field.state.meta.errors)[0] ?? null}
                    </FieldError>
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
              <form.Field name="branchPhone" validators={stepValidator("branchPhone")}>
                {(field) => {
                  const errors = fieldErrorMessages(field.state.meta.errors)
                  return (
                    <Field>
                      <FieldLabel htmlFor="branchPhone">Teléfono (opcional)</FieldLabel>
                      <PhoneInput
                        id="branchPhone"
                        value={field.state.value || null}
                        defaultCountry={normalizeCountry(country)}
                        invalid={errors.length > 0}
                        aria-describedby={errors.length ? "branchPhone-error" : undefined}
                        onChange={(next) => field.handleChange(next ?? "")}
                      />
                      <FieldError id="branchPhone-error">{errors[0] ?? null}</FieldError>
                    </Field>
                  )
                }}
              </form.Field>
              <form.Field name="branchTimezone" validators={stepValidator("branchTimezone")}>
                {(field) => (
                  <Field>
                    <FieldLabel htmlFor="branchTimezone">Zona horaria</FieldLabel>
                    <TimeZoneSelect
                      id="branchTimezone"
                      invalid={field.state.meta.errors.length > 0}
                      aria-describedby={
                        field.state.meta.errors.length
                          ? "branchTimezone-help branchTimezone-error"
                          : "branchTimezone-help"
                      }
                      value={field.state.value}
                      suggested={zonesForCountry(country)}
                      onChange={(next) => field.handleChange(next ?? "")}
                    />
                    <FieldDescription id="branchTimezone-help">
                      Con ella se interpretan la agenda, el historial y los documentos de la
                      clínica.
                    </FieldDescription>
                    <FieldError id="branchTimezone-error">
                      {fieldErrorMessages(field.state.meta.errors)[0] ?? null}
                    </FieldError>
                  </Field>
                )}
              </form.Field>
            </div>

            <div className="flex justify-between">
              {currentPosition > 0 ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => goTo(shownIndexes[currentPosition - 1] ?? 0)}
                >
                  Atrás
                </Button>
              ) : (
                <span />
              )}
              <form.Subscribe selector={(state) => state.isSubmitting}>
                {(isSubmitting) => (
                  <SubmitButton type="submit" pending={isSubmitting}>
                    {step === STEPS.length - 1
                      ? skipOrg
                        ? "Terminar alta"
                        : "Crear organización"
                      : "Continuar"}
                  </SubmitButton>
                )}
              </form.Subscribe>
            </div>
          </FieldGroup>
        </form>
      </PageShell>
    </main>
  )
}

/**
 * Lo que se sabe de la dirección mientras se escribe: formato, reservada, si
 * está libre y, si no, una alternativa libre para usar con un clic.
 */
function AddressStatus({
  id,
  address,
  checking,
  result,
  failed,
  onUse,
}: {
  id: string
  address: string
  checking: boolean
  result: AddressCheck | undefined
  failed: boolean
  onUse: (suggestion: string) => void
}) {
  let content: ReactNode = null
  if (!address) content = null
  else if (!CLINIC_ADDRESS_PATTERN.test(address))
    content = (
      <span className="text-destructive">Usa solo letras sin tilde, números y guiones.</span>
    )
  else if (RESERVED_SLUGS[address])
    content = (
      <span className="text-destructive">«{address}» está reservada para {panelWords.name}. Elige otra.</span>
    )
  else if (checking)
    content = <span className="text-muted-foreground">Comprobando si está libre…</span>
  else if (failed)
    content = (
      <span className="text-muted-foreground">
        No pudimos comprobarla ahora. La comprobamos al crear tu clínica.
      </span>
    )
  else if (result?.free)
    content = (
      <span className="text-success">
        ✓ {address}.{BASE_DOMAIN} está libre.
      </span>
    )
  else if (result)
    content = (
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-destructive">✕ Ya está en uso.</span>
        {result.suggestion ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={() => onUse(result.suggestion as string)}
          >
            Usar {result.suggestion}
          </Button>
        ) : (
          <span className="text-muted-foreground">Prueba con otra.</span>
        )}
      </span>
    )
  return (
    <p id={id} aria-live="polite" className="min-h-5 text-sm">
      {content}
    </p>
  )
}
