/**
 * Lo que la administración le pide a una app que es otro sistema (ADR 0213, tablero 3 del
 * lienzo A): abrir la cuenta de un cliente con su plan, dejar entrar a soporte y quitar a una
 * persona. Lo hace la app, con sus reglas; aquí queda el botón que lo pide, quién lo pidió y cómo
 * quedó (pendiente, hecho o falló, con lo que respondió la app). Solo la administración.
 */
import { Badge, FieldGroup } from "@odentia/ui"
import {
  type CountryCode,
  CountrySelect,
  FormDrawer,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useMutation } from "@tanstack/react-query"
import { useState } from "react"
import { z } from "zod"
import { api } from "../lib/api"
import { APP_NAMES } from "./app-accounts"
import { CurrencySelect } from "./billing-fields"
import { money } from "./billing-payments"
import type { AdminPlan } from "./plan-drawer"

export const appRequestSchema = z.object({
  id: z.string(),
  type: z.enum(["cuenta.abrir", "soporte.entrar", "equipo.quitar"]),
  status: z.enum(["pendiente", "hecho", "fallo"]),
  message: z.string().nullable(),
  requestedBy: z.string().nullable(),
  createdAt: z.string(),
  doneAt: z.string().nullable(),
  detail: z.string().nullable(),
})
export type AppRequest = z.infer<typeof appRequestSchema>

const REQUEST_NAMES: Record<AppRequest["type"], string> = {
  "cuenta.abrir": "Abrir la cuenta",
  "soporte.entrar": "Dejar entrar a soporte",
  "equipo.quitar": "Quitar a una persona",
}
const STATUS_NAMES: Record<AppRequest["status"], string> = {
  pendiente: "Pendiente",
  hecho: "Hecho",
  fallo: "Falló",
}

const when = (iso: string) =>
  new Intl.DateTimeFormat("es-PE", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso),
  )

/** Lo pedido a la app de esta cuenta, del más nuevo al más viejo. */
export function AppRequestList({ requests }: { requests: AppRequest[] }) {
  if (requests.length === 0)
    return <p className="text-sm text-muted-foreground">Todavía no se le pidió nada a su app.</p>
  return (
    <ul className="flex flex-col gap-2">
      {requests.map((request) => (
        <li key={request.id} className="flex flex-col gap-1 rounded-lg border p-4 text-sm">
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-medium">{REQUEST_NAMES[request.type]}</span>
            <Badge
              variant={
                request.status === "fallo"
                  ? "destructive"
                  : request.status === "hecho"
                    ? "secondary"
                    : "outline"
              }
            >
              {STATUS_NAMES[request.status]}
            </Badge>
            <span className="ml-auto text-xs text-muted-foreground">
              {request.requestedBy ?? "Alguien del equipo"} · {when(request.createdAt)}
            </span>
          </p>
          {request.detail ? <p className="text-muted-foreground">{request.detail}</p> : null}
          {request.message ? (
            <p
              className={request.status === "fallo" ? "text-destructive" : "text-muted-foreground"}
            >
              {request.status === "pendiente"
                ? `Todavía no llega: ${request.message}`
                : request.message}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

const reason = z
  .string()
  .trim()
  .min(3, "Escribe el motivo (al menos 3 caracteres)")
  .max(500, "Escribe como mucho 500 caracteres")

/** Entrar como soporte pide por cuánto; quitar a alguien, su correo. Los dos, el motivo. */
const requestSchema = (support: boolean) =>
  z.object({
    minutes: z.enum(["15", "30", "60"]),
    reason,
    email: support
      ? z.string()
      : z.string().trim().email("Escribe el correo de su cuenta").max(254),
  })

/**
 * «Dejar entrar a soporte» o «Quitar a una persona»: el pedido sale a la app con su motivo.
 * Entrar como soporte es a nombre de quien lo pide, con su propia cuenta; la tienda decide.
 */
export function AppRequestDrawer({
  accountId,
  app,
  kind,
  onClose,
  onSaved,
}: {
  accountId: string
  app: string
  kind: "soporte.entrar" | "equipo.quitar"
  onClose: () => void
  onSaved: () => void
}) {
  const send = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/api/admin/billing/accounts/${accountId}/requests`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
  })
  const support = kind === "soporte.entrar"
  const form = useAppForm({
    defaultValues: { minutes: "30", reason: "", email: "" },
    validators: { onSubmit: requestSchema(support) },
    onSubmit: async ({ value }) => {
      await send.mutateAsync(
        support
          ? { type: kind, minutes: Number(value.minutes), reason: value.reason.trim() }
          : { type: kind, email: value.email.trim(), reason: value.reason.trim() },
      )
      onSaved()
      onClose()
    },
  })
  const surface = useFormSurface(form)
  const name = APP_NAMES[app] ?? app
  return (
    <FormDrawer
      {...surface}
      open
      title={support ? "Dejar entrar a soporte" : "Quitar a una persona"}
      description={
        support
          ? `Le pide a ${name} que te deje mirar la cuenta, solo a mirar, el rato que elijas. La tienda lo acepta o no; entras con tu cuenta.`
          : `Le pide a ${name} que la saque del equipo de la cuenta. Si es su único Dueño, no se puede.`
      }
      submitLabel="Pedirlo"
      onClose={onClose}
    >
      <FieldGroup>
        {support ? (
          <form.AppField name="minutes">
            {(field) => (
              <field.SelectField
                id="app-request-minutes"
                label="Por cuánto"
                options={[
                  { value: "15", label: "15 minutos" },
                  { value: "30", label: "30 minutos" },
                  { value: "60", label: "1 hora" },
                ]}
              />
            )}
          </form.AppField>
        ) : (
          <form.AppField name="email">
            {(field) => (
              <field.TextField
                id="app-request-email"
                label="Correo de su cuenta"
                type="email"
                autoComplete="off"
              />
            )}
          </form.AppField>
        )}
        <form.AppField name="reason">
          {(field) => (
            <field.TextareaField
              id="app-request-reason"
              label={support ? "Para qué" : "Motivo"}
              description={support ? "Lo lee la tienda antes de decidir." : undefined}
              rows={3}
            />
          )}
        </form.AppField>
      </FieldGroup>
    </FormDrawer>
  )
}

const openSchema = z.object({
  name: z.string().trim().min(1, "Escribe el nombre").max(80, "Escribe como mucho 80 caracteres"),
  ownerEmail: z.string().trim().email("Escribe el correo de su cuenta").max(254),
  currency: z.string().regex(/^[A-Z]{3}$/, "Elige la moneda"),
  country: z.string().regex(/^[A-Z]{2}$/, "Elige el país"),
  planCode: z.string().min(1, "Elige el plan"),
})

/**
 * «Abrir una cuenta»: la cuenta de un cliente en una app, con su plan desde hoy. La app la abre a
 * nombre de su dueño (que ya tiene cuenta) y él entra con la suya.
 */
export function OpenAppAccountDrawer({
  app,
  plans,
  onClose,
  onSaved,
}: {
  app: string
  plans: AdminPlan[]
  onClose: () => void
  onSaved: () => void
}) {
  const own = plans.filter((plan) => plan.app === app && plan.isActive)
  const open = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api("/api/admin/billing/accounts", { method: "POST", body: JSON.stringify(body) }),
  })
  const [initial] = useState(() => {
    const first = own.find((plan) => plan.isDefault) ?? own[0]
    return {
      name: "",
      ownerEmail: "",
      currency: first?.currency ?? "PEN",
      country: "PE",
      planCode: first?.code ?? "",
    }
  })
  const form = useAppForm({
    defaultValues: initial,
    validators: { onSubmit: openSchema },
    onSubmit: async ({ value }) => {
      await open.mutateAsync({
        app,
        name: value.name.trim(),
        ownerEmail: value.ownerEmail.trim(),
        currency: value.currency,
        country: value.country,
        planCode: value.planCode,
      })
      onSaved()
      onClose()
    },
  })
  const surface = useFormSurface(form)
  const name = APP_NAMES[app] ?? app
  return (
    <FormDrawer
      {...surface}
      open
      title={`Abrir una cuenta de ${name}`}
      description={`${name} la abre a nombre de su dueño, con el plan que elijas desde hoy. Su dueño entra con su propia cuenta.`}
      submitLabel="Abrir la cuenta"
      onClose={onClose}
    >
      <FieldGroup>
        <form.AppField name="name">
          {(field) => <field.TextField id="app-open-name" label="Nombre de la tienda" />}
        </form.AppField>
        <form.AppField name="ownerEmail">
          {(field) => (
            <field.TextField
              id="app-open-owner"
              label="Correo de su dueño"
              description="El de su cuenta: tiene que haberse registrado antes."
              type="email"
              autoComplete="off"
            />
          )}
        </form.AppField>
        <div className="grid gap-x-4 gap-y-6 sm:grid-cols-2">
          <form.AppField name="currency">
            {(field) => (
              <field.Control
                id="app-open-currency"
                label="Moneda en que vende"
                description="No cambia después."
              >
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
          <form.AppField name="country">
            {(field) => (
              <field.Control id="app-open-country" label="País">
                {(control) => (
                  <CountrySelect
                    id={control.id}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onBlur={control.onBlur}
                    value={field.state.value as CountryCode}
                    onChange={(code) => field.handleChange(code)}
                  />
                )}
              </field.Control>
            )}
          </form.AppField>
        </div>
        <form.AppField name="planCode">
          {(field) => (
            <field.SelectField
              id="app-open-plan"
              label="Plan"
              placeholder={own.length ? "Elige un plan" : `${name} no tiene planes`}
              options={own.map((plan) => ({
                value: plan.code,
                label: `${plan.name} · ${money(plan.priceCents, plan.currency)}`,
              }))}
            />
          )}
        </form.AppField>
      </FieldGroup>
    </FormDrawer>
  )
}
