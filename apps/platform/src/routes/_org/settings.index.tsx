import { Button, Field, FieldDescription, FieldError, FieldLabel, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, toast } from "@odentia/ui"
import {
  type CountryCode,
  CountrySelect,
  common,
  DEFAULT_COUNTRY,
  EmptyState,
  ErrorState,
  fieldErrorMessages,
  normalizeCountry,
  PageHeader,
  SubmitButton,
  TimeZoneSelect,
  timeZoneMeta,
  zonesForCountry,
} from "@odentia/ui-patterns"
import { useForm, useStore } from "@tanstack/react-form"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { type FormEvent, useEffect, useState } from "react"
import { z } from "zod"
import { usePermission } from "../../lib/crm"
import { fetchOrgProfile, fetchRegionDefaults, type OrgProfile, type OrgProfileInput, saveOrgProfile, useOrgProfile } from "../../lib/org"
import { PageDraftGuard, sameDraft } from "../../lib/page-draft-guard"

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

const profileSchema = z.object({
  legalName: z.string().min(1, "Ingresa la razón social"),
  tradeName: z.string(),
  fiscalDocType: z.string(),
  fiscalDocNumber: z.string(),
  billingEmail: z.union([z.literal(""), z.email("Correo inválido")]),
  fiscalAddress: z.string(),
  countryCode: z.string().length(2, "Elige un país"),
  currency: z.string().length(3, "Moneda de 3 letras"),
  timezone: z.string().min(1, "Elige una zona horaria"),
  locale: z.string().min(2, "Elige el idioma y formato"),
  receiptWidth: z.enum(["58", "80"]),
  sheetSize: z.enum(["A4", "Letter"]),
  ticketFooter: z.string().min(1, "Escribe la frase al pie del ticket").max(280),
  applyCountryPreset: z.boolean(),
})

type ProfileValues = z.infer<typeof profileSchema>

/** Valores de partida cuando la organización todavía no tiene perfil. */
const emptyValues: ProfileValues = {
  legalName: "",
  tradeName: "",
  fiscalDocType: "",
  fiscalDocNumber: "",
  billingEmail: "",
  fiscalAddress: "",
  countryCode: DEFAULT_COUNTRY,
  // Moneda, zona y formato los propone el país al cargar el formulario.
  currency: "",
  timezone: "",
  locale: "",
  receiptWidth: "80",
  sheetSize: "A4",
  ticketFooter: "Recibo interno. No es un documento fiscal.",
  applyCountryPreset: true,
}

function toValues(profile: {
  legalName: string
  tradeName: string | null
  fiscalDocType: string | null
  fiscalDocNumber: string | null
  billingEmail: string | null
  fiscalAddress: string | null
  countryCode: string
  currency: string
  timezone: string
  locale: string
  receiptWidth: string | null
  sheetSize: string | null
  ticketFooter: string | null
}): ProfileValues {
  return {
    legalName: profile.legalName,
    tradeName: profile.tradeName ?? "",
    fiscalDocType: profile.fiscalDocType ?? "",
    fiscalDocNumber: profile.fiscalDocNumber ?? "",
    billingEmail: profile.billingEmail ?? "",
    fiscalAddress: profile.fiscalAddress ?? "",
    countryCode: normalizeCountry(profile.countryCode) ?? DEFAULT_COUNTRY,
    currency: profile.currency,
    timezone: profile.timezone,
    locale: profile.locale,
    receiptWidth: profile.receiptWidth === "58" ? "58" : "80",
    sheetSize: profile.sheetSize === "Letter" ? "Letter" : "A4",
    ticketFooter: profile.ticketFooter ?? "Recibo interno. No es un documento fiscal.",
    applyCountryPreset: false,
  }
}

/** Lo vacío se manda sin la clave: el API lo guarda como `null`. */
function toInput(values: ProfileValues): OrgProfileInput {
  return {
    legalName: values.legalName.trim(),
    ...(values.tradeName.trim() ? { tradeName: values.tradeName.trim() } : {}),
    ...(values.fiscalDocType.trim() ? { fiscalDocType: values.fiscalDocType.trim() } : {}),
    ...(values.fiscalDocNumber.trim() ? { fiscalDocNumber: values.fiscalDocNumber.trim() } : {}),
    ...(values.billingEmail.trim() ? { billingEmail: values.billingEmail.trim() } : {}),
    ...(values.fiscalAddress.trim() ? { fiscalAddress: values.fiscalAddress.trim() } : {}),
    countryCode: values.countryCode,
    currency: values.currency.trim().toUpperCase(),
    timezone: values.timezone,
    locale: values.locale.trim(),
    receiptWidth: values.receiptWidth,
    sheetSize: values.sheetSize,
    ticketFooter: values.ticketFooter.trim(),
  }
}

/**
 * Perfil de la organización: identidad fiscal, país, moneda e **idioma y zona
 * horaria**.
 *
 * El país y la zona horaria no son adorno: con ellos se interpretan la agenda,
 * el historial del paciente y los documentos (`org_profile.timezone`), y el
 * país define la máscara de todos los teléfonos que se capturan.
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
      await queryClient.invalidateQueries({ queryKey: ["org-profile"] })
    },
    onError: () => toast.error("No pudimos guardar los datos"),
  })

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Organización" subtitle={org.name} />
      <p className="max-w-2xl text-sm text-muted-foreground">
        Identidad fiscal y reglas del país: definen la zona horaria con la que se interpretan la
        agenda, el historial y los documentos, y el formato de los teléfonos.
      </p>
      {profile === undefined ? (
        profileQuery.isError ? (
          <ErrorState
            message="No pudimos cargar el perfil de la organización."
            error={profileQuery.error}
            onRetry={() => void profileQuery.refetch()}
          />
        ) : (
          <p className="text-sm text-muted-foreground">{common.states.loading}</p>
        )
      ) : canWrite ? (
        <ProfileForm
          key={org.id}
          values={toValues(profile ?? emptyValues)}
          pending={saveMutation.isPending}
          onSubmit={(values) => saveMutation.mutateAsync(values)}
        />
      ) : (
        <EmptyState
          title="Sin permiso"
          description="Necesitas permiso de configuración para editar estos datos."
        />
      )}
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
  // Suscripción explícita: el país y la zona alimentan campos que se renderizan
  // aparte (sugerencias y la hora local), no solo su propio `<Field>`.
  const country = useStore(form.store, (state) => state.values.countryCode)
  const timezone = useStore(form.store, (state) => state.values.timezone)
  const zone = timeZoneMeta(timezone)
  // La hora local es dato del navegador: el primer render —el que hidrata el HTML
  // del servidor— va sin ella, para que un minuto de diferencia no regenere el
  // árbol. El desfase, en cambio, es el mismo en los dos lados.
  const [localTime, setLocalTime] = useState<string | null>(null)
  useEffect(() => setLocalTime(zone?.localTime ?? null), [zone?.localTime])
  // Al elegir país se propone lo que cambia con él. Queda escrito en el
  // formulario, a la vista, y nada se guarda hasta pulsar Guardar. Lo que el
  // país no permite deducir (una moneda desconocida, varias zonas) queda como
  // estaba para que la persona lo elija.
  const proposeRegion = async (nextCountry: string) => {
    try {
      const language = form.state.values.locale.split("-")[0] || undefined
      const proposal = await fetchRegionDefaults(nextCountry, language)
      if (proposal.currency) form.setFieldValue("currency", proposal.currency)
      form.setFieldValue("locale", proposal.locale)
      const zoneProposal = proposal.timezone ?? zonesForCountry(nextCountry)[0]
      if (zoneProposal) form.setFieldValue("timezone", zoneProposal)
      form.setFieldValue("sheetSize", proposal.sheetSize)
    } catch {
      toast.error("No pudimos proponer los datos de ese país: complétalos a mano.")
    }
  }
  // Una clínica sin perfil parte de lo que propone su país, no de valores fijos.
  const needsProposal = !values.currency
  useEffect(() => {
    if (needsProposal) void proposeRegion(values.countryCode)
    // Solo al montar: después manda lo que la persona escriba.
    // biome-ignore lint/correctness/useExhaustiveDependencies: propuesta inicial única
  }, [needsProposal])

  return (
    <form
      className="flex max-w-2xl flex-col gap-8"
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        void form.handleSubmit()
      }}
    >
      <PageDraftGuard dirty={dirty} />
      <section className="flex flex-col gap-4 elevated rounded-xl border bg-card p-6">
        <h2 className="font-heading text-base font-medium">Identidad</h2>
        <form.Field name="legalName">
          {(field) => (
            <Field>
              <FieldLabel htmlFor="org-legal-name">Razón social</FieldLabel>
              <Input
                id="org-legal-name"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
              <FieldError>{fieldErrorMessages(field.state.meta.errors)[0] ?? null}</FieldError>
            </Field>
          )}
        </form.Field>
        <form.Field name="tradeName">
          {(field) => (
            <Field>
              <FieldLabel htmlFor="org-trade-name">Nombre comercial</FieldLabel>
              <Input
                id="org-trade-name"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
            </Field>
          )}
        </form.Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <form.Field name="fiscalDocType">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="org-doc-type">Tipo de documento fiscal</FieldLabel>
                <Input
                  id="org-doc-type"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </Field>
            )}
          </form.Field>
          <form.Field name="fiscalDocNumber">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="org-doc-number">Número de documento</FieldLabel>
                <Input
                  id="org-doc-number"
                  value={field.state.value}
                  inputMode="numeric"
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </Field>
            )}
          </form.Field>
        </div>
        <form.Field name="billingEmail">
          {(field) => (
            <Field>
              <FieldLabel htmlFor="org-billing-email">Correo de facturación</FieldLabel>
              <Input
                id="org-billing-email"
                type="email"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
              <FieldError>{fieldErrorMessages(field.state.meta.errors)[0] ?? null}</FieldError>
            </Field>
          )}
        </form.Field>
        <form.Field name="fiscalAddress">
          {(field) => (
            <Field>
              <FieldLabel htmlFor="org-fiscal-address">Dirección fiscal</FieldLabel>
              <Input
                id="org-fiscal-address"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
            </Field>
          )}
        </form.Field>
      </section>

      <section className="flex flex-col gap-4 elevated rounded-xl border bg-card p-6">
        <h2 className="font-heading text-base font-medium">País y horario</h2>
        <form.Field name="countryCode">
          {(field) => (
            <Field>
              <FieldLabel htmlFor="org-country">País</FieldLabel>
              <CountrySelect
                id="org-country"
                value={normalizeCountry(field.state.value) ?? DEFAULT_COUNTRY}
                onChange={(next: CountryCode) => {
                  field.handleChange(next)
                  void proposeRegion(next)
                }}
              />
              <FieldDescription>
                Define el formato de los teléfonos. Al cambiarlo se proponen aquí abajo su zona
                horaria, moneda, formato y papel: revísalos antes de guardar.
              </FieldDescription>
              <FieldError>{fieldErrorMessages(field.state.meta.errors)[0] ?? null}</FieldError>
            </Field>
          )}
        </form.Field>
        <form.Field name="timezone">
          {(field) => (
            <Field>
              <FieldLabel htmlFor="org-timezone">Zona horaria</FieldLabel>
              <TimeZoneSelect
                id="org-timezone"
                value={field.state.value}
                onChange={(next) => field.handleChange(next ?? "")}
                suggested={zonesForCountry(country)}
              />
              <FieldDescription>
                {zone ? (
                  <>
                    {localTime ? `Allí son las ${localTime} (${zone.offsetLabel}). ` : ""}
                    Se usa para la agenda, el historial y los documentos.
                  </>
                ) : (
                  "Elige la zona horaria con la que se interpretan las fechas."
                )}
              </FieldDescription>
              <FieldError>{fieldErrorMessages(field.state.meta.errors)[0] ?? null}</FieldError>
            </Field>
          )}
        </form.Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <form.Field name="currency">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="org-currency">Moneda</FieldLabel>
                <Input
                  id="org-currency"
                  value={field.state.value}
                  maxLength={3}
                  onChange={(event) => field.handleChange(event.target.value.toUpperCase())}
                />
                <FieldDescription>
                  Código ISO 4217. Si la clínica ya tiene movimientos, no se puede
                  cambiar sin una migración explícita: los históricos no se convierten.
                </FieldDescription>
                <FieldError>{fieldErrorMessages(field.state.meta.errors)[0] ?? null}</FieldError>
              </Field>
            )}
          </form.Field>
          <form.Field name="locale">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="org-locale">Idioma y formato</FieldLabel>
                <Input
                  id="org-locale"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldError>{fieldErrorMessages(field.state.meta.errors)[0] ?? null}</FieldError>
              </Field>
            )}
          </form.Field>
        </div>
      </section>

      <section className="flex flex-col gap-4 elevated rounded-xl border bg-card p-6">
        <h2 className="font-heading text-base font-medium">Impresión</h2>
        <FieldDescription>
          De aquí salen la moneda, los formatos y el papel. El ticket y la hoja de
          cierre salen en térmica; el presupuesto, en hoja.
        </FieldDescription>
        <div className="grid gap-4 sm:grid-cols-2">
          <form.Field name="receiptWidth">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="org-receipt-width">Ticket y cierre en</FieldLabel>
                <Select
                  value={field.state.value}
                  onValueChange={(next) => field.handleChange(next as "58" | "80")}
                >
                  <SelectTrigger id="org-receipt-width">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="80">Térmica de 80 mm</SelectItem>
                    <SelectItem value="58">Térmica de 58 mm</SelectItem>
                  </SelectContent>
                </Select>
                <FieldError>{fieldErrorMessages(field.state.meta.errors)[0] ?? null}</FieldError>
              </Field>
            )}
          </form.Field>
          <form.Field name="sheetSize">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="org-sheet-size">Tamaño de hoja, para el presupuesto</FieldLabel>
                <Select
                  value={field.state.value}
                  onValueChange={(next) => field.handleChange(next as "A4" | "Letter")}
                >
                  <SelectTrigger id="org-sheet-size">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="A4">A4 · 210 × 297 mm</SelectItem>
                    <SelectItem value="Letter">Carta · 216 × 279 mm</SelectItem>
                  </SelectContent>
                </Select>
                <FieldError>{fieldErrorMessages(field.state.meta.errors)[0] ?? null}</FieldError>
              </Field>
            )}
          </form.Field>
        </div>
        <form.Field name="ticketFooter">
          {(field) => (
            <Field>
              <FieldLabel htmlFor="org-ticket-footer">Frase al pie del ticket</FieldLabel>
              <Input
                id="org-ticket-footer"
                value={field.state.value}
                maxLength={280}
                onChange={(event) => field.handleChange(event.target.value)}
              />
              <FieldError>{fieldErrorMessages(field.state.meta.errors)[0] ?? null}</FieldError>
            </Field>
          )}
        </form.Field>
      </section>

      <div className="flex justify-end gap-3">
        <Button type="button" variant="ghost" onClick={() => form.reset()}>
          {common.actions.cancel}
        </Button>
        <SubmitButton type="submit" pending={pending}>
          {common.actions.save}
        </SubmitButton>
      </div>
    </form>
  )
}
