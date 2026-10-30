import { clinicalProfileFor, DIAGNOSIS_SYSTEM_INFO } from "@odentia/clinical"
import { Button, Skeleton, toast } from "@odentia/ui"
import {
  common,
  countryOptions,
  ErrorState,
  normalizeCountry,
  PageHeader,
  regionCountry,
  type ServerFieldMap,
  SubmitButton,
  TimeZoneSelect,
  useAppForm,
  useFormSubmit,
  useFormSubmitError,
  zonesForCountry,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { useEffect, useMemo, useState } from "react"
import { z } from "zod"
import { ClinicLogoSettings } from "../../components/settings/clinic-logo"
import { DiagnosisListSettings } from "../../components/settings/diagnosis-list"
import { capitalize } from "../../components/official-code-field"
import { SettingsNoAccess } from "../../components/settings/no-access"
import { SearchSelect } from "../../components/settings/search-select"
import {
  emptyTaxValues,
  OTHER_TAX,
  otherTaxError,
  TaxesCard,
  taxesInputFrom,
  taxValuesFromProfile,
} from "../../components/settings/taxes-card"
import { useReceptionName } from "../../lib/agent-names"
import { usePermission } from "../../lib/crm"
import { useOrgLocale } from "../../lib/locale"
import {
  fetchOrgProfile,
  fetchRegionDefaults,
  type OrgProfile,
  type OrgProfileInput,
  REGION_DEFAULTS_STALE_MS,
  regionDefaultsKey,
  effectiveDiagnosisSystem,
  saveOrgProfile,
  useOrgProfile,
} from "../../lib/org"
import { PageDraftGuard, sameDraft } from "../../lib/page-draft-guard"
import {
  countryName,
  currencyOptions,
  displayLanguage,
  type NamedOption,
  type RegionPreview,
  regionPreview,
} from "../../lib/region-format"
import { productUi } from "../../product/product-ui"

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
  // Teléfono para urgencias (ADR 0050): E.164 del campo de teléfono o null.
  // Un número a medias lo detiene el propio campo, con su aviso.
  emergencyPhone: z.string().nullable(),
  countryCode: z.string().length(2, "Elige el país"),
  currency: z.string().length(3, "Elige la moneda"),
  timezone: z.string().min(1, "Elige la zona horaria"),
  // Siempre el español del país (#48): sale del país y no tiene campo propio,
  // así que no se valida aquí (nunca bloquea sin decir dónde); lo revisa el servidor.
  locale: z.string(),
  // Impuestos (ADR 0083): "" es lo del país; «otra» lleva su porcentaje.
  taxLegalForm: z.string(),
  servicesTax: z.string(),
  servicesOther: z.string(),
  productsTax: z.string(),
  productsOther: z.string(),
}).superRefine((values, ctx) => {
  const services = otherTaxError(values.servicesTax, values.servicesOther)
  if (services) ctx.addIssue({ code: "custom", path: ["servicesOther"], message: services })
  const products = otherTaxError(values.productsTax, values.productsOther)
  if (products) ctx.addIssue({ code: "custom", path: ["productsOther"], message: products })
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
  emergencyPhone: null,
  countryCode: "",
  currency: "",
  timezone: "",
  locale: "",
  ...emptyTaxValues,
}

function toValues(profile: OrgProfile): ProfileValues {
  return {
    legalName: profile.legalName,
    tradeName: profile.tradeName ?? "",
    fiscalDocType: profile.fiscalDocType ?? "",
    fiscalDocNumber: profile.fiscalDocNumber ?? "",
    fiscalAddress: profile.fiscalAddress ?? "",
    emergencyPhone: profile.emergencyPhone ?? null,
    // El país guardado se conserva tal cual: nunca se cambia por otro al cargar.
    countryCode: profile.countryCode.trim().toUpperCase(),
    currency: profile.currency,
    timezone: profile.timezone,
    locale: profile.locale,
    ...taxValuesFromProfile(profile),
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
    emergencyPhone: values.emergencyPhone?.trim() || null,
    countryCode: values.countryCode,
    currency: values.currency,
    timezone: values.timezone,
    locale: values.locale,
    taxes: taxesInputFrom(values.countryCode, values),
  }
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
  { id: "region", fields: ["pais", "zona", "moneda"] },
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

/**
 * Cómo se llama en esta pantalla lo que el servidor señala por su nombre en el
 * cuerpo: el formato sale del país, y cada impuesto va a su lista o, si se
 * eligió «Otra tasa…», al porcentaje escrito.
 */
function profileFieldMap(values: ProfileValues): ServerFieldMap {
  return (key) => {
    if (key === "locale") return "countryCode"
    if (key.startsWith("taxes.legalForm")) return "taxLegalForm"
    if (key.startsWith("taxes.servicios")) return values.servicesTax === OTHER_TAX ? "servicesOther" : "servicesTax"
    if (key.startsWith("taxes.productos")) return values.productsTax === OTHER_TAX ? "productsOther" : "productsTax"
    return undefined
  }
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
  const form = useAppForm({
    defaultValues: initialValues,
    validators: { onSubmit: profileSchema },
    // Si el servidor lo rechaza, cada motivo va a su campo y el resto junto a «Guardar».
    onSubmit: async ({ value, formApi }) => {
      await onSubmit(value)
      setInitialValues(value)
      setBaseline(value)
      if (sameDraft(formApi.state.values, value)) formApi.reset(value)
    },
  })
  const currentValues = useStore(form.store, (state) => state.values)
  const dirty = !sameDraft(currentValues, baseline)
  const { countryCode: country, timezone, currency, locale } = currentValues
  const countryZones = useMemo(() => zonesForCountry(country), [country])
  const countries = useMemo(() => countryChoices(country, language), [country, language])
  const currencies = useMemo(() => currencyOptions(language, currency), [language, currency])

  // Al elegir país se propone lo que cambia con él. Queda escrito en el
  // formulario, a la vista, y nada se guarda hasta pulsar Guardar.
  const proposeRegion = async (nextCountry: string) => {
    // Fechas y números en el español del país, aunque la propuesta no llegue (#48).
    form.setFieldValue("locale", `es-${nextCountry}`)
    // Otro país, otro impuesto: se propone el suyo (ADR 0083).
    for (const [key, value] of Object.entries(emptyTaxValues)) form.setFieldValue(key as keyof typeof emptyTaxValues, value)
    try {
      const proposal = await queryClient.fetchQuery({
        queryKey: regionDefaultsKey(nextCountry),
        queryFn: () => fetchRegionDefaults(nextCountry),
        staleTime: REGION_DEFAULTS_STALE_MS,
      })
      // Si mientras tanto se eligió otro país, esta propuesta ya no vale.
      if (form.state.values.countryCode !== nextCountry) return
      // Una moneda que no se conoce queda como estaba: la elige la persona.
      if (proposal.currency) form.setFieldValue("currency", proposal.currency)
      // La zona solo se propone si es una sola; con varias, vale la que ya
      // estaba si es de ese país y, si no, queda por elegir.
      const zones = zonesForCountry(nextCountry)
      const zone = proposal.timezone ?? (zones.length === 1 ? zones[0] : undefined)
      if (zone) form.setFieldValue("timezone", zone)
      else if (!zones.includes(form.state.values.timezone)) form.setFieldValue("timezone", "")
    } catch {
      toast.error("No pudimos proponer la zona y la moneda de ese país: elígelas aquí.")
    }
  }
  // El ejemplo usa la hora de este momento: se escribe ya en el navegador, para
  // que el primer pintado coincida con el que envió el servidor.
  const [now, setNow] = useState<Date | null>(null)
  useEffect(() => setNow(new Date()), [])
  const preview = now ? regionPreview(now, { locale, timeZone: timezone, currency }) : null
  const submit = useFormSubmit(form, { fieldMap: profileFieldMap(currentValues) })
  const submitError = useFormSubmitError(form)

  return (
    <form className="flex max-w-3xl flex-col gap-4" noValidate onSubmit={submit}>
      <PageDraftGuard dirty={dirty} />
      <section aria-labelledby="org-identity" className={CARD}>
        <h2 id="org-identity" className="font-heading text-base font-medium">
          Identidad
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <form.AppField name="legalName">
            {(field) => <field.TextField id="org-legal-name" label="Razón social" maxLength={200} />}
          </form.AppField>
          <form.AppField name="tradeName">
            {(field) => (
              <field.TextField
                id="org-trade-name"
                label="Nombre comercial"
                maxLength={200}
                description="Así te ven tus pacientes: en WhatsApp, «Su enlace», el portal, el registro y los PDF. La razón social va solo en el comprobante."
              />
            )}
          </form.AppField>
          <form.AppField name="fiscalDocType">
            {(field) => (
              <field.TextField
                id="org-doc-type"
                label="Documento fiscal"
                maxLength={20}
                description="Como se llama en tu país el identificador fiscal de la clínica."
              />
            )}
          </form.AppField>
          <form.AppField name="fiscalDocNumber">
            {(field) => <field.TextField id="org-doc-number" label="Número" maxLength={20} />}
          </form.AppField>
        </div>
        <form.AppField name="fiscalAddress">
          {(field) => <field.TextField id="org-fiscal-address" label="Dirección fiscal" maxLength={300} />}
        </form.AppField>
        <form.AppField name="emergencyPhone">
          {(field) => (
            <field.PhoneField
              id="org-emergency-phone"
              label="Teléfono para urgencias"
              className="[&_[data-slot=input-group]]:min-h-11 [&_[data-slot=select-trigger]]:min-h-11 sm:[&_[data-slot=input-group]]:min-h-9"
              defaultCountry={normalizeCountry(country) ?? undefined}
              description={`${receptionName} lo da ante una urgencia, junto con el número de emergencias del país. Si lo dejas vacío, solo da ese número o dice que vaya a la emergencia más cercana.`}
            />
          )}
        </form.AppField>
      </section>

      <section aria-labelledby="org-region" className={CARD}>
        <h2 id="org-region" className="font-heading text-base font-medium">
          País y formato
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <form.AppField name="countryCode">
            {(field) => (
              <field.Control id="org-country" label="País" description="Define el formato de los teléfonos.">
                {(control) => (
                  <SearchSelect
                    id={control.id}
                    label="País"
                    placeholder="Buscar país…"
                    value={field.state.value}
                    options={countries}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onChange={(next) => {
                      if (next === field.state.value) return
                      field.handleChange(next)
                      void proposeRegion(next)
                    }}
                  />
                )}
              </field.Control>
            )}
          </form.AppField>
          <form.AppField name="timezone">
            {(field) => (
              <field.Control
                id="org-timezone"
                label="Zona horaria"
                description={
                  !field.state.value && countryZones.length > 1
                    ? "Ese país tiene varias zonas horarias: elige la de la clínica."
                    : "Con ella se leen la agenda, el historial y los documentos."
                }
              >
                {(control) => (
                  <TimeZoneSelect
                    id={control.id}
                    name={control.name}
                    value={field.state.value || null}
                    onChange={(next) => field.handleChange(next ?? "")}
                    suggested={countryZones}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                  />
                )}
              </field.Control>
            )}
          </form.AppField>
          <form.AppField name="currency">
            {(field) => (
              <field.Control
                id="org-currency"
                label="Moneda"
                description="Con ella se cobra. Si la clínica ya tiene cobros o presupuestos en otra moneda, no se puede cambiar: los importes anteriores no se convierten."
              >
                {(control) => (
                  <SearchSelect
                    id={control.id}
                    label="Moneda"
                    placeholder="Buscar moneda…"
                    value={field.state.value}
                    options={currencies}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onChange={(next) => field.handleChange(next)}
                  />
                )}
              </field.Control>
            )}
          </form.AppField>
        </div>
        <RegionExample preview={preview} />
        <CountryRules country={country} language={language} />
      </section>

      <TaxesCard
        form={form}
        fields={{
          taxLegalForm: "taxLegalForm",
          servicesTax: "servicesTax",
          servicesOther: "servicesOther",
          productsTax: "productsTax",
          productsOther: "productsOther",
        }}
        country={country}
        countryLabel={country.length === 2 ? countryName(country, language) : ""}
        currency={currency}
        locale={locale}
        cardClassName={CARD}
      />

      <div className="flex flex-col items-end gap-2">
        {submitError ? (
          <p role="alert" className="text-sm text-destructive">
            {submitError}
          </p>
        ) : null}
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
      </div>
    </form>
  )
}

/**
 * «Normas de tu país» (tablero 6 del lienzo del issue 40): de solo lectura y
 * sin interruptores, lo que exige el país elegido. Cada línea sale de su
 * perfil (`clinicalProfileFor` y, lo del producto, `productUi().country`); un país sin perfil propio dice lo del núcleo.
 */
function CountryRules({ country, language }: { country: string; language: string }) {
  const saved = useOrgProfile().data
  if (country.length !== 2) return null
  const profile = clinicalProfileFor(country)
  const product = productUi().country
  // La lista de diagnósticos guardada vale para el país guardado; otro país propone la suya.
  const diagnosis =
    saved?.countryCode === country
      ? effectiveDiagnosisSystem(saved).short
      : DIAGNOSIS_SYSTEM_INFO[profile.diagnosis.recommended].short
  const rows: Array<readonly [string, string]> = [
    [
      "Servicios",
      profile.services
        ? `${capitalize(profile.services.listName)}, ${profile.services.required ? "obligatoria" : "de referencia"} (${profile.services.norm})`
        : "No hay una lista oficial: tus servicios no llevan código",
    ],
    ["Especialidades", product.specialtiesNorm(country)],
    ["Diagnósticos", `${diagnosis} (se cambia en «Lista de diagnósticos»)`],
    ...product.normRows(country),
  ]
  return (
    <div role="group" className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2.5" aria-labelledby="org-country-rules">
      <h3 id="org-country-rules" className="text-sm font-medium">
        {`Normas de ${countryName(country, language)}`}
      </h3>
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
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
