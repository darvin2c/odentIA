import {
  Button,
  FieldGroup,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
  toast,
} from "@odentia/ui"
import {
  CountrySelect,
  detectedTimeZone,
  focusFirstInvalid,
  isValidE164,
  normalizeCountry,
  PageHeader,
  PageShell,
  regionCountry,
  SubmitButton,
  submitForm,
  TimeZoneSelect,
  useAppForm,
  useFormSubmitError,
  WizardSteps,
  zonesForCountry,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router"
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { z } from "zod"
import { ApiError, apiFetch } from "../lib/api"
import { API_URL, authClient } from "../lib/auth-client"
import { type AuthClientError, authError, authFailureOf, authFormMessage } from "../lib/auth-error"
import { panelWords } from "../lib/brand"
import { addressAlternatives, addressFromName, CLINIC_ADDRESS_PATTERN } from "../lib/clinic-address"
import { FOUNDER_INVITATION_HEADER, forgetInvitation, rememberInvitation, storedInvitation } from "../lib/founders"
import { requireTermsAccepted, requireVerifiedSession } from "../lib/guards"
import { BASE_DOMAIN, tenantUrl } from "../lib/host"

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

// Los máximos son los de la API (`PUT /api/org-profile`, `POST /api/branches`):
// lo que no cabe se dice aquí, antes de enviar.
const onboardingSchema = personaSchema.extend({
  orgName: z.string().min(2, "Escribe el nombre de tu clínica").max(200, "Escribe como mucho 200 caracteres."),
  slug: z
    .string()
    .min(1, "Escribe la dirección de tu clínica")
    .regex(CLINIC_ADDRESS_PATTERN, "Usa solo letras sin tilde, números y guiones")
    .refine(
      (slug) => !RESERVED_SLUGS[slug],
      `Esa dirección está reservada para ${panelWords.name}. Elige otra.`,
    ),
  legalName: z
    .string()
    .min(2, "Escribe la razón social (al menos 2 caracteres)")
    .max(200, "Escribe como mucho 200 caracteres."),
  fiscalDocNumber: z.string().max(20, "El documento fiscal tiene como mucho 20 caracteres."),
  // El país define la máscara de los teléfonos y las zonas horarias sugeridas.
  countryCode: z.string().length(2, "Elige el país"),
  // ISO 4217: se propone según el país y se puede cambiar.
  currency: z.string().regex(/^[A-Z]{3}$/, "Elige la moneda con la que cobra la clínica"),
  branchName: z
    .string()
    .min(2, "Escribe el nombre de la sede (al menos 2 caracteres)")
    .max(120, "Escribe como mucho 120 caracteres."),
  branchAddress: z.string().max(300, "Escribe como mucho 300 caracteres."),
  // `null` = sin teléfono; si hay valor, tiene que ser un número real (E.164).
  branchPhone: z
    .string()
    .nullable()
    .refine((value) => value === null || isValidE164(value), "Teléfono inválido"),
  branchTimezone: z.string().min(1, "Elige la zona horaria"),
})

type OnboardingValues = z.infer<typeof onboardingSchema>
type OnboardingField = keyof OnboardingValues

const onboardingSubmitSchema = onboardingSchema.extend({
  orgName: z.string(),
  slug: z.string(),
})
/** Schema por campo; valida al salir de su paso y en el submit final. */
const FIELD_SCHEMAS = onboardingSchema.shape

/** Paso que posee cada campo: antes de ese paso el campo no se valida. */
const FIELD_STEP: Record<OnboardingField, number> = {
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

/**
 * Dónde se dice lo que señalan `PUT /api/org-profile` y `POST /api/branches`
 * (dato del cuerpo → campo del asistente; los demás se llaman igual). La
 * dirección de la sede es una sola línea: lo que el servidor diga de su
 * ciudad, región o código postal se dice en ella.
 */
const SERVER_FIELDS: Record<string, OnboardingField> = {
  tradeName: "orgName",
  timezone: "branchTimezone",
  name: "branchName",
  addressLine1: "branchAddress",
  city: "branchAddress",
  district: "branchAddress",
  region: "branchAddress",
  postalCode: "branchAddress",
  country: "branchAddress",
  phone: "branchPhone",
}

/** Rechazos de `organization.create` que son de la dirección (`slug`). */
const ADDRESS_ERRORS = {
  RESERVED_SLUG: "slug",
  ORGANIZATION_ALREADY_EXISTS: "slug",
  ORGANIZATION_SLUG_ALREADY_TAKEN: "slug",
}

/** `updateUser` rechazado: lo conocido con su texto; lo demás, que no se guardó el nombre. */
function nameSaveError(error: AuthClientError): ApiError {
  const failure = authFailureOf(error)
  if (failure.code) return authError(error)
  return new ApiError(failure.status, {
    message: "No pudimos guardar tu nombre. Inténtalo de nuevo en un momento.",
    fields: failure.fields,
  })
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
  // La clínica que este alta ya creó: si falló el perfil o la sede, el
  // reintento solo guarda eso y nunca abre otra clínica. Su dirección ya no cambia.
  const [createdSlug, setCreatedSlug] = useState<string | null>(null)
  // Cada vez que el asistente lleva a un paso con errores, el foco va al primero.
  const formRef = useRef<HTMLFormElement>(null)
  const [focusRequest, setFocusRequest] = useState(0)
  // La organización activa apunta a la clínica invitada para que el perfil y
  // la sede se guarden en ella (el contexto la deduce de la sesión).
  useEffect(() => {
    if (skipOrg && continueOrgId) {
      authClient.organization.setActive({ organizationId: continueOrgId }).catch(() => {})
    }
  }, [skipOrg, continueOrgId])
  // El tipo sale del esquema: `branchPhone` es `string | null` y `countryCode`
  // es un ISO de 2 letras, no el literal del valor inicial.
  const initialValues: OnboardingValues = {
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
    branchPhone: null,
    // La clínica se configura desde su propio dispositivo: su zona es la de
    // partida; sin ella se elige en el último paso.
    branchTimezone: detectedTimeZone() ?? "",
  }
  const form = useAppForm({
    defaultValues: initialValues,
    validators: { onSubmit: onboardingSubmitSchema },
    onSubmit: async ({ value }) => {
      const { error: nameError } = await authClient.updateUser({
        name: `${value.firstName} ${value.lastName}`.trim(),
        firstName: value.firstName,
        lastName: value.lastName,
      })
      if (nameError) {
        // El nombre se corrige en su paso (si la cuenta no lo traía guardado).
        if (!hasStoredName) goTo(0)
        throw nameSaveError(nameError)
      }
      let slug = value.slug
      if (createdSlug) {
        // Reintento: la clínica ya se creó en este alta; faltan su perfil y su sede.
        slug = createdSlug
      } else if (!skipOrg) {
        const { data: org, error: orgError } = await authClient.organization.create(
          { name: value.orgName, slug: value.slug },
          founderToken ? { headers: { [FOUNDER_INVITATION_HEADER]: founderToken } } : undefined,
        )
        if (orgError) {
          const { code, message } = authFailureOf(orgError)
          if (code === "INVITATION_INVALID") forgetInvitation()
          if (code === "INVITATION_REQUIRED" || code === "INVITATION_INVALID") {
            // Sin una invitación que sirva no se abre la clínica aquí: se vuelve al inicio (como antes),
            // y el aviso viaja en un toast porque este formulario deja de estar a la vista.
            toast.error(message)
            await navigate({ to: "/" })
            return
          }
          if (code === "ORGANIZATION_ALREADY_EXISTS" || code === "ORGANIZATION_SLUG_ALREADY_TAKEN") {
            // Alguien la tomó entre la comprobación y el envío: el campo lo dice
            // y lo sigue diciendo al volver a «Continuar» hasta que cambie.
            takenAddresses.current.add(value.slug)
            void queryClient.invalidateQueries({ queryKey: ["onboarding", "address", value.slug] })
          }
          // La dirección (reservada, en uso) va a su campo; la invitación, junto al botón.
          throw authError(orgError, {
            fields: ADDRESS_ERRORS,
            messages: { RESERVED_SLUG: `Esa dirección está reservada para ${panelWords.name}. Elige otra.` },
          })
        }
        forgetInvitation()
        slug = org?.slug ?? value.slug
        setCreatedSlug(slug)
      } else if (continueOrgId) {
        await authClient.organization.setActive({ organizationId: continueOrgId }).catch(() => {})
        const { data: orgs } = await authClient.organization.list()
        slug = orgs?.find((org) => org.id === continueOrgId)?.slug ?? ""
      }
      // Lo que rechacen se dice en su campo (`SERVER_FIELDS`) y el asistente vuelve a su paso.
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
          phone: value.branchPhone ?? undefined,
          timezone: value.branchTimezone,
        }),
      })
      if (skipOrg) {
        // La clínica ya existía: el launcher decide a dónde seguir.
        await navigate({ to: "/" })
        return
      }
      window.location.assign(tenantUrl(slug, "/home"))
    },
  })
  const submitError = useFormSubmitError(form)
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
    !skipOrg && !createdSlug && CLINIC_ADDRESS_PATTERN.test(checkedAddress) && !RESERVED_SLUGS[checkedAddress]
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
      value: code,
      label: `${code} — ${names.of(code) ?? code}`,
    }))
  }, [])

  // Precarga el nombre de la sesión cuando llega después del primer render y
  // salta el paso de perfil si la cuenta ya lo trae guardado.
  // biome-ignore lint/correctness/useExhaustiveDependencies: solo cuando llega la sesión; el paso y lo visitado se leen en ese momento, no lo vuelven a disparar.
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
  }, [sessionUser])

  // El foco va al primer campo marcado del paso que se ve (los otros pasos están ocultos).
  // biome-ignore lint/correctness/useExhaustiveDependencies: enfoca solo al pedirlo; cambiar de paso no debe mover el foco.
  useEffect(() => {
    if (focusRequest === 0) return
    focusFirstInvalid(formRef.current?.querySelector(`[data-step="${step}"]`) ?? null)
  }, [focusRequest])

  function goTo(index: number) {
    setStep(index)
    setVisited((prev) => (prev.includes(index) ? prev : [...prev, index]))
  }

  /** Validador de campo activo solo desde su paso en adelante (nunca org en reanudada). */
  function stepValidator(key: OnboardingField) {
    return {
      onSubmit: ({ value }: { value: unknown }) => {
        if (skipOrg && (key === "orgName" || key === "slug")) return undefined
        // La clínica ya se creó: su dirección quedó fija.
        if (createdSlug && key === "slug") return undefined
        if (step < FIELD_STEP[key]) return undefined
        const parsed = FIELD_SCHEMAS[key].safeParse(value)
        if (!parsed.success) return parsed.error.issues[0]?.message ?? undefined
        if (key === "slug" && typeof value === "string" && takenAddresses.current.has(value))
          return "Esa dirección ya está en uso. Elige otra."
        return undefined
      },
    }
  }

  /**
   * Valida un campo del paso con su propio validador. `form.validateField`
   * correría además el esquema de todo el formulario y dejaría errores en los
   * campos de pasos que aún no se ven («Nombre de la sede» en rojo al llegar).
   * Se marca como visitado para que el campo diga su error.
   */
  function validateStepField(field: OnboardingField) {
    const instance = form.fieldInfo[field]?.instance
    if (!instance) return form.validateField(field, "submit")
    form.setFieldMeta(field, (prev) => ({ ...prev, isTouched: true, isBlurred: true }))
    return instance.validate("submit", { skipFormValidation: true })
  }

  /** Valida los campos del paso actual y avanza si pasan; si no, enfoca el primero que falla. */
  async function handleContinue() {
    const results = await Promise.all(
      STEP_FIELDS[step].map((field) => Promise.resolve(validateStepField(field))),
    )
    if (results.some((errors) => errors.length > 0)) {
      setFocusRequest((count) => count + 1)
      return
    }
    goTo(step + 1 === 1 && skipOrg ? 2 : step + 1)
  }

  /**
   * Envía todo. Lo que falle (el esquema o el servidor) queda en su campo y el
   * asistente vuelve al primer paso con errores; lo demás se dice junto al botón.
   */
  async function finish() {
    const ok = await submitForm(form, {
      fieldMap: SERVER_FIELDS,
      formMessage: authFormMessage,
      root: formRef.current,
    })
    if (ok) return
    const invalidStep = STEP_FIELDS.findIndex((fields) =>
      fields.some((field) => (form.getFieldMeta(field)?.errors.length ?? 0) > 0),
    )
    if (invalidStep === -1) return
    goTo(skipOrg && invalidStep === 1 ? 2 : invalidStep)
    setFocusRequest((count) => count + 1)
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
          ref={formRef}
          noValidate
          className="mt-8"
          onSubmit={(event) => {
            event.preventDefault()
            if (step < STEPS.length - 1) void handleContinue()
            else void finish()
          }}
        >
          <FieldGroup className="gap-4">
            <div data-step={0} className={step === 0 ? "flex flex-col gap-4" : "hidden"}>
              <form.AppField name="firstName" validators={stepValidator("firstName")}>
                {(field) => <field.TextField id="firstName" label="Nombre" autoComplete="given-name" />}
              </form.AppField>
              <form.AppField name="lastName" validators={stepValidator("lastName")}>
                {(field) => <field.TextField id="lastName" label="Apellidos" autoComplete="family-name" />}
              </form.AppField>
            </div>

            <div data-step={1} className={step === 1 && !skipOrg ? "flex flex-col gap-4" : "hidden"}>
              <form.AppField
                name="orgName"
                validators={stepValidator("orgName")}
                listeners={{
                  onChange: ({ value }) => {
                    if (!addressEdited && !createdSlug) form.setFieldValue("slug", addressFromName(value))
                  },
                }}
              >
                {(field) => (
                  <field.TextField
                    id="orgName"
                    label="Nombre de tu clínica"
                    description="El que verán tus pacientes."
                  />
                )}
              </form.AppField>
              <form.AppField name="slug" validators={stepValidator("slug")}>
                {(field) => (
                  <field.Control
                    id="slug"
                    label={
                      <>
                        Dirección de tu {panelWords.place.one} en {panelWords.name}
                      </>
                    }
                    description="Es la dirección de tu enlace de reservas. No se cambia después."
                  >
                    {(control) => (
                      <>
                        <InputGroup>
                          <InputGroupInput
                            {...control.props}
                            aria-describedby={["slug-status", control.describedBy].filter(Boolean).join(" ")}
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            readOnly={createdSlug !== null}
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
                          invalid={control.invalid}
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
                      </>
                    )}
                  </field.Control>
                )}
              </form.AppField>
            </div>

            <div data-step={2} className={step === 2 ? "flex flex-col gap-4" : "hidden"}>
              <form.AppField name="legalName" validators={stepValidator("legalName")}>
                {(field) => <field.TextField id="legalName" label="Razón social" />}
              </form.AppField>
              <form.AppField name="fiscalDocNumber" validators={stepValidator("fiscalDocNumber")}>
                {(field) => (
                  <field.TextField id="fiscalDocNumber" label="Documento fiscal (opcional)" maxLength={20} />
                )}
              </form.AppField>
              <form.AppField name="countryCode" validators={stepValidator("countryCode")}>
                {(field) => (
                  <field.Control
                    id="countryCode"
                    label="País"
                    description="Define el formato de los teléfonos, la moneda y las zonas horarias que se sugieren."
                  >
                    {(control) => (
                      <CountrySelect
                        id={control.id}
                        invalid={control.invalid}
                        aria-describedby={control.describedBy}
                        onBlur={control.onBlur}
                        value={normalizeCountry(field.state.value) ?? regionCountry()}
                        onChange={(next) => field.handleChange(next)}
                      />
                    )}
                  </field.Control>
                )}
              </form.AppField>
              <form.AppField name="currency" validators={stepValidator("currency")}>
                {(field) => (
                  <field.SelectField
                    id="currency"
                    label="Moneda"
                    description="Con ella se cobran y se muestran los importes. Se propone según el país."
                    placeholder="Elige la moneda"
                    options={currencies}
                  />
                )}
              </form.AppField>
            </div>

            <div data-step={3} className={step === 3 ? "flex flex-col gap-4" : "hidden"}>
              <form.AppField name="branchName" validators={stepValidator("branchName")}>
                {(field) => <field.TextField id="branchName" label="Nombre de la sede" />}
              </form.AppField>
              <form.AppField name="branchAddress" validators={stepValidator("branchAddress")}>
                {(field) => <field.TextField id="branchAddress" label="Dirección (opcional)" />}
              </form.AppField>
              <form.AppField name="branchPhone" validators={stepValidator("branchPhone")}>
                {(field) => (
                  <field.PhoneField
                    id="branchPhone"
                    label="Teléfono (opcional)"
                    defaultCountry={normalizeCountry(country)}
                  />
                )}
              </form.AppField>
              <form.AppField name="branchTimezone" validators={stepValidator("branchTimezone")}>
                {(field) => (
                  <field.Control
                    id="branchTimezone"
                    label="Zona horaria"
                    description="Con ella se interpretan la agenda, el historial y los documentos de la clínica."
                  >
                    {(control) => (
                      <TimeZoneSelect
                        id={control.id}
                        invalid={control.invalid}
                        aria-describedby={control.describedBy}
                        value={field.state.value}
                        suggested={zonesForCountry(country)}
                        onChange={(next) => field.handleChange(next ?? "")}
                      />
                    )}
                  </field.Control>
                )}
              </form.AppField>
            </div>

            {submitError ? (
              <p role="alert" className="text-sm text-destructive">
                {submitError}
              </p>
            ) : null}
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
                      ? skipOrg || createdSlug
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
 * está libre y, si no, una alternativa libre para usar con un clic. Cuando el
 * campo ya dice su error (`invalid`), aquí no se repite: solo queda la alternativa.
 */
function AddressStatus({
  id,
  address,
  invalid,
  checking,
  result,
  failed,
  onUse,
}: {
  id: string
  address: string
  invalid: boolean
  checking: boolean
  result: AddressCheck | undefined
  failed: boolean
  onUse: (suggestion: string) => void
}) {
  let content: ReactNode = null
  if (!address) content = null
  else if (!CLINIC_ADDRESS_PATTERN.test(address))
    content = invalid ? null : (
      <span className="text-destructive">Usa solo letras sin tilde, números y guiones.</span>
    )
  else if (RESERVED_SLUGS[address])
    content = invalid ? null : (
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
        {invalid ? null : <span className="text-destructive">✕ Ya está en uso.</span>}
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
        ) : invalid ? null : (
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
