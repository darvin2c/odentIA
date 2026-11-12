/**
 * «Cambiar datos» del Resumen de la ficha: el nombre, dónde está, cuántos
 * atienden, qué usan hoy y cómo llegó. El responsable lo cambia solo
 * Administración (el servidor también lo exige). Se envía solo lo que cambió.
 */
import { toast } from "@odentia/ui"
import {
  common,
  countryOptions,
  FormDrawer,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useQueryClient } from "@tanstack/react-query"
import * as React from "react"
import { z } from "zod"
import { api } from "../../lib/api"
import { CLIENT_ORIGIN_NAMES } from "../../lib/list-search"
import { useIsAdmin } from "../../lib/session"
import {
  type ClientDetail,
  invalidateClient,
  ORIGIN_WORDS,
  PROFESSIONALS_OPTIONS,
  PROFESSIONALS_WORDS,
  TOOL_OPTIONS,
  TOOL_WORDS,
} from "./client-model"
import { useStaff } from "./new-client-drawer"

const schema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Escribe el nombre de la clínica")
    .max(160, "Usa como máximo 160 caracteres"),
  city: z.string().trim().max(120, "Usa como máximo 120 caracteres"),
  countryCode: z.string().regex(/^[A-Z]{2}$/, "Elige el país"),
  professionals: z.string(),
  currentTool: z.string(),
  origin: z.enum(CLIENT_ORIGIN_NAMES, "Elige cómo llegó"),
  originDetail: z.string().trim().max(300, "Usa como máximo 300 caracteres"),
  ownerUserId: z.string(),
})
type Values = z.input<typeof schema>

const valuesOf = (client: ClientDetail): Values => ({
  name: client.name,
  city: client.city ?? "",
  countryCode: client.countryCode,
  professionals: client.professionals ?? "",
  currentTool: client.currentTool ?? "",
  origin: (CLIENT_ORIGIN_NAMES as readonly string[]).includes(client.origin)
    ? (client.origin as Values["origin"])
    : "otro",
  originDetail: client.originDetail ?? "",
  ownerUserId: client.owner?.userId ?? "",
})

export function ClientDataDrawer({
  client,
  open,
  onClose,
}: {
  client: ClientDetail
  open: boolean
  onClose: () => void
}) {
  if (!open) return null
  return <DataForm client={client} onClose={onClose} />
}

function DataForm({ client, onClose }: { client: ClientDetail; onClose: () => void }) {
  const isAdmin = useIsAdmin()
  const queryClient = useQueryClient()
  const staff = useStaff()
  const initial = React.useMemo(() => valuesOf(client), [client])
  const countries = React.useMemo(
    () =>
      countryOptions("PE", undefined, "es").map((item) => ({
        value: item.value,
        label: item.label,
      })),
    [],
  )
  const form = useAppForm({
    defaultValues: initial,
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const next = {
        name: value.name.trim(),
        city: value.city.trim() || null,
        countryCode: value.countryCode,
        professionals: value.professionals || null,
        currentTool: value.currentTool || null,
        origin: value.origin,
        originDetail: value.originDetail.trim() || null,
        ownerUserId: value.ownerUserId || null,
      }
      const before = {
        name: initial.name,
        city: initial.city || null,
        countryCode: initial.countryCode,
        professionals: initial.professionals || null,
        currentTool: initial.currentTool || null,
        origin: initial.origin,
        originDetail: initial.originDetail || null,
        ownerUserId: initial.ownerUserId || null,
      }
      const patch = Object.fromEntries(
        Object.entries(next).filter(
          ([key, val]) =>
            (key !== "ownerUserId" || isAdmin) && before[key as keyof typeof before] !== val,
        ),
      )
      if (Object.keys(patch).length) {
        await api(`/api/admin/clients/${encodeURIComponent(client.id)}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        })
        invalidateClient(queryClient, client.id)
        toast.success("Datos guardados")
      }
      onClose()
    },
  })
  const surface = useFormSurface(form)
  const staffOptions = [
    { value: "", label: "Sin responsable" },
    ...(staff.data ?? []).map((row) => ({ value: row.userId, label: row.name || row.email })),
  ]

  return (
    <FormDrawer
      {...surface}
      open
      onClose={onClose}
      title="Datos del cliente"
      description="Lo que se sabe de la clínica. Lo que falta, Kairós lo pide en «Qué falta saber»."
      submitLabel="Guardar"
      cancelLabel={common.actions.cancel}
    >
      <div className="flex flex-col gap-4">
        <form.AppField name="name">
          {(field) => <field.TextField id="datos-nombre" label="Clínica" maxLength={160} />}
        </form.AppField>
        <form.AppField name="city">
          {(field) => (
            <field.TextField
              id="datos-ciudad"
              label="Ciudad"
              placeholder="Ej.: Cusco"
              maxLength={120}
            />
          )}
        </form.AppField>
        <form.AppField name="countryCode">
          {(field) => <field.SelectField id="datos-pais" label="País" options={countries} />}
        </form.AppField>
        <form.AppField name="professionals">
          {(field) => (
            <field.SelectField
              id="datos-profesionales"
              label="Cuántos atienden"
              options={[
                { value: "", label: "Aún no se sabe" },
                ...PROFESSIONALS_OPTIONS.map((value) => ({
                  value,
                  label: PROFESSIONALS_WORDS[value] ?? value,
                })),
              ]}
            />
          )}
        </form.AppField>
        <form.AppField name="currentTool">
          {(field) => (
            <field.SelectField
              id="datos-herramienta"
              label="Qué usan hoy"
              options={[
                { value: "", label: "Aún no se sabe" },
                ...TOOL_OPTIONS.map((value) => ({ value, label: TOOL_WORDS[value] ?? value })),
              ]}
            />
          )}
        </form.AppField>
        <form.AppField name="origin">
          {(field) => (
            <field.SelectField
              id="datos-origen"
              label="Cómo llegó"
              options={CLIENT_ORIGIN_NAMES.map((origin) => ({
                value: origin,
                label: ORIGIN_WORDS[origin],
              }))}
            />
          )}
        </form.AppField>
        <form.AppField name="originDetail">
          {(field) => (
            <field.TextField
              id="datos-origen-detalle"
              label="Quién la refirió o dónde la conocimos"
              maxLength={300}
            />
          )}
        </form.AppField>
        {isAdmin ? (
          <form.AppField name="ownerUserId">
            {(field) => (
              <field.SelectField
                id="datos-responsable"
                label="Responsable"
                options={staffOptions}
              />
            )}
          </form.AppField>
        ) : (
          <p className="text-sm text-muted-foreground">El responsable lo cambia Administración.</p>
        )}
      </div>
    </FormDrawer>
  )
}
