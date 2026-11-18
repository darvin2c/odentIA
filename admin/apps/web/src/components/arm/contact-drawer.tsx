/**
 * Agregar o cambiar una persona del cliente: su nombre, su cargo, sus papeles
 * (decide, la usa, paga), cómo contactarla y por dónde prefiere. Decir sus
 * papeles los confirma. El correo de quien está ligada a su usuario es el de su
 * cuenta: no se cambia aquí (lo dice el servidor).
 */
import { Checkbox, toast } from "@odentia/ui"
import { common, FormDrawer, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useQueryClient } from "@tanstack/react-query"
import { z } from "zod"
import { api } from "../../lib/api"
import {
  CHANNEL_WORDS,
  CONTACT_CHANNELS,
  CONTACT_ROLES,
  type ContactRow,
  invalidateClient,
  ROLE_WORDS,
} from "./client-model"

const schema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Escribe el nombre de la persona")
    .max(160, "Usa como máximo 160 caracteres"),
  title: z.string().trim().max(120, "Usa como máximo 120 caracteres"),
  roles: z.array(z.enum(CONTACT_ROLES)),
  phone: z.string().nullable(),
  email: z.union([
    z.literal(""),
    z.email("Escribe un correo válido, como nombre@clinica.com").max(254),
  ]),
  preferredChannel: z.string(),
  isPrimary: z.boolean(),
})
type Values = z.input<typeof schema>

export interface ContactDrawerProps {
  clientId: string
  open: boolean
  onClose: () => void
  /** Sin ella, una persona nueva. */
  contact?: ContactRow | null
  /** Lo que viene escrito al agregar (un miembro de la cuenta que aún no es persona del cliente). */
  initial?: Partial<Pick<Values, "name" | "email">>
}

export function ContactDrawer(props: ContactDrawerProps) {
  if (!props.open) return null
  return <ContactForm {...props} />
}

function ContactForm({ clientId, onClose, contact, initial }: ContactDrawerProps) {
  const queryClient = useQueryClient()
  const editing = Boolean(contact?.id)
  const linked = Boolean(contact?.user)
  const defaults: Values = {
    name: contact?.name ?? initial?.name ?? "",
    title: contact?.title ?? "",
    roles: (contact?.roles ?? []).filter((role): role is (typeof CONTACT_ROLES)[number] =>
      (CONTACT_ROLES as readonly string[]).includes(role),
    ),
    phone: contact?.phone ?? null,
    email: contact?.email ?? initial?.email ?? "",
    preferredChannel: contact?.preferredChannel ?? "",
    isPrimary: false,
  }
  const form = useAppForm({
    defaultValues: defaults,
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const body = {
        name: value.name.trim(),
        title: value.title.trim() || null,
        roles: value.roles,
        phone: value.phone || null,
        // El de una persona ligada es el de su cuenta: no se manda.
        ...(linked ? {} : { email: value.email.trim().toLowerCase() || null }),
        preferredChannel: value.preferredChannel || null,
        ...(editing ? {} : value.isPrimary ? { isPrimary: true } : {}),
      }
      if (editing && contact?.id)
        await api(`/api/admin/clients/contacts/${encodeURIComponent(contact.id)}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        })
      else
        await api(`/api/admin/clients/${encodeURIComponent(clientId)}/contacts`, {
          method: "POST",
          body: JSON.stringify(body),
        })
      invalidateClient(queryClient, clientId)
      toast.success(editing ? "Persona guardada" : `${body.name} quedó entre sus personas`)
      onClose()
    },
  })
  const surface = useFormSurface(form)

  return (
    <FormDrawer
      {...surface}
      open
      onClose={onClose}
      title={editing ? `Cambiar a ${contact?.name}` : "Agregar persona"}
      description="Con quién hablamos en la clínica. No escribas datos de pacientes."
      submitLabel="Guardar"
      cancelLabel={common.actions.cancel}
    >
      <div className="flex flex-col gap-4">
        <form.AppField name="name">
          {(field) => (
            <field.TextField
              id="persona-nombre"
              label="Nombre"
              maxLength={160}
              autoComplete="off"
              autoFocus={!editing}
            />
          )}
        </form.AppField>
        <form.AppField name="title">
          {(field) => (
            <field.TextField
              id="persona-cargo"
              label="Cargo (opcional)"
              placeholder="Ej.: Directora, administradora"
              maxLength={120}
            />
          )}
        </form.AppField>
        <form.AppField name="roles">
          {(field) => (
            <field.Group
              legend="Qué papel tiene"
              description="Puede tener varios. Al guardarlos quedan confirmados."
              id="persona-papeles"
            >
              {() => (
                <div className="flex flex-wrap gap-4">
                  {CONTACT_ROLES.map((role) => {
                    const id = `persona-papel-${role}`
                    const checked = field.state.value.includes(role)
                    return (
                      <label key={role} htmlFor={id} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          id={id}
                          checked={checked}
                          onCheckedChange={(next) =>
                            field.handleChange(
                              next === true
                                ? [...field.state.value, role]
                                : field.state.value.filter((item) => item !== role),
                            )
                          }
                        />
                        {ROLE_WORDS[role]}
                      </label>
                    )
                  })}
                </div>
              )}
            </field.Group>
          )}
        </form.AppField>
        <form.AppField name="phone">
          {(field) => (
            <field.PhoneField id="persona-celular" label="Celular (WhatsApp)" defaultCountry="PE" />
          )}
        </form.AppField>
        <form.AppField name="email">
          {(field) => (
            <field.TextField
              id="persona-correo"
              label="Correo"
              type="email"
              maxLength={254}
              autoComplete="off"
              disabled={linked}
              description={
                linked ? "Está ligada a su usuario: su correo es el de su cuenta." : undefined
              }
            />
          )}
        </form.AppField>
        <form.AppField name="preferredChannel">
          {(field) => (
            <field.SelectField
              id="persona-canal"
              label="Por dónde prefiere"
              options={[
                { value: "", label: "Sin preferencia" },
                ...CONTACT_CHANNELS.map((channel) => ({
                  value: channel,
                  label: CHANNEL_WORDS[channel] ?? channel,
                })),
              ]}
            />
          )}
        </form.AppField>
        {editing ? null : (
          <form.AppField name="isPrimary">
            {(field) => (
              <field.CheckboxField
                id="persona-principal"
                label="Es la persona principal"
                description="A ella va lo que se escribe si no se elige a otra."
              />
            )}
          </form.AppField>
        )}
      </div>
    </FormDrawer>
  )
}
