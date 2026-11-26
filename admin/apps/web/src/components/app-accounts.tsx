/**
 * Las cuentas de las apps que son otro sistema (gestorIA, ADR 0211): las abre la app por el
 * acuerdo y aquí se administran como las de una clínica, con las mismas tablas: su plan, sus
 * cargos, sus pagos y su soporte. Sus planes son de su app: una clínica nunca los ve, ni una
 * cuenta de gestorIA los de una clínica. Solo la administración (ADR 0094).
 */
import { Button, FieldGroup, toast } from "@odentia/ui"
import {
  EmptyState,
  ErrorState,
  FormDrawer,
  SkeletonRegion,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { z } from "zod"
import { api } from "../lib/api"
import { CurrencySelect, centsToMajor, majorToCents } from "./billing-fields"
import { money } from "./billing-payments"
import { OpenAppAccountDrawer } from "./app-requests"
import type { AdminPlan } from "./plan-drawer"
import { APP_NAMES, AppMark } from "./product"

// La marca de una app que es otro sistema vive con la del producto: también la usa la Bandeja.
export { APP_NAMES, AppMark }

/** El estado de la suscripción en palabras; sin suscripción, no se le cobra. */
export const ACCOUNT_STATUS: Record<string, string> = {
  prueba: "En prueba",
  activa: "Activa",
  gracia: "En gracia",
  restringida: "Restringida: solo lee",
  pausada: "En pausa",
  cancelada: "Cancelada",
  sin_suscripcion: "Sin plan: no se le cobra",
}

const accountRowSchema = z.object({
  id: z.string(),
  app: z.string(),
  externalRef: z.string(),
  name: z.string().nullable(),
  country: z.string().nullable(),
  status: z.string(),
  planName: z.string().nullable(),
  ownerEmail: z.string().nullable(),
  createdAt: z.string(),
})

/** Un plan de una app: su cuota y crédito, lo de cada conversación y su prueba, nada más. */
const appPlanSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(1, "Escribe el código del plan")
      .max(80, "Escribe como mucho 80 caracteres"),
    name: z
      .string()
      .trim()
      .min(1, "Escribe el nombre del plan")
      .max(120, "Escribe como mucho 120 caracteres"),
    currency: z.string().regex(/^[A-Z]{3}$/, "Elige la moneda"),
    price: z.string(),
    credit: z.string(),
    attended: z.string(),
    order: z.string(),
    trialCredit: z.string(),
    trialDays: z.string(),
    isDefault: z.boolean(),
  })
  .superRefine((value, ctx) => {
    const say = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message })
    const cents = (text: string) =>
      /^\d+(?:[.,]\d+)?$/.test(text.trim()) ? majorToCents(text, value.currency) : null
    if (cents(value.price) === null)
      say("price", "Escribe la cuota en números, por ejemplo 15 o 15.90")
    if (cents(value.credit) === null) say("credit", "Escribe un importe en números (0 si no tiene)")
    if (cents(value.trialCredit) === null)
      say("trialCredit", "Escribe un importe en números (0 si no tiene)")
    for (const key of ["attended", "order"] as const)
      if (value[key].trim() && micros(value[key]) === null)
        say(key, "Escribe un importe, o déjalo vacío si el plan no lo cobra")
    // Sin precio de la que tomó un pedido, la atendida que sube quedaría sin cobrar.
    if (value.attended.trim() && !value.order.trim())
      say("order", "Escribe también el precio de la que tomó un pedido")
    const days = Number(value.trialDays.trim())
    if (!/^\d+$/.test(value.trialDays.trim()) || days < 1 || days > 365)
      say("trialDays", "Escribe de 1 a 365 días")
  })
type AppPlanValues = z.input<typeof appPlanSchema>

/** «0.30» → 300000 millonésimas; null si está vacío o no es un importe. */
function micros(text: string): number | null {
  if (!/^\d+(?:[.,]\d+)?$/.test(text.trim())) return null
  const value = Math.round(Number(text.trim().replace(",", ".")) * 1_000_000)
  return value <= 1_000_000_000 ? value : null
}
const fromMicros = (value: number | null) => (value === null ? "" : String(value / 1_000_000))

/**
 * Crear o editar un plan de gestorIA. La conversación «atendida» y la que «tomó un pedido» son
 * las dos que cuenta la app (lo que una clínica llama Informa y Gestiona); sin negociación ni
 * meses garantizados: lo que no tiene motivo en una tienda no se pide.
 */
export function AppPlanDrawer({
  app,
  plan,
  onClose,
  onSaved,
}: {
  app: string
  plan?: AdminPlan
  onClose: () => void
  onSaved: () => void
}) {
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      plan
        ? api(`/api/admin/billing/plans/${plan.id}`, {
            method: "PATCH",
            body: JSON.stringify(body),
          })
        : api("/api/admin/billing/plans", {
            method: "POST",
            body: JSON.stringify({ ...body, app }),
          }),
  })
  const [initial] = useState(
    (): AppPlanValues => ({
      code: plan?.code ?? "",
      name: plan?.name ?? "",
      currency: plan?.currency ?? "USD",
      price: plan ? centsToMajor(plan.priceCents, plan.currency) : "",
      credit: plan ? centsToMajor(plan.creditCents, plan.currency) : "0",
      attended: fromMicros(plan?.conversationInformMicros ?? null),
      order: fromMicros(plan?.conversationMicros ?? null),
      trialCredit: plan ? centsToMajor(plan.trialCreditCents, plan.currency) : "0",
      trialDays: String(plan?.trialDays ?? 30),
      isDefault: plan?.isDefault ?? false,
    }),
  )
  const form = useAppForm({
    defaultValues: initial,
    validators: { onSubmit: appPlanSchema },
    onSubmit: async ({ value }) => {
      const cents = (text: string) => majorToCents(text, value.currency) ?? 0
      await save.mutateAsync({
        code: value.code.trim(),
        name: value.name.trim(),
        currency: value.currency,
        priceCents: cents(value.price),
        creditCents: cents(value.credit),
        conversationInformMicros: micros(value.attended),
        conversationMicros: micros(value.order),
        fixedPriceTiers: [],
        maxDiscountBps: 0,
        sellerDiscountBps: 0,
        trialCreditCents: cents(value.trialCredit),
        trialMaxCreditCents: cents(value.trialCredit),
        trialDays: Number(value.trialDays.trim()),
        trialMaxDays: Number(value.trialDays.trim()),
        isDefault: value.isDefault,
      })
      onSaved()
      onClose()
    },
  })
  const surface = useFormSurface(form, {
    fieldMap: {
      priceCents: "price",
      creditCents: "credit",
      conversationInformMicros: "attended",
      conversationMicros: "order",
      trialCreditCents: "trialCredit",
    },
  })
  const currency = useStore(form.store, (state) => state.values.currency)
  const name = APP_NAMES[app] ?? app
  return (
    <FormDrawer
      {...surface}
      open
      title={plan ? `Editar plan de ${name}` : `Nuevo plan de ${name}`}
      description={
        plan
          ? "Cambiar un precio rige desde ahora: lo ya contado y los cargos emitidos no cambian."
          : `Lo usan solo las cuentas de ${name}.`
      }
      submitLabel={plan ? "Guardar" : "Crear plan"}
      onClose={onClose}
    >
      <FieldGroup>
        <div className="grid gap-x-4 gap-y-6 sm:grid-cols-2">
          <form.AppField name="code">
            {(field) => (
              <field.TextField id="app-plan-code" label="Código" placeholder="gestoria" />
            )}
          </form.AppField>
          <form.AppField name="name">
            {(field) => <field.TextField id="app-plan-name" label="Nombre" />}
          </form.AppField>
          <form.AppField name="currency">
            {(field) => (
              <field.Control id="app-plan-currency" label="Moneda">
                {(control) => (
                  <CurrencySelect
                    id={control.id}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onBlur={control.onBlur}
                    value={field.state.value}
                    onChange={(code) => field.handleChange(code)}
                  />
                )}
              </field.Control>
            )}
          </form.AppField>
          <form.AppField name="price">
            {(field) => (
              <field.TextField id="app-plan-price" label="Cuota al mes" inputMode="decimal" />
            )}
          </form.AppField>
          <form.AppField name="credit">
            {(field) => (
              <field.TextField
                id="app-plan-credit"
                label="Crédito para Sofi"
                description="Lo que vuelve de la cuota cada mes."
                inputMode="decimal"
              />
            )}
          </form.AppField>
          <span aria-hidden />
          <form.AppField name="attended">
            {(field) => (
              <field.TextField
                id="app-plan-attended"
                label={`Conversación atendida (${currency})`}
                description="Vacío: se cobra como la que tomó un pedido."
                inputMode="decimal"
              />
            )}
          </form.AppField>
          <form.AppField name="order">
            {(field) => (
              <field.TextField
                id="app-plan-order"
                label={`Conversación que tomó un pedido (${currency})`}
                description="Reemplaza a la atendida: no se suman. Vacío: no se cobra ninguna."
                inputMode="decimal"
              />
            )}
          </form.AppField>
          <form.AppField name="trialCredit">
            {(field) => (
              <field.TextField
                id="app-plan-trial-credit"
                label="Saldo de prueba"
                inputMode="decimal"
              />
            )}
          </form.AppField>
          <form.AppField name="trialDays">
            {(field) => (
              <field.TextField
                id="app-plan-trial-days"
                label="Días de prueba"
                inputMode="numeric"
              />
            )}
          </form.AppField>
        </div>
        <form.AppField name="isDefault">
          {(field) => (
            <field.CheckboxField
              id="app-plan-default"
              label={`Plan por defecto de ${name}`}
              description={`Con él abre y prueba cada cuenta nueva de ${name}. Sin plan por defecto, la cuenta abre sin plan y no se le cobra hasta asignarle uno.`}
            />
          )}
        </form.AppField>
      </FieldGroup>
    </FormDrawer>
  )
}

/** En Cobros y planes: los planes y las cuentas de cada app que es otro sistema. */
export function AppAccountsSection({
  plans,
  onChanged,
}: {
  plans: AdminPlan[]
  onChanged: () => void
}) {
  const [drawer, setDrawer] = useState<null | { app: string; plan?: AdminPlan }>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const accounts = useQuery({
    queryKey: ["admin", "billing", "accounts"],
    queryFn: async () =>
      z.array(accountRowSchema).parse(await api<unknown>("/api/admin/billing/accounts")),
  })
  return (
    <section aria-labelledby="otras-apps" className="flex flex-col gap-2">
      <h2 id="otras-apps" className="text-base font-semibold">
        Cuentas de otras apps
      </h2>
      {Object.keys(APP_NAMES).map((app) => {
        const own = plans.filter((plan) => plan.app === app)
        const ofApp = accounts.data?.filter((account) => account.app === app) ?? []
        return (
          <div key={app} className="flex flex-col gap-2">
            <h3 className="flex flex-wrap items-center gap-2 text-sm">
              <AppMark app={app} className="text-sm" />
              <span className="text-muted-foreground">
                · las abre la app, o la administración para un cliente
              </span>
              <span className="ml-auto flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!own.some((plan) => plan.isActive)}
                  title={
                    own.some((plan) => plan.isActive) ? undefined : "Primero crea un plan de la app"
                  }
                  onClick={() => setOpening(app)}
                >
                  Abrir una cuenta
                </Button>
                <Button size="sm" variant="outline" onClick={() => setDrawer({ app })}>
                  Nuevo plan
                </Button>
              </span>
            </h3>
            {own.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Sin planes de {APP_NAMES[app]}: sus cuentas abren sin plan y no se les cobra.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {own.map((plan) => (
                  <li
                    key={plan.id}
                    className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border p-4"
                  >
                    <div className="min-w-0 flex-1 basis-56">
                      <p className="text-sm font-medium">
                        {plan.name}{" "}
                        {!plan.isActive ? (
                          <span className="text-muted-foreground">(archivado)</span>
                        ) : null}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {plan.code}
                        {plan.isDefault ? " · por defecto" : ""}
                        {plan.creditCents
                          ? ` · vuelve ${money(plan.creditCents, plan.currency)} en crédito`
                          : ""}
                        {plan.conversationInformMicros !== null
                          ? ` · atendida ${plan.conversationInformMicros / 1_000_000}`
                          : ""}
                        {plan.conversationMicros !== null
                          ? ` · con pedido ${plan.conversationMicros / 1_000_000}`
                          : ""}
                      </p>
                    </div>
                    <p className="text-sm font-semibold tabular-nums">
                      {money(plan.priceCents, plan.currency)}
                    </p>
                    <Button size="sm" variant="outline" onClick={() => setDrawer({ app, plan })}>
                      Editar
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {accounts.isPending ? (
              <SkeletonRegion message="Cargando cuentas…">
                <div className="h-16 rounded-lg border" />
              </SkeletonRegion>
            ) : accounts.isError ? (
              <ErrorState
                title="No se pudieron cargar las cuentas"
                message={submitErrorMessage(accounts.error)}
                onRetry={() => void accounts.refetch()}
              />
            ) : ofApp.length === 0 ? (
              <EmptyState
                title={`Sin cuentas de ${APP_NAMES[app]}`}
                description="Aparecen cuando la app avisa que abrió una, o al abrirla aquí para un cliente."
              />
            ) : (
              <ul className="flex flex-col gap-2">
                {ofApp.map((account) => (
                  <li
                    key={account.id}
                    className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border p-4"
                  >
                    <div className="min-w-0 flex-1 basis-56">
                      <p className="text-sm font-medium">{account.name ?? account.externalRef}</p>
                      <p className="text-xs text-muted-foreground">
                        {ACCOUNT_STATUS[account.status] ?? account.status}
                        {account.planName ? ` · ${account.planName}` : ""}
                        {account.ownerEmail ? ` · ${account.ownerEmail}` : ""}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      render={<Link to="/accounts/$accountId" params={{ accountId: account.id }} />}
                    >
                      Abrir
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      })}
      {opening ? (
        <OpenAppAccountDrawer
          app={opening}
          plans={plans}
          onClose={() => setOpening(null)}
          onSaved={() => {
            toast.success("Cuenta abierta: su app la abre ahora para su dueño.")
            void accounts.refetch()
            onChanged()
          }}
        />
      ) : null}
      {drawer ? (
        <AppPlanDrawer
          app={drawer.app}
          plan={drawer.plan}
          onClose={() => setDrawer(null)}
          onSaved={onChanged}
        />
      ) : null}
    </section>
  )
}
