import {
  Button,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Skeleton,
  toast,
} from "@odentia/ui"
import {
  common,
  countryOptions,
  ErrorState,
  fieldErrorMessages,
  normalizeCountry,
  PageHeader,
  PhoneInput,
  regionCountry,
  SubmitButton,
  TimeZoneSelect,
  zonesForCountry,
} from "@odentia/ui-patterns"
import { useForm, useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { type FormEvent, useEffect, useMemo, useState } from "react"
import { z } from "zod"
import { ClinicLogoSettings } from "../../components/settings/clinic-logo"
import { DiagnosisListSettings } from "../../components/settings/diagnosis-list"
import { SettingsNoAccess } from "../../components/settings/no-access"
import { SearchSelect } from "../../components/settings/search-select"
import { useReceptionName } from "../../lib/agent-names"
import { ApiError } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { useOrgLocale } from "../../lib/locale"
import {
  fetchOrgProfile,
  fetchRegionDefaults,
  type OrgProfile,
  type OrgProfileInput,
  REGION_DEFAULTS_STALE_MS,
  regionDefaultsKey,
  saveOrgProfile,
  useOrgProfile,
} from "../../lib/org"
import { PageDraftGuard, sameDraft } from "../../lib/page-draft-guard"
import {
  countryName,
  currencyOptions,
  displayLanguage,
  localeOptions,
  type NamedOption,
  type RegionPreview,
  regionPreview,
} from "../../lib/region-format"

export const Route = createFileRoute("/_org/settings/")({
  // El perfil son datos de configuración: el loader lo trae una vez —también en
  // SSR, para que el formulario esté en el primer pintado— y la query lo
  // refresca en cliente con la misma caducidad.
  staleTime: 5 * 60_000,
  loader: async (): Promise<ProfileLoad> => {
    try {
      return { profile: await fetchOrgProfile(), loaded: true }
    } catch {
      // Sin perfil no hay formulario que pintar: la pantalla espera a la query y,
      // si tampoco responde, lo dice y ofrece reintentar.
      return { profile: null, loaded: false }
    }
  },
  component: OrgProfilePage,
})

/** Lo que el loader deja a la pantalla. */
interface ProfileLoad {
  /** Perfil de la organización, o `null` si todavía no tiene. */
  profile: OrgProfile | null
  /** `false` cuando la API no respondió: el dato queda pendiente en la query. */
  loaded: boolean
}

const orgRouteApi = getRouteApi("/_org")

/** La tarjeta de página, la misma en toda Configuración. */
const CARD = "elevated flex flex-col gap-4 rounded-xl border bg-card p-5"

const profileSchema = z.object({
  legalName: z.string().trim().min(1, "Escribe la razón social"),
  tradeName: z.string().trim().min(1, "Escribe el nombre comercial"),
  fiscalDocType: z.string(),
  fiscalDocNumber: z.string(),
  fiscalAddress: z.string(),
  // Teléfono para urgencias (ADR 0050): E.164 del campo de teléfono o vacío.
  emergencyPhone: z.string(),
  countryCode: z.string().length(2, "Elige el país"),
  currency: z.string().length(3, "Elige la moneda"),
  timezone: z.string().min(1, "Elige la zona horaria"),
  locale: z.string().min(2, "Elige el idioma y formato"),
})

type ProfileValues = z.infer<typeof profileSchema>

/**
 * Valores de partida cuando la organización todavía no tiene perfil: sin país
 * supuesto. Al elegirlo se proponen la zona, la moneda y el formato.
 */
const emptyValues: ProfileValues = {
  legalName: "",
  tradeName: "",
  fiscalDocType: "",
  fiscalDocNumber: "",
  fiscalAddress: "",
  emergencyPhone: "",
  countryCode: "",
  currency: "",
  timezone: "",
  locale: "",
}

function toValues(profile: OrgProfile): ProfileValues {
  return {
    legalName: profile.legalName,
    tradeName: profile.tradeName ?? "",
    fiscalDocType: profile.fiscalDocType ?? "",
    fiscalDocNumber: profile.fiscalDocNumber ?? "",
    fiscalAddress: profile.fiscalAddress ?? "",
    emergencyPhone: profile.emergencyPhone ?? "",
    // El país guardado se conserva tal cual: nunca se cambia por otro al cargar.
    countryCode: profile.countryCode.trim().toUpperCase(),
    currency: profile.currency,
    timezone: profile.timezone,
    locale: profile.locale,
  }
}

/**
 * Los países, por nombre y con el elegido primero. Uno guardado que la lista
 * no traiga se conserva a la vista con su nombre: un valor guardado nunca se
 * esconde.
 */
function countryChoices(country: string, language: string): NamedOption[] {
  const selected = normalizeCountry(country)
  const options = countryOptions(selected ?? regionCountry(), undefined, language).map(
    ({ value, label }) => ({
      value: value as string,
      label,
    }),
  )
  if (selected) return options
  // Sin país elegido ninguno va primero.
  const collator = new Intl.Collator(language, { sensitivity: "base" })
  const byName = [...options].sort((a, b) => collator.compare(a.label, b.label))
  return country ? [{ value: country, label: countryName(country, language) }, ...byName] : byName
}

/**
 * Lo vacío viaja como `null` para que se guarde vacío. El correo de
 * facturación y la impresión no viajan: quedan como estaban.
 */
function toInput(values: ProfileValues): OrgProfileInput {
  return {
    legalName: values.legalName.trim(),
    tradeName: values.tradeName.trim(),
    fiscalDocType: values.fiscalDocType.trim() || null,
    fiscalDocNumber: values.fiscalDocNumber.trim() || null,
    fiscalAddress: values.fiscalAddress.trim() || null,
    emergencyPhone: values.emergencyPhone.trim() || null,
    countryCode: values.countryCode,
    currency: values.currency,
    timezone: values.timezone,
    locale: values.locale,
  }
}

/** Idioma de un formato (`es` de `es-PE`), para proponer el de otro país. */
function languageOf(locale: string): string | undefined {
  return locale.split("-")[0] || undefined
}

/**
 * Datos de la clínica: su identidad fiscal y el país, la zona horaria, la
 * moneda y el formato con los que se leen fechas, importes y documentos.
 * Un solo formulario con su «Guardar» al final.
 */
function OrgProfilePage() {
  const { org } = orgRouteApi.useRouteContext()
  const { profile: loaded, loaded: fetched } = Route.useLoaderData()
  const queryClient = useQueryClient()
  const canWrite = usePermission("settings.write")
  const profileQuery = useOrgProfile()
  // El loader ya trajo el perfil (también en SSR: el formulario está en el primer
  // pintado). La query manda después —al guardar, al reintentar o si la API no
  // respondió al servidor—; sólo si tampoco hay dato suyo la pantalla espera.
  const { data } = profileQuery
  const profile = data !== undefined ? data : fetched ? loaded : undefined

  const saveMutation = useMutation({
    mutationFn: (values: ProfileValues) => saveOrgProfile(toInput(values)),
    onSuccess: async () => {
      toast.success("Datos guardados")
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["org-profile"] }),
        // Caja lee la moneda y el formato de su propia consulta del perfil.
        queryClient.invalidateQueries({ queryKey: ["org-finance-profile"] }),
      ])
    },
    onError: (error) =>
      // Lo que la clínica puede corregir se dice con su motivo; lo demás, sin jerga.
      toast.error(
        error instanceof ApiError && error.status < 500 && error.shape.message
          ? error.shape.message
          : "No pudimos guardar los datos",
      ),
  })

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Datos de la clínica"
        subtitle="Con estos datos se leen las fechas, los importes y los documentos de toda la clínica."
      />
      {!canWrite ? (
        <SettingsNoAccess />
      ) : profile === undefined ? (
        profileQuery.isError ? (
          <ErrorState
            title="No pudimos cargar los datos de la clínica"
            message="Comprueba tu conexión y vuelve a intentarlo."
            onRetry={() => void profileQuery.refetch()}
          />
        ) : (
          <ProfileSkeleton />
        )
      ) : (
        <>
          <ProfileForm
            key={org.id}
            values={profile ? toValues(profile) : emptyValues}
            pending={saveMutation.isPending}
            onSubmit={(values) => saveMutation.mutateAsync(values)}
          />
          {/* Se guardan solos, con su confirmación: no son parte del «Guardar» de arriba. */}
          {profile ? (
            <div className="flex max-w-3xl flex-col gap-4">
              <ClinicLogoSettings logo={profile.logo ?? null} name={profile.tradeName} />
              <DiagnosisListSettings profile={profile} />
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}

/** Las dos tarjetas del formulario y sus campos, para reservar su hueco. */
const SKELETON_CARDS = [
  { id: "identidad", fields: ["razon", "comercial", "documento", "numero", "direccion"] },
  { id: "region", fields: ["pais", "zona", "moneda", "formato"] },
]

/** El hueco del formulario mientras llega el perfil: las dos tarjetas con sus campos. */
function ProfileSkeleton() {
  return (
    <div
      role="status"
      aria-busy
      aria-label="Cargando los datos de la clínica…"
      className="flex max-w-3xl flex-col gap-4"
    >
      {SKELETON_CARDS.map((card) => (
        <div key={card.id} aria-hidden className={CARD}>
          <Skeleton className="h-5 w-32" />
          <div className="grid gap-4 sm:grid-cols-2">
            {card.fields.map((field) => (
              <div key={field} className="flex flex-col gap-2">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-9 w-full" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function ProfileForm({
  values,
  pending,
  onSubmit,
}: {
  values: ProfileValues
  pending: boolean
  onSubmit: (values: ProfileValues) => Promise<unknown>
}) {
  const receptionName = useReceptionName()
  const queryClient = useQueryClient()
  const language = displayLanguage(useOrgLocale())
  const [initialValues, setInitialValues] = useState(values)
  const [baseline, setBaseline] = useState(values)
  const form = useForm({
    defaultValues: initialValues,
    validators: { onSubmit: profileSchema },
    onSubmit: async ({ value, formApi }) => {
      try {
        await onSubmit(value)
        setInitialValues(value)
        setBaseline(value)
        if (sameDraft(formApi.state.values, value)) formApi.reset(value)
      } catch {
        // La mutación muestra el error; el borrador queda intacto para reintentar.
      }
    },
  })
  const currentValues = useStore(form.store, (state) => state.values)
  const dirty = !sameDraft(currentValues, baseline)
  const { countryCode: country, timezone, currency, locale } = currentValues
  const countryZones = useMemo(() => zonesForCountry(country), [country])
  // Idioma de respaldo para proponer el formato de otro país: el guardado, que
  // no cambia mientras se edita.
  const fallbackLanguage = languageOf(baseline.locale)

  // Qué formatos se ofrecen para el país elegido. Es un dato auxiliar: llega
  // después y solo llena la lista, nunca toca lo que la persona ya eligió.
  const defaultsQuery = useQuery({
    queryKey: regionDefaultsKey(country, fallbackLanguage),
    queryFn: () => fetchRegionDefaults(country, fallbackLanguage),
    staleTime: REGION_DEFAULTS_STALE_MS,
    enabled: country.length === 2,
  })

  const countries = useMemo(() => countryChoices(country, language), [country, language])
  const currencies = useMemo(() => currencyOptions(language, currency), [language, currency])
  const formats = useMemo(
    () => localeOptions(defaultsQuery.data?.locales ?? [], locale, language),
    [defaultsQuery.data, locale, language],
  )

  // Al elegir país se propone lo que cambia con él. Queda escrito en el
  // formulario, a la vista, y nada se guarda hasta pulsar Guardar.
  const proposeRegion = async (nextCountry: string) => {
    try {
      const proposal = await queryClient.fetchQuery({
        queryKey: regionDefaultsKey(nextCountry, fallbackLanguage),
        queryFn: () => fetchRegionDefaults(nextCountry, fallbackLanguage),
        staleTime: REGION_DEFAULTS_STALE_MS,
      })
      // Si mientras tanto se eligió otro país, esta propuesta ya no vale.
      if (form.state.values.countryCode !== nextCountry) return
      // Una moneda que no se conoce queda como estaba: la elige la persona.
      if (proposal.currency) form.setFieldValue("currency", proposal.currency)
      form.setFieldValue("locale", proposal.locale)
      // La zona solo se propone si es una sola; con varias, vale la que ya
      // estaba si es de ese país y, si no, queda por elegir.
      const zones = zonesForCountry(nextCountry)
      const zone = proposal.timezone ?? (zones.length === 1 ? zones[0] : undefined)
      if (zone) form.setFieldValue("timezone", zone)
      else if (!zones.includes(form.state.values.timezone)) form.setFieldValue("timezone", "")
    } catch {
      toast.error("No pudimos proponer la zona, la moneda y el formato de ese país: elígelos aquí.")
    }
  }
  // El ejemplo usa la hora de este momento: se escribe ya en el navegador, para
  // que el primer pintado coincida con el que envió el servidor.
  const [now, setNow] = useState<Date | null>(null)
  useEffect(() => setNow(new Date()), [])
  const preview = now ? regionPreview(now, { locale, timeZone: timezone, currency }) : null

  return (
    <form
      className="flex max-w-3xl flex-col gap-4"
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        void form.handleSubmit()
      }}
    >
      <PageDraftGuard dirty={dirty} />
      <section aria-labelledby="org-identity" className={CARD}>
        <h2 id="org-identity" className="font-heading text-base font-medium">
          Identidad
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <form.Field name="legalName">
            {(field) => {
              const error = fieldErrorMessages(field.state.meta.errors)[0]
              return (
                <Field>
                  <FieldLabel htmlFor="org-legal-name">Razón social</FieldLabel>
                  <Input
                    id="org-legal-name"
                    maxLength={200}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? "org-legal-name-error" : undefined}
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                  <FieldError id="org-legal-name-error">{error ?? null}</FieldError>
                </Field>
              )
            }}
          </form.Field>
          <form.Field name="tradeName">
            {(field) => {
              const error = fieldErrorMessages(field.state.meta.errors)[0]
              return (
                <Field>
                  <FieldLabel htmlFor="org-trade-name">Nombre comercial</FieldLabel>
                  <Input
                    id="org-trade-name"
                    maxLength={200}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? "org-trade-name-error" : "org-trade-name-help"}
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                  {error ? (
                    <FieldError id="org-trade-name-error">{error}</FieldError>
                  ) : (
                    <FieldDescription id="org-trade-name-help">
                      Así te ven tus pacientes: en WhatsApp, «Su enlace», el portal, el registro y los PDF. La
                      razón social va solo en el comprobante.
                    </FieldDescription>
                  )}
                </Field>
              )
            }}
          </form.Field>
          <form.Field name="fiscalDocType">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="org-doc-type">Documento fiscal</FieldLabel>
                <Input
                  id="org-doc-type"
                  maxLength={20}
                  aria-describedby="org-doc-type-help"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldDescription id="org-doc-type-help">
                  Como se llama en tu país el identificador fiscal de la clínica.
                </FieldDescription>
              </Field>
            )}
          </form.Field>
          <form.Field name="fiscalDocNumber">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="org-doc-number">Número</FieldLabel>
                <Input
                  id="org-doc-number"
                  maxLength={20}
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </Field>
            )}
          </form.Field>
        </div>
        <form.Field name="fiscalAddress">
          {(field) => (
            <Field>
              <FieldLabel htmlFor="org-fiscal-address">Dirección fiscal</FieldLabel>
              <Input
                id="org-fiscal-address"
                maxLength={300}
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
            </Field>
          )}
        </form.Field>
        <form.Field name="emergencyPhone">
          {(field) => (
            <Field>
              <FieldLabel htmlFor="org-emergency-phone">Teléfono para urgencias</FieldLabel>
              <PhoneInput
                id="org-emergency-phone"
                className="[&_[data-slot=input-group]]:min-h-11 [&_[data-slot=select-trigger]]:min-h-11 sm:[&_[data-slot=input-group]]:min-h-9"
                value={field.state.value || null}
                defaultCountry={normalizeCountry(form.state.values.countryCode) ?? undefined}
                aria-describedby="org-emergency-phone-hint"
                onChange={(next) => field.handleChange(next ?? "")}
              />
              <FieldDescription id="org-emergency-phone-hint">
                {receptionName} lo da ante una urgencia, también fuera de horario. Si lo dejas vacío, dice que acuda al servicio de emergencias más cercano.
              </FieldDescription>
            </Field>
          )}
        </form.Field>
      </section>

      <section aria-labelledby="org-region" className={CARD}>
        <h2 id="org-region" className="font-heading text-base font-medium">
          País y formato
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <form.Field name="countryCode">
            {(field) => {
              const error = fieldErrorMessages(field.state.meta.errors)[0]
              return (
                <Field>
                  <FieldLabel htmlFor="org-country">País</FieldLabel>
                  <SearchSelect
                    id="org-country"
                    label="País"
                    placeholder="Buscar país…"
                    value={field.state.value}
                    options={countries}
                    invalid={Boolean(error)}
                    aria-describedby="org-country-help"
                    onChange={(next) => {
                      if (next === field.state.value) return
                      field.handleChange(next)
                      void proposeRegion(next)
                    }}
                  />
                  <FieldDescription id="org-country-help">
                    Define el formato de los teléfonos.
                  </FieldDescription>
                  <FieldError>{error ?? null}</FieldError>
                </Field>
              )
            }}
          </form.Field>
          <form.Field name="timezone">
            {(field) => {
              const error = fieldErrorMessages(field.state.meta.errors)[0]
              return (
                <Field>
                  <FieldLabel htmlFor="org-timezone">Zona horaria</FieldLabel>
                  <TimeZoneSelect
                    id="org-timezone"
                    value={field.state.value || null}
                    onChange={(next) => field.handleChange(next ?? "")}
                    suggested={countryZones}
                    invalid={Boolean(error)}
                    aria-describedby="org-timezone-help"
                  />
                  <FieldDescription id="org-timezone-help">
                    {!field.state.value && countryZones.length > 1
                      ? "Ese país tiene varias zonas horarias: elige la de la clínica."
                      : "Con ella se leen la agenda, el historial y los documentos."}
                  </FieldDescription>
                  <FieldError>{error ?? null}</FieldError>
                </Field>
              )
            }}
          </form.Field>
          <form.Field name="currency">
            {(field) => {
              const error = fieldErrorMessages(field.state.meta.errors)[0]
              return (
                <Field>
                  <FieldLabel htmlFor="org-currency">Moneda</FieldLabel>
                  <SearchSelect
                    id="org-currency"
                    label="Moneda"
                    placeholder="Buscar moneda…"
                    value={field.state.value}
                    options={currencies}
                    invalid={Boolean(error)}
                    aria-describedby="org-currency-help"
                    onChange={(next) => field.handleChange(next)}
                  />
                  <FieldDescription id="org-currency-help">
                    Con ella se cobra. Si la clínica ya tiene cobros o presupuestos en otra moneda,
                    no se puede cambiar: los importes anteriores no se convierten.
                  </FieldDescription>
                  <FieldError>{error ?? null}</FieldError>
                </Field>
              )
            }}
          </form.Field>
          <form.Field name="locale">
            {(field) => {
              const error = fieldErrorMessages(field.state.meta.errors)[0]
              return (
                <Field>
                  <FieldLabel htmlFor="org-locale">Idioma y formato</FieldLabel>
                  <SearchSelect
                    id="org-locale"
                    label="Idioma y formato"
                    placeholder="Buscar idioma…"
                    value={field.state.value}
                    options={formats}
                    invalid={Boolean(error)}
                    aria-describedby="org-locale-help"
                    onChange={(next) => field.handleChange(next)}
                  />
                  <FieldDescription id="org-locale-help">
                    {defaultsQuery.isError
                      ? "No pudimos cargar los demás formatos de ese país. El elegido se conserva."
                      : "Cómo se escriben las fechas y los números. No cambia el idioma de odentIA."}
                  </FieldDescription>
                  <FieldError>{error ?? null}</FieldError>
                </Field>
              )
            }}
          </form.Field>
        </div>
        <RegionExample preview={preview} />
      </section>

      <div className="flex justify-end gap-3">
        <Button
          type="button"
          variant="ghost"
          className="min-h-11"
          disabled={pending}
          onClick={() => form.reset()}
        >
          {common.actions.cancel}
        </Button>
        <SubmitButton type="submit" className="min-h-11" pending={pending}>
          {common.actions.save}
        </SubmitButton>
      </div>
    </form>
  )
}

/** «Así se verán»: lo elegido arriba, aplicado a una fecha, una hora y un importe. */
function RegionExample({ preview }: { preview: RegionPreview | null }) {
  return (
    <p className="rounded-lg bg-muted px-3 py-2.5 text-sm text-muted-foreground">
      {preview ? (
        <>
          Así se verán:{" "}
          <span className="font-medium text-foreground">
            {preview.date} · {preview.time} · {preview.amount}
          </span>
          .{" "}
        </>
      ) : null}
      Al cambiar el país se proponen zona, moneda y formato; nada se guarda hasta pulsar Guardar.
    </p>
  )
}
