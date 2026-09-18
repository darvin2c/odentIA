import { Button, Field, FieldDescription, FieldError, FieldLabel, Input, toast } from "@odentia/ui"
import {
  type CountryCode,
  CountrySelect,
  common,
  DEFAULT_COUNTRY,
  EmptyState,
  fieldErrorMessages,
  normalizeCountry,
  PageHeader,
  PageShell,
  SubmitButton,
  TimeZoneSelect,
  timeZoneMeta,
  zonesForCountry,
} from "@odentia/ui-patterns"
import { useForm, useStore } from "@tanstack/react-form"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import type { FormEvent } from "react"
import { z } from "zod"
import { useCanWrite } from "../../lib/crm"
import { type OrgProfileInput, saveOrgProfile, useOrgProfile } from "../../lib/org"

export const Route = createFileRoute("/_org/settings/")({
  component: OrgProfilePage,
})

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
  currency: "PEN",
  timezone: "America/Lima",
  locale: "es-PE",
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
  const queryClient = useQueryClient()
  const canWrite = useCanWrite()
  const profileQuery = useOrgProfile()
  const profile = profileQuery.data ?? null

  const saveMutation = useMutation({
    mutationFn: (values: ProfileValues) => saveOrgProfile(toInput(values)),
    onSuccess: async () => {
      toast.success("Datos guardados")
      await queryClient.invalidateQueries({ queryKey: ["org-profile"] })
    },
    onError: () => toast.error("No pudimos guardar los datos"),
  })

  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader title="Organización" subtitle={org.name} />
      <p className="max-w-2xl text-sm text-muted-foreground">
        Identidad fiscal y reglas del país: definen la zona horaria con la que se interpretan la
        agenda, el historial y los documentos, y el formato de los teléfonos.
      </p>
      {profileQuery.isPending ? (
        <p className="text-sm text-muted-foreground">{common.states.loading}</p>
      ) : canWrite ? (
        <ProfileForm
          key={profile?.organizationId ?? "nuevo"}
          values={toValues(profile ?? emptyValues)}
          pending={saveMutation.isPending}
          onSubmit={(values) => saveMutation.mutate(values)}
        />
      ) : (
        <EmptyState
          title="Solo owner/admin"
          description="Pide a un administrador de la organización que edite estos datos."
        />
      )}
    </PageShell>
  )
}

function ProfileForm({
  values,
  pending,
  onSubmit,
}: {
  values: ProfileValues
  pending: boolean
  onSubmit: (values: ProfileValues) => void
}) {
  const form = useForm({
    defaultValues: values,
    validators: { onSubmit: profileSchema },
    onSubmit: ({ value }) => onSubmit(value),
  })
  // Suscripción explícita: el país y la zona alimentan campos que se renderizan
  // aparte (sugerencias y la hora local), no solo su propio `<Field>`.
  const country = useStore(form.store, (state) => state.values.countryCode)
  const timezone = useStore(form.store, (state) => state.values.timezone)
  const zone = timeZoneMeta(timezone)

  return (
    <form
      className="flex max-w-2xl flex-col gap-8"
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        void form.handleSubmit()
      }}
    >
      <section className="flex flex-col gap-4 rounded-md bg-card p-6">
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
                  placeholder="RUC"
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

      <section className="flex flex-col gap-4 rounded-md bg-card p-6">
        <h2 className="font-heading text-base font-medium">País y horario</h2>
        <form.Field name="countryCode">
          {(field) => (
            <Field>
              <FieldLabel htmlFor="org-country">País</FieldLabel>
              <CountrySelect
                id="org-country"
                value={normalizeCountry(field.state.value) ?? DEFAULT_COUNTRY}
                onChange={(next: CountryCode) => field.handleChange(next)}
              />
              <FieldDescription>
                Define el formato de los teléfonos y las zonas horarias sugeridas.
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
                {zone
                  ? `Allí son las ${zone.localTime} (${zone.offsetLabel}). Se usa para la agenda, el historial y los documentos.`
                  : "Elige la zona horaria con la que se interpretan las fechas."}
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
                  placeholder="es-PE"
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldError>{fieldErrorMessages(field.state.meta.errors)[0] ?? null}</FieldError>
              </Field>
            )}
          </form.Field>
        </div>
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
